// Memo Superform - 近期词汇阅读入口接线。
//
// 只负责三件事：建一个全屏覆盖层、把「近期词汇阅读」按钮接上去、把容器交给
// window.MemoReadingUI.mount()。业务与交互都在 recent-vocab.js / reading-practice.js /
// reading-practice-ui.js 里，两套主题共用这套结构，差异只由样式表承担。
(function (globalScope) {
    'use strict';

    var overlay = null;

    function ui() {
        return typeof globalScope.MemoReadingUI !== 'undefined' ? globalScope.MemoReadingUI : null;
    }

    function ensureOverlay() {
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.className = 'reading-overlay';
        overlay.id = 'readingOverlay';
        overlay.hidden = true;

        var root = document.createElement('div');
        root.className = 'reading-root';
        root.id = 'readingRoot';
        // 覆盖层本体是对话框语义：标题由界面层提供。
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-labelledby', 'readingTitle');

        var host = document.createElement('div');
        host.className = 'reading-host';
        host.setAttribute('data-reading-host', '');
        root.appendChild(host);
        overlay.appendChild(root);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', function (event) {
            // 点遮罩关闭，但只点在遮罩本身时才关（不误伤内部点击）。
            if (event.target === overlay) close();
        });
        return overlay;
    }

    function open() {
        var api = ui();
        if (!api) return false;
        ensureOverlay();
        overlay.hidden = false;
        if (typeof api.open === 'function') api.open();
        if (typeof api.mount === 'function') {
            api.mount(overlay.querySelector('[data-reading-host]'));
        }
        return true;
    }

    function close() {
        var api = ui();
        if (api && typeof api.close === 'function') api.close();
        if (overlay) overlay.hidden = true;
    }

    function bindEntry() {
        var button = document.getElementById('recentReadingBtn');
        if (!button || button.dataset.readingReady) return;
        button.dataset.readingReady = 'true';
        button.addEventListener('click', function () { open(); });
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && overlay && !overlay.hidden) close();
        });
    }

    function init() {
        bindEntry();
    }

    globalScope.MemoReadingWire = { init: init, open: open, close: close };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}(typeof window !== 'undefined' ? window : this));
