'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const {execFileSync} = require('child_process');
const storage = new Map();
const context = vm.createContext({console, localStorage: {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value)
}});
vm.runInContext(fs.readFileSync('js/study-shortcuts.js', 'utf8') + '\nthis.shortcuts = StudyShortcuts;', context);
const api = context.shortcuts;
function event(key, extra = {}) {
    return {key, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, ...extra};
}
assert.equal(api.findShortcutAction(api.defaultShortcuts(), event('s')), 'SHOW_ANSWER');
assert.equal(api.findShortcutAction(api.defaultShortcuts(), event(' ')), 'START_SPELLING');
assert.equal(api.findShortcutAction(api.defaultShortcuts(), event('s', {isComposing: true})), undefined);
assert.equal(api.findShortcutAction(api.defaultShortcuts(), event('s', {keyCode: 229})), undefined);
assert.equal(api.findShortcutAction(api.defaultShortcuts(), event('s', {ctrlKey: true})), undefined);
storage.set('shortcut_settings', JSON.stringify({version: 1, enabled: false, shortcuts: {FAMILIAR: {key: 'j', modifiers: []}}}));
storage.set('memo_study_shortcuts', JSON.stringify({know: 'k'}));
assert.equal(api.loadShortcuts().FAMILIAR.key, 'J', 'legacy settings must not override the current binding');
api.saveShortcuts(api.loadShortcuts());
let saved = JSON.parse(storage.get('shortcut_settings'));
assert.equal(saved.shortcuts.FAMILIAR.key, 'j', 'upstream matches lowercase event.key');
assert.equal(saved.enabled, false, 'preserve unrelated settings');
let events = [];
class KeyboardEvent { constructor(type, options) { Object.assign(this, options, {type}); } }
const doc = {body: {dispatchEvent: e => events.push(e)}, dispatchEvent: e => events.push(e)};
const iframe = {contentDocument: doc, contentWindow: {KeyboardEvent}};
assert(api.sendKey(iframe, 'Space'));
assert.deepEqual(events.map(e => [e.type, e.key, e.code, e.keyCode]), [
    ['keydown', ' ', 'Space', 32], ['keyup', ' ', 'Space', 32]
]);
events = [];
api.sendKey(iframe, {key: 'S', modifiers: []});
assert.equal(events.length, 2, 'one down/up pair per action');
assert.equal(events[0].key, 's');
assert.equal(events[0].code, 'KeyS');
assert.equal(api.sendKey(null, 'Space'), false);
const injection = execFileSync(process.env.PYTHON || 'python', ['-c', 'from memo_injection import MEMO_STUDY_KEYS_JS; print(MEMO_STUDY_KEYS_JS)'], {encoding: 'utf8'});
const inline = injection.match(/<script>\(function\(\)\{[\s\S]*<\/script>/)[0].replace(/^<script>|<\/script>$/g, '');
context.location = {pathname: '/memo-tc/webstudy/app'};
context.window = {};
vm.runInContext('StudyShortcuts.installSpellingGuard = function() {};', context);
saved = {version: 1, enabled: false, shortcuts: {START_SPELLING: {key: 'F2', enabled: false}, SHOW_ANSWER: {key: 'Space'}}};
storage.set('shortcut_settings', JSON.stringify(saved));
vm.runInContext(inline, context);
assert.deepEqual(JSON.parse(storage.get('shortcut_settings')), saved, 'page load preserves custom and disabled bindings');
storage.delete('shortcut_settings');
vm.runInContext(inline, context);
saved = JSON.parse(storage.get('shortcut_settings'));
assert.equal(saved.shortcuts.START_SPELLING.key, 'Space');
assert.equal(saved.shortcuts.SHOW_ANSWER.key, 's');
console.log('STUDY_KEYBOARD_PASS: dispatch, key normalization, IME, persistence and migration');
