'use strict';

// The one-click authorisation button used to disappear whenever a status query
// was superseded by another one: the losing call returned the module's initial
// connection literal, which had no `configured` / `callback_ready` fields, so
// the settings panel read `undefined` as "not configured" and hid the button.
//
// This suite pins the contract that made that possible:
//   1. every refreshConnection() caller receives the payload of ITS OWN request,
//   2. discarding a stale response never strips server capability fields,
//   3. concurrent refreshes in the same credential generation are de-duplicated,
//   4. a credential mutation invalidates any in-flight status query,
//   5. failure and recovery both propagate to the caller.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('js/api.js', 'utf8');

let pendingStatus = [];
let statusRequests = 0;
let failNextStatus = null;
let resolveManualToken = null;
let resolveDisconnect = null;

function response(data, ok) {
    return { ok: ok !== false, json: async function() { return data; }, status: ok === false ? 503 : 200 };
}

const storage = {};
const context = {
    console: console, Promise: Promise, Date: Date, JSON: JSON, Object: Object,
    localStorage: {
        getItem: function(k) { return Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null; },
        setItem: function(k, v) { storage[k] = String(v); },
        removeItem: function(k) { delete storage[k]; },
        key: function(i) { return Object.keys(storage)[i] || null; },
        get length() { return Object.keys(storage).length; }
    },
    fetch: function(path) {
        if (path === '/api/maimemo-auth/status') {
            statusRequests += 1;
            if (failNextStatus) {
                const error = failNextStatus;
                failNextStatus = null;
                return Promise.resolve(response(error, false));
            }
            return new Promise(function(resolve) { pendingStatus.push(resolve); });
        }
        if (path === '/api/maimemo-auth/manual-token') {
            return new Promise(function(resolve) { resolveManualToken = resolve; });
        }
        if (path === '/api/maimemo-auth/disconnect') {
            return new Promise(function(resolve) { resolveDisconnect = resolve; });
        }
        if (path === '/api/maimemo-auth/start') {
            return Promise.resolve(response({ authorization_url: 'https://example.invalid/a', opened: true }));
        }
        throw new Error('unexpected request: ' + path);
    }
};

vm.createContext(context);
vm.runInContext(source, context, { filename: 'js/api.js' });
const api = vm.runInContext('MaimemoAPI', context);

const READY = {
    connected: false, mode: '', profile_id: '',
    configured: true, callback_ready: true, callback_error: '',
    pending: false, error: '', display_name: ''
};

async function run() {
    // ---- 1. a superseded concurrent refresh still returns a full status payload ----
    statusRequests = 0;
    const first = api.refreshConnection();
    const second = api.refreshConnection();
    assert.strictEqual(statusRequests, 1, 'concurrent refreshes in one generation must share a single request');
    pendingStatus.shift()(response(Object.assign({}, READY)));
    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(a.configured, true, 'first caller must see configured');
    assert.strictEqual(b.configured, true, 'second caller must see configured');
    assert.strictEqual(a.callback_ready, true, 'first caller must see callback_ready');
    assert.strictEqual(b.callback_ready, true, 'second caller must see callback_ready');

    // ---- 2. sequential refreshes each get their own request and payload ----
    statusRequests = 0;
    const seqA = api.refreshConnection();
    pendingStatus.shift()(response(Object.assign({}, READY, { configured: false })));
    const seqAResult = await seqA;
    const seqB = api.refreshConnection();
    pendingStatus.shift()(response(Object.assign({}, READY)));
    const seqBResult = await seqB;
    assert.strictEqual(statusRequests, 2, 'sequential refreshes must not reuse the finished request');
    assert.strictEqual(seqAResult.configured, false, 'caller must see its own snapshot');
    assert.strictEqual(seqBResult.configured, true, 'a later caller must see the newer snapshot');

    // ---- 3. a credential mutation invalidates the in-flight status query ----
    // (the stale payload must not overwrite the new connection, but the caller of
    //  the stale request must still receive a payload with capability fields)
    statusRequests = 0;
    const staleStatus = api.refreshConnection();
    const save = api.saveManualToken('token-1');
    resolveManualToken(response({ connected: true, mode: 'manual', profile_id: 'p-new' }));
    await save;
    assert.strictEqual(api.hasToken(), true, 'manual token must connect');
    // saveMessage consumed one status slot? no: manual-token path does not poll status
    pendingStatus.shift()(response(Object.assign({}, READY, { connected: false, profile_id: '' })));
    const staleResult = await staleStatus;
    assert.strictEqual(api.hasToken(), true, 'a pre-save status must not clear the new connection');
    assert.strictEqual(staleResult.configured, true,
        'the stale caller must still receive capability fields so the UI cannot misread "unconfigured"');

    // ---- 4. losing a race must not strip configured/callback_ready from shared state ----
    const oauthStatus = api.refreshConnection();
    pendingStatus.shift()(response(Object.assign({}, READY, {
        connected: true, mode: 'oauth', profile_id: 'p-new', display_name: 'Anon'
    })));
    await oauthStatus;
    const shared = api.connectionStatus();
    assert.strictEqual(shared.configured, true, 'capability fields must survive later commits');
    assert.strictEqual(shared.callback_ready, true, 'callback_ready must survive later commits');

    // ---- 5. disconnect keeps capability fields but clears the account ----
    const disconnect = api.disconnect();
    resolveDisconnect(response({ ok: true }));
    await disconnect;
    const afterDisconnect = api.connectionStatus();
    assert.strictEqual(afterDisconnect.connected, false, 'disconnect must clear connected');
    assert.strictEqual(afterDisconnect.configured, true,
        'disconnect must not erase the server capability field (it describes the install, not the account)');
    assert.strictEqual(afterDisconnect.callback_ready, true, 'disconnect must not erase callback_ready');

    // ---- 6. a failed status query rejects so the UI can show a reason ----
    failNextStatus = { error: '账号服务错误: 503' };
    let rejected = null;
    await api.refreshConnection().catch(function(error) { rejected = error; });
    assert.ok(rejected, 'a failed status query must reject instead of silently returning stale state');
    assert.ok(/503|账号服务/.test(rejected.message), 'the rejection must carry the reason');

    // ---- 7. recovery after failure ----
    const recovered = api.refreshConnection();
    pendingStatus.shift()(response(Object.assign({}, READY)));
    const recoveredResult = await recovered;
    assert.strictEqual(recoveredResult.configured, true, 'a later successful query must recover');

    // ---- 8. initial state must not look like "unconfigured" ----
    const freshContext = { console: console, Promise: Promise, Date: Date, JSON: JSON, Object: Object,
        localStorage: { getItem: function() { return null; }, setItem: function() {}, removeItem: function() {}, key: function() { return null; }, get length() { return 0; } },
        fetch: function() { return new Promise(function() {}); } };
    vm.createContext(freshContext);
    vm.runInContext(source, freshContext, { filename: 'js/api.js' });
    const fresh = vm.runInContext('MaimemoAPI', freshContext);
    const beforeAnyQuery = fresh.connectionStatus();
    assert.strictEqual(beforeAnyQuery.configured, null,
        'before the first query, configured must be null (unknown) rather than undefined/false');
    assert.strictEqual(fresh.isStatusLoaded(), false, 'status must report as not yet loaded');
    assert.strictEqual(typeof fresh.isStatusLoaded, 'function', 'isStatusLoaded must be exported');
}

run()
    .then(function() { console.log('AUTH_STATE_REGRESSION_PASS'); })
    .catch(function(error) { console.error(error); process.exitCode = 1; });
