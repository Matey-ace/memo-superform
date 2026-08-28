'use strict';

// The backend can legitimately take longer than the ordinary synthesis budget
// while it boots Python and loads GPT/SoVITS weights.  The browser request
// must therefore not retain the historical 45-second hard abort on an
// explicitly-unloaded runtime.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('js/tts.js', 'utf8');

class SilentAudio {
    constructor() { this.currentTime = 0; this.src = ''; }
    pause() {}
    play() { return Promise.resolve(); }
    addEventListener() {}
    removeEventListener() {}
}

async function flushUntil(predicate, message) {
    for (let step = 0; step < 40; step += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert.fail(message);
}

async function testColdStartDoesNotUseLegacyFortyFiveSecondAbort() {
    const scheduled = [];
    let speakStarted = false;
    const context = {
        Audio: SilentAudio,
        AbortController: AbortController,
        Promise: Promise,
        setTimeout: function(callback, milliseconds) {
            const timer = { callback: callback, milliseconds: milliseconds, cleared: false };
            scheduled.push(timer);
            return timer;
        },
        clearTimeout: function(timer) { if (timer) timer.cleared = true; },
        localStorage: {
            getItem: function(key) {
                const values = {
                    tts_speed: '1.0', tts_top_k: '15', tts_fragment_interval: '0.5',
                    tts_text_split_method: 'cut0', tts_seed: '-1', tts_cuda_graph: 'false',
                    tts_parallel_infer: 'false'
                };
                return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
            },
            setItem: function() {}
        },
        fetch: function(path, options) {
            if (path === '/api/tts/status') {
                return Promise.resolve({ ok: true, status: 200, json: async function() {
                    // This is a fresh packaged-process launch: no worker has
                    // loaded the role's model yet.
                    return {
                        enabled: true, engine_ready: true, role_ready: true,
                        runtime_ready: true, loaded: false
                    };
                } });
            }
            assert.strictEqual(path, '/api/tts/speak');
            speakStarted = true;
            return new Promise(function(_resolve, reject) {
                if (options.signal) {
                    options.signal.addEventListener('abort', function() {
                        const error = new Error('request aborted for fixture cleanup');
                        error.name = 'AbortError';
                        reject(error);
                    });
                }
            });
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'js/tts.js' });
    await context.TTS.refresh();
    // Ignore the short status-refresh watchdog.  Everything scheduled after
    // speech begins belongs to the synthesis request itself in this fixture.
    scheduled.length = 0;
    const pending = context.TTS.speak('冷启动的完整测试句子。');
    await flushUntil(function() { return speakStarted; }, 'cold-start speech request was not dispatched');

    const liveSynthesisTimeouts = scheduled
        .filter(function(timer) { return !timer.cleared; })
        .map(function(timer) { return timer.milliseconds; });
    assert(
        !liveSynthesisTimeouts.includes(45000),
        'cold-start synthesis must not retain the old 45-second hard abort'
    );
    // An implementation may intentionally leave cold-start requests without
    // a browser watchdog, or use a longer watchdog.  A shorter substitute is
    // still a regression because model loading commonly exceeds 45 seconds.
    liveSynthesisTimeouts.forEach(function(milliseconds) {
        assert(
            milliseconds > 45000,
            'any cold-start synthesis watchdog must be longer than the legacy 45-second abort'
        );
    });

    context.TTS.stop();
    assert.strictEqual(await pending, false, 'fixture cleanup must cancel the pending cold-start request');
}

Promise.resolve()
    .then(testColdStartDoesNotUseLegacyFortyFiveSecondAbort)
    .then(function() { console.log('TTS_COLD_START_TIMEOUT_REGRESSION_PASS'); })
    .catch(function(error) { console.error(error); process.exitCode = 1; });
