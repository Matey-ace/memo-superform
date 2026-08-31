'use strict';

// Static browser contracts for the in-app updater. Backend integrity and
// helper replacement behavior live in test_app_update.py; this keeps the UI
// test independent of a running local server or GitHub connection.
const assert = require('assert');
const fs = require('fs');

const index = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('js/app.js', 'utf8');
const update = fs.readFileSync('js/app-update.js', 'utf8');
const syncUI = fs.readFileSync('js/study-sync-ui.js', 'utf8');
const standardCss = fs.readFileSync('css/style.css', 'utf8');
const notebookCss = fs.readFileSync('css/style-anon.css', 'utf8');

for (const id of [
    'appUpdateCurrentVersion', 'appUpdateStatus', 'appUpdateCheckBtn', 'appUpdateInstallBtn',
    'appUpdateModal', 'appUpdateModalNotes', 'appUpdateModalPrimaryBtn', 'appUpdateLaterBtn'
]) {
    assert(index.includes('id="' + id + '"'), 'missing update UI node: ' + id);
}
const updateScriptIndex = index.indexOf('js/app-update.js');
const appScriptIndex = index.indexOf('js/app.js');
assert(updateScriptIndex >= 0 && updateScriptIndex < appScriptIndex, 'update module must load before App.init');
assert(app.includes('window.AppUpdate.init'), 'App.init must start a non-blocking update check');
assert(update.includes("'/api/app/update-status'"), 'client must ask the local update-status API');
assert(update.includes("'/api/app/update/download'"), 'client is missing download route');
assert(update.includes("'/api/app/update/apply'"), 'client is missing install route');
assert(update.includes("'X-Requested-With': 'XMLHttpRequest'"), 'update mutations must use the local CSRF header');
assert(update.includes('info.update_available && info.important'), 'only important updates may auto-open the modal');
assert(update.includes('REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000'), 'later reminder must suppress only 24 hours');
assert(update.includes('textContent = String(info.release_notes'), 'release notes must be rendered as text');
assert(!update.includes('innerHTML'), 'release notes must never be inserted as HTML');
assert(update.includes("document.addEventListener('keydown'"), 'modal must trap Escape before lower overlays');
assert(update.includes('event.stopPropagation()'), 'Escape must not close settings behind the update modal');
assert(syncUI.includes('.app-update-modal.show'), 'study sync must consider the update modal a non-idle overlay');
for (const css of [standardCss, notebookCss]) {
    assert(css.includes('.app-update-modal'), 'both themes need the update modal layer');
    assert(css.includes('z-index: 3000'), 'update modal must sit above settings/fullscreen overlays');
}

console.log('APP_UPDATE_UI_REGRESSION_PASS');
