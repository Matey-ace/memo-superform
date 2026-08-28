'use strict';

// Focused runtime contracts for the renderer failure path.  This uses a tiny
// DOM/PIXI fixture so we can exercise the closure-scoped renderer code without
// requiring a GPU in CI.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('js/live2d-companion.js', 'utf8');

function classList() {
    const values = new Set();
    return {
        add: function(name) { values.add(name); },
        remove: function(name) { values.delete(name); },
        contains: function(name) { return values.has(name); },
        toggle: function(name, force) { if (force === false) values.delete(name); else values.add(name); }
    };
}

function node(id, options) {
    const handlers = {};
    const attributes = {};
    const result = {
        id: id,
        hidden: false,
        textContent: '',
        innerHTML: '',
        value: '',
        dataset: {},
        style: {},
        classList: classList(),
        clientWidth: options && options.width || 420,
        clientHeight: options && options.height || 360,
        handlers: handlers,
        addEventListener: function(type, handler) { handlers[type] = handler; },
        setAttribute: function(name, value) { attributes[name] = String(value); },
        removeAttribute: function(name) { delete attributes[name]; },
        getAttribute: function(name) { return attributes[name]; },
        appendChild: function(child) { if (child) child.parentNode = result; },
        removeChild: function(child) { if (child) child.parentNode = null; },
        remove: function() { if (result.parentNode && result.parentNode.removeChild) result.parentNode.removeChild(result); },
        getBoundingClientRect: function() {
            return { left: 0, top: 0, width: result.clientWidth, height: result.clientHeight };
        }
    };
    if (options && options.canvas) result.getContext = options.getContext;
    return result;
}

function buildHarness(options) {
    const ids = [
        'companionModeBtn', 'exitCompanionModeBtn', 'companionAskBtn', 'closeCompanionBirthdayCard',
        'dashboard', 'companionStudy', 'companionBirthdayCard', 'companionStudyFrame',
        'companionLive2DHost', 'companionGifFallback', 'companionModelName', 'companionLive2DCanvas',
        'companionBubble', 'companionMood', 'companionBirthdayBadge', 'companionTitle'
    ];
    const nodes = {};
    ids.forEach(function(id) {
        nodes[id] = node(id, id === 'companionLive2DHost' ? { width: 420, height: 360 } : undefined);
    });
    nodes.companionLive2DCanvas.getContext = options.getContext;
    nodes.body = node('body');
    const probeContexts = [];
    const document = {
        body: nodes.body,
        getElementById: function(id) { return nodes[id] || null; },
        createElement: function(tag) {
            if (tag === 'canvas') {
                return {
                    getContext: function(kind) {
                        probeContexts.push(kind);
                        return options.getContext(kind);
                    }
                };
            }
            const area = node(tag);
            area.select = function() {};
            area.remove = function() {};
            return area;
        },
        execCommand: function(command) { return command === 'copy'; }
    };
    const model = {
        model_id: 'test-model', display_name: '诊断测试模型', entry_file: 'memo.model.json', character_id: '999'
    };
    const models = options.models || [model];
    const preference = options.preference || { active_model_id: model.model_id, companion_enabled: true };
    const roleBinding = Object.prototype.hasOwnProperty.call(options, 'roleBinding') ? options.roleBinding : {
        enforced: true, ready: true, active_role_id: 'test-role', active_role_name: '诊断测试角色', active_model_id: model.model_id
    };
    const storage = Object.assign({}, options.storage || {});
    const window = {
        PIXI: options.pixi,
        Live2D: {},
        addEventListener: function() {},
        TTS: options.tts
    };
    const context = {
        window: window,
        PIXI: options.pixi,
        document: document,
        console: console,
        Promise: Promise,
        Date: Date,
        setTimeout: function() { return 1; },
        clearTimeout: function() {},
        setInterval: function() { return 1; },
        clearInterval: function() {},
        localStorage: {
            getItem: function(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
            setItem: function(key, value) { storage[key] = String(value); }
        },
        fetch: async function(path) {
            assert.strictEqual(path, '/api/live2d/models');
            return { ok: true, json: async function() { return { models: models, preference: preference, role_binding: roleBinding }; } };
        },
        StudyWeb: { render: function() { return { dispose: function() {} }; } }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'js/live2d-companion.js' });
    return { context: context, nodes: nodes, probeContexts: probeContexts, model: model };
}

async function testLoaderFailureDiagnostic() {
    function Application() { throw new Error('renderer failed at C:\\Users\\Matey\\private\\model.moc'); }
    const harness = buildHarness({
        getContext: function(kind) {
            if (kind !== 'webgl2') return null;
            return { getExtension: function() { return { loseContext: function() {} }; } };
        },
        pixi: { VERSION: '6.5.10', Application: Application, live2d: { Live2DModel: { from: async function() {} } } }
    });
    harness.context.window.Live2DCompanion.init();
    await harness.context.window.Live2DCompanion.enter();
    const diagnostic = harness.context.window.Live2DCompanion.getRendererDiagnostic();
    const bubble = harness.nodes.companionBubble;
    assert(diagnostic.includes('L2D_LOAD_FAILED'), 'loader failure needs a stable diagnostic code');
    assert(diagnostic.includes('WebGL 上下文：WebGL2 可用'), 'diagnostic should include WebGL status');
    assert(diagnostic.includes('PIXI：已加载（6.5.10）'), 'diagnostic should include PIXI status');
    assert(diagnostic.includes('/api/live2d/assets/test-model/memo.model.json'), 'diagnostic should include safe model URL');
    assert(diagnostic.includes('[本地路径]'), 'local failure paths must be redacted');
    assert(!diagnostic.includes('C:\\Users\\Matey'), 'local user path leaked through diagnostic');
    assert(bubble.classList.contains('has-renderer-diagnostic'), 'failure must remain visibly styled in the companion bubble');
    assert.strictEqual(harness.nodes.companionGifFallback.hidden, false, 'fallback must remain visible on failure');
    assert(harness.probeContexts.includes('webgl2'), 'renderer should preflight a WebGL context');
    harness.nodes.companionModelName.handlers.click();
    assert.strictEqual(harness.nodes.companionModelName.dataset.live2dRendererCopied, 'true', 'model tag should offer copyable diagnostics');
}

async function testMissingWebGLDiagnostic() {
    const harness = buildHarness({
        getContext: function() { return null; },
        pixi: { VERSION: '6.5.10', Application: function() {}, live2d: { Live2DModel: { from: async function() {} } } }
    });
    harness.context.window.Live2DCompanion.init();
    await harness.context.window.Live2DCompanion.enter();
    const diagnostic = harness.context.window.Live2DCompanion.getRendererDiagnostic();
    assert(diagnostic.includes('L2D_WEBGL_UNAVAILABLE'), 'missing WebGL must not silently fall back');
    assert(diagnostic.includes('WebGL 上下文：不可用'), 'missing WebGL reason should be visible');
    assert.strictEqual(harness.nodes.companionGifFallback.hidden, false, 'fallback must survive the WebGL preflight failure');
}

async function testSuccessfulRendererKeepsNormalFlow() {
    function Application() {
        this.stage = { addChild: function() {} };
        this.renderer = { screen: { width: 420, height: 360 }, resize: function() {} };
        this.destroy = function() {};
    }
    const harness = buildHarness({
        getContext: function(kind) {
            if (kind !== 'webgl2') return null;
            return { getExtension: function() { return { loseContext: function() {} }; } };
        },
        pixi: {
            VERSION: '6.5.10',
            Application: Application,
            live2d: {
                Live2DModel: {
                    from: async function() {
                        return {
                            width: 300, height: 400,
                            anchor: { set: function() {} },
                            scale: { set: function() {} },
                            motion: function() {},
                            destroy: function() {}
                        };
                    }
                }
            }
        }
    });
    harness.context.window.Live2DCompanion.init();
    await harness.context.window.Live2DCompanion.enter();
    assert.strictEqual(harness.context.window.Live2DCompanion.getRendererDiagnostic(), '', 'successful renderer should clear stale diagnostics');
    assert.strictEqual(harness.nodes.companionGifFallback.hidden, true, 'successful renderer must hide fallback');
    assert.strictEqual(harness.nodes.companionModelName.textContent, '诊断测试模型', 'successful renderer keeps the normal model label');
    assert(!harness.nodes.companionBubble.classList.contains('has-renderer-diagnostic'), 'successful renderer keeps normal dialogue styling');
}

async function testRoleBindingWinsOverLegacyPreference() {
    const legacy = { model_id: 'legacy-model', display_name: '旧偏好模型', entry_file: 'legacy.model.json', character_id: '036' };
    const bound = { model_id: 'role-model', display_name: '角色绑定模型', entry_file: 'role.model.json', character_id: '037' };
    const loadedUrls = [];
    function Application() {
        this.stage = { addChild: function() {} };
        this.renderer = { screen: { width: 420, height: 360 }, resize: function() {} };
        this.destroy = function() {};
    }
    const harness = buildHarness({
        getContext: function(kind) {
            if (kind !== 'webgl2') return null;
            return { getExtension: function() { return { loseContext: function() {} }; } };
        },
        models: [legacy, bound],
        preference: { active_model_id: legacy.model_id, companion_enabled: true },
        roleBinding: {
            enforced: true, ready: true, active_role_id: 'ayon', active_role_name: '千早爱音', active_model_id: bound.model_id
        },
        pixi: {
            VERSION: '6.5.10',
            Application: Application,
            live2d: {
                Live2DModel: {
                    from: async function(url) {
                        loadedUrls.push(url);
                        return {
                            width: 300, height: 400,
                            anchor: { set: function() {} }, scale: { set: function() {} },
                            motion: function() {}, destroy: function() {}
                        };
                    }
                }
            }
        }
    });
    harness.context.window.Live2DCompanion.init();
    await harness.context.window.Live2DCompanion.enter();
    assert.strictEqual(harness.context.window.Live2DModelManager.current().model_id, bound.model_id, 'enforced role binding must override legacy active-model preference');
    assert.strictEqual(loadedUrls.length, 1, 'only the role-bound model should reach the renderer');
    assert(loadedUrls[0].includes('/role-model/role.model.json'), 'renderer loaded legacy preference instead of active role binding');
    assert(!loadedUrls[0].includes('legacy-model'), 'legacy preference leaked into the renderer URL');
    assert(harness.nodes.companionTitle.textContent.includes('千早爱音'), 'companion title must follow the enabled role name');
}

async function testFallbackTouchStillReactsAndSpeaks() {
    const spoken = [];
    const harness = buildHarness({
        getContext: function() { return null; },
        storage: { tts_companion_enabled: 'true' },
        tts: {
            isReady: function() { return true; },
            speak: function(text) { spoken.push(text); return Promise.resolve(true); },
            getLastError: function() { return ''; }
        },
        pixi: { VERSION: '6.5.10', Application: function() {}, live2d: { Live2DModel: { from: async function() {} } } }
    });
    harness.context.window.Live2DCompanion.init();
    await harness.context.window.Live2DCompanion.enter();
    assert.strictEqual(harness.nodes.companionGifFallback.hidden, false, 'test fixture must exercise the fallback renderer path');
    const pointerUp = harness.nodes.companionLive2DHost.handlers.pointerup;
    assert.strictEqual(typeof pointerUp, 'function', 'fallback host must receive the touch handler');
    pointerUp({ target: harness.nodes.companionGifFallback, clientX: 210, clientY: 75 });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(spoken.length, 1, 'touching the fallback image must still route its reaction through the enabled role voice');
    assert(spoken[0].length >= 4, 'fallback touch must produce a complete local reaction rather than an empty utterance');
    assert(harness.nodes.companionBubble.textContent.length >= 4, 'fallback touch must visibly acknowledge the interaction');
}

Promise.resolve()
    .then(testLoaderFailureDiagnostic)
    .then(testMissingWebGLDiagnostic)
    .then(testSuccessfulRendererKeepsNormalFlow)
    .then(testRoleBindingWinsOverLegacyPreference)
    .then(testFallbackTouchStillReactsAndSpeaks)
    .then(function() { console.log('LIVE2D_RENDERER_DIAGNOSTICS_PASS'); })
    .catch(function(error) { console.error(error); process.exitCode = 1; });
