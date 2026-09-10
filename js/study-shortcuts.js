// Memo Superform - 学习快捷键的持久化、渲染与分发。
const StudyShortcuts = (function() {
    function defaultShortcuts() { return {
        SHOW_ANSWER: { key: 'S', modifiers: [], enabled: true }, PREVIOUS_WORD: { key: 'Backspace', modifiers: [], enabled: true },
        FAMILIAR: { key: '1', modifiers: [], enabled: true }, VAGUE: { key: '2', modifiers: [], enabled: true }, FORGET: { key: '3', modifiers: [], enabled: true }, WELL_FAMILIAR: { key: '4', modifiers: [], enabled: true },
        PLAY_AUDIO: { key: 'P', modifiers: ['Alt'], enabled: false }, START_SPELLING: { key: 'Space', modifiers: [], enabled: true }, EXIT_SPELLING: { key: 'Escape', modifiers: [], enabled: true }, CLEAR_INPUT: { key: 'Enter', modifiers: [], enabled: true },
        TTS_PHRASE_1: { key: '1', modifiers: ['Alt'], enabled: false }, TTS_PHRASE_2: { key: '2', modifiers: ['Alt'], enabled: false }, TTS_PHRASE_3: { key: '3', modifiers: ['Alt'], enabled: false }, SEARCH: { key: 'S', modifiers: ['Alt'], enabled: false }
    }; }
    function loadShortcuts() {
        var defaults = defaultShortcuts(), saved = {};
        try { saved = JSON.parse(localStorage.getItem('shortcut_settings') || '{}').shortcuts || {}; } catch(e) {}
        try {
            var legacy = JSON.parse(localStorage.getItem('memo_study_shortcuts') || '{}');
            var legacyActions = { know: 'FAMILIAR', vague: 'VAGUE', forget: 'FORGET', well: 'WELL_FAMILIAR' };
            Object.keys(legacyActions).forEach(function(key) { if (legacy[key] && !saved[legacyActions[key]]) saved[legacyActions[key]] = { key: legacy[key], modifiers: [], enabled: true }; });
        } catch(e) {}
        Object.keys(saved).forEach(function(action) { if (defaults[action] && saved[action] && typeof saved[action] === 'object') defaults[action] = Object.assign({}, defaults[action], saved[action], { key: normaliseKey(saved[action].key == null ? defaults[action].key : saved[action].key) }); });
        return defaults;
    }
    function saveShortcuts(map) {
        var settings = {};
        try { settings = JSON.parse(localStorage.getItem('shortcut_settings') || '{}') || {}; } catch(e) {}
        var shortcuts = {};
        Object.keys(map).forEach(function(action) {
            var shortcut = Object.assign({}, map[action], { action: action });
            if (/^[A-Z]$/.test(shortcut.key) && !(shortcut.modifiers || []).includes('Shift'))
                shortcut.key = shortcut.key.toLowerCase();
            shortcuts[action] = shortcut;
        });
        localStorage.setItem('shortcut_settings', JSON.stringify(Object.assign({}, settings, { version: 1, shortcuts: shortcuts })));
    }
    function actionForDefault(key) { return ({'1':'FAMILIAR','2':'VAGUE','3':'FORGET','4':'WELL_FAMILIAR'})[key]; }
    function shortcutGroups() { return [
        ['判断', ['FAMILIAR','VAGUE','FORGET','WELL_FAMILIAR']],
        ['拼写与浏览', ['START_SPELLING','SHOW_ANSWER','PREVIOUS_WORD','EXIT_SPELLING','CLEAR_INPUT']],
        ['辅助功能', ['PLAY_AUDIO','TTS_PHRASE_1','TTS_PHRASE_2','TTS_PHRASE_3','SEARCH']]
    ]; }
    function shortcutNames() { return { FAMILIAR:'认识', VAGUE:'模糊', FORGET:'忘记', WELL_FAMILIAR:'熟知', START_SPELLING:'开始手写', SHOW_ANSWER:'跳过手写 / 显示答案', PREVIOUS_WORD:'上一个单词', EXIT_SPELLING:'退出手写', CLEAR_INPUT:'清空输入', PLAY_AUDIO:'播放发音', TTS_PHRASE_1:'朗读例句 1', TTS_PHRASE_2:'朗读例句 2', TTS_PHRASE_3:'朗读例句 3', SEARCH:'搜索单词' }; }
    function buildShortcutFields(map) { var names = shortcutNames(); return shortcutGroups().map(function(group) { return '<div class="study-shortcut-group"><span>' + group[0] + '</span>' + group[1].map(function(action) { return '<label><span class="shortcut-action-name">' + names[action] + (map[action].enabled === false ? '（未启用）' : '') + '</span><input readonly data-shortcut="' + action + '" value="' + formatShortcut(map[action]) + '" aria-label="修改' + names[action] + '快捷键"></label>'; }).join('') + '</div>'; }).join(''); }
    function eventModifiers(e) { var result=[]; if(e.ctrlKey) result.push('Control'); if(e.altKey) result.push('Alt'); if(e.shiftKey) result.push('Shift'); if(e.metaKey) result.push('Meta'); return result; }
    function normaliseKey(key) { return key === ' ' || key === 'Spacebar' ? 'Space' : typeof key === 'string' && key.length === 1 ? key.toUpperCase() : (key || ''); }
    function formatShortcut(shortcut) { if (!shortcut || !shortcut.key) return '未设置'; var labels = { Control:'Ctrl', Alt:'Alt', Shift:'Shift', Meta:'Cmd', Space:'空格', Escape:'Esc' }; return (shortcut.modifiers || []).concat([shortcut.key]).map(function(key) { return labels[key] || key; }).join(' + '); }
    function findShortcutAction(map, e) { if (e.isComposing || e.keyCode === 229) return; var key=normaliseKey(e.key); return Object.keys(map).find(function(action) { var shortcut=map[action], modifiers=shortcut.modifiers || []; return shortcut.enabled !== false && normaliseKey(shortcut.key) === key && e.altKey === modifiers.includes('Alt') && e.ctrlKey === modifiers.includes('Control') && e.shiftKey === modifiers.includes('Shift') && e.metaKey === modifiers.includes('Meta'); }); }
    function updateShortcutLabels(container, map) {
        container.querySelectorAll('.study-web-btn').forEach(function(btn) {
            var action = actionForDefault(btn.getAttribute('data-key')); btn.setAttribute('data-action', action);
            var hint = btn.querySelector('.key-hint'); if (hint) hint.textContent = formatShortcut(map[action]);
            btn.title = '快捷键 ' + formatShortcut(map[action]) + '：' + shortcutNames()[action];
        });
    }

    function isEditable(target) {
        return !!(target && (target.isContentEditable || (target.closest &&
            target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))));
    }

    // The upstream START_SPELLING handler seeds its input with event.key.
    // Invoke the existing spelling button instead, so a shortcut never becomes an answer.
    function installSpellingGuard(win) {
        var doc = win.document;
        var held = null;
        function handle(event) {
            var identity = event.code || normaliseKey(event.key);
            if (held === identity) {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (event.type === 'keyup') held = null;
                return;
            }
            if (isEditable(event.target)) {
                // Upstream global keyup shortcuts also run inside search/spelling inputs.
                // Keep text (including phrase spaces) local, while retaining explicit edit commands.
                var action = findShortcutAction(loadShortcuts(), event);
                var spelling = event.target.closest && event.target.closest('.verify-input');
                if (event.type === 'keyup' && event.target.closest && event.target.closest('.rev-root') &&
                    !(spelling && ['EXIT_SPELLING', 'CLEAR_INPUT'].includes(action))) event.stopImmediatePropagation();
                return;
            }
            if (event.type !== 'keydown' || event.isComposing || event.keyCode === 229) return;
            var allPages = Array.from(doc.querySelectorAll('.taro_page'));
            var pages = allPages.filter(function(page) {
                if (!page.classList.contains('taro_page_show')) return false;
                var style = win.getComputedStyle(page);
                return !page.classList.contains('taro_page_shade') && style.display !== 'none' && style.visibility !== 'hidden';
            });
            if (allPages.length && !pages.length) return;
            var scope = pages.length ? pages[pages.length - 1] : doc;
            var button = scope.querySelector('.rev-root .ask-spelling .reset-button');
            if (!button || !button.getClientRects().length || button.disabled) return;
            if (event.target && event.target.closest && event.target.closest('button, a[href], [role="button"]') && !button.contains(event.target)) return;
            var style = win.getComputedStyle(button);
            if (style.visibility === 'hidden' || style.display === 'none') return;
            if (findShortcutAction(loadShortcuts(), event) !== 'START_SPELLING') return;
            event.preventDefault();
            event.stopImmediatePropagation();
            held = identity;
            if (!event.repeat) button.click();
        }
        function reset() { held = null; }
        doc.addEventListener('keydown', handle, true);
        doc.addEventListener('keyup', handle, true);
        win.addEventListener('blur', reset);
        return function() {
            doc.removeEventListener('keydown', handle, true);
            doc.removeEventListener('keyup', handle, true);
            win.removeEventListener('blur', reset);
        };
    }

    // Dispatch once from body: bubbling reaches both document and window listeners.
    function sendKey(iframe, shortcut) {
        try {
            if (!iframe || !iframe.contentWindow || !iframe.contentDocument) return false;
            var win = iframe.contentWindow;
            var doc = iframe.contentDocument;
            var key = shortcut && shortcut.key != null ? shortcut.key : shortcut;
            var modifiers = shortcut && shortcut.modifiers ? shortcut.modifiers : [];
            key = normaliseKey(key);
            if (!key) return false;
            var code = key;
            var keyCode = ({ Space: 32, Enter: 13, Escape: 27, Backspace: 8, Tab: 9, Delete: 46 })[key] || 0;
            if (/^[A-Z0-9]$/.test(key)) {
                code = /[0-9]/.test(key) ? 'Digit' + key : 'Key' + key;
                keyCode = key.charCodeAt(0);
                if (!modifiers.includes('Shift')) key = key.toLowerCase();
            } else if (key === 'Space') key = ' ';
            var options = {
                key: key, code: code, keyCode: keyCode, which: keyCode,
                altKey: modifiers.includes('Alt'), ctrlKey: modifiers.includes('Control'),
                shiftKey: modifiers.includes('Shift'), metaKey: modifiers.includes('Meta'),
                bubbles: true, cancelable: true
            };
            var target = doc.body || doc;
            target.dispatchEvent(new win.KeyboardEvent('keydown', options));
            target.dispatchEvent(new win.KeyboardEvent('keyup', options));
            return true;
        } catch (error) {
            console.warn('sendKey error:', error);
            return false;
        }
    }

    return { defaultShortcuts, loadShortcuts, saveShortcuts, actionForDefault, shortcutNames,
        buildShortcutFields, eventModifiers, normaliseKey, formatShortcut, findShortcutAction,
        updateShortcutLabels, isEditable, installSpellingGuard, sendKey };
})();
