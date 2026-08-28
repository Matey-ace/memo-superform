'use strict';

// Runtime coverage for the final browser-audio leg of companion speech.  The
// backend may return a valid audio URL while the browser still blocks or fails
// to play it; callers must receive `false` and a useful reason instead of
// treating that request as a successful spoken reaction.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('js/tts.js', 'utf8');

class FakeAudio {
    constructor(playBehavior) {
        this._playBehavior = playBehavior;
        this._listeners = {};
        this.src = '';
        this.currentTime = 0;
        this.pauseCalls = 0;
    }
    addEventListener(type, handler) {
        if (!this._listeners[type]) this._listeners[type] = new Set();
        this._listeners[type].add(handler);
    }
    removeEventListener(type, handler) {
        if (this._listeners[type]) this._listeners[type].delete(handler);
    }
    emit(type) {
        (this._listeners[type] || new Set()).forEach(function(handler) { handler(); });
    }
    pause() { this.pauseCalls += 1; }
    play() { return this._playBehavior(this); }
}

function buildHarness(playBehavior, settings) {
    const audios = [];
    const storage = Object.assign({
        tts_speed: '1.0',
        tts_top_k: '15',
        tts_fragment_interval: '0.5',
        tts_text_split_method: 'cut0',
        tts_seed: '-1',
        tts_cuda_graph: 'false',
        tts_parallel_infer: 'false'
    }, settings || {});
    let lastSpeakBody = null;
    const context = {
        Audio: function() {
            const audio = new FakeAudio(playBehavior);
            audios.push(audio);
            return audio;
        },
        AbortController: AbortController,
        Promise: Promise,
        setTimeout: function() { return 1; },
        clearTimeout: function() {},
        localStorage: {
            getItem: function(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
            setItem: function(key, value) { storage[key] = String(value); }
        },
        fetch: async function(path, options) {
            if (path === '/api/tts/status') {
                return { ok: true, status: 200, json: async function() {
                    return { enabled: true, engine_ready: true, role_ready: true, pack_ready: true };
                } };
            }
            if (path === '/api/tts/speak') {
                lastSpeakBody = JSON.parse(options.body);
                return { ok: true, status: 200, json: async function() { return { audio_url: '/api/tts/audio/test.wav' }; } };
            }
            throw new Error('unexpected fetch: ' + path);
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'js/tts.js' });
    return {
        TTS: context.TTS,
        audios: audios,
        getLastSpeakBody: function() { return lastSpeakBody; }
    };
}

async function prepare(harness) {
    await harness.TTS.refresh();
    assert.strictEqual(harness.TTS.isReady(), true, 'fixture status must allow speech');
}

async function waitForAudio(harness) {
    for (let index = 0; index < 8; index += 1) {
        const candidate = harness.audios[0];
        if (candidate && candidate._listeners.error && candidate._listeners.error.size) return candidate;
        await Promise.resolve();
    }
    assert.strictEqual(harness.audios.length, 1, 'speech response must start browser audio playback');
    throw new Error('speech response did not attach the browser audio failure listener');
}

async function testPlaybackSuccessAndRoleOnlyRequest() {
    const harness = buildHarness(function() { return Promise.resolve(); });
    await prepare(harness);
    const ok = await harness.TTS.speak('这是一句完整的测试语音。');
    assert.strictEqual(ok, true, 'resolved browser playback must report speech success');
    assert.strictEqual(harness.TTS.getLastError(), '', 'successful playback must clear stale audio errors');
    const body = harness.getLastSpeakBody();
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, 'voice'), false, 'browser must never select a legacy voice path');
    assert.strictEqual(body.text, '这是一句完整的测试语音。', 'speech body must preserve the requested text');
}

async function testAutoplayRejectionIsVisible() {
    const notAllowed = new Error('autoplay blocked');
    notAllowed.name = 'NotAllowedError';
    const harness = buildHarness(function() { return Promise.reject(notAllowed); });
    await prepare(harness);
    const ok = await harness.TTS.speak('需要浏览器播放的完整句子。');
    assert.strictEqual(ok, false, 'autoplay rejection must not be reported as a completed spoken reaction');
    assert(harness.TTS.getLastError().includes('浏览器阻止了语音播放'), 'autoplay rejection must expose a useful recovery hint');
}

async function testAudioElementFailureIsVisible() {
    const harness = buildHarness(function() { return new Promise(function() {}); });
    await prepare(harness);
    const pending = harness.TTS.speak('音频元素失败时也应反馈。');
    const audio = await waitForAudio(harness);
    audio.emit('error');
    const ok = await pending;
    assert.strictEqual(ok, false, 'audio element errors must make speech fail');
    assert(harness.TTS.getLastError().includes('音频播放失败'), 'audio element failure must be surfaced to the companion UI');
}

Promise.resolve()
    .then(testPlaybackSuccessAndRoleOnlyRequest)
    .then(testAutoplayRejectionIsVisible)
    .then(testAudioElementFailureIsVisible)
    .then(function() { console.log('TTS_PLAYBACK_REGRESSION_PASS'); })
    .catch(function(error) { console.error(error); process.exitCode = 1; });
