'use strict';

// The companion is deliberately quiet during ordinary study events.  This
// regression coverage keeps that boundary, the user-configured reminder
// cadence, and the three explicit speech entry points deterministic without a
// browser, network, or TTS worker.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const companionSource = fs.readFileSync('js/live2d-companion.js', 'utf8');
const appSource = fs.readFileSync('js/app.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

function makeNode(id) {
    const attributes = {};
    return {
        id: id,
        dataset: {},
        style: {},
        textContent: '',
        innerHTML: '',
        hidden: false,
        disabled: false,
        classList: { add: function() {}, remove: function() {} },
        addEventListener: function() {},
        appendChild: function() {},
        removeAttribute: function(name) { delete attributes[name]; },
        setAttribute: function(name, value) { attributes[name] = String(value); },
        getBoundingClientRect: function() { return { left: 0, top: 0, width: 420, height: 360 }; }
    };
}

function flushPromises() {
    let pending = Promise.resolve();
    for (let index = 0; index < 12; index += 1) pending = pending.then(function() {});
    return pending;
}

function instrumentedCompanionSource() {
    const marker = /(\s+return\s+\{\s*)(init\s*:\s*init,\s*enter\s*:\s*enter,\s*exit\s*:\s*exit,\s*reloadModel\s*:\s*reloadModel,)/;
    assert(marker.test(companionSource), 'Live2DCompanion public API marker changed; update the speech-routing probe');
    return companionSource.replace(marker,
        '$1__testHooks: { onSessionSignal: onSessionSignal, askTouchAI: askTouchAI },\n        $2');
}

function companionHarness(storageValues) {
    const storage = Object.assign({
        tts_companion_enabled: 'true',
        companion_language: 'zh',
        companion_reminder_enabled: 'false',
        companion_reminder_minutes: '30'
    }, storageValues || {});
    const nodes = {};
    [
        'companionBubble', 'companionMood', 'companionSummary', 'companionCurrentWord',
        'companionAskBtn', 'companionBirthdayCard', 'companionBirthdayCardText',
        'closeCompanionBirthdayCard', 'companionLive2DHost', 'companionModelName'
    ].forEach(function(id) { nodes[id] = makeNode(id); });
    const speechCalls = [];
    const context = {
        window: {
            addEventListener: function() {},
            TTS: {
                isReady: function() { return true; },
                speak: function(text, options) {
                    speechCalls.push({ text: String(text), options: options || {} });
                    return Promise.resolve(true);
                },
                getLastError: function() { return ''; }
            }
        },
        document: {
            body: makeNode('body'),
            getElementById: function(id) { return nodes[id] || null; },
            createElement: function(tag) { return makeNode(tag); },
            querySelector: function() { return null; }
        },
        localStorage: {
            getItem: function(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
            setItem: function(key, value) { storage[key] = String(value); }
        },
        console: { warn: function() {}, error: function() {}, log: function() {} },
        Date: Date,
        Math: Math,
        Promise: Promise,
        setTimeout: function() { return 1; },
        clearTimeout: function() {},
        setInterval: function() { return 1; },
        clearInterval: function() {}
    };
    vm.createContext(context);
    vm.runInContext(instrumentedCompanionSource(), context, { filename: 'js/live2d-companion.js' });
    return { hooks: context.window.Live2DCompanion.__testHooks, speechCalls: speechCalls, storage: storage };
}

function sessionHarness(storageValues) {
    let now = 1000;
    const storage = Object.assign({
        companion_reminder_enabled: 'true',
        companion_reminder_minutes: '2'
    }, storageValues || {});
    function ClockDate() { return new Date(now); }
    ClockDate.now = function() { return now; };
    ClockDate.prototype = Date.prototype;
    const signals = [];
    const context = {
        window: { addEventListener: function() {} },
        document: { getElementById: function() { return null; }, createElement: function() { return makeNode('node'); } },
        localStorage: {
            getItem: function(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
            setItem: function(key, value) { storage[key] = String(value); }
        },
        console: { warn: function() {}, error: function() {}, log: function() {} },
        Date: ClockDate,
        Math: Math,
        Promise: Promise,
        setTimeout: function() { return 1; },
        clearTimeout: function() {},
        setInterval: function() { return 1; },
        clearInterval: function() {}
    };
    vm.createContext(context);
    vm.runInContext(companionSource, context, { filename: 'js/live2d-companion.js' });
    const session = context.window.CompanionSession.create(function(kind, summary) {
        signals.push({ kind: kind, summary: summary });
    });
    return {
        session: session,
        storage: storage,
        signals: signals,
        advance: function(milliseconds) { now += milliseconds; },
        reminderCount: function() { return signals.filter(function(signal) { return signal.kind === 'reminder'; }).length; }
    };
}

function summary() {
    return { count: 4, correct: 3, weak: 1, accuracy: 75, elapsed_minutes: 2, current_word: 'encourage', last_action: 'FAMILIAR' };
}

function testReminderSettingsAreExposedAndPersisted() {
    assert(index.includes('id="companionReminderEnabled"'), 'settings must expose the reminder enable switch');
    assert(index.includes('id="companionReminderMinutes"'), 'settings must expose the reminder interval input');
    assert(/id="companionReminderMinutes"[^>]*min="1"[^>]*max="180"/.test(index), 'reminder interval must be constrained to a safe minute range');
    assert(appSource.includes("localStorage.getItem('companion_reminder_enabled')"), 'settings must restore whether reminders are enabled');
    assert(appSource.includes("localStorage.setItem('companion_reminder_enabled'"), 'settings must persist whether reminders are enabled');
    assert(appSource.includes("localStorage.getItem('companion_reminder_minutes')"), 'settings must restore the reminder interval');
    assert(appSource.includes("localStorage.setItem('companion_reminder_minutes'"), 'settings must persist the reminder interval');
    assert(appSource.includes('companion-reminder-settings-changed'), 'open companion sessions must be notified when reminder settings change');
}

function testReminderCadenceUsesTheStoredSettingsWithoutPerWordFlooding() {
    const harness = sessionHarness({ companion_reminder_enabled: 'true', companion_reminder_minutes: '2' });
    harness.session.screen(true);
    harness.session.record({ action: 'FAMILIAR', word: 'first' });
    harness.advance(119999);
    harness.session.tick();
    assert.strictEqual(harness.reminderCount(), 0, 'a two-minute reminder must not fire early');

    harness.advance(1);
    harness.session.tick();
    assert.strictEqual(harness.reminderCount(), 1, 'a configured interval must emit one reminder');

    for (let index = 0; index < 24; index += 1) {
        harness.session.record({ action: 'FAMILIAR', word: 'word-' + index });
        harness.session.tick();
    }
    assert.strictEqual(harness.reminderCount(), 1, 'ordinary answers and ticks between intervals must not create reminder speech floods');

    harness.advance(119999);
    harness.session.tick();
    assert.strictEqual(harness.reminderCount(), 1, 'the next reminder must still wait for a full interval');
    harness.advance(1);
    harness.session.tick();
    assert.strictEqual(harness.reminderCount(), 2, 'reminders must resume once per configured interval');
}

function testDisabledAndChangedReminderSettingsAreHonored() {
    const harness = sessionHarness({ companion_reminder_enabled: 'false', companion_reminder_minutes: '1' });
    harness.session.screen(true);
    harness.session.record({ action: 'FAMILIAR', word: 'quiet' });
    harness.advance(10 * 60 * 1000);
    harness.session.tick();
    assert.strictEqual(harness.reminderCount(), 0, 'disabled reminders must stay silent regardless of elapsed study time');

    assert.strictEqual(typeof harness.session.refreshReminder, 'function', 'a live session must provide refreshReminder() for settings changes');
    harness.storage.companion_reminder_enabled = 'true';
    harness.storage.companion_reminder_minutes = '1';
    harness.session.refreshReminder();
    harness.advance(59999);
    harness.session.tick();
    assert.strictEqual(harness.reminderCount(), 0, 'enabling mid-session must begin a fresh full interval');
    harness.advance(1);
    harness.session.tick();
    assert.strictEqual(harness.reminderCount(), 1, 'the refreshed interval must honor the newly stored minute value');
}

async function testOnlyExplicitCompanionInteractionsSpeak() {
    const normal = companionHarness();
    ['started', 'state', 'milestone', 'needs-help', 'finish', 'focus-time'].forEach(function(kind) {
        normal.hooks.onSessionSignal(kind, summary());
    });
    await flushPromises();
    assert.strictEqual(normal.speechCalls.length, 0, 'normal study signals must update silently and never ask TTS to speak');

    const manual = companionHarness();
    manual.hooks.onSessionSignal('manual', summary());
    await flushPromises();
    assert.strictEqual(manual.speechCalls.length, 1, 'the explicit “看看” request must be allowed to speak');

    const reminder = companionHarness();
    reminder.hooks.onSessionSignal('reminder', summary());
    await flushPromises();
    assert.strictEqual(reminder.speechCalls.length, 1, 'a configured timed reminder must be allowed to speak');

    const head = companionHarness({ companion_language: 'ja' });
    await head.hooks.askTouchAI('head');
    await flushPromises();
    assert.strictEqual(head.speechCalls.length, 1, 'head touch must be allowed to speak');
    assert.strictEqual(head.speechCalls[0].options.language, '日文', 'Japanese head-touch speech must preserve the selected GPT-SoVITS text language');

    for (const region of ['hand', 'body', 'lower']) {
        const touch = companionHarness();
        await touch.hooks.askTouchAI(region);
        await flushPromises();
        assert.strictEqual(touch.speechCalls.length, 0, region + ' touch must remain visual/text-only and never request speech');
    }
}

Promise.resolve()
    .then(testReminderSettingsAreExposedAndPersisted)
    .then(testReminderCadenceUsesTheStoredSettingsWithoutPerWordFlooding)
    .then(testDisabledAndChangedReminderSettingsAreHonored)
    .then(testOnlyExplicitCompanionInteractionsSpeak)
    .then(function() { console.log('COMPANION_REMINDER_REGRESSION_PASS'); })
    .catch(function(error) { console.error(error); process.exitCode = 1; });
