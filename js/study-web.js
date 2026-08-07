// ==========================================
// Memo Superform - 背单词磁贴 (网页版嵌入)
// 通过反向代理加载墨墨网页版SPA，模拟键盘事件答题
// ==========================================

const StudyWeb = (function() {

    function render(containerId) {
        var container = document.getElementById(containerId);
        if (!container) return null;

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
                '<div class="study-web-actions" style="display:none">' +
                    '<button class="study-web-btn know" data-key="1">' +
                        '\u8ba4\u8bc6<span class="key-hint">1</span></button>' +
                    '<button class="study-web-btn vague" data-key="2">' +
                        '\u6a21\u7cca<span class="key-hint">2</span></button>' +
                    '<button class="study-web-btn forget" data-key="3">' +
                        '\u5fd8\u8bb0<span class="key-hint">3</span></button>' +
                    '<button class="study-web-btn well" data-key="4">' +
                        '\u7194\u77e5<span class="key-hint">4</span></button>' +
                '</div>' +
            '</div>';

        var iframe = container.querySelector('.study-web-iframe');
        var loading = container.querySelector('.study-web-loading');
        var actions = container.querySelector('.study-web-actions');

        // Listen for iframe load events to detect state changes
        // (login page -> SPA after login)
        iframe.addEventListener('load', function() {
            var url = '';
            try { url = iframe.contentWindow.location.href; } catch(e) {}

            if (url.indexOf('/webstudy/app') >= 0 || url.indexOf('/memo-tc/webstudy/app') >= 0) {
                // SPA loaded (either directly or after login callback)
                setTimeout(function() {
                    loading.style.display = 'none';
                    actions.style.display = 'flex';
                }, 1500);
            } else if (url.indexOf('/interaction/') >= 0 || url.indexOf('/memo-accounts/') >= 0) {
                // Login page loaded - show login prompt
                loading.innerHTML = '<p style="font-size:13px;color:#888">请在上方窗口登录墨墨账号</p>';
                loading.style.display = 'block';
                actions.style.display = 'none';
            }
        });

        // Bind button events
        container.querySelectorAll('.study-web-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var key = btn.getAttribute('data-key');
                sendKey(iframe, key);
                btn.style.transform = 'scale(0.92)';
                setTimeout(function() { btn.style.transform = ''; }, 150);
            });
        });

        return createMockInstance(container);
    }

    // 向 iframe 发送键盘事件
    function sendKey(iframe, key) {
        if (!iframe || !iframe.contentWindow || !iframe.contentDocument) {
            console.warn('iframe not ready');
            return;
        }

        var win = iframe.contentWindow;
        var doc = iframe.contentDocument;
        var keyCode = 48 + parseInt(key);

        try {
            // keydown
            var downEvent = new win.KeyboardEvent('keydown', {
                key: key,
                code: 'Digit' + key,
                keyCode: keyCode,
                which: keyCode,
                bubbles: true,
                cancelable: true
            });
            doc.dispatchEvent(downEvent);
            if (doc.body) doc.body.dispatchEvent(downEvent);

            // keyup
            var upEvent = new win.KeyboardEvent('keyup', {
                key: key,
                code: 'Digit' + key,
                keyCode: keyCode,
                which: keyCode,
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
                // 已在登录页，让用户在iframe里直接登录
                loading.innerHTML = '<p style="font-size:13px;color:#888">\u8bf7\u5728\u4e0a\u65b9\u7a97\u53e3\u767b\u5f55\u58a8\u58a8\u8d26\u53f7</p>';
                loading.style.display = 'block';
                actions.style.display = 'none';
            }
        } catch(e) {
            // 跨域无法访问（不应该发生，因为通过代理是同源）
        }
    }

    // 创建模拟实例对象（兼容图表系统的 dispose/resize 调用）
    function createMockInstance(container) {
        return {
            dispose: function() {
                container.innerHTML = '';
            },
            resize: function() {
                // iframe 自动跟随容器大小，无需手动 resize
            }
        };
    }

    return { render: render };
})();