/*
 * Focused regression contract for the single role-package upload workflow.
 * Kept separate from the broad UI smoke test because this replaces the older
 * standalone model-drop-zone contract.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = function(file) { return fs.readFileSync(path.join(root, file), 'utf8'); };
const index = read('index.html');
const app = read('js/app.js');

assert(!index.includes('id="ttsModelDrop"'), 'standalone TTS model drop zone must be removed');
assert(!app.includes('uploadTTSModel'), 'standalone TTS model uploader must be removed');
assert(index.includes('ttsRoleIndexFile'), 'role editor needs an optional .index input');
assert(index.includes('选中角色（编辑 / 上传目标）'), 'selected role must be described as the upload target');
assert(index.includes('ttsRoleEditorContext'), 'editor must identify the role being edited');
assert(index.includes('ttsRoleSelectionHint'), 'UI must distinguish selected and active roles');

for (const id of ['ttsRoleGptFile', 'ttsRoleSovitsFile', 'ttsRoleIndexFile', 'ttsRoleAudioFile']) {
    assert(app.includes("'" + id + "'"), 'role file input is not managed: ' + id);
}
const fixedId = app.indexOf('if (roleId) roleId.value = id;');
const metadataBody = app.indexOf('const body = { role_id: id');
assert(fixedId >= 0 && fixedId < metadataBody, 'new role ID must be fixed before saving metadata');
const ckpt = app.indexOf("kind: 'ckpt'");
const pth = app.indexOf("kind: 'pth'");
const indexFile = app.indexOf("kind: 'index'");
const audio = app.indexOf("kind: 'audio'");
assert(ckpt >= 0 && ckpt < pth && pth < indexFile && indexFile < audio, 'assets must upload in ckpt, pth, index, audio order');
assert(app.includes('setRoleSaveLock(true)'), 'editor controls must lock during a role save');
assert(app.includes('function closeRoleEditor()'), 'role editor must have one close path');
assert(app.includes('clearRoleFileInputs();'), 'cancel must clear pending files before closing the editor');
assert(app.includes('setRoleEditorSelectionLock(true)'), 'opening the editor must lock selected-role controls');

// Existing role assets are now staged.  These checks deliberately assert the
// ordering rather than merely looking for the three endpoints independently:
// an interrupted upload must never expose a half-new voice package.
const begin = app.indexOf("'/begin-update'");
const stageUpload = app.indexOf('await uploadSelectedAssets(batchId);');
const commit = app.indexOf("'/commit-update'");
const discard = app.indexOf("'/discard-update'");
assert(begin >= 0 && begin < stageUpload && stageUpload < commit, 'existing role update must begin, stage every selected asset, then commit');
assert(discard >= 0 && discard < begin, 'failed staged updates must have a discard path before commit is attempted');
assert(app.includes("'&batch=' + encodeURIComponent(batchId)"), 'every staged asset upload must include the batch id');
assert(app.includes('await discardRoleUpdate(id, batchId);'), 'failed staged updates must be discarded');
assert(app.includes('editingExistingRole && selectedAssets.length'), 'only existing roles with new assets should enter the staged update transaction');
assert(app.includes("postRoleJson('/api/tts/roles', body)"), 'new role drafts must first receive their own role id before direct draft uploads');
assert(app.includes("await uploadSelectedAssets();"), 'new role drafts must still upload their selected assets into their own package');

const runtimeStart = app.indexOf('async function refreshActiveRoleRuntime()');
const runtimeEnd = app.indexOf('async function saveRoleEditor()', runtimeStart);
const runtimeRefresh = app.slice(runtimeStart, runtimeEnd);
const refreshModels = runtimeRefresh.indexOf('await window.Live2DModelManager.loadModels()');
const reloadModel = runtimeRefresh.indexOf('return window.Live2DCompanion.reloadModel()');
assert(refreshModels >= 0 && refreshModels < reloadModel, 'Live2D manager must refresh before renderer reload');
assert(app.includes("body: JSON.stringify({})"), 'preload must let the server resolve the active role');

// The old library-level selector was the second conflicting selection path.
// The library now only manages installed assets; binding happens in this editor.
const companion = read('js/live2d-companion.js');
assert(!companion.includes('selectModel'), 'Live2D model library still exposes an independent active-model selector');
assert(!companion.includes('data-live2d-select'), 'Live2D model library still renders a direct selection button');
assert(companion.includes('当前陪伴由已启用角色'), 'Live2D library must explain that the active role owns the binding');
assert(companion.includes('data-live2d-remove'), 'Live2D model library must retain asset removal controls');

console.log('role upload UI regression checks passed');
