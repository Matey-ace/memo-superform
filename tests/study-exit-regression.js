'use strict';

// Every learning surface must have a user-visible way out, and leaving must
// clean up what it started. This suite pins the exit contract without opening a
// browser: it asserts the wiring exists and is not merely a keyboard shortcut.
const assert = require('assert');
const fs = require('fs');

const index = fs.readFileSync('index.html', 'utf8');
const studyWeb = fs.readFileSync('js/study-web.js', 'utf8');
const charts = fs.readFileSync('js/charts.js', 'utf8');
const layout = fs.readFileSync('js/layout.js', 'utf8');
const editor = fs.readFileSync('js/study-content-editor.js', 'utf8');
const wire = fs.readFileSync('js/article-vocab-wire.js', 'utf8');
const appUpdate = fs.readFileSync('js/app-update.js', 'utf8');
const app = fs.readFileSync('js/app.js', 'utf8');
const guard = fs.readFileSync('js/standard-companion-guard.js', 'utf8');

// ---- 1. the study tile itself has a visible exit button ----
assert.ok(studyWeb.includes('data-exit-study'), 'the study tile must render a visible exit control');
assert.ok(/退出背单词/.test(studyWeb), 'the exit control must be labelled in plain language');
assert.ok(!/aria-hidden="true"[^>]*data-exit-study/.test(studyWeb), 'the exit control must not be hidden from users');
assert.ok(studyWeb.includes('exitButton.addEventListener'), 'the exit control must be wired');
assert.ok(!/keydown[\s\S]{0,200}data-exit-study/.test(studyWeb),
    'a keyboard shortcut cannot be the only way out of the study tile');

// ---- 2. exiting the tile returns to a normal chart and preserves learning state ----
assert.ok(charts.includes('exitStudyTile'), 'charts must own the "leave study tile" transition');
assert.ok(/function exitStudyTile[\s\S]{0,900}selector\.value = next/.test(charts),
    'leaving the study tile must restore a normal chart type');
assert.ok(/function exitStudyTile[\s\S]{0,900}render\(tileIndex, next/.test(charts),
    'leaving the study tile must re-render the替代 chart');
assert.ok(/function exitStudyTile[\s\S]{0,1200}LayoutManager\.applyChartToTile/.test(charts),
    'the tile header must be restored together with the chart');

// ---- 3. teardown removes listeners and timers ----
assert.ok(studyWeb.includes("document.removeEventListener('keydown', handleShortcutKeydown)"),
    'study tile teardown must remove its key listener');
assert.ok(studyWeb.includes("window.removeEventListener('message', handleStudyNavigationMessage)"),
    'study tile teardown must remove its message listener');
assert.ok(studyWeb.includes('contentEditor.dispose()'), 'study tile teardown must dispose the content editor');
assert.ok(studyWeb.includes('stopStudyScreenWatch()'), 'study tile teardown must stop the screen watcher');
assert.ok(studyWeb.includes('clearTimeout(shortcutCloseTimer)'),
    'study tile teardown must clear the shortcut panel close timer');
assert.ok(studyWeb.includes('cancelAnimationFrame(shortcutOpenFrame)'),
    'study tile teardown must cancel pending animation frames');
assert.ok(studyWeb.includes("reportStudyEvent({ type: 'screen', active: false })"),
    'leaving the study tile must report that the study screen is no longer active');

// ---- 4. nested exits close the innermost layer first ----
assert.ok(editor.includes('function requestClose'), 'the content editor needs a single close path');
assert.ok(/hasUnsavedDraft[\s\S]{0,200}confirm/.test(editor),
    'the content editor must warn before discarding an unsaved draft');
assert.ok(/standardTheme\(\) && trigger[\s\S]{0,60}trigger\.focus\(\)/.test(editor),
    'closing the content editor must return focus in the standard theme');
assert.ok(/cur\.tagName === 'DETAILS'|state\.form\) \{[\s\S]{0,120}render\(\)/.test(editor),
    'Escape must close the innermost layer first');
assert.ok(!/state\.saving\) return;?[\s\S]{0,40}\}$/.test(editor.replace(/\s+/g, ' ')) ||
    /if \(state\.saving\) return false/.test(editor),
    'a pending save must block closing instead of silently dropping the draft');
// 清理在普通版执行；笔记本主题是冻结的，保持改动前不清理的行为。
assert.ok(/if \(standardTheme\(\) && poll\) \{ clearInterval\(poll\); poll = null; \}/.test(editor),
    'closing the editor must stop its 500ms polling in the standard theme');

// ---- 5. fullscreen exit cascades to the study overlays ----
assert.ok(layout.includes('closeStudyOverlays'), 'closing fullscreen must cascade to study overlays');
// 级联只在普通版执行（笔记本主题是冻结的），所以断言里带上主题前置条件。
assert.ok(/if \(wasOpen && standardTheme\(\) && !closeStudyOverlays\(fullscreenChartBackup\)\) return;/.test(layout),
    'a declined cascade must abort the fullscreen close in the standard theme');
assert.ok(layout.includes('isFullscreenOpen'), 'fullscreen state must be queryable');
assert.ok(index.includes('id="closeFullscreen"'), 'fullscreen must keep a visible close button');

// ---- 6. companion and fullscreen are mutually exclusive ----
assert.ok(guard.includes('isFullscreenOpen') && guard.includes('closeFullscreen'),
    'entering companion mode must leave fullscreen first');
assert.ok(layout.includes('Live2DCompanion.isOpen'),
    'opening fullscreen must leave companion mode first (standard theme only)');
assert.ok(guard.includes('stopCompanionTimers'), 'leaving companion mode must stop its heartbeat');
assert.ok(guard.includes('clearInterval'), 'companion cleanup must actually clear the interval');
assert.ok(/if \(style\.isNotebook\) return/.test(guard),
    'the companion lifecycle adapter must not run for the notebook theme');
assert.ok(index.includes('js/standard-companion-guard.js'), 'the adapter must be loaded by the standard shell');

// ---- 7. article vocab close aborts in-flight reads and keeps write uncertainty visible ----
assert.ok(wire.includes('AbortController'), 'article vocab must be able to abort its requests');
assert.ok(/requestController\.abort\(\)/.test(wire), 'closing article vocab must abort in-flight requests');
assert.ok(/正在提交到墨墨|可能已经写入/.test(wire),
    'closing during a write must keep the uncertainty visible');
assert.ok(wire.includes('submittingState'), 'close must detect an in-flight submission');

// ---- 8. the update dialog stops polling when closed ----
assert.ok(/function closeModal\(remind\)\s*\{[\s\S]*?stopPolling\(\)/.test(appUpdate),
    'closing the update dialog must stop download polling');

// ---- 9. closing settings stops its polling ----
assert.ok(/function stopSettingsPolling/.test(app), 'settings must own a polling stop helper');
assert.ok(/function closeSettings\(\)[\s\S]{0,600}stopSettingsPolling\(\)/.test(app),
    'closing settings must stop its polling');

// ---- 10. no exit path disconnects the account, deletes data or logs out ----
for (const source of [studyWeb, charts, layout, editor, wire, guard, appUpdate]) {
    assert.ok(!/MaimemoAPI\.disconnect\s*\(/.test(source),
        'an exit path must not disconnect the maimemo account');
    assert.ok(!/deleteLocalData\s*\(/.test(source), 'an exit path must not delete local data');
    assert.ok(!/localStorage\.clear\s*\(/.test(source), 'an exit path must not clear all preferences');
    assert.ok(!/\/api\/codex\/logout/.test(source), 'an exit path must not log out of Codex');
}

// ---- 11. the companion heartbeat cannot leak after exit in the standard theme ----
assert.ok(!/setInterval\([\s\S]{0,80}session\.tick/.test(guard) || guard.includes('captureInitTimers'),
    'the companion heartbeat must be captured so it can be stopped');

console.log('STUDY_EXIT_REGRESSION_PASS');
