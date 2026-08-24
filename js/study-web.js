// ==========================================
// Memo Superform - 背单词磁贴 (网页版嵌入)
// 通过反向代理加载墨墨网页版SPA，模拟键盘事件答题
// ==========================================

const StudyWeb = (function() {

    function render(containerId) {
        var container = document.getElementById(containerId);
        if (!container) return null;

        // 四个快捷判断按钮属于手账版专属交互。原版/桌面原版即使加载
        // 同一份脚本也不创建可操作状态，避免样式或点击逻辑意外泄漏。
        var notebookMode = document.body.classList.contains('notebook-mode');
        var shortcutMap = loadShortcuts();

        if (container.querySelector('.study-web-iframe')) {
            return createMockInstance(container);
        }

        // Check if user already has a token (logged in)
        var token = null;
        try { token = localStorage.getItem('token'); } catch(e) {}

        var iframeSrc;
        if (token) {
            // Already logged in - load SPA directly
            iframeSrc = '/memo-tc/webstudy/app';
        } else {
            // Not logged in - load login page directly through proxy.
            // This bypasses the SPA's own window.location.replace() redirect
            // which is unreliable inside an iframe.
            // After login, the callback redirects to the SPA with a token.
            iframeSrc = '/memo-tc/study/api/v1/users/auth/login?return_url=' +
                encodeURIComponent('https://tc-apis.maimemo.com/webstudy/app');
        }

        container.innerHTML =
            '<div class="study-web-container">' +
                '<iframe class="study-web-iframe" src="' + iframeSrc + '" ' +
                    'sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>' +
                '<div class="study-web-loading">' +
                    '<div class="spinner"></div>' +
                    '<p>' + (token ? '正在加载墨墨背单词...' : '正在跳转登录页...') + '</p>' +
                '</div>' +
                '<div class="study-web-actions" hidden aria-label="手账模式快捷判断">' +
                    '<button class="study-web-btn know" data-key="1" title="快捷键 1：认识">' +
                        '\u8ba4\u8bc6<span class="key-hint">1</span></button>' +
                    '<button class="study-web-btn vague" data-key="2" title="快捷键 2：模糊">' +
                        '\u6a21\u7cca<span class="key-hint">2</span></button>' +
                    '<button class="study-web-btn forget" data-key="3" title="快捷键 3：忘记">' +
                        '\u5fd8\u8bb0<span class="key-hint">3</span></button>' +
                    '<button class="study-web-btn well" data-key="4" title="快捷键 4：熟知">' +
                        '\u7194\u77e5<span class="key-hint">4</span></button>' +
                '</div>' +
                '<button class="study-shortcut-toggle" type="button" hidden aria-label="查看和修改快捷键">⌘ 快捷键</button>' +
                '<section class="study-shortcut-panel" hidden aria-label="背单词快捷键设置">' +
                    '<div class="study-shortcut-head"><strong>快捷键便签</strong><button type="button" data-close-shortcuts aria-label="关闭快捷键便签">×</button></div>' +
                    '<p>点按按键框后按下新组合键；改动立即保存并生效。</p>' +
                    buildShortcutFields(shortcutMap) +
                    '<button class="study-shortcut-reset" type="button">恢复墨墨默认快捷键</button>' +
                '</section>' +
            '</div>';

        var iframe = container.querySelector('.study-web-iframe');
        var loading = container.querySelector('.study-web-loading');
        var actions = container.querySelector('.study-web-actions');
        var shortcutToggle = container.querySelector('.study-shortcut-toggle');
        var shortcutPanel = container.querySelector('.study-shortcut-panel');
        shortcutToggle.hidden = !notebookMode;

        // Listen for iframe load events to detect state changes
        // (login page -> SPA after login)
        // 根据仪表盘暗色主题同步 iframe 样式
        function syncIframeTheme() {
            try {
                var idoc = iframe.contentDocument;
                if (idoc && idoc.documentElement) {
                    idoc.documentElement.classList.toggle('memo-dark', document.body.classList.contains('dark'));
                }
            } catch(e) {}
        }

        iframe.addEventListener('load', function() {
            var url = '';
            try { url = iframe.contentWindow.location.href; } catch(e) {}
            syncIframeTheme();

            if (url.indexOf('/webstudy/app') >= 0 || url.indexOf('/memo-tc/webstudy/app') >= 0) {
                // SPA loaded (either directly or after login callback)
                setTimeout(function() {
                    loading.style.display = 'none';
                    actions.hidden = !notebookMode;
                    shortcutToggle.hidden = !notebookMode;
                }, 1500);
            } else if (url.indexOf('/interaction/') >= 0 || url.indexOf('/memo-accounts/') >= 0) {
                // 登录页已经可交互：必须撤掉全屏 loading，不能用提示层盖住表单。
                loading.style.display = 'none';
                actions.hidden = true;
            }
        });

        // Bind button events
        if (notebookMode) {
            updateShortcutLabels(container, shortcutMap);
            container.querySelectorAll('.study-web-btn').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var shortcut = shortcutMap[btn.getAttribute('data-action') || actionForDefault(btn.getAttribute('data-key'))];
                    sendKey(iframe, shortcut);
                    btn.style.transform = 'translateY(1px) scale(0.94)';
                    setTimeout(function() { btn.style.transform = ''; }, 150);
                });
            });
            var shortcutCloseTimer = 0;
            shortcutToggle.setAttribute('aria-expanded', 'false');
            shortcutPanel.setAttribute('aria-hidden', 'true');
            function setShortcutPanelOpen(open) {
                clearTimeout(shortcutCloseTimer);
                shortcutToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
                shortcutPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
                if (open) {
                    shortcutPanel.hidden = false;
                    requestAnimationFrame(function() {
                        requestAnimationFrame(function() { shortcutPanel.classList.add('is-open'); });
                    });
                    return;
                }
                shortcutPanel.classList.remove('is-open');
                shortcutCloseTimer = setTimeout(function() {
                    if (!shortcutPanel.classList.contains('is-open')) shortcutPanel.hidden = true;
                }, 360);
            }
            shortcutToggle.addEventListener('click', function() { setShortcutPanelOpen(!shortcutPanel.classList.contains('is-open')); });
            shortcutPanel.querySelector('[data-close-shortcuts]').addEventListener('click', function() { setShortcutPanelOpen(false); });
            shortcutPanel.querySelectorAll('[data-shortcut]').forEach(function(input) {
                input.addEventListener('keydown', function(e) {
                    e.preventDefault();
                    if (['Shift','Control','Alt','Meta','Tab','Escape'].indexOf(e.key) >= 0) return;
                    var action = input.getAttribute('data-shortcut');
                    shortcutMap[action] = { key: normaliseKey(e.key), modifiers: eventModifiers(e), enabled: true };
                    input.value = formatShortcut(shortcutMap[action]);
                    var name = input.parentNode.querySelector('.shortcut-action-name');
                    if (name) name.textContent = shortcutNames()[action];
                    saveShortcuts(shortcutMap); updateShortcutLabels(container, shortcutMap);
                });
            });
            shortcutPanel.querySelector('.study-shortcut-reset').addEventListener('click', function() { shortcutMap = defaultShortcuts(); saveShortcuts(shortcutMap); shortcutPanel.querySelectorAll('[data-shortcut]').forEach(function(i){i.value=formatShortcut(shortcutMap[i.getAttribute('data-shortcut')]);}); updateShortcutLabels(container, shortcutMap); });
            document.addEventListener('keydown', handleShortcutKeydown);
        }

        return createMockInstance(container, function() { document.removeEventListener('keydown', handleShortcutKeydown); });

        function handleShortcutKeydown(e) {
            var target = e.target;
            if (e.repeat || (target && target.closest && target.closest('.study-shortcut-panel, input, textarea, select, [contenteditable="true"]'))) return;
            var action = findShortcutAction(shortcutMap, e);
            if (!action) return;
            e.preventDefault();
            sendKey(iframe, shortcutMap[action]);
            var activeButton = container.querySelector('.study-web-btn[data-action="' + action + '"]');
            if (activeButton) {
                activeButton.classList.add('is-key-active');
                setTimeout(function() { activeButton.classList.remove('is-key-active'); }, 150);
            }
        }
    }

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

    // 检测登录状态
    function checkLoginState(iframe, loading, actions) {
        try {
            var doc = iframe.contentDocument;
            if (!doc) return;

            var url = '';
            try {
                url = iframe.contentWindow.location.href;
            } catch(e) {}

            // 检查是否在登录页
            var bodyText = doc.body ? doc.body.innerText : '';
            var hasLoginForm = url.indexOf('login') >= 0 ||
                               bodyText.indexOf('\u767b\u5f55\u58a8\u58a8') >= 0 ||
                               (doc.querySelector('input[type=password]') && !doc.querySelector('.study-web-iframe'));

            if (hasLoginForm) {
                // 已在登录页，让用户直接操作 iframe 内的登录表单。
                loading.style.display = 'none';
                actions.hidden = true;
            }
        } catch(e) {
            // 跨域无法访问（不应该发生，因为通过代理是同源）
        }
    }

    // 创建模拟实例对象（兼容图表系统的 dispose/resize 调用）
    function createMockInstance(container, onDispose) {
        return {
            dispose: function() {
                if (onDispose) onDispose();
                container.innerHTML = '';
            },
            resize: function() {
                // iframe 自动跟随容器大小，无需手动 resize
            }
        };
    }

    return { render: render };
})();
