'use strict';

// The companion language preference is browser-local.  Keep this focused
// regression test independent of a running server so both the WebView build
// and ordinary browser mode exercise the same prompt/fallback/TTS contracts.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const companionSource = fs.readFileSync('js/live2d-companion.js', 'utf8');
const ttsSource = fs.readFileSync('js/tts.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const appSource = fs.readFileSync('js/app.js', 'utf8');

function companionHarness(language) {
    const marker = 'return {\n        init: init, enter: enter, exit: exit, reloadModel: reloadModel,';
    assert(companionSource.includes(marker), 'companion public API marker changed; update the local-fallback probe');
    const instrumented = companionSource.replace(marker,
        'return {\n        __testLocalLine: function(kind) { return randomLine(kind, getCompanionLanguage()); },\n' +
        '        __testTouchLine: function(region) { return randomTouchLine(region, getCompanionLanguage()); },\n' +
        '        init: init, enter: enter, exit: exit, reloadModel: reloadModel,');
    const context = {
        window: { addEventListener: function() {} },
        document: {
            getElementById: function() { return null; },
            createElement: function() { return { textContent: '', innerHTML: '' }; },
            querySelector: function() { return null; }
        },
        localStorage: {
            getItem: function(key) { return key === 'companion_language' ? language : null; },
            setItem: function() {}
        },
        setTimeout: function() { return 1; }, clearTimeout: function() {},
        setInterval: function() { return 1; }, clearInterval: function() {},
        console: { warn: function() {}, error: function() {}, log: function() {} },
        Promise: Promise, Date: Date, Math: Math
    };
    vm.createContext(context);
    vm.runInContext(instrumented, context, { filename: 'js/live2d-companion.js' });
    return context;
}

function hasJapaneseKana(text) { return /[\u3040-\u30ff]/.test(String(text)); }
function hasChinese(text) { return /[\u4e00-\u9fa5]/.test(String(text)); }

function testCompanionLanguagePromptAndFallback() {
    assert(index.includes('id="companionLanguageSelect"'), 'settings must expose the companion language selector');
    assert(index.includes('aria-describedby="companionLanguageHint"'), 'companion language selector needs an accessible explanation');
    assert(appSource.includes("localStorage.getItem('companion_language')"), 'settings must restore the saved companion language');
    assert(appSource.includes("localStorage.setItem('companion_language'"), 'settings must persist the companion language');

    const ja = companionHarness('ja');
    assert.strictEqual(vm.runInContext('getCompanionLanguage()', ja), 'ja');
    assert(vm.runInContext("companionOutputInstruction('study', 'ja')", ja).includes('出力言語：日本語'), 'Japanese study prompt must explicitly select Japanese');
    assert(vm.runInContext("companionOutputInstruction('touch', 'ja')", ja).includes('出力言語：日本語'), 'Japanese touch prompt must explicitly select Japanese');
    assert(hasJapaneseKana(ja.window.Live2DCompanion.__testLocalLine('started')), 'Japanese fallback must remain Japanese without an AI service');
    assert(hasJapaneseKana(ja.window.Live2DCompanion.__testTouchLine('head')), 'Japanese touch fallback must remain Japanese without an AI service');
    assert.strictEqual(vm.runInContext("isMeaningfulCompanionReply('今日はこの調子でいこう。', 'ja')", ja), true, 'Japanese replies containing kana must be accepted');

    const zh = companionHarness('invalid-value');
    assert.strictEqual(vm.runInContext('getCompanionLanguage()', zh), 'zh', 'missing or malformed values must safely default to Chinese');
    assert(vm.runInContext("companionOutputInstruction('study', 'zh')", zh).includes('输出语言：简体中文'), 'Chinese study prompt must explicitly select Chinese');
    assert(hasChinese(zh.window.Live2DCompanion.__testLocalLine('started')), 'Chinese fallback must remain Chinese');
    assert(hasChinese(zh.window.Live2DCompanion.__testTouchLine('head')), 'Chinese touch fallback must remain Chinese');
    assert.strictEqual(vm.runInContext("isMeaningfulCompanionReply('这次做得很好。', 'zh')", zh), true, 'Chinese replies must be accepted');
}

class FakeAudio {
    constructor() { this.listeners = {}; this.currentTime = 0; this.src = ''; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    removeEventListener(type) { delete this.listeners[type]; }
    pause() {}
    play() { return Promise.resolve(); }
}

async function testTtsPerCallLanguageForwarding() {
    const audio = new FakeAudio();
    const requests = [];
    const context = {
        Audio: function() { return audio; },
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
            if (path === '/api/tts/status') {
                return Promise.resolve({ ok: true, status: 200, json: async function() {
                    return { enabled: true, engine_ready: true, role_ready: true, runtime_ready: true };
                } });
            }
            assert.strictEqual(path, '/api/tts/speak');
            requests.push(JSON.parse(options.body));
            return Promise.resolve({ ok: true, status: 200, json: async function() { return { audio_url: '/generated/test.wav' }; } });
        }
    };
    vm.createContext(context);
    vm.runInContext(ttsSource, context, { filename: 'js/tts.js' });
    await context.TTS.refresh();
    assert.strictEqual(await context.TTS.speak('日本語の返答です。', { language: '日文' }), true);
    assert.strictEqual(requests[0].language, '日文', 'Japanese companion speech must forward the Japanese text-language parameter');
    assert.strictEqual(await context.TTS.speak('默认调用保持资源包设置。'), true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(requests[1], 'language'), false, 'existing callers must preserve the resource-pack language default');
}

Promise.resolve()
    .then(testCompanionLanguagePromptAndFallback)
    .then(testTtsPerCallLanguageForwarding)
    .then(function() { console.log('COMPANION_LANGUAGE_REGRESSION_PASS'); })
    .catch(function(error) { console.error(error); process.exitCode = 1; });
