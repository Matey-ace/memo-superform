// ==========================================
// Memo Superform - 背单词磁贴 (网页版嵌入)
// 通过反向代理加载墨墨网页版SPA，模拟键盘事件答题
// ==========================================

const StudyWeb = (function() {
    var defaultShortcuts = StudyShortcuts.defaultShortcuts;
    var loadShortcuts = StudyShortcuts.loadShortcuts;
    var saveShortcuts = StudyShortcuts.saveShortcuts;
    var actionForDefault = StudyShortcuts.actionForDefault;
    var shortcutNames = StudyShortcuts.shortcutNames;
    var buildShortcutFields = StudyShortcuts.buildShortcutFields;
    var eventModifiers = StudyShortcuts.eventModifiers;
    var normaliseKey = StudyShortcuts.normaliseKey;
    var formatShortcut = StudyShortcuts.formatShortcut;
    var findShortcutAction = StudyShortcuts.findShortcutAction;
    var updateShortcutLabels = StudyShortcuts.updateShortcutLabels;
    var sendKey = StudyShortcuts.sendKey;

    function render(containerId, options) {
        var container = document.getElementById(containerId);
        if (!container) return null;
        options = options || {};
        var reportStudyEvent = typeof options.onStudyEvent === 'function' ? options.onStudyEvent : function() {};

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
                '<div class="study-web-actions" hidden aria-label="快捷判断">' +
                    '<button class="study-web-btn know" data-action="FAMILIAR" data-key="1" title="快捷键 1：认识">' +
                        '\u8ba4\u8bc6<span class="key-hint">1</span></button>' +
                    '<button class="study-web-btn vague" data-action="VAGUE" data-key="2" title="快捷键 2：模糊">' +
                        '\u6a21\u7cca<span class="key-hint">2</span></button>' +
                    '<button class="study-web-btn forget" data-action="FORGET" data-key="3" title="快捷键 3：忘记">' +
                        '\u5fd8\u8bb0<span class="key-hint">3</span></button>' +
                    '<button class="study-web-btn well" data-action="WELL_FAMILIAR" data-key="4" title="快捷键 4：熟知">' +
                        '\u719f\u77e5<span class="key-hint">4</span></button>' +
                '</div>' +
                '<button class="study-shortcut-toggle" type="button" hidden aria-label="查看和修改快捷键">⌘ 快捷键</button>' +
                '<section class="study-shortcut-panel" hidden aria-label="背单词快捷键设置">' +
                    '<div class="study-shortcut-head"><strong>快捷键设置</strong><button type="button" data-close-shortcuts aria-label="关闭快捷键设置">×</button></div>' +
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
        var studyControlsActive = false;
        var studyAddWordOverlayOpen = false;
        var studyHomeFallbackPending = false;

        // Companion mode receives only the current word and answer category.
        // Its callback is inert for the normal dashboard study tile.
        function currentStudyWord() {
            try {
                var idoc = iframe.contentDocument;
                var activePage = idoc && getActiveTaroPage(idoc);
                var scope = activePage || idoc;
                if (!scope) return '';
                var node = scope.querySelector('.phrase-spelling, .phrase-word, .rev-word, [data-word], .phrase-title');
                var text = node && (node.getAttribute('data-word') || node.innerText || node.textContent);
                text = (text || '').replace(/\s+/g, ' ').trim();
                return /^[A-Za-z][A-Za-z' -]{0,80}$/.test(text) ? text : '';
            } catch(e) { return ''; }
        }

        function reportAnswer(action) {
            if (!studyControlsActive || studyAddWordOverlayOpen) return;
            reportStudyEvent({ type: 'answer', action: action, word: currentStudyWord() });
        }

        // URL 只能说明墨墨 SPA 已加载，公测说明、词书和设置页也共用
        // /webstudy/app。只有学习页的语义根节点实际挂载后才显示操作栏，
        // 避免操作栏提前覆盖说明页并拦截“进入背单词”的点击。
        function getActiveTaroPage(idoc) {
            var pages = Array.prototype.slice.call(idoc.querySelectorAll('.taro_page.taro_page_show'));
            var visible = pages.filter(function(page) {
                if (page.classList.contains('taro_page_shade')) return false;
                var style = iframe.contentWindow.getComputedStyle(page);
                return style.display !== 'none' && style.visibility !== 'hidden';
            });
            return visible.length ? visible[visible.length - 1] : null;
        }

        function isIframeElementVisible(idoc, element) {
            try {
                var style = iframe.contentWindow.getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                var rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            } catch(e) {
                return false;
            }
        }

        // 单词详情弹窗中的“加入复习”会被固定在底部的四个判断按钮遮住。
        // 只识别可见的加入复习/背诵/学习操作，避免普通学习页误收起按钮。
        function hasAddWordOverlay(idoc) {
            var overlayRoots = Array.prototype.slice.call(idoc.querySelectorAll(
                '.memo-word-popup, .taro-modal__content, .taro-modal__inner, ' +
                '.taro-model__bd, .taroify-dialog, .taroify-popup--center'
            ));
            var addAction = /(?:加入|添加).{0,8}(?:复习|背诵|学习)/;
            if (overlayRoots.some(function(root) {
                return isIframeElementVisible(idoc, root) && addAction.test((root.innerText || root.textContent || '').replace(/\s+/g, ''));
            })) return true;
            var actionNodes = Array.prototype.slice.call(idoc.querySelectorAll(
                '.memo-word-popup button, .memo-word-popup [role="button"], ' +
                '.taro-modal__content button, .taro-modal__content [role="button"], ' +
                '.taro-modal__inner button, .taro-modal__inner [role="button"], ' +
                '.taroify-dialog button, .taroify-dialog [role="button"], ' +
                '.taroify-popup--center button, .taroify-popup--center [role="button"]'
            ));
            return actionNodes.some(function(node) {
                if (!isIframeElementVisible(idoc, node)) return false;
                var label = (node.innerText || node.textContent || '').replace(/\s+/g, '');
                return addAction.test(label);
            });
        }

        function isActualStudyScreen() {
            try {
                var idoc = iframe.contentDocument;
                if (!idoc || !idoc.body) {
                    studyAddWordOverlayOpen = false;
                    return false;
                }
                var activePage = getActiveTaroPage(idoc);
                var scope = activePage || idoc;
                var reviewRoot = scope.querySelector('.rev-root');
                var active = !!(reviewRoot && scope.querySelector('.rev-top, .rev-scroller, .rev-bottom, .rev-resp-btns'));
                studyAddWordOverlayOpen = active && hasAddWordOverlay(idoc);
                return active;
            } catch(e) {
                studyAddWordOverlayOpen = false;
                return false;
            }
        }

        function setStudyControlsActive(active) {
            var changed = studyControlsActive !== !!active;
            studyControlsActive = !!active;
            var hideForAddWordOverlay = studyControlsActive && studyAddWordOverlayOpen;
            actions.hidden = !studyControlsActive;
            actions.classList.toggle('is-add-word-overlay', hideForAddWordOverlay);
            actions.toggleAttribute('inert', hideForAddWordOverlay);
            actions.setAttribute('aria-hidden', (!studyControlsActive || hideForAddWordOverlay) ? 'true' : 'false');
            shortcutToggle.hidden = !studyControlsActive;
            container.dataset.studyScreenActive = studyControlsActive ? 'true' : 'false';
            container.dataset.studyAddWordOverlay = hideForAddWordOverlay ? 'true' : 'false';
            if (!studyControlsActive || hideForAddWordOverlay) setShortcutPanelOpen(false);
            if (changed) reportStudyEvent({ type: 'screen', active: studyControlsActive });
        }

        var studyWatch = StudyLifecycle.create(iframe, isActualStudyScreen, setStudyControlsActive);
        var stopStudyScreenWatch = studyWatch.stop;
        var syncStudyScreen = studyWatch.sync;
        var startStudyScreenWatch = studyWatch.start;

        // Listen for iframe load events to detect state changes
        // (login page -> SPA after login)
        // 根据仪表盘暗色主题同步 iframe 样式
        function syncIframeTheme() {
            try {
                var idoc = iframe.contentDocument;
                if (idoc && idoc.documentElement) {
                    var notebook = !!(window.MemoUIStyle && window.MemoUIStyle.isNotebook) ||
                        document.body.classList.contains('notebook-mode');
                    idoc.documentElement.classList.toggle('memo-dark', !notebook && document.body.classList.contains('dark'));
                }
            } catch(e) {}
        }

        // The upstream TTS settings route can be mounted without a working
        // Taro back control.  Only the current, same-origin study iframe may
        // request the hard fallback to the Maimemo home route.
        function handleStudyNavigationMessage(event) {
            if (event.source !== iframe.contentWindow || event.origin !== window.location.origin) return;
            var message = event.data;
            if (!message || message.type !== 'memo-study-navigation' || message.action !== 'home-fallback') return;
            if (studyHomeFallbackPending) return;

            studyHomeFallbackPending = true;
            setStudyControlsActive(false);
            stopStudyScreenWatch();
            var loadingText = loading.querySelector('p');
            if (loadingText) loadingText.textContent = '正在返回墨墨首页...';
            loading.style.display = 'flex';
            iframe.src = '/memo-tc/webstudy/app?memo_home=1';
        }

        window.addEventListener('message', handleStudyNavigationMessage);

        iframe.addEventListener('load', function() {
            var url = '';
            try { url = iframe.contentWindow.location.href; } catch(e) {}
            studyHomeFallbackPending = false;
            syncIframeTheme();
            loading.style.display = 'none';
            startStudyScreenWatch();

            if (url.indexOf('/webstudy/app') >= 0 || url.indexOf('/memo-tc/webstudy/app') >= 0) {
                // SPA 已加载；选择栏继续等待 .rev-root 学习界面挂载。
                syncStudyScreen();
            } else if (url.indexOf('/interaction/') >= 0 || url.indexOf('/memo-accounts/') >= 0) {
                // 登录页已经可交互：必须撤掉全屏 loading，不能用提示层盖住表单。
                setStudyControlsActive(false);
            }
        });

        // Bind button events
        updateShortcutLabels(container, shortcutMap);
            container.querySelectorAll('.study-web-btn').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var action = btn.getAttribute('data-action') || actionForDefault(btn.getAttribute('data-key'));
                    var shortcut = shortcutMap[action];
                    sendKey(iframe, shortcut);
                    reportAnswer(action);
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

        return createMockInstance(container, function() {
            document.removeEventListener('keydown', handleShortcutKeydown);
            window.removeEventListener('message', handleStudyNavigationMessage);
            stopStudyScreenWatch();
            reportStudyEvent({ type: 'screen', active: false });
        });

        function handleShortcutKeydown(e) {
            if (!studyControlsActive || studyAddWordOverlayOpen) return;
            var target = e.target;
            if (e.repeat || (target && target.closest && target.closest('.study-shortcut-panel, input, textarea, select, [contenteditable="true"]'))) return;
            var action = findShortcutAction(shortcutMap, e);
            if (!action) return;
            e.preventDefault();
            sendKey(iframe, shortcutMap[action]);
            reportAnswer(action);
            var activeButton = container.querySelector('.study-web-btn[data-action="' + action + '"]');
            if (activeButton) {
                activeButton.classList.add('is-key-active');
                setTimeout(function() { activeButton.classList.remove('is-key-active'); }, 150);
            }
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
