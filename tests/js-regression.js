'use strict';
const fs = require('fs');
const assert = require('assert');
const vm = require('vm');
const read = p => fs.readFileSync(p, 'utf8');
const index = read('index.html');
const files = ['js/ui-style.js','js/api.js','js/tts.js','js/dashboard-core.js','js/charts.js','js/layout.js','js/study-shortcuts.js','js/study-lifecycle.js','js/study-web.js','js/live2d-companion.js','js/study-sync-ui.js','js/app.js'];
for (const file of files) assert(index.includes(file), `missing script load: ${file}`);
const study = read('js/study-shortcuts.js');
const actions = ['FAMILIAR','VAGUE','FORGET','WELL_FAMILIAR','START_SPELLING','SHOW_ANSWER','PREVIOUS_WORD','EXIT_SPELLING','CLEAR_INPUT','PLAY_AUDIO','TTS_PHRASE_1','TTS_PHRASE_2','TTS_PHRASE_3','SEARCH'];
for (const action of actions) assert(study.includes(action), `missing shortcut ${action}`);
assert.strictEqual(new Set(actions).size, 14);
const globals = {App:'js/app.js',MaimemoAPI:'js/api.js',AIAPI:'js/api.js',RecommendAPI:'js/api.js',ChartManager:'js/charts.js',LayoutManager:'js/layout.js',StudyWeb:'js/study-web.js',TTS:'js/tts.js',MemoUIStyle:'js/ui-style.js'};
for (const [name,file] of Object.entries(globals)) assert(new RegExp(`(?:const|var)\\s+${name}\\s*=`).test(read(file)) || read(file).includes(`window.${name} =`), `missing global ${name}`);
const api = read('js/api.js');
assert(!api.includes('fetchByOffset'), 'unsupported study-record offset pagination returned');
assert(!api.includes('catchAll'), 'unfiltered full-fetch fallback returned');
assert(!api.includes("['2020-01-01T00:00:00'"), 'ordinary frontend still hard-codes old history ranges');
assert(!api.includes('payload.success === false || payload.error'), 'sync status error field is misclassified as a transport error');
for (const route of ['/api/study-records','/api/study-sync','/api/study-sync/status','/api/study-sync/current']) {
  assert(api.includes(route), `missing SQLite sync route ${route}`);
}
const syncUI = read('js/study-sync-ui.js');
assert(syncUI.includes('完整核验'), 'missing manual reconciliation confirmation');
assert(syncUI.includes("sync('incremental'"), 'normal refresh is not incremental');
const studyWeb = read('js/study-web.js');
assert(studyWeb.includes('hasAddWordOverlay'), 'missing add-word overlay detector');
assert(studyWeb.includes('studyAddWordOverlayOpen'), 'missing add-word overlay state');
assert(studyWeb.includes("actions.classList.toggle('is-add-word-overlay'"), 'actions are not hidden for add-word overlay');
const studyCss = read('css/study-web.css') + read('css/study-web-standard.css') + read('css/study-web-notebook.css');
assert(studyCss.includes('.study-web-actions.is-add-word-overlay'), 'missing add-word overlay hide style');
const companion = read('js/live2d-companion.js');
for (const name of ['Live2DCompanion','CompanionSession','Live2DModelManager']) assert(new RegExp(`const\\s+${name}\\s*=`).test(companion), `missing ${name}`);
for (const name of ['Live2DCompanion','CompanionSession','Live2DModelManager']) assert(companion.includes(`window.${name} = ${name}`), `${name} is not exposed to App.init`);
const companionNodes = {};
for (const id of ['companionModeBtn','exitCompanionModeBtn','companionAskBtn','closeCompanionBirthdayCard']) {
  companionNodes[id] = { dataset: {}, handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; } };
}
const companionContext = { window: { addEventListener() {} }, document: { getElementById(id) { return companionNodes[id] || null; } }, setInterval() {}, console };
vm.createContext(companionContext);
vm.runInContext(companion, companionContext);
companionContext.window.Live2DCompanion.init();
assert.strictEqual(typeof companionNodes.companionModeBtn.handlers.click, 'function', 'companion entry click handler is not bound');
for (const contract of ['rendererGeneration', 'fitLiveModel', 'scheduleRendererReload', "webglcontextlost", 'if (rendererLoading)']) {
  assert(companion.includes(contract), `missing fullscreen renderer contract ${contract}`);
}
for (const contract of ['TOUCH_REACTIONS', 'touchRegionFor', 'handleCharacterTouch', "addEventListener('pointerup'", 'companion-touch-feedback']) {
  assert(companion.includes(contract) || studyCss.includes(contract), `missing touch interaction contract ${contract}`);
}
for (const contract of ['typeof AIAPI', 'typeof MaimemoAPI', 'typeof LayoutManager', 'typeof ChartManager']) {
  assert(companion.includes(contract), `missing safe global reference contract ${contract}`);
}
for (const broken of ['window.AIAPI', 'window.MaimemoAPI', 'window.LayoutManager', 'window.ChartManager']) {
  assert(!companion.includes(broken), `live2d-companion still uses broken global reference ${broken}`);
}
for (const contract of ['DEFAULT_PERSONAS', 'getActivePersona', 'memo_live2d_personas']) {
  assert(new RegExp(`(?:const|function)\\s+${contract}\\s*[=(]`).test(companion) || companion.includes(contract), `missing persona contract ${contract}`);
}
assert(/function personaSystemPrompt\(persona\)[\s\S]*persona\.name[\s\S]*persona\.background/.test(companion), 'persona prompt does not include name and background');
for (const fn of ['askAI', 'askTouchAI']) {
  const start = companion.indexOf(`async function ${fn}`);
  const end = companion.indexOf('\n    function ', start + 1);
  const body = companion.slice(start, end > start ? end : undefined);
  assert(body.includes('getActivePersona()') && body.includes('personaSystemPrompt(persona)'), `${fn} does not inject the active persona`);
}
assert(companion.includes('maybeSpeakCompanion'), 'missing companion voice speaker');
assert(companion.includes("localStorage.getItem('tts_companion_enabled')"), 'companion voice is not gated by a setting');
assert(index.includes('ttsCompanionRead'), 'missing companion voice toggle in settings');
assert(read('js/app.js').includes('ttsCompanionRead'), 'companion voice toggle is not bound in app');
assert(index.includes('ttsModelDrop'), 'missing TTS model drop zone');
assert(read('js/app.js').includes('/api/tts/import-model'), 'TTS model drop does not upload to import endpoint');
assert(read('js/app.js').includes('ttsModelKind'), 'TTS model drop does not classify dropped model files');
const ttsJs = read('js/tts.js');
for (const contract of ['tts_top_k', 'tts_fragment_interval', 'tts_text_split_method', 'tts_seed', 'use_cuda_graph', 'tts_cuda_graph', 'parallel_infer', 'tts_parallel_infer']) {
  assert(ttsJs.includes(contract), `TTS speak does not forward tuning setting ${contract}`);
}
for (const id of ['ttsFragRange', 'ttsTopK', 'ttsSplitSelect', 'ttsSeed', 'ttsCudaGraph', 'ttsParallelInfer']) {
  assert(index.includes(id), `missing TTS tuning control ${id}`);
}
const appJs = read('js/app.js');
for (const key of ['tts_fragment_interval', 'tts_top_k', 'tts_text_split_method', 'tts_seed', 'tts_cuda_graph', 'tts_parallel_infer']) {
  assert(appJs.includes(key), `TTS tuning control not persisted in app: ${key}`);
}
assert(!read('js/study-sync-ui.js').includes('window.LayoutManager'), 'study-sync-ui still uses broken window.LayoutManager');
assert(!read('js/app.js').includes('window.StudySyncUI'), 'app still uses broken window.StudySyncUI');
assert(index.includes('companionModeBtn'), 'missing companion learning entry');
assert(read('live2d_service.py').includes('MAX_MODEL_BYTES'), 'missing model size limit');
console.log('JS_CONTRACTS_PASS: scripts, 14 shortcuts, and public globals are preserved');
