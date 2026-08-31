'use strict';

// Fast touch bursts must not create a FIFO of GPU jobs, and role-local
// personas must outrank the legacy character-id browser map.  Both contracts
// are exercised in lightweight VM harnesses so they stay deterministic in CI.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const ttsSource = fs.readFileSync('js/tts.js', 'utf8');
const companionSource = fs.readFileSync('js/live2d-companion.js', 'utf8');

class FakeAudio {
    constructor() {
        this._listeners = {};
        this.src = '';
        this.currentTime = 0;
        this.playCalls = 0;
    }
    addEventListener(type, handler) {
        if (!this._listeners[type]) this._listeners[type] = new Set();
        this._listeners[type].add(handler);
    }
    removeEventListener(type, handler) {
        if (this._listeners[type]) this._listeners[type].delete(handler);
    }
    pause() {}
    play() { this.playCalls += 1; return Promise.resolve(); }
}

function queueHarness() {
    const requests = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const audio = new FakeAudio();
    const context = {
        Audio: function() { return audio; },
        AbortController: AbortController,
        Promise: Promise,
        setTimeout: function() { return 1; },
        clearTimeout: function() {},
        localStorage: {
            getItem: function(key) {
                const settings = {
                    tts_speed: '1.0', tts_top_k: '15', tts_fragment_interval: '0.5',
                    tts_text_split_method: 'cut0', tts_seed: '-1', tts_cuda_graph: 'false',
                    tts_parallel_infer: 'false'
                };
                return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : null;
            },
            setItem: function() {}
        },
        fetch: function(path, options) {
            if (path === '/api/tts/status') {
                return Promise.resolve({ ok: true, status: 200, json: async function() {
                    return { enabled: true, engine_ready: true, role_ready: true, runtime_ready: true };
                } });
            }
            if (path !== '/api/tts/speak') throw new Error('unexpected request: ' + path);
            activeRequests += 1;
            maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
            return new Promise(function(resolve) {
                requests.push({
                    body: JSON.parse(options.body),
                    respond: function(url) {
                        activeRequests -= 1;
                        resolve({ ok: true, status: 200, json: async function() { return { audio_url: url }; } });
                    }
                });
            });
        }
    };
    vm.createContext(context);
    vm.runInContext(ttsSource, context, { filename: 'js/tts.js' });
    return {
        TTS: context.TTS,
        requests: requests,
        audio: audio,
        maxActiveRequests: function() { return maxActiveRequests; }
    };
}

async function flushUntil(predicate, message) {
    for (let step = 0; step < 40; step += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert.fail(message);
}

async function testRapidSpeechKeepsOnlyLatestQueuedReaction() {
    const harness = queueHarness();
    await harness.TTS.refresh();

    const first = harness.TTS.speak('第一次触摸的旧回应。');
    await flushUntil(function() { return harness.requests.length === 1; }, 'first speech request was not dispatched');
    const second = harness.TTS.speak('第二次触摸的过期回应。');
    const third = harness.TTS.speak('第三次触摸的最终回应。');

    // While the first worker request is unresolved, neither a second nor a
    // third GPU request may be dispatched.  The middle request is discarded
    // and only the latest pending touch survives.
    assert.strictEqual(harness.requests.length, 1, 'rapid touches must keep synthesis single-flight');
    assert.strictEqual(harness.maxActiveRequests(), 1, 'there must never be overlapping speech fetches');
    assert.strictEqual(await second, false, 'a superseded queued touch must settle as not spoken');

    harness.requests[0].respond('/generated/first.wav');
    assert.strictEqual(await first, false, 'a completed stale worker response must not be played over a newer touch');
    await flushUntil(function() { return harness.requests.length === 2; }, 'latest queued touch was not dispatched after first completion');
    assert.strictEqual(harness.requests[1].body.text, '第三次触摸的最终回应。', 'only newest queued text may reach the worker');
    assert.strictEqual(harness.maxActiveRequests(), 1, 'second request must start only after first request completed');

    harness.requests[1].respond('/generated/latest.wav');
    assert.strictEqual(await third, true, 'latest queued touch should play after the worker becomes free');
    assert.strictEqual(harness.audio.playCalls, 1, 'only the newest audio result may be sent to browser playback');
    assert.deepStrictEqual(harness.requests.map(function(request) { return request.body.text; }), [
        '第一次触摸的旧回应。', '第三次触摸的最终回应。'
    ]);
}

function completePersona(name) {
    return {
        name: name,
        background: name + ' 的资料包背景',
        tone: name + ' 的资料包语气',
        avoid: '不要使用旧角色人设。',
        examples: '这是一句完整回应。'
    };
}

async function testRuntimePersonaComesFromActiveRoleBindingNotSharedCharacterId() {
    const payloads = [
        {
            models: [], preference: { active_model_id: 'legacy-model' },
            role_binding: {
                enforced: true, ready: true, active_role_id: 'voice-a', active_role_name: '语音 A',
                active_model_id: 'shared-model', model_character_id: '037', persona: completePersona('角色包 A')
            }
        },
        {
            models: [], preference: { active_model_id: 'legacy-model' },
            role_binding: {
                enforced: true, ready: true, active_role_id: 'voice-b', active_role_name: '语音 B',
                active_model_id: 'shared-model', model_character_id: '037', persona: completePersona('角色包 B')
            }
        }
    ];
    let fetchCount = 0;
    const context = {
        window: { addEventListener: function() {} },
        document: {
            getElementById: function() { return null; },
            createElement: function() { return { textContent: '', innerHTML: '' }; }
        },
        localStorage: {
            // A stale character-id override for the same 037 model must not
            // leak into either role's complete persisted persona.
            getItem: function(key) {
                if (key !== 'memo_live2d_personas') return null;
                return JSON.stringify({ 37: completePersona('旧 character_id 人设') });
            },
            setItem: function() {}
        },
        fetch: async function(path) {
            assert.strictEqual(path, '/api/live2d/models');
            const data = payloads[fetchCount++];
            return { ok: true, status: 200, json: async function() { return data; } };
        },
        console: { warn: function() {}, error: function() {}, log: function() {} },
        setTimeout: function() { return 1; }, clearTimeout: function() {},
        setInterval: function() { return 1; }, clearInterval: function() {},
        Promise: Promise, Date: Date
    };
    vm.createContext(context);
    vm.runInContext(companionSource, context, { filename: 'js/live2d-companion.js' });

    await vm.runInContext('Live2DModelManager.loadModels()', context);
    const personaA = JSON.parse(vm.runInContext('JSON.stringify(getActivePersona())', context));
    assert.deepStrictEqual(personaA, completePersona('角色包 A'));
    await vm.runInContext('Live2DModelManager.loadModels()', context);
    const personaB = JSON.parse(vm.runInContext('JSON.stringify(getActivePersona())', context));
    assert.deepStrictEqual(personaB, completePersona('角色包 B'));
    assert.notDeepStrictEqual(personaA, personaB, 'same character_id must support independent role personas');
    assert.strictEqual(fetchCount, 2);
}

async function testLegacyBrowserPersonaMigratesForIncompleteRoleBinding() {
    const migratedPersona = completePersona('旧浏览器覆盖角色');
    let fetchCount = 0;
    let migrationBody = null;
    const context = {
        window: { addEventListener: function() {} },
        document: {
            getElementById: function() { return null; },
            createElement: function() { return { textContent: '', innerHTML: '' }; }
        },
        localStorage: {
            getItem: function(key) {
                if (key === 'memo_live2d_personas') return JSON.stringify({ 37: migratedPersona });
                return null;
            },
            setItem: function() {}
        },
        fetch: async function(path, options) {
            fetchCount += 1;
            if (path === '/api/live2d/models') {
                return { ok: true, status: 200, json: async function() {
                    return {
                        models: [{ model_id: 'shared-model', character_id: '037' }],
                        preference: {},
                        role_binding: {
                            enforced: true, ready: false, active_role_id: 'voice-a',
                            active_role_name: '角色包 A', configured_model_id: 'shared-model',
                            persona: { name: '角色包 A', background: '', tone: '', avoid: '', examples: '' }
                        }
                    };
                } };
            }
            assert.strictEqual(path, '/api/tts/roles/voice-a/persona');
            migrationBody = JSON.parse(options.body);
            return { ok: true, status: 200, json: async function() { return { role: { persona: migratedPersona } }; } };
        }
    };
    vm.createContext(context);
    vm.runInContext(companionSource, context, { filename: 'js/live2d-companion.js' });
    await vm.runInContext('Live2DModelManager.loadModels()', context);
    const activePersona = JSON.parse(vm.runInContext('JSON.stringify(getActivePersona())', context));
    assert.deepStrictEqual(activePersona, migratedPersona, 'legacy browser profile should migrate into the incomplete role package');
    assert.strictEqual(migrationBody.persona.name, migratedPersona.name);
    assert.strictEqual(fetchCount, 2, 'loading an incomplete role may perform exactly one migration write');
}

function testLongPersonaKeepsStablePromptBudget() {
    const context = {
        window: { addEventListener: function() {} },
        document: { getElementById: function() { return null; }, createElement: function() { return { textContent: '', innerHTML: '' }; } },
        localStorage: { getItem: function() { return null; }, setItem: function() {} },
        console: { warn: function() {}, error: function() {}, log: function() {} },
        setTimeout: function() { return 1; }, clearTimeout: function() {},
        setInterval: function() { return 1; }, clearInterval: function() {}
    };
    vm.createContext(context);
    vm.runInContext(companionSource, context, { filename: 'js/live2d-companion.js' });
    const persona = {
        name: '角'.repeat(80), background: '背'.repeat(9000), tone: '语'.repeat(3000),
        avoid: '禁'.repeat(3000), examples: '例'.repeat(3000)
    };
    const prompt = vm.runInContext('personaSystemPrompt(' + JSON.stringify(persona) + ')', context);
    assert(prompt.includes('你现在扮演 `' + '角'.repeat(64) + '`。'), 'name budget must be 64 characters');
    assert(prompt.includes('语气要求：' + '语'.repeat(900)), 'tone must keep its reserved prompt budget');
    assert(prompt.includes('禁忌：' + '禁'.repeat(900)), 'guardrails must keep their reserved prompt budget');
    assert(prompt.includes('角色背景：' + '背'.repeat(3200)), 'background must support the expanded prompt budget');
    assert(prompt.includes('回复示例：' + '例'.repeat(900)), 'examples must keep their reserved prompt budget');
    assert(prompt.length < 6200, 'persona system prompt must stay within the fixed runtime budget');
}

Promise.resolve()
    .then(testRapidSpeechKeepsOnlyLatestQueuedReaction)
    .then(testRuntimePersonaComesFromActiveRoleBindingNotSharedCharacterId)
    .then(testLegacyBrowserPersonaMigratesForIncompleteRoleBinding)
    .then(testLongPersonaKeepsStablePromptBudget)
    .then(function() { console.log('TTS_SINGLE_FLIGHT_PERSONA_REGRESSION_PASS'); })
    .catch(function(error) { console.error(error); process.exitCode = 1; });
