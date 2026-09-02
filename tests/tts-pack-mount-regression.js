'use strict';

// Static UI/API contract for the large voice-pack importer. ZIP safety and
// transactional replacement behaviour live in test_tts_pack_mount.py.
const assert = require('assert');
const fs = require('fs');

const index = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('js/app.js', 'utf8');
const api = fs.readFileSync('app_api.py', 'utf8');
const tts = fs.readFileSync('tts.py', 'utf8');
const launcher = fs.readFileSync('launcher.py', 'utf8');

const importDisclosureStart = index.indexOf('<details class="tts-settings-disclosure tts-pack-disclosure">');
const importDisclosureEnd = index.indexOf('</details>', importDisclosureStart);
assert(importDisclosureStart >= 0 && importDisclosureEnd > importDisclosureStart,
    'quick mounting must be grouped under the collapsible import-voice-pack section');
for (const id of [
    'ttsPackMountDropzone', 'ttsPackMountInput', 'ttsPackMountBrowseBtn',
    'ttsPackMountNativeBtn', 'ttsPackMountProgressWrap', 'ttsPackMountProgress',
    'ttsPackMountProgressText', 'ttsPackMountStatus', 'ttsPackMountMissing'
]) {
    assert(index.includes('id="' + id + '"'), 'missing quick-mount control: ' + id);
    const position = index.indexOf('id="' + id + '"');
    assert(position > importDisclosureStart && position < importDisclosureEnd,
        'quick-mount control must remain inside import disclosure: ' + id);
}
assert(index.includes('直接后台安装大型 ZIP'), 'drop target must explain native background import');

assert(app.includes("'/api/tts/mount-pack?name='"), 'browser fallback route is missing');
assert(app.includes("'Content-Type': 'application/zip'"), 'browser fallback must declare a ZIP body');
const mountStart = app.indexOf('async function mountTtsPack(file)');
const mountEnd = app.indexOf('function selectTtsPack(files)', mountStart);
assert(mountStart >= 0 && mountEnd > mountStart, 'quick-mount handler bounds changed');
const mountHandler = app.slice(mountStart, mountEnd);
assert(mountHandler.includes('TTS_PACK_WEB_UPLOAD_MAX_BYTES'), 'browser fallback needs a small-package cap');
assert(mountHandler.includes('isDesktopShell()'), 'desktop shell must bypass browser upload');
assert(mountHandler.includes('body: file'), 'small browser fallback must stream the File directly');
assert(!mountHandler.includes('await file.arrayBuffer'), 'quick-mount must not duplicate a ZIP in browser memory');
for (const contract of [
    'getNativeTtsPackBridge', 'chooseNativeTtsPack', 'startPackMountPolling',
    'startNativeDroppedPack', 'discardNativeDroppedPack', 'pywebviewready',
    'memoNativeTtsPackReady', 'memoTtsPackDropPending', 'sessionStorage'
]) {
    assert(app.includes(contract), 'desktop mount client is missing: ' + contract);
}
assert(app.includes("/api/tts/mount-pack/jobs/"), 'client must poll job state');
for (const eventName of ['dragover', 'dragleave', 'drop']) {
    assert(app.includes("addEventListener('" + eventName + "'"), 'missing quick-mount drag event: ' + eventName);
}
assert(app.includes('await TTS.refresh();'), 'quick-mount must refresh post-mount TTS status');
assert(app.includes('await loadRoles();'), 'quick-mount must refresh mounted roles');
for (const contract of ['renderPackMountMissing', 'runtime_missing', 'incomplete_roles', 'data.complete']) {
    assert(app.includes(contract), 'quick-mount UI is missing partial-package feedback: ' + contract);
}

assert(api.includes('path == "/api/tts/mount-pack"'), 'local API is missing the quick-mount endpoint');
assert(api.includes('path.startswith("/api/tts/mount-pack/jobs/")'), 'local API is missing job status');
assert(api.includes('start_stream('), 'small web upload must enter the background job manager');
assert(api.includes('TTS_PACK_WEB_UPLOAD_MAX_BYTES'), 'server must reject oversized web uploads');
assert(tts.includes('class TTSPackMountJobManager'), 'TTS layer is missing the background job manager');
for (const contract of [
    'start_local_archive', 'start_stream', 'recover_stale_staging',
    'TTS_PACK_WEB_UPLOAD_MAX_BYTES', 'def mount_tts_pack_stream',
    'def mount_tts_pack_archive', '_safe_zip_member_parts',
    '_extract_tts_pack_archive', '_replace_tts_pack_atomically',
    '_check_tts_pack_can_be_replaced'
]) {
    assert(tts.includes(contract), 'missing safe/background mount contract: ' + contract);
}
for (const contract of ['_inspect_tts_pack_root', '_runtime_layout_missing', '"incomplete_roles"']) {
    assert(tts.includes(contract), 'partial-package backend contract is missing: ' + contract);
}
assert(tts.includes('_PERSONA_FILENAME') && tts.includes('角色人设'),
    'a mounted role package must report a missing persona.json profile alongside missing voice assets');
assert(!tts.includes('def _validate_tts_pack_root'), 'mounting must not reject a structurally valid partial package');

for (const contract of [
    'class _DesktopTtsPackBridge', 'js_api=desktop_tts_bridge',
    'create_file_dialog', 'pywebviewFullPath', 'memoTtsPackDropPending',
    'start_tts_pack_drop', 'discard_tts_pack_drop',
    'is_tts_pack_mount_active', 'window.events.before_load'
]) {
    assert(launcher.includes(contract), 'desktop native bridge is missing: ' + contract);
}

console.log('tts pack native background-mount regression checks passed');
