// Memo Superform - study shortcut persistence, rendering and dispatch.
const StudyShortcuts = (function() {
    function defaultShortcuts() { return {
        SHOW_ANSWER: { key: 'S', modifiers: [], enabled: true }, PREVIOUS_WORD: { key: 'Backspace', modifiers: [], enabled: true },
        FAMILIAR: { key: '1', modifiers: [], enabled: true }, VAGUE: { key: '2', modifiers: [], enabled: true }, FORGET: { key: '3', modifiers: [], enabled: true }, WELL_FAMILIAR: { key: '4', modifiers: [], enabled: true },
        PLAY_AUDIO: { key: 'P', modifiers: ['Alt'], enabled: false }, START_SPELLING: { key: 'Space', modifiers: [], enabled: true }, EXIT_SPELLING: { key: 'Escape', modifiers: [], enabled: false }, CLEAR_INPUT: { key: 'Enter', modifiers: [], enabled: false },
        TTS_PHRASE_1: { key: '1', modifiers: ['Alt'], enabled: false }, TTS_PHRASE_2: { key: '2', modifiers: ['Alt'], enabled: false }, TTS_PHRASE_3: { key: '3', modifiers: ['Alt'], enabled: false }, SEARCH: { key: 'S', modifiers: ['Alt'], enabled: false }
    }; }
    function loadShortcuts() {
        var defaults = defaultShortcuts(), saved = {};
        try { saved = JSON.parse(localStorage.getItem('shortcut_settings') || '{}').shortcuts || {}; } catch(e) {}
        try {
            var legacy = JSON.parse(localStorage.getItem('memo_study_shortcuts') || '{}');
            var legacyActions = { know: 'FAMILIAR', vague: 'VAGUE', forget: 'FORGET', well: 'WELL_FAMILIAR' };
            Object.keys(legacyActions).forEach(function(key) { if (legacy[key]) saved[legacyActions[key]] = { key: legacy[key], modifiers: [], enabled: true }; });
        } catch(e) {}
        Object.keys(saved).forEach(function(action) { if (defaults[action]) defaults[action] = Object.assign({}, defaults[action], saved[action]); });
        return defaults;
    }
    function saveShortcuts(map) { localStorage.setItem('shortcut_settings', JSON.stringify({ version: 1, shortcuts: map, enabled: true })); }
    function actionForDefault(key) { return ({'1':'FAMILIAR','2':'VAGUE','3':'FORGET','4':'WELL_FAMILIAR'})[key]; }
    function shortcutGroups() { return [
        ['判断', ['FAMILIAR','VAGUE','FORGET','WELL_FAMILIAR']],
        ['拼写与浏览', ['START_SPELLING','SHOW_ANSWER','PREVIOUS_WORD','EXIT_SPELLING','CLEAR_INPUT']],
        ['辅助功能', ['PLAY_AUDIO','TTS_PHRASE_1','TTS_PHRASE_2','TTS_PHRASE_3','SEARCH']]
    ]; }
    function shortcutNames() { return { FAMILIAR:'认识', VAGUE:'模糊', FORGET:'忘记', WELL_FAMILIAR:'熟知', START_SPELLING:'开始手写', SHOW_ANSWER:'跳过手写 / 显示答案', PREVIOUS_WORD:'上一个单词', EXIT_SPELLING:'退出手写', CLEAR_INPUT:'清空输入', PLAY_AUDIO:'播放发音', TTS_PHRASE_1:'朗读例句 1', TTS_PHRASE_2:'朗读例句 2', TTS_PHRASE_3:'朗读例句 3', SEARCH:'搜索单词' }; }
    function buildShortcutFields(map) { var names = shortcutNames(); return shortcutGroups().map(function(group) { return '<div class="study-shortcut-group"><span>' + group[0] + '</span>' + group[1].map(function(action) { return '<label><span class="shortcut-action-name">' + names[action] + (map[action].enabled === false ? '（未启用）' : '') + '</span><input readonly data-shortcut="' + action + '" value="' + formatShortcut(map[action]) + '" aria-label="修改' + names[action] + '快捷键"></label>'; }).join('') + '</div>'; }).join(''); }
    function eventModifiers(e) { var result=[]; if(e.ctrlKey) result.push('Control'); if(e.altKey) result.push('Alt'); if(e.shiftKey) result.push('Shift'); if(e.metaKey) result.push('Meta'); return result; }
    function normaliseKey(key) { return key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key; }
    function formatShortcut(shortcut) { if (!shortcut || !shortcut.key) return '未设置'; var labels = { Control:'Ctrl', Alt:'Alt', Shift:'Shift', Meta:'Cmd', Space:'空格', Escape:'Esc' }; return (shortcut.modifiers || []).concat([shortcut.key]).map(function(key) { return labels[key] || key; }).join(' + '); }
    function findShortcutAction(map, e) { var key=normaliseKey(e.key); return Object.keys(map).find(function(action) { var shortcut=map[action], modifiers=shortcut.modifiers || []; return shortcut.enabled !== false && shortcut.key === key && e.altKey === modifiers.includes('Alt') && e.ctrlKey === modifiers.includes('Control') && e.shiftKey === modifiers.includes('Shift') && e.metaKey === modifiers.includes('Meta'); }); }
    function updateShortcutLabels(container, map) {
        container.querySelectorAll('.study-web-btn').forEach(function(btn) {
            var action = actionForDefault(btn.getAttribute('data-key')); btn.setAttribute('data-action', action);
            var hint = btn.querySelector('.key-hint'); if (hint) hint.textContent = formatShortcut(map[action]);
            btn.title = '快捷键 ' + formatShortcut(map[action]) + '：' + shortcutNames()[action];
        });
    }

    // 向 iframe 发送键盘事件
    function sendKey(iframe, shortcut) {
        if (!iframe || !iframe.contentWindow || !iframe.contentDocument) {
            console.warn('iframe not ready');
            return;
        }

        var win = iframe.contentWindow;
        var doc = iframe.contentDocument;
        var key = shortcut && shortcut.key ? shortcut.key : shortcut;
        var modifiers = shortcut && shortcut.modifiers ? shortcut.modifiers : [];
        var keyCode = key && key.length === 1 && /[0-9]/.test(key) ? 48 + parseInt(key, 10) : 0;

        try {
            // keydown
            var downEvent = new win.KeyboardEvent('keydown', {
                key: key,
                code: key === 'Space' ? 'Space' : (key && key.length === 1 && /[0-9]/.test(key) ? 'Digit' + key : key),
                keyCode: keyCode,
                which: keyCode,
                altKey: modifiers.indexOf('Alt') >= 0,
                ctrlKey: modifiers.indexOf('Control') >= 0,
                shiftKey: modifiers.indexOf('Shift') >= 0,
                metaKey: modifiers.indexOf('Meta') >= 0,
                bubbles: true,
                cancelable: true
            });
            doc.dispatchEvent(downEvent);
            if (doc.body) doc.body.dispatchEvent(downEvent);

            // keyup
            var upEvent = new win.KeyboardEvent('keyup', {
                key: key,
                code: key === 'Space' ? 'Space' : (key && key.length === 1 && /[0-9]/.test(key) ? 'Digit' + key : key),
                keyCode: keyCode,
                which: keyCode,
                altKey: modifiers.indexOf('Alt') >= 0,
                ctrlKey: modifiers.indexOf('Control') >= 0,
                shiftKey: modifiers.indexOf('Shift') >= 0,
                metaKey: modifiers.indexOf('Meta') >= 0,
                bubbles: true,
                cancelable: true
            });
            doc.dispatchEvent(upEvent);
            if (doc.body) doc.body.dispatchEvent(upEvent);
        } catch (e) {
            console.warn('sendKey error:', e);
        }
    }

    return { defaultShortcuts, loadShortcuts, saveShortcuts, actionForDefault, shortcutNames,
        buildShortcutFields, eventModifiers, normaliseKey, formatShortcut, findShortcutAction,
        updateShortcutLabels, sendKey };
})();
