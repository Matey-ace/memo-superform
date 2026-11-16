'use strict';

// The standard settings panel moved from one long page to "category directory ->
// category detail". The panel markup is SHARED with the notebook theme, so the
// categories must be built at runtime by standard-only code rather than written
// into index.html — otherwise the notebook's long-page settings get dismantled.
const assert = require('assert');
const fs = require('fs');
const { execFileSync } = require('child_process');

const index = fs.readFileSync('index.html', 'utf8');
const nav = fs.readFileSync('js/standard-settings-nav.js', 'utf8');
const app = fs.readFileSync('js/app.js', 'utf8');
const css = fs.readFileSync('css/standard-settings.css', 'utf8');
const head = execFileSync('git', ['show', 'HEAD:index.html'], { encoding: 'utf8' });

// ---- 1. the settings panel markup must stay shared/untouched ----
// Everything from the panel opening tag to its closing tag must be byte-identical
// to HEAD, apart from the deliberate auth-state additions asserted below.
const panelOf = source => {
    const start = source.indexOf('<div id="settingsPanel"');
    const end = source.indexOf('<!-- 全屏模态框 -->');
    return source.slice(start, end);
};
const nowPanel = panelOf(index);
const headPanel = panelOf(head);
assert.ok(nowPanel.length > 1000, 'settings panel must exist');
// The only permitted difference: the auth state elements.
const stripAuth = text => text
    .replace(/\s*<button id="maimemoRetryBtn"[^>]*>重新检测<\/button>/, '')
    .replace(/\s*<p id="maimemoConnectReason"[^>]*><\/p>/, '')
    .replace(/ role="status" aria-live="polite"/g, '')
    // 只把“用 hidden 属性代替内联 display:none”视作等价改写。
    .replace(/\s+hidden(?=[ >])/g, '')
    .replace(/\s*style="display:\s*none"/g, '')
    .replace(/\s+/g, ' ');
assert.strictEqual(stripAuth(nowPanel), stripAuth(headPanel),
    'settings panel markup must stay identical to HEAD except the auth-state elements');

// ---- 2. no category markup is hard-coded into the shared HTML ----
assert.ok(!/data-settings-page=/.test(index), 'categorised pages must not be hard-coded in index.html');
assert.ok(!/class="settings-nav-item"/.test(index), 'category tabs must not be hard-coded in index.html');
assert.ok(!/class="settings-layout"/.test(index), 'the category layout must not be hard-coded in index.html');
assert.ok(!/settings-back/.test(index), 'the back entry must not be hard-coded in index.html');

// ---- 3. the seven categories exist in the standard-only builder ----
const CATEGORIES = [
    ['account', '账号与连接'],
    ['learning', '学习与进度'],
    ['companion', '角色与陪伴'],
    ['voice', '语音与音频'],
    ['ai', 'AI 与记忆'],
    ['appearance', '外观与窗口'],
    ['maintenance', '数据与维护'],
];
for (const [id, title] of CATEGORIES) {
    assert.ok(nav.includes("id: '" + id + "'"), 'missing category definition: ' + id);
    assert.ok(nav.includes("title: '" + title + "'"), 'category must use a plain-language name: ' + title);
    assert.ok(new RegExp("summary: '[^']+'").test(nav), 'each category needs a status summary: ' + id);
}

// ---- 4. every original setting group is claimed by exactly one category ----
const groupsInHead = (head.match(/<div class="setting-group[ "][^>]*>\s*<h3>([^<]+)<\/h3>/g) || [])
    .map(m => /<h3>([^<]+)<\/h3>/.exec(m)[1]);
assert.ok(groupsInHead.length >= 9, 'expected the original setting groups, found ' + groupsInHead.length);
for (const title of groupsInHead) {
    const occurrences = nav.split("'" + title + "'").length - 1;
    assert.strictEqual(occurrences, 1,
        'setting group "' + title + '" must be listed in exactly one category (found ' + occurrences + ')');
}

// ---- 5. grouping moves nodes instead of copying them ----
// 用 appendChild 搬运已存在的节点即为“移动”；关键是绝不能复制。
assert.ok(/page\.appendChild\(group\)/.test(nav), 'groups must be moved into the category page');
assert.ok(!/removeChild\(group\)/.test(nav),
    'moving with appendChild already detaches the node; a follow-up removeChild would delete it');
assert.ok(!/cloneNode/.test(nav), 'grouping must not clone settings (ids would duplicate)');
assert.ok(nav.includes('body.dataset.settingsSplit'), 'grouping must run at most once');
assert.ok(/missing\.length[\s\S]{0,400}return false/.test(nav),
    'an unrecognised setting group must abort grouping rather than drop the setting');

// ---- 6. switching only toggles visibility; it does not rebuild or re-fetch ----
assert.ok(nav.includes('page.hidden = !active'), 'switching must only toggle page visibility');
assert.ok(!/\bcreateElement\('section'\)[\s\S]{0,400}(setActive|click)/.test(nav),
    'switching must not create category DOM');
assert.ok(!/\bfetch\s*\(/.test(nav), 'opening/switching categories must not issue requests');
assert.ok(!/setInterval/.test(nav), 'category switching must not create polling');
assert.ok(nav.includes('settingsNavReady'), 'navigation must guard against re-binding handlers');

// ---- 7. the notebook theme is excluded before anything runs ----
const earlyReturn = nav.indexOf('if (style.isNotebook) return;');
assert.ok(earlyReturn > 0 && earlyReturn < nav.indexOf('function buildCategories'),
    'the notebook theme must opt out before any DOM work');
assert.ok(nav.includes('if (style.isNotebook) return;'), 'init must also re-check the theme');

// ---- 8. unsaved edits are protected ----
assert.ok(nav.includes('function hasUnsavedChanges'), 'missing unsaved-change detection');
assert.ok(nav.includes('function confirmLeave'), 'missing leave confirmation');
assert.ok(nav.includes("confirmLeave('切换分类')"), 'switching categories must confirm when a draft exists');
assert.ok(nav.includes("confirmLeave('返回分类目录')"), 'returning to the directory must confirm when a draft exists');
assert.ok(app.includes('MemoSettingsNav.confirmLeave'),
    'closing the settings panel must also guard unsaved edits');

// ---- 9. detail pages have a title and a way back ----
assert.ok(nav.includes('settings-page-title'), 'each category needs a visible title');
assert.ok(nav.includes('data-settings-back'), 'each category needs a back-to-directory entry');
assert.ok(nav.includes('全部设置'), 'the back entry must be labelled for users');
assert.ok(/@media \(max-width: 900px\)/.test(css), 'narrow windows need the two-page layout');
assert.ok(/settings-layout\.is-detail \.settings-nav \{ display: none/.test(css),
    'narrow windows must show either the directory or a detail page, not both');

// ---- 10. the save button keeps its original semantics ----
assert.ok(index.includes('id="saveSettingsBtn"'), 'explicit save must remain available');
assert.ok(app.includes("document.getElementById('saveSettingsBtn').addEventListener"),
    'save handler must stay bound');

// ---- 11. every original setting id survives ----
const REQUIRED = [
    'uiStyleSelect', 'maimemoAccountStatus', 'maimemoConnectBtn', 'maimemoReconnectBtn',
    'maimemoDisconnectBtn', 'maimemoManualToken', 'maimemoManualSaveBtn', 'maimemoDeleteDataBtn',
    'aiProviderSelect', 'aiEndpointInput', 'aiKeyInput', 'aiModelInput',
    'codexAuthBox', 'codexLoginBtn', 'codexLogoutBtn', 'codexStatus',
    'companionLanguageSelect', 'companionReminderEnabled', 'companionReminderMinutes',
    'studySyncStatus', 'studySyncMeta', 'studySyncCoverage', 'runReconcileBtn',
    'cancelStudySyncBtn', 'clearCacheBtn',
    'currentModeText', 'defaultModeSelect', 'setDefaultModeBtn', 'relaunchModeBtn', 'modeStatus',
    'appUpdateCurrentVersion', 'appUpdateStatus', 'appUpdateCheckBtn', 'appUpdateInstallBtn', 'appUpdateHint',
    'ttsStatusText', 'ttsVoiceSelect', 'ttsRoleNewBtn', 'ttsRoleEditBtn', 'ttsRoleActivateBtn',
    'ttsRoleDeleteBtn', 'ttsRoleEditor', 'ttsAutoRead', 'ttsCompanionRead', 'ttsEnableBtn',
    'ttsSpeedRange', 'ttsFragRange', 'ttsTopK', 'ttsSplitSelect', 'ttsSeed',
    'ttsCudaGraph', 'ttsParallelInfer',
    'live2dCatalogSearch', 'live2dCatalogRefreshBtn', 'live2dImportPath', 'live2dImportBtn',
    'live2dInstalledModels',
    'saveSettingsBtn', 'settingsTitle', 'closeSettings', 'settingsPanel',
];
for (const id of REQUIRED) {
    const count = (index.match(new RegExp('id="' + id + '"', 'g')) || []).length;
    assert.strictEqual(count, 1, 'setting ' + id + ' must exist exactly once (found ' + count + ')');
}

// ---- 12. standard CSS must not target the notebook theme ----
assert.ok(!/data-ui-style="notebook"/.test(css), 'standard settings CSS must not target the notebook theme');
assert.ok(index.includes('js/standard-settings-nav.js'), 'the module must be loaded');

// ---- 13. the unsaved-changes net must cover every field the save handler writes ----
// app.js writes provider into the config; if SAVE_FIELDS misses it, switching away
// silently drops the change.
const saveBlock = /provider: document\.getElementById\('aiProviderSelect'\)\.value/.test(app);
assert.ok(saveBlock, 'the save handler is expected to persist aiProviderSelect');
assert.ok(/SAVE_FIELDS = \[[^\]]*'aiProviderSelect'/.test(nav),
    'aiProviderSelect must be guarded by the unsaved-changes check, otherwise the change is dropped silently');
for (const id of ['aiEndpointInput', 'aiKeyInput', 'aiModelInput']) {
    assert.ok(new RegExp("'" + id + "'").test(nav), id + ' must stay guarded');
}
assert.ok(/uiStyleSelect/.test(nav) && /defaultModeSelect/.test(nav),
    'the instant/save-required fields must stay guarded');

// ---- 14. a value filled in by an async request must not read as "user edited" ----
assert.ok(/dirtyFields\[id\] = true/.test(nav),
    'dirtiness must be driven by user input events, not by comparing against a baseline captured before async fill');
assert.ok(/var dirtyFields = \{\};/.test(nav), 'there must be a dirty-field set');
assert.ok(/captureBaseline[\s\S]{0,200}dirtyFields = \{\}/.test(nav),
    'capturing a new baseline must also clear the dirty set');
assert.ok(/node\.addEventListener\(type, function \(\) \{ dirtyFields\[id\] = true; \}\)/.test(nav),
    'only real input/change events may mark a field dirty (programmatic assignment must not)');

// ---- 15. reopening the panel must always land on the directory ----
assert.ok(/function resetToDirectory/.test(nav), 'the module must be able to reset to the directory');
assert.ok(/resetToDirectory\(\);/.test(nav), 'opening the panel must reset to the directory');
assert.ok(/'settingsBtn', 'welcomeSettingsBtn'[\s\S]{0,400}resetToDirectory/.test(nav),
    'every entry point that opens settings must reset to the directory (narrow windows otherwise reopen on the last detail page)');

// ---- 16. focus must not fall to body when the directory is hidden ----
assert.ok(/\.settings-page-title/.test(nav) && /tabindex/.test(nav),
    'entering a detail page in a narrow window must move focus to the page title');

// ---- 17. directory summaries reflect real state ----
assert.ok(/setSummary\('account'/.test(nav), 'the account summary must be driven by real connection state');
assert.ok(/function syncAccountSummary/.test(nav), 'there must be a summary sync function');
assert.ok(/data-state/.test(nav) && /setAttribute\('data-state'/.test(nav),
    'summaries must use the data-state attribute the CSS styles');
assert.ok(!/classList\.add\(level\)/.test(nav),
    'summaries must not use bare classes the CSS does not style');
assert.ok(/memo-account-changed[\s\S]{0,120}syncAccountSummary/.test(nav),
    'account changes must refresh the directory summary');

console.log('STANDARD_SETTINGS_NAV_REGRESSION_PASS');
