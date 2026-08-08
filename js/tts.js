// ==========================================
// Memo Superform - 语音资源包前端（TTS）
// ==========================================

const TTS = (function() {
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
        const controller = new AbortController();
        const timer = setTimeout(function() { controller.abort(); }, 10000);
        try {
            const resp = await fetch('/api/tts/status', { signal: controller.signal });
            if (resp.ok) status = await resp.json();
        } catch (e) { /* 超时或代理未启动时保持上次状态 */ }
        finally { clearTimeout(timer); }
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

    async function speak(text) {
        if (!text || !isReady()) return false;
        const controller = new AbortController();
        const timer = setTimeout(function() { controller.abort(); }, 45000);
        try {
            const resp = await fetch('/api/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    text: text,
                    voice: localStorage.getItem('tts_voice') || undefined,
                    speed: parseFloat(localStorage.getItem('tts_speed') || '1.0')
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
                headers: { 'Content-Type': 'application/json' },
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
