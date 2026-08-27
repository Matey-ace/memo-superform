// ==========================================
// Memo Superform - 语音资源包前端（TTS）
// ==========================================

var TTS = (function() {
    let status = {
        enabled: false,
        pack_ready: false,
        engine_ready: false,
        install_error: '',
        voices: [],
        device: null,
        loaded: false,
        busy: false
    };
    let audio = new Audio();

    async function refresh() {
        let controller = null;
        let timer = null;
        try {
            controller = new AbortController();
            timer = setTimeout(function() { try { controller.abort(); } catch (e) {} }, 10000);
        } catch (e) { /* AbortController 不可用时退化为无超时请求 */ }
        try {
            const resp = await fetch('/api/tts/status', { signal: controller ? controller.signal : undefined });
            if (resp.ok) status = await resp.json();
        } catch (e) { /* 超时或代理未启动时保持上次状态 */ }
        finally { if (timer) clearTimeout(timer); }
        return status;
    }

    function isReady() {
        return !!(status.enabled && status.engine_ready);
    }

    function play(url) {
        stop();
        audio.src = url;
        audio.play().catch(function() {});
    }

    function stop() {
        audio.pause();
        audio.currentTime = 0;
    }

    function numSetting(key, fallback, min, max) {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === '') return fallback;
        const n = Number(raw);
        if (!Number.isFinite(n)) return fallback;
        if (min !== undefined && n < min) return fallback;
        if (max !== undefined && n > max) return fallback;
        return n;
    }

    function boolSetting(key, fallback) {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        return raw === 'true';
    }

    async function speak(text) {
        if (!text || !isReady()) return false;
        const controller = new AbortController();
        const timer = setTimeout(function() { controller.abort(); }, 45000);
        try {
            const resp = await fetch('/api/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                signal: controller.signal,
                body: JSON.stringify({
                    text: text,
                    // The backend resolves an explicit role package; do not let
                    // a dropdown accidentally combine another role's model and
                    // reference audio.
                    voice: localStorage.getItem('tts_active_role_id') || undefined,
                    speed: parseFloat(localStorage.getItem('tts_speed') || '1.0'),
                    top_k: numSetting('tts_top_k', 15, 1, 100),
                    fragment_interval: numSetting('tts_fragment_interval', 0.5, 0, 5),
                    text_split_method: localStorage.getItem('tts_text_split_method') || 'cut0',
                    seed: numSetting('tts_seed', -1),
                    use_cuda_graph: boolSetting('tts_cuda_graph', false),
                    parallel_infer: boolSetting('tts_parallel_infer', false)
                })
            });
            const data = await resp.json();
            if (resp.ok && data.audio_url) {
                play(data.audio_url);
                return true;
            }
            return false;
        } catch (e) {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    async function setEnabled(enabled) {
        try {
            const resp = await fetch(enabled ? '/api/tts/enable' : '/api/tts/disable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({})
            });
            const data = await resp.json();
            if (resp.ok) {
                status.enabled = enabled;
                return { ok: true };
            }
            return { ok: false, error: data.error || '操作失败' };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    return {
        refresh: refresh,
        speak: speak,
        stop: stop,
        isReady: isReady,
        setEnabled: setEnabled,
        getStatus: function() { return status; }
    };
})();
