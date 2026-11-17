'use strict';

// Anon 的笔记本设置从一张长页改成"分类目录 → 分类详情"。这是对笔记本冻结策略的
// 局部解除（仅设置区），所以必须把边界钉死：
//   · 分类结构在运行时构建，不写进共享的 index.html；
//   · 两版导航互斥，各自早退，不互相覆盖；
//   · 只搬运原设置节点，不克隆、不重建、不复制 id；
//   · 笔记本样式只作用于设置区，不泄漏到首页/图表/学习页。
const assert = require('assert');
const fs = require('fs');
const { execFileSync } = require('child_process');

// 源码是 CRLF，正则里写的 \n 匹配不到；先归一化行尾。
const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const index = read('index.html');
const notebookNav = read('js/notebook-settings-nav.js');
const standardNav = read('js/standard-settings-nav.js');
const notebookCss = read('css/notebook-settings.css');
const uiStyle = read('js/ui-style.js');

// ---- 1. 两版导航互斥：各自在对方的主题下早退 ----
assert.ok(/if \(style\.isNotebook\) return;/.test(standardNav),
    'standard nav must still bail out on the notebook theme');
assert.ok(/if \(!style\.isNotebook\)\s*return;/.test(notebookNav) ||
    /if \(!\s*window\.MemoUIStyle\.isNotebook\)\s*return;/.test(notebookNav),
    'notebook nav must bail out unless the notebook theme is active');
// 早退必须发生在任何 DOM 操作和全局导出之前（注释里的字样不算，只看真实语句）
const nbBail = notebookNav.search(/if \(!style\.isNotebook\)\s*return;|if \(!\s*window\.MemoUIStyle\.isNotebook\)\s*return;/);
const nbFirstDom = notebookNav.search(/document\.(querySelector|createElement|getElementById)/);
assert.ok(nbBail >= 0, 'notebook nav must have an explicit theme guard');
if (nbFirstDom >= 0) {
    assert.ok(nbBail < nbFirstDom, 'the notebook theme guard must run before any DOM access');
}

// ---- 2. 分类结构不能写进共享 HTML ----
assert.ok(!/data-settings-page=/.test(index), 'category markup must not be written into shared index.html');
assert.ok(!/settings-nav-item/.test(index), 'category tabs must not be written into shared index.html');

// ---- 3. 只搬运节点，不克隆、不重建 ----
assert.ok(/appendChild\(group\)/.test(notebookNav), 'the notebook must move the original setting groups');
assert.ok(!/cloneNode/.test(notebookNav), 'the notebook must not clone setting groups');
assert.ok(!/removeChild\(group\)/.test(notebookNav),
    'must not "clean up" moved groups — after appendChild their parent is the category page');
// 不允许用 innerHTML 重建设置内容
assert.ok(!/innerHTML\s*=\s*[^;]*setting-group/.test(notebookNav),
    'the notebook must not rebuild settings via innerHTML');

// ---- 4. 分类映射：原有每个设置组恰好归属一次，不遗漏不重复 ----
const GROUP_TITLES = ['界面风格', '墨墨账号', 'AI API 配置（可选）', '陪伴模式', '数据更新',
    '运行模式', '软件更新', '语音功能（GPT-SoVITS 资源包）', 'Live2D 模型库'];
// 这些组必须真的出现在 index.html 里（分组是按标题文字识别的）
for (const title of GROUP_TITLES) {
    assert.ok(index.includes('>' + title + '<') || index.includes(title),
        'setting group "' + title + '" must still exist in index.html');
    const occurrences = (notebookNav.match(new RegExp(title.replace(/[（）]/g, m => m), 'g')) || []).length;
    assert.ok(occurrences >= 1, 'group "' + title + '" must be claimed by a notebook category');
}
// 每个组标题在 CATEGORIES 里出现且仅出现一次
for (const title of GROUP_TITLES) {
    const quoted = "'" + title + "'";
    const count = notebookNav.split(quoted).length - 1;
    assert.strictEqual(count, 1, 'group "' + title + '" must appear exactly once in the category map (found ' + count + ')');
}

// ---- 5. 独立浏览状态键，不覆盖普通版偏好 ----
assert.ok(/memo_notebook_settings_last_category/.test(notebookNav),
    'the notebook must use its own last-category key');
assert.ok(!/localStorage\.setItem\(\s*'memo_settings_last_category'/.test(notebookNav),
    'the notebook must not write the standard theme\'s last-category key');
assert.ok(/memo_settings_last_category/.test(standardNav),
    'the standard nav keeps its own key');

// ---- 6. 未保存保护覆盖 app.js 实际保存的字段 ----
const app = read('js/app.js');
for (const id of ['aiProviderSelect', 'aiEndpointInput', 'aiKeyInput', 'aiModelInput',
                  'uiStyleSelect', 'defaultModeSelect']) {
    assert.ok(app.includes(id), 'app.js is expected to reference ' + id);
    assert.ok(notebookNav.includes(id),
        'the notebook unsaved-changes guard must cover ' + id);
}
// AIAPI 是顶层 const，不挂在 window 上；写成 window.AIAPI 会恒为假。
// 注释里为了说明这个坑会提到它，所以先去掉行注释再检查真实代码。
const nbCode = notebookNav.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
assert.ok(!/window\.AIAPI/.test(nbCode),
    'AIAPI is a top-level const, not on window — comparing via window.AIAPI is always false');
assert.ok(/typeof AIAPI !== 'undefined'/.test(notebookNav),
    'the notebook must read AIAPI through typeof');
// 只用用户事件置脏，程序回填不算
assert.ok(/'input'/.test(notebookNav) && /'change'/.test(notebookNav),
    'dirty tracking must listen to user input/change events');
assert.ok(/dataset\./.test(notebookNav), 'dirty watchers must be marked to avoid duplicate binding');

// ---- 7. 生命周期接口与普通版一致，app.js 不需要感知主题 ----
for (const method of ['markSaved', 'prepareOpen', 'confirmLeave', 'resetToDirectory',
                      'hasUnsavedChanges', 'setSummary', 'syncAccountSummary']) {
    assert.ok(new RegExp(method).test(notebookNav),
        'the notebook nav must expose ' + method + ' like the standard one');
}
// app.js 通过 window.MemoSettingsNav 调用，两版各自定义、互斥
assert.ok(/window\.MemoSettingsNav\s*=/.test(standardNav), 'standard nav defines MemoSettingsNav');
assert.ok(/window\.MemoSettingsNav\s*=/.test(notebookNav), 'notebook nav defines MemoSettingsNav');
// 定义必须在早退之后（否则笔记本会拿到两个互相覆盖的定义）
const nbExport = notebookNav.search(/window\.MemoSettingsNav\s*=/);
assert.ok(nbBail >= 0 && nbExport > nbBail,
    'the notebook must only define MemoSettingsNav after its theme guard');

// ---- 8. 笔记本样式只作用于设置区 ----
assert.ok(/html\[data-ui-style="notebook"\]/.test(notebookCss),
    'notebook settings styles must be scoped to the notebook theme');
// 不允许出现会命中首页/图表/学习页的全局规则
const globalRules = notebookCss.split('\n').filter(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('@')) return false;
    return /^\s*[.#a-zA-Z]/.test(trimmed) && !/settings|notebook-settings|palette/.test(trimmed) &&
        !trimmed.startsWith('}') && !trimmed.startsWith(':') && trimmed.includes('{');
});
assert.strictEqual(globalRules.length, 0,
    'notebook settings CSS must not style anything outside the settings area: ' + globalRules.slice(0, 3).join(' | '));

// ---- 9. 笔记本样式表只在笔记本分支加载 ----
assert.ok(/css\/notebook-settings\.css/.test(uiStyle), 'the notebook CSS must be loaded by ui-style.js');
const nbBranch = uiStyle.indexOf('if (notebook) {');
const elseBranch = uiStyle.indexOf('} else {');
const nbCssPos = uiStyle.indexOf('css/notebook-settings.css');
assert.ok(nbBranch >= 0 && nbCssPos > nbBranch && (elseBranch < 0 || nbCssPos < elseBranch),
    'the notebook CSS must be loaded inside the notebook branch only');

// ---- 10. 模块必须被页面加载 ----
assert.ok(/js\/notebook-settings-nav\.js/.test(index), 'the notebook nav module must be loaded');

console.log('NOTEBOOK_SETTINGS_NAV_REGRESSION_PASS');
