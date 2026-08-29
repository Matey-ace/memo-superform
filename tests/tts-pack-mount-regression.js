'use strict';

// Static UI contract for large voice-pack mounting.  The actual ZIP safety and
// transactional replacement behavior is covered by test_tts_pack_mount.py.
const assert = require('assert');
const fs = require('fs');

const index = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('js/app.js', 'utf8');
const api = fs.readFileSync('app_api.py', 'utf8');
const tts = fs.readFileSync('tts.py', 'utf8');

for (const id of ['ttsPackMountDropzone', 'ttsPackMountInput', 'ttsPackMountBrowseBtn', 'ttsPackMountStatus', 'ttsPackMountMissing']) {
    assert(index.includes('id="' + id + '"'), 'missing quick-mount control: ' + id);
}
assert(index.includes('ZIP 至少需包含有效的'), 'drop target must explain the minimum ZIP requirement');
assert(app.includes("'/api/tts/mount-pack?name='"), 'quick-mount client is missing its API route');
assert(app.includes("'Content-Type': 'application/zip'"), 'quick-mount client must declare a ZIP body');
const mountStart = app.indexOf('async function mountTtsPack(file)');
const mountEnd = app.indexOf('function selectTtsPack(files)', mountStart);
assert(mountStart >= 0 && mountEnd > mountStart, 'quick-mount handler bounds changed');
const mountHandler = app.slice(mountStart, mountEnd);
assert(mountHandler.includes('body: file'), 'quick-mount client must pass the File directly for streaming');
assert(!mountHandler.includes('await file.arrayBuffer'), 'quick-mount must not duplicate a large archive in browser memory');
for (const eventName of ['dragover', 'dragleave', 'drop']) {
    assert(app.includes("addEventListener('" + eventName + "'"), 'missing quick-mount drag event: ' + eventName);
}
assert(app.includes('await TTS.refresh();'), 'quick-mount must refresh the post-mount TTS status');
assert(app.includes('await loadRoles();'), 'quick-mount must refresh mounted roles');
for (const contract of ['renderPackMountMissing', 'runtime_missing', 'incomplete_roles', 'data.complete']) {
    assert(app.includes(contract), 'quick-mount UI is missing partial-package feedback: ' + contract);
}
assert(api.includes('path == "/api/tts/mount-pack"'), 'local API is missing the quick-mount endpoint');
assert(api.includes('mount_tts_pack_stream'), 'local API must pass the archive as a stream');
assert(tts.includes('def mount_tts_pack_stream'), 'TTS layer must receive the archive stream');
assert(tts.includes('def mount_tts_pack_archive'), 'TTS layer must validate and install the staged archive');
for (const contract of ['_safe_zip_member_parts', '_extract_tts_pack_archive', '_replace_tts_pack_atomically', '_check_tts_pack_can_be_replaced']) {
    assert(tts.includes(contract), 'missing safe mount contract: ' + contract);
}
for (const contract of ['_inspect_tts_pack_root', '_runtime_layout_missing', '"incomplete_roles"']) {
    assert(tts.includes(contract), 'partial-package backend contract is missing: ' + contract);
}
assert(!tts.includes('def _validate_tts_pack_root'), 'mounting must no longer reject a structurally valid partial package');

console.log('tts pack quick-mount UI regression checks passed');
