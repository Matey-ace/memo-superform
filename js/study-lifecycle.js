// Memo Superform - 统一管理学习页观察与兜底轮询的生命周期。
const StudyLifecycle = (function() {
    function create(iframe, detect, onChange) {
        var observer = null;
        var poll = null;
        function sync() { onChange(!!detect()); }
        function stop() {
            if (observer) observer.disconnect();
            observer = null;
            if (poll) clearInterval(poll);
            poll = null;
        }
        function start() {
            stop();
            onChange(false);
            try {
                var doc = iframe.contentDocument;
                if (!doc || !doc.documentElement) return;
                var FrameMutationObserver = iframe.contentWindow && iframe.contentWindow.MutationObserver;
                if (!FrameMutationObserver) return;
                observer = new FrameMutationObserver(sync);
                observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
                poll = setInterval(sync, 500);
                sync();
            } catch(e) {}
        }
        return { start: start, stop: stop, sync: sync };
    }
    function isVisible(node) {
        if (!node || node.isConnected === false) return false;
        for (var current = node; current && current.nodeType === 1; current = current.parentElement) {
            if (current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return false;
            var style = window.getComputedStyle(current);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return !node.getClientRects || node.getClientRects().length > 0;
    }
    return { create: create, isVisible: isVisible };
})();
