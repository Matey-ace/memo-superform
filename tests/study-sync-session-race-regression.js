'use strict';

// A profile reset can happen while SQLite records for the previous account are
// still in flight. The late response must not reach the dashboard callback.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('js/study-sync-ui.js', 'utf8');
let resolveOldRecords;
let recordsCalls = 0;
const delivered = [];

const context = {
    console: console,
    Promise: Promise,
    Date: Date,
    Event: function() {},
    setTimeout: function() { return 1; },
    clearTimeout: function() {},
    window: { dispatchEvent: function() {}, confirm: function() { return false; } },
    document: {
        visibilityState: 'visible',
        getElementById: function() { return null; },
        querySelector: function() { return null; },
        querySelectorAll: function() { return []; }
    },
    MaimemoAPI: {
        hasToken: function() { return true; },
        getAllStudyRecords: function() {
            recordsCalls += 1;
            if (recordsCalls === 1) {
                return new Promise(function(resolve) { resolveOldRecords = resolve; });
            }
            return Promise.resolve([{ voc_id: 'new-account-word', voc_spelling: 'fresh' }]);
        },
        getStudySyncStatus: async function() { return { status: 'completed', active: false, changed: false }; },
        startStudySync: async function() { return { status: 'completed', active: false, changed: false }; },
        cancelStudySync: async function() { return { status: 'cancelled', active: false }; }
    }
};

vm.createContext(context);
vm.runInContext(source, context, { filename: 'js/study-sync-ui.js' });
const syncUI = vm.runInContext('StudySyncUI', context);

async function run() {
    syncUI.init({ onRecordsChanged: function(records) { delivered.push(records.map(function(record) { return record.voc_id; })); } });
    const oldLoad = syncUI.loadInitialData('old-account');
    syncUI.reset();
    await syncUI.loadInitialData('new-account');
    resolveOldRecords([{ voc_id: 'old-account-word', voc_spelling: 'stale' }]);
    const oldResult = await oldLoad;
    await Promise.resolve();

    assert.strictEqual(oldResult.stale, true, 'the old account load should report that its session was superseded');
    assert.deepStrictEqual(delivered, [['new-account-word']], 'only the new account records may be delivered to the dashboard');
}

run()
    .then(function() { console.log('STUDY_SYNC_SESSION_RACE_REGRESSION_PASS'); })
    .catch(function(error) { console.error(error); process.exitCode = 1; });
