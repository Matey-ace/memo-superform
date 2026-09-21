'use strict';

// Account status is fetched asynchronously while manual-token save and
// disconnect mutate the credential held by the local service. Verify a late
// status response cannot roll the in-memory connection back to an old account.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('js/api.js', 'utf8');
const pendingStatus = [];
let resolveManualToken = null;
let resolveDisconnect = null;

function response(data) {
    return { ok: true, json: async function() { return data; } };
}

const storage = {};
const context = {
    console: console,
    Promise: Promise,
    Date: Date,
    JSON: JSON,
    localStorage: {
        getItem: function(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
        setItem: function(key, value) { storage[key] = String(value); },
        removeItem: function(key) { delete storage[key]; },
        key: function(index) { return Object.keys(storage)[index] || null; },
        get length() { return Object.keys(storage).length; }
    },
    fetch: function(path) {
        if (path === '/api/maimemo-auth/status') {
            return new Promise(function(resolve) { pendingStatus.push(resolve); });
        }
        if (path === '/api/maimemo-auth/manual-token') {
            return new Promise(function(resolve) { resolveManualToken = resolve; });
        }
        if (path === '/api/maimemo-auth/disconnect') {
            return new Promise(function(resolve) { resolveDisconnect = resolve; });
        }
        throw new Error('unexpected request: ' + path);
    }
};

vm.createContext(context);
vm.runInContext(source, context, { filename: 'js/api.js' });
const api = vm.runInContext('MaimemoAPI', context);

async function run() {
    const staleBeforeSave = api.refreshConnection();
    const save = api.saveManualToken('new-token');
    resolveManualToken(response({ connected: true, mode: 'manual', profile_id: 'new-profile' }));
    await save;
    assert.strictEqual(api.hasToken(), true, 'manual token save must establish the new connection');

    pendingStatus.shift()(response({ connected: false, mode: '', profile_id: '' }));
    await staleBeforeSave;
    assert.strictEqual(api.hasToken(), true, 'a pre-save status response must not clear the new connection');

    const staleBeforeDisconnect = api.refreshConnection();
    const disconnect = api.disconnect();
    resolveDisconnect(response({ ok: true }));
    await disconnect;
    assert.strictEqual(api.hasToken(), false, 'disconnect must clear the active connection');

    pendingStatus.shift()(response({ connected: true, mode: 'manual', profile_id: 'old-profile' }));
    await staleBeforeDisconnect;
    assert.strictEqual(api.hasToken(), false, 'a pre-disconnect status response must not restore the old connection');
}

run()
    .then(function() { console.log('API_CONNECTION_RACE_REGRESSION_PASS'); })
    .catch(function(error) { console.error(error); process.exitCode = 1; });
