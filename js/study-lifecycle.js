// Memo Superform - one lifecycle owner for study-page observation and fallback polling.
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
    return { create: create };
})();
