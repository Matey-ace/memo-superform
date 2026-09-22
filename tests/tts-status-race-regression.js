'use strict';

// A slow status response from before a voice-pack switch must not overwrite
// the newer mounting state. This runs the public TTS client in a minimal VM
// harness rather than relying on a browser timing accident.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('js/tts.js', 'utf8');

class SilentAudio {
    pause() {}
    play() { return Promise.resolve(); }
    addEventListener() {}
    removeEventListener() {}
}

async function testLatestStatusWinsAndMountingBlocksSpeech() {
    let resolveFirst;
    let calls = 0;
    const context = {
        Audio: SilentAudio,
        AbortController: AbortController,
        Promise: Promise,
        setTimeout: function() { return 1; },
        clearTimeout: function() {},
        localStorage: { getItem: function() { return null; }, setItem: function() {} },
        fetch: function(path) {
            assert.strictEqual(path, '/api/tts/status');
            calls += 1;
            if (calls === 1) {
                return new Promise(function(resolve) { resolveFirst = resolve; });
            }
            return Promise.resolve({
                ok: true,
                json: async function() {
                    return {
                        enabled: true, engine_ready: true, role_ready: true,
                        runtime_ready: true, mounting: true
                    };
                }
            });
        }
    };
    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'js/tts.js' });

    const stale = context.TTS.refresh();
    await context.TTS.refresh();
    resolveFirst({
        ok: true,
        json: async function() {
            return {
                enabled: false, engine_ready: false, role_ready: false,
                runtime_ready: false, mounting: false
            };
        }
    });
    await stale;

    const status = context.TTS.getStatus();
    assert.strictEqual(status.mounting, true, 'the newer mount state must remain authoritative');
    assert.strictEqual(status.enabled, true, 'the older response must not overwrite shared status');
    assert.strictEqual(context.TTS.isReady(), false, 'speech must stay blocked while a pack is mounting');
}

testLatestStatusWinsAndMountingBlocksSpeech()
    .then(function() { console.log('TTS_STATUS_RACE_REGRESSION_PASS'); })
    .catch(function(error) { console.error(error); process.exitCode = 1; });
