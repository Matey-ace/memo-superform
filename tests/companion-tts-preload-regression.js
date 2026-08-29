'use strict';

// Opening companion mode must warm the already-enabled TTS role once, without
// generating a fake utterance.  These fixtures exercise the browser client
// only, so the test stays fast even when GPT-SoVITS is unavailable in CI.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const ttsSource = fs.readFileSync('js/tts.js', 'utf8');
const companionSource = fs.readFileSync('js/live2d-companion.js', 'utf8');

class SilentAudio {
    constructor() { this.currentTime = 0; this.src = ''; }
    pause() {}
    play() { return Promise.resolve(); }
    addEventListener() {}
    removeEventListener() {}
}

function makeTtsHarness(preloadResponse) {
    const requests = [];
    const context = {
        Audio: SilentAudio,
        AbortController: AbortController,
        Promise: Promise,
        setTimeout: function() { return 1; }, clearTimeout: function() {},
        localStorage: {
            getItem: function(key) {
                const values = {
                    tts_speed: '1.0', tts_top_k: '15', tts_fragment_interval: '0.5',
                    tts_text_split_method: 'cut0', tts_seed: '-1', tts_cuda_graph: 'false',
                    tts_parallel_infer: 'false'
                };
                return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
            }
        },
        fetch: function(path, options) {
            requests.push({ path: path, options: options || {} });
            if (path === '/api/tts/status') {
                return Promise.resolve({ ok: true, status: 200, json: async function() {
                    return { enabled: true, engine_ready: true, role_ready: true, runtime_ready: true, loaded: false };
                } });
            }
            if (path === '/api/tts/preload') return Promise.resolve(preloadResponse);
            throw new Error('preload must never synthesize a placeholder utterance: ' + path);
        }
    };
    vm.createContext(context);
    vm.runInContext(ttsSource, context, { filename: 'js/tts.js' });
    return { TTS: context.TTS, requests: requests };
}

function preloadWasSuccessful(result) {
    return result === true || !!(result && result.ok === true);
}

async function testPreloadUsesDedicatedEndpointAndMarksWorkerWarm() {
    const harness = makeTtsHarness({ ok: true, status: 200, json: async function() { return { ok: true }; } });
    await harness.TTS.refresh();
    assert.strictEqual(typeof harness.TTS.preload, 'function', 'TTS must expose a preload client for companion mode');
    const result = await harness.TTS.preload();
    assert(preloadWasSuccessful(result), 'a successful preload must resolve successfully');
    const preloadRequests = harness.requests.filter(function(item) { return item.path === '/api/tts/preload'; });
    assert.strictEqual(preloadRequests.length, 1, 'one companion entry must issue exactly one preload request');
    assert.strictEqual(preloadRequests[0].options.method, 'POST', 'preload must use the server preload endpoint');
    assert(
        harness.requests.every(function(item) { return item.path !== '/api/tts/speak'; }),
        'preload must not synthesize or play a synthetic sentence'
    );
    assert.strictEqual(harness.TTS.getStatus().loaded, true, 'successful preload must mark the frontend worker state warm');
}

async function testPreloadFailureResolvesWithoutStudyDisruption() {
    const harness = makeTtsHarness({ ok: false, status: 503, json: async function() { return { error: 'worker unavailable' }; } });
    await harness.TTS.refresh();
    let result;
    try {
        result = await harness.TTS.preload();
    } catch (error) {
        assert.fail('optional preload failure must resolve rather than interrupt companion mode: ' + error.message);
    }
    assert(!preloadWasSuccessful(result), 'failed preload must report a non-success result');
    assert.strictEqual(harness.TTS.getStatus().loaded, false, 'failed preload must not falsely mark the worker warm');
    assert(
        harness.requests.every(function(item) { return item.path !== '/api/tts/speak'; }),
        'a failed preload must not fall back to generated speech'
    );
}

function instrumentCompanionSource() {
    const marker = 'return {\n        init: init, enter: enter, exit: exit, reloadModel: reloadModel,';
    assert(companionSource.includes(marker), 'companion public API marker changed; update preload test instrumentation');
    return companionSource.replace(marker,
        'return {\n' +
        '        __testPreloadCompanionVoice: preloadCompanionVoice,\n' +
        '        __testSetOpen: function(value) { open = !!value; },\n' +
        '        init: init, enter: enter, exit: exit, reloadModel: reloadModel,');
}

function flushPromises() {
    let chain = Promise.resolve();
    for (let step = 0; step < 8; step += 1) chain = chain.then(function() { return Promise.resolve(); });
    return chain;
}

function makeCompanionPreloadHarness(preload) {
    const calls = { refresh: 0, preload: 0, speak: 0 };
    const mood = { textContent: '', setAttribute: function() {} };
    const context = {
        window: {
            addEventListener: function() {},
            TTS: {
                refresh: function() { calls.refresh += 1; return Promise.resolve(); },
                isReady: function() { return true; },
                preload: function() { calls.preload += 1; return preload(); },
                speak: function() { calls.speak += 1; return Promise.resolve(true); }
            }
        },
        document: {
            getElementById: function(id) { return id === 'companionMood' ? mood : null; },
            createElement: function() { return { textContent: '', innerHTML: '' }; }
        },
        localStorage: {
            getItem: function(key) { return key === 'tts_companion_enabled' ? 'true' : null; },
            setItem: function() {}
        },
        console: { warn: function() {}, error: function() {}, log: function() {} },
        Promise: Promise, Date: Date, Math: Math,
        setTimeout: function() { return 1; }, clearTimeout: function() {},
        setInterval: function() { return 1; }, clearInterval: function() {}
    };
    vm.createContext(context);
    vm.runInContext(instrumentCompanionSource(), context, { filename: 'js/live2d-companion.js' });
    return { hooks: context.window.Live2DCompanion, calls: calls };
}

async function testCompanionEntryPreloadIsSilentAndFailuresAreCaught() {
    const helperStart = companionSource.indexOf('function preloadCompanionVoice()');
    const helperEnd = companionSource.indexOf('function maybeSpeakCompanion', helperStart);
    const enterStart = companionSource.indexOf('async function enter()');
    const exitStart = companionSource.indexOf('function exit()', enterStart);
    assert(helperStart >= 0 && helperEnd > helperStart, 'companion must keep a dedicated preload helper');
    const helper = companionSource.slice(helperStart, helperEnd);
    const refreshCall = helper.indexOf('tts.refresh');
    const preloadCall = helper.indexOf('tts.preload');
    assert(refreshCall >= 0 && preloadCall > refreshCall, 'preload helper must refresh readiness before warming TTS');
    assert.strictEqual(helper.indexOf('tts.speak'), -1, 'preload helper must never speak a placeholder sentence');
    assert(enterStart >= 0 && companionSource.slice(enterStart, exitStart).includes('preloadCompanionVoice();'), 'opening companion mode must invoke the preload helper');

    const success = makeCompanionPreloadHarness(function() { return Promise.resolve(true); });
    success.hooks.__testSetOpen(true);
    success.hooks.__testPreloadCompanionVoice();
    await flushPromises();
    assert.deepStrictEqual(success.calls, { refresh: 1, preload: 1, speak: 0 }, 'companion entry must warm one worker and stay silent');

    const failure = makeCompanionPreloadHarness(function() { return Promise.reject(new Error('offline worker')); });
    failure.hooks.__testSetOpen(true);
    try {
        failure.hooks.__testPreloadCompanionVoice();
        await flushPromises();
    } catch (error) {
        assert.fail('a preload failure must be absorbed so companion study stays usable: ' + error.message);
    }
    assert.deepStrictEqual(failure.calls, { refresh: 1, preload: 1, speak: 0 }, 'a failed preload must remain silent and never issue synthetic speech');
}

Promise.resolve()
    .then(testPreloadUsesDedicatedEndpointAndMarksWorkerWarm)
    .then(testPreloadFailureResolvesWithoutStudyDisruption)
    .then(testCompanionEntryPreloadIsSilentAndFailuresAreCaught)
    .then(function() { console.log('COMPANION_TTS_PRELOAD_REGRESSION_PASS'); })
    .catch(function(error) { console.error(error); process.exitCode = 1; });
