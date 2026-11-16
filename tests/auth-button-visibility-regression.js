'use strict';

// The settings panel markup is SHARED with the notebook theme, so the auth buttons
// keep their original inline style="display:none". The standard renderer used to
// toggle only the `hidden` attribute, which cannot override an inline declaration —
// so after a successful connection the user could never see "重新授权", "断开连接"
// or "删除本机墨墨学习数据". This suite pins the contract that prevents that.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

// Source files are CRLF, so regexes written with a bare LF never match; normalise first.
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const app = read('js/app.js');
const index = read('index.html');

// ---- 1. the shared markup really does use inline display:none ----
for (const id of ['maimemoReconnectBtn', 'maimemoDisconnectBtn']) {
    const tag = new RegExp('<button id="' + id + '"[^>]*>').exec(index);
    assert.ok(tag, 'missing button ' + id);
    assert.ok(/style="display:\s*none"/.test(tag[0]),
        id + ' must keep its original inline display:none (shared with the notebook theme)');
}

// ---- 2. the standard renderer must clear the inline style as well as hidden ----
const showFn = /function showMaimemo\(selector, visible\) \{([\s\S]*?)\n        \}/.exec(app);
assert.ok(showFn, 'showMaimemo must exist');
assert.ok(/\.hidden = !visible/.test(showFn[1]), 'showMaimemo must toggle hidden');
assert.ok(/\.style\.display = visible \? '' : 'none'/.test(showFn[1]),
    'showMaimemo must also clear the inline display, otherwise inline display:none wins');

// ---- 3. every button that is shown by a state goes through showMaimemo ----
for (const id of ['maimemoReconnectBtn', 'maimemoDisconnectBtn', 'maimemoDeleteDataBtn', 'maimemoConnectBtn']) {
    const direct = new RegExp(id + '\.hidden\s*=').test(app);
    assert.strictEqual(direct, false,
        id + ' must not be toggled via .hidden directly (inline display would win)');
}

// ---- 4. the connected branch must show reconnect / disconnect / delete ----
const connected = /case 'connected':([\s\S]*?)break;/.exec(app);
assert.ok(connected, "renderMaimemoState must have a connected branch");
assert.ok(/showMaimemo\(maimemoReconnectBtn,/.test(connected[1]), 'connected must show reconnect');
assert.ok(/showMaimemo\(maimemoDisconnectBtn, true\)/.test(connected[1]), 'connected must show disconnect');
assert.ok(/showMaimemo\(maimemoDeleteDataBtn, true\)/.test(connected[1]), 'connected must show delete');

// ---- 5. pending keeps a usable entry (the server holds the slot for 10 minutes) ----
const pending = /case 'pending':([\s\S]*?)break;/.exec(app);
assert.ok(pending, 'renderMaimemoState must have a pending branch');
assert.ok(/showMaimemo\(maimemoReconnectBtn, true\)/.test(pending[1]),
    'pending must keep a way to restart authorisation instead of hiding every entry');
assert.ok(/showMaimemo\(maimemoRetryBtn, true\)/.test(pending[1]), 'pending must offer re-check');

// ---- 6. the retry button is not unconditionally visible ----
assert.ok(/showMaimemo\(maimemoRetryBtn, false\);/.test(app),
    'the reset block must hide the retry button first');
for (const kind of ['loading', 'error', 'unconfigured', 'callback-missing']) {
    const branch = new RegExp("case '" + kind + "':([\\s\\S]*?)break;").exec(app);
    assert.ok(branch, 'missing branch ' + kind);
    assert.ok(/showMaimemo\(maimemoRetryBtn, true\)/.test(branch[1]),
        kind + ' must offer the retry entry');
}

// ---- 7. polling only starts for the authorisation that is still current ----
const login = /async function startMaimemoLogin\(\)([\s\S]*?)\n        \}\n/.exec(app);

assert.ok(login, 'startMaimemoLogin must exist');
assert.ok(/if \(sequence === maimemoUiSequence\) \{[\s\S]*setInterval\(refreshMaimemoAccount, 1500\)/.test(login[1]),
    'the status poll must start inside the "still current" guard, not for a superseded flow');
assert.ok(!/\n                stopMaimemoPolling\(\);\n                maimemoPollTimer = setInterval/.test(login[1]),
    'polling must not start outside the guard');

// ---- 8. credential changes elsewhere repaint the panel ----
assert.ok(/repaintMaimemoPanel = function/.test(app),
    'the panel must expose a repaint hook for out-of-band credential changes');
assert.ok(/memo-account-changed[\s\S]{0,400}repaintMaimemoPanel/.test(app),
    'the account-changed listener must repaint the auth panel (bootstrap migration)');

// ---- 9. notebook theme keeps the original renderer ----
assert.ok(/if \(!standardAuthUi\) \{ renderMaimemoLegacy/.test(app),
    'non-standard themes must use the original rendering');
assert.ok(/standardAuthUi = !!\(window\.MemoUIStyle && !window\.MemoUIStyle\.isNotebook\)/.test(app),
    'standardAuthUi must be derived from the active theme');

console.log('AUTH_BUTTON_VISIBILITY_REGRESSION_PASS');
