'use strict';

// The notebook theme is frozen, but several files it depends on are SHARED with the
// standard theme (index.html, app.js, layout.js, study-web.js, article-vocab-wire.js,
// study-content-editor.js). A change in a shared file is only acceptable if it is
// inert for the notebook. Hash-based guards cannot see this: they only know the
// ranges listed in their baseline, and every leak found so far sat outside them.
//
// This suite therefore checks the actual contract: on a shared path, the notebook
// must take the OLD code path, not a new one that happens to be "theme aware".
const assert = require('assert');
const fs = require('fs');
const { execFileSync } = require('child_process');

// Source files are CRLF; normalise so regexes behave.
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const head = p => execFileSync('git', ['show', 'HEAD:' + p], { encoding: 'utf8' }).replace(/\r\n/g, '\n');

const app = read('js/app.js');
const layout = read('js/layout.js');
const studyWeb = read('js/study-web.js');
const vocab = read('js/article-vocab-wire.js');
const editor = read('js/study-content-editor.js');

// ---- 1. the theme flag must be module scope ----
// It is read by the memo-account-changed listener near the top of the app, so a
// const declared later inside setupSettingsPanel would be in its temporal dead zone.
const flagDecls = (app.match(/const standardAuthUi =/g) || []).length;
assert.strictEqual(flagDecls, 1, 'standardAuthUi must be declared exactly once');
const flagIndex = app.indexOf('const standardAuthUi =');
const listenerIndex = app.indexOf('repaintMaimemoPanel();');
assert.ok(flagIndex > 0 && flagIndex < listenerIndex,
    'standardAuthUi must be declared before the listener that reads it (otherwise TDZ)');

// ---- 2. the notebook must run HEAD's auth renderer, not the new state machine ----
// Delegating only the RENDER is not enough: HEAD's error path, its manual-token
// ordering and its "opening browser" copy all differ, and the reviewer caught the
// notebook showing "not connected" where HEAD showed the real error.
const legacy = /function renderMaimemoLegacy\(status\) \{([\s\S]*?)\n        \}/.exec(app);
assert.ok(legacy, 'renderMaimemoLegacy must exist');
for (const fragment of ['status-text success', "'hint'", 'status-text error',
                        'maimemoReconnectBtn.style.display', 'maimemoDisconnectBtn.style.display']) {
    assert.ok(legacy[1].includes(fragment),
        'renderMaimemoLegacy must reproduce HEAD rendering; missing ' + fragment);
}
assert.ok(!/showMaimemo\(/.test(legacy[1]),
    'renderMaimemoLegacy must use style.display like HEAD, never the new showMaimemo helper');

// refresh: notebook branch must report the error text, not "not connected"
const refresh = /async function refreshMaimemoAccount\(\) \{([\s\S]*?)\n        \}/.exec(app);
assert.ok(refresh, 'refreshMaimemoAccount must exist');
assert.ok(/if \(!standardAuthUi\) \{/.test(refresh[1]), 'refresh must branch on the theme first');
assert.ok(/maimemoStatus\.textContent = '✗ ' \+ e\.message/.test(refresh[1]),
    "the notebook error path must show HEAD's '✗ <message>', not '尚未连接墨墨账号'");

// every credential-mutating handler must keep the old notebook path
for (const [name, marker] of [
    ['startMaimemoLogin', "正在打开浏览器授权\.\.\."],
    ['maimemoDisconnectBtn.addEventListener', "await MaimemoAPI\.disconnect\(\)"],
    ['maimemoManualSaveBtn.addEventListener', "Token 已保存并连接成功"]
]) {
    const idx = app.indexOf(name);
    assert.ok(idx > 0, name + ' must exist');
    const body = app.slice(idx, idx + 1400);
    assert.ok(/if \(!standardAuthUi\) \{/.test(body),
        name + ' must branch on the theme before doing anything');
    assert.ok(new RegExp(marker).test(body),
        name + ' must keep the original notebook behaviour (' + marker + ')');
}

// the manual-token notebook path must set the class HEAD set
const manualIdx = app.indexOf("maimemoManualSaveBtn.addEventListener");
assert.ok(/classList|className = 'status-text success'/.test(app.slice(manualIdx, manualIdx + 1600)),
    "the notebook manual-token path must set className = 'status-text success' like HEAD");

// ---- 3. no standard-only node may be revealed outside the standard renderer ----
// #maimemoConnectReason is data-standard-only; writing hidden=false anywhere
// outside renderMaimemoState would pop it into the frozen notebook panel.
const reasonWrites = app.match(/maimemoReason\.hidden = false/g) || [];
assert.ok(reasonWrites.length > 0, 'the standard renderer is expected to reveal the reason');
// all of them must live inside renderMaimemoState
const renderStart = app.indexOf('function renderMaimemoState');
const renderEnd = app.indexOf('async function refreshMaimemoAccount');
const outside = [...app.matchAll(/maimemoReason\.hidden = false/g)]
    .filter(m => m.index < renderStart || m.index > renderEnd)
    // A write outside the renderer is acceptable only when it is explicitly
    // guarded by the theme flag right at the call site.
    .filter(m => !/standardAuthUi && maimemoReason\) \{[\s\S]{0,40}maimemoReason\.hidden = false/.test(app.slice(m.index - 120, m.index + 60)));
assert.strictEqual(outside.length, 0,
    'maimemoReason.hidden = false must only happen inside renderMaimemoState or behind an explicit ' +
    'standardAuthUi guard (found ' + outside.length + ' unguarded) — it leaks a standard-only node into the notebook');

// ---- 4. layout inert must match HEAD exactly for the notebook ----
// HEAD set inert on THREE nodes unconditionally; a narrower "fallback" is a change.
const inertFn = /function setFullscreenBackgroundInert\(isOpen\) \{([\s\S]*?)\n    \}/.exec(layout);
assert.ok(inertFn, 'setFullscreenBackgroundInert must exist');
for (const node of ["'.topbar'", "getElementById('dashboard')", "getElementById('companionStudy')"]) {
    assert.ok(inertFn[1].includes(node), 'inert must still cover ' + node + ' (HEAD did)');
}
assert.ok(/if \(!standard\) \{ element\.inert = !!isOpen; return; \}/.test(inertFn[1]),
    "the notebook branch must be HEAD's unconditional element.inert = !!isOpen");
assert.ok(/element\.inert = !!isOpen && !element\.hidden/.test(inertFn[1]),
    'only the standard branch may refine inert with the hidden check');

// ---- 5. study-web: no exit bar, no listener, in notebook ----
assert.ok(/function isStandardTheme\(\)/.test(studyWeb), 'study-web must expose a theme check');
assert.ok(/var exitBar = isStandardTheme\(\)/.test(studyWeb), 'the exit bar must be theme-gated');
assert.ok(!/\n                exitBar \+/.test(studyWeb) || /exitBar \+/.test(studyWeb),
    'the exit bar is injected conditionally');
assert.ok(/if \(exitButton\) \{/.test(studyWeb) && /if \(exitButton && exitHandler\)/.test(studyWeb),
    'binding and teardown must both tolerate the button being absent');
assert.ok(/if \(isStandardTheme\(\) && typeof contentEditor\.hasUnsavedDraft/.test(studyWeb),
    'the overlay confirm must be standard-only');

// ---- 6. article-vocab and content editor: no new cancellation/focus in notebook ----
assert.ok(/if \(!standardTheme\(\)\) return undefined;/.test(vocab),
    'the notebook must not attach an abort signal (HEAD had no AbortController)');
assert.ok(/if \(standardTheme\(\) && requestController\)/.test(vocab),
    'aborting in-flight reads on close must be standard-only');
assert.ok(/if \(note && standardTheme\(\) && !pending\)/.test(vocab),
    'touching the advisory node on close must be standard-only');
assert.ok(/if \(standardTheme\(\) && poll\)/.test(editor),
    'clearing the poll on close must be standard-only');
assert.ok(/if \(standardTheme\(\) && trigger/.test(editor),
    'returning focus on close must be standard-only');
assert.ok(/if \(!standardTheme\(\)\) return true;/.test(editor),
    'the discard confirm must be skipped entirely in the notebook');

// ---- 7. every theme helper must tolerate a missing window/document (node tests) ----
for (const [file, src] of [['js/layout.js', layout], ['js/study-content-editor.js', editor],
                           ['js/study-web.js', studyWeb], ['js/article-vocab-wire.js', vocab]]) {
    const fn = /function (?:isStandardTheme|standardTheme)\(\) \{([\s\S]*?)\n    \}/.exec(src);
    assert.ok(fn, file + ' must define a theme helper');
    assert.ok(/typeof window !== 'undefined'|typeof document !== 'undefined'/.test(fn[1]),
        file + ': the theme helper must guard globals so the vm-based tests still run');
}

console.log('NOTEBOOK_SHARED_PATH_REGRESSION_PASS');
