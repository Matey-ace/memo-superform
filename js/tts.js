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
        busy: false,
        role_ready: false,
        runtime_ready: false,
        runtime_error: ''
    };
    let audio = new Audio();
    let playbackGeneration = 0;
    let synthesisGeneration = 0;
    let synthesisController = null;
    let synthesisInFlight = false;
    let queuedSynthesis = null;
    let lastError = '';

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
        return !!(status.enabled && status.engine_ready && status.role_ready && status.runtime_ready !== false);
    }

    function play(url) {
        const generation = ++playbackGeneration;
        try { audio.pause(); audio.currentTime = 0; } catch (error) {}
        audio.src = url;
        return new Promise(function(resolve) {
            let settled = false;
            let timer = null;
            const clean = function() {
                if (timer) clearTimeout(timer);
                if (audio.removeEventListener) {
                    audio.removeEventListener('error', onError);
                    audio.removeEventListener('abort', onAbort);
                }
            };
            const finish = function(ok, error) {
                if (settled) return;
                settled = true;
                clean();
                if (!ok && error) lastError = error;
                resolve(!!ok);
            };
            const onError = function() { finish(false, '音频播放失败，请检查系统音频输出或生成文件。'); };
            const onAbort = function() {
                if (generation === playbackGeneration) finish(false, '音频播放被中断。');
            };
            if (audio.addEventListener) {
                audio.addEventListener('error', onError);
                audio.addEventListener('abort', onAbort);
            }
            timer = setTimeout(function() { finish(false, '音频开始播放超时。'); }, 12000);
            try {
                Promise.resolve(audio.play()).then(function() {
                    if (generation !== playbackGeneration) { finish(false); return; }
                    finish(true);
                }).catch(function(error) {
                    const text = error && error.name === 'NotAllowedError'
                        ? '浏览器阻止了语音播放，请先点击页面后重试。'
                        : '浏览器未能播放生成的语音。';
                    finish(false, text);
                });
            } catch (error) { finish(false, '浏览器未能播放生成的语音。'); }
        });
    }

    function stop() {
        playbackGeneration += 1;
        synthesisGeneration += 1;
        try { audio.pause(); audio.currentTime = 0; } catch (error) {}
        if (queuedSynthesis) {
            queuedSynthesis.waiters.forEach(function(resolve) { resolve(false); });
            queuedSynthesis = null;
        }
        if (synthesisController) {
            try { synthesisController.abort(); } catch (error) {}
            synthesisController = null;
        }
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

    function delay(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    async function requestSpeech(text, controller, requestGeneration, options) {
        // The worker intentionally processes one GPU synthesis at a time.  A
        // previous browser request can be cancelled locally while the worker
        // continues running, so retry a short "正在合成中" window instead of
        // treating rapid interactions as permanently silent.
        for (let attempt = 0; attempt < 18; attempt += 1) {
            const requestBody = {
                text: text,
                // The backend resolves the single enabled role from its
                // manifest.  Do not let browser state choose another
                // character's model or reference audio.
                speed: parseFloat(localStorage.getItem('tts_speed') || '1.0'),
                top_k: numSetting('tts_top_k', 15, 1, 100),
                fragment_interval: numSetting('tts_fragment_interval', 0.5, 0, 5),
                text_split_method: localStorage.getItem('tts_text_split_method') || 'cut0',
                seed: numSetting('tts_seed', -1),
                use_cuda_graph: boolSetting('tts_cuda_graph', false),
                parallel_infer: boolSetting('tts_parallel_infer', false)
            };
            // Most callers rely on the resource pack's default text language.
            // Companion mode supplies this per utterance so a Japanese reply
            // does not inherit a stale Chinese text-language preference.
            if (options && (options.language === '中文' || options.language === '日文')) {
                requestBody.language = options.language;
            }
            const resp = await fetch('/api/tts/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                signal: controller ? controller.signal : undefined,
                body: JSON.stringify(requestBody)
            });
            const data = await resp.json().catch(function() { return {}; });
            if (requestGeneration !== synthesisGeneration) return { cancelled: true };
            if (resp.ok && data.audio_url) return { audio_url: data.audio_url };
            const message = data.error || ('语音生成失败（HTTP ' + resp.status + '）。');
            if (message.indexOf('正在合成') >= 0 && attempt < 17) {
                await delay(650);
                continue;
            }
            return { error: message };
        }
        return { error: '语音引擎持续忙碌，请稍后重试。' };
    }

    function settle(waiters, result) {
        waiters.forEach(function(resolve) { resolve(!!result); });
    }

    async function runSynthesis(text, waiters, options) {
        const requestGeneration = ++synthesisGeneration;
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        synthesisController = controller;
        synthesisInFlight = true;
        lastError = '';
        // GPT-SoVITS' first request after launch loads model weights and can
        // legitimately take well over the normal speech timeout.  Do not
        // abort that cold request at 45 seconds: the server cannot cancel GPU
        // work safely, and killing the browser request used to make touches
        // appear permanently silent.  Once a response succeeds, later turns
        // retain the tighter warm-path guard.
        const requestTimeout = status.loaded ? 45000 : 210000;
        const timer = setTimeout(function() { if (controller) controller.abort(); }, requestTimeout);
        try {
            const result = await requestSpeech(text, controller, requestGeneration, options);
            if (result.cancelled || requestGeneration !== synthesisGeneration) {
                settle(waiters, false);
            } else if (result.audio_url) {
                status.loaded = true;
                // A newer touch arrived while this GPU job was running.  Do
                // not play the stale response over it; finish this worker job
                // and synthesize only the most recent pending reaction.
                if (queuedSynthesis) settle(waiters, false);
                else settle(waiters, await play(result.audio_url));
            } else {
                lastError = result.error || '语音生成失败。';
                settle(waiters, false);
            }
        } catch (e) {
            if (requestGeneration === synthesisGeneration) {
                lastError = e && e.name === 'AbortError' ? '语音生成请求已被新的互动替换。' : '语音请求失败，请检查语音引擎状态。';
            }
            settle(waiters, false);
        } finally {
            clearTimeout(timer);
            if (synthesisController === controller) synthesisController = null;
            synthesisInFlight = false;
            // Only an explicit stop increments the generation while a request
            // is active.  New touches are deliberately queued, never aborted.
            const next = queuedSynthesis;
            queuedSynthesis = null;
            if (next && requestGeneration === synthesisGeneration && isReady()) {
                runSynthesis(next.text, next.waiters, next.options);
            } else if (next) {
                settle(next.waiters, false);
            }
        }
    }

    function speak(text, options) {
        if (!text || !isReady()) return Promise.resolve(false);
        lastError = '';
        return new Promise(function(resolve) {
            if (synthesisInFlight) {
                // Keep the latest meaningful touch only.  The server cannot
                // cancel an already-running inference, so replacing the queue
                // prevents a burst of clicks from piling up stale speeches.
                if (queuedSynthesis) settle(queuedSynthesis.waiters, false);
                queuedSynthesis = { text: text, waiters: [resolve], options: options };
                return;
            }
            runSynthesis(text, [resolve], options);
        });
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
        getStatus: function() { return status; },
        getLastError: function() { return lastError; }
    };
})();
