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

// The profile is now part of the role package rather than an unrelated Live2D
// preference.  Its form must come before binding any model or voice assets.
const dossierStart = index.indexOf('class="tts-role-editor-section tts-role-dossier"');
const bindingsStart = index.indexOf('class="tts-role-editor-section tts-role-bindings"');
assert(dossierStart >= 0 && bindingsStart > dossierStart, 'role dossier must precede asset bindings');
assert(index.slice(dossierStart, bindingsStart).includes('persona.json'), 'dossier must identify persona.json as its stored profile');
assert(!index.includes('id="ttsRoleName"'), 'the obsolete duplicate role-name field must stay removed');
assert(!index.includes('id="live2d-persona-settings"'), 'the independent Live2D persona section must stay removed');
assert(index.includes('<input id="ttsRoleId" type="hidden">'), 'role ID must stay internal to the editor');
for (const [id, maximum] of [
    ['ttsRolePersonaName', 64], ['ttsRolePersonaBackground', 8000],
    ['ttsRolePersonaTone', 2000], ['ttsRolePersonaAvoid', 2000],
    ['ttsRolePersonaExamples', 2000]
]) {
    const fieldStart = index.indexOf('id="' + id + '"');
    const fieldEnd = index.indexOf('>', fieldStart);
    assert(fieldStart >= 0, 'missing dossier field: ' + id);
    assert(index.slice(fieldStart, fieldEnd).includes('maxlength="' + maximum + '"'), 'missing field size guard: ' + id);
}
for (const id of ['ttsRolePersonaTotalCount', 'ttsRolePersonaImportInput', 'ttsRolePersonaImportBtn', 'ttsRolePersonaExportBtn', 'ttsRolePersonaResetBtn']) {
    assert(index.includes('id="' + id + '"'), 'missing dossier action: ' + id);
}
assert(app.includes("const ROLE_PERSONA_JSON_KEYS = ['版本', '角色', '语气', '背景', '禁忌', '示例'];"), 'persona JSON must use the fixed Chinese schema');
for (const contract of [
    'function personaJsonFromLegacy', 'function legacyPersonaFromJson',
    'function importRolePersonaJson', 'function exportRolePersonaJson',
    'function resetRolePersona', 'ROLE_PERSONA_TOTAL_LIMIT = 12000',
    "reader.readAsText(file, 'utf-8')", 'new Blob([contents]', 'URL.createObjectURL(blob)'
]) {
    assert(app.includes(contract), 'missing persona dossier workflow: ' + contract);
}
assert(!/\broleName\b/.test(app), 'role display names must no longer have a second app-state source');

for (const id of ['ttsRoleGptFile', 'ttsRoleSovitsFile', 'ttsRoleIndexFile', 'ttsRoleAudioFile']) {
    assert(app.includes("'" + id + "'"), 'role file input is not managed: ' + id);
}
const saveStart = app.indexOf('async function saveRoleEditor()');
const saveEnd = app.indexOf('rolePersonaFields.forEach', saveStart);
assert(saveStart >= 0 && saveEnd > saveStart, 'role save handler bounds changed');
const saveBody = app.slice(saveStart, saveEnd);
assert(!/\bnewRoleId\s*\(/.test(saveBody), 'front end must never manufacture a new role ID');
assert(!saveBody.includes('role_id: id'), 'new role metadata must not be seeded with a browser-generated ID');
assert(saveBody.includes('if (id) body.role_id = id;'), 'existing role updates must retain their server ID');
const metadataBody = saveBody.indexOf('const body = {');
const createDraft = saveBody.indexOf("postRoleJson('/api/tts/roles', body)");
const receiveServerId = saveBody.indexOf("id = String(savedRole.role_id || '').trim();");
const uploadDraftAssets = saveBody.indexOf('await uploadSelectedAssets();', receiveServerId);
assert(metadataBody >= 0 && metadataBody < createDraft && createDraft < receiveServerId && receiveServerId < uploadDraftAssets,
    'new roles must be saved first, receive a server ID, then upload their assets');
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
