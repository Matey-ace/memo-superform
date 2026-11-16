// ==========================================
// Memo Superform - 普通版陪伴模式生命周期适配层
// ==========================================
// 为什么需要这一层：js/live2d-companion.js 是 Anon的笔记本与普通版共用的文件，
// 受保护、不能修改。但该文件里的陪伴心跳 setInterval(session.tick, 60000) 没有
// 对应的 clearInterval，退出陪伴后仍会永久空转。本模块在**运行时**为普通版补上
// 生命周期收口：不改动被保护文件的任何内容，也绝不在笔记本主题下生效。
(function () {
    'use strict';

    var style = window.MemoUIStyle || {};
    if (style.isNotebook) return;   // 笔记本主题下完全不做任何事

    var timerHandles = [];
    var installed = false;

    // 只在 init() 执行期间临时接管 setInterval，把这段代码自己创建的定时器
    // 句柄抄一份下来。作用域刻意收得很窄：调用结束立刻还原全局函数，
    // 不改变任何其他代码的定时器行为。
    function captureInitTimers(initFn, thisArg) {
        var nativeSetInterval = window.setInterval;
        var nativeClearInterval = window.clearInterval;
        var captured = [];
        window.setInterval = function () {
            var handle = nativeSetInterval.apply(window, arguments);
            captured.push(handle);
            return handle;
        };
        window.clearInterval = function (handle) {
            for (var i = captured.length - 1; i >= 0; i--) {
                if (captured[i] === handle) captured.splice(i, 1);
            }
            return nativeClearInterval.apply(window, arguments);
        };
        try {
            return initFn.call(thisArg);
        } finally {
            window.setInterval = nativeSetInterval;
            window.clearInterval = nativeClearInterval;
            timerHandles = timerHandles.concat(captured);
        }
    }

    function stopCompanionTimers() {
        timerHandles.forEach(function (handle) {
            try { window.clearInterval(handle); } catch (e) {}
        });
        timerHandles.length = 0;
    }

    // 退出陪伴后可能残留的可见痕迹：原实现只隐藏纪念卡，徽章会留在界面上。
    function hideCompanionResidue() {
        var badge = document.getElementById('companionBirthdayBadge');
        if (badge) badge.hidden = true;
        var card = document.getElementById('companionBirthdayCard');
        if (card) card.hidden = true;
    }

    function install() {
        if (installed) return;
        var companion = window.Live2DCompanion;
        if (!companion || typeof companion.init !== 'function') return;
        installed = true;

        var nativeInit = companion.init;
        var nativeExit = companion.exit;
        var nativeEnter = companion.enter;

        companion.init = function () {
            return captureInitTimers(nativeInit, this);
        };
        companion.exit = function () {
            var result = nativeExit.apply(this, arguments);
            stopCompanionTimers();
            hideCompanionResidue();
            return result;
        };
        companion.enter = function () {
            // 全屏弹层与陪伴模式互相破坏：陪伴进入会 disposeAll() 销毁已移入弹层的
            // 学习实例，而 #companionStudy 又被全屏设为 inert，结果既空白又不可点。
            if (window.LayoutManager && typeof LayoutManager.isFullscreenOpen === 'function' &&
                LayoutManager.isFullscreenOpen() && typeof LayoutManager.closeFullscreen === 'function') {
                LayoutManager.closeFullscreen();
            }
            return nativeEnter.apply(this, arguments);
        };
    }

    function boot() {
        if (window.Live2DCompanion) install();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    boot();

    window.MemoCompanionGuard = {
        installed: function () { return installed; },
        activeTimerCount: function () { return timerHandles.length; },
        stop: stopCompanionTimers
    };
})();
