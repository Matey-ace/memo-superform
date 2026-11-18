'use strict';
// Preparation only until the parent explicitly authorizes the exact invocation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '../..');
const BASE = 'http://127.0.0.1:55395';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BEFORE = 'docs/redesign/source-before/';
const SELF = 'tests/redesign/performance-pilot.js';
const CSS = ['tokens', 'components', 'layout'].map(x => 'css/theme-constructivist-' + x + '.css');
const IDS = ['memo-constructivist-tokens', 'memo-constructivist-components', 'memo-constructivist-layout'];
const ORIGINALS = ['index.html', 'js/ui-style.js', 'js/charts.js', 'memo_injection.py', 'css/maimemo-standard.css', 'css/style.css', 'css/study-web-standard.css'];
const FROZEN = '3ad830841b35e3df402094b47d5031b1e498c5036acee44545042f1952befe2d';
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--out', '--run-authorized'].includes(key) || !process.argv[i + 1] || Object.hasOwn(args, key)) throw Error('Invalid or duplicate argument');
  args[key] = process.argv[i + 1];
}
if (!args['--out'] || args['--run-authorized'] !== 'yes') throw Error('Requires --out NEW_pilot_DIRECTORY --run-authorized yes; parent authorization required');
const OUT = path.resolve(ROOT, args['--out']);
if (path.dirname(OUT) !== path.join(ROOT, 'docs/redesign/performance') || !/^pilot-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(path.basename(OUT)) || fs.existsSync(OUT)) throw Error('Requires new direct docs/redesign/performance/pilot-* directory; no overwrite');
const read = p => fs.readFileSync(path.join(ROOT, p));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(read(BEFORE + 'assets-sha256.json')).files;
const frozenFiles = [...new Set([...Object.keys(manifest), ...CSS])].sort();
const publicFiles = new Set(frozenFiles.filter(p => /^(js|css|fonts|img|vendor)\//.test(p) && /\.(js|css|woff2?|ttf|otf|png|ico|gif|jpg|jpeg|webp|svg)$/.test(p)).map(p => '/' + p));
publicFiles.add('/'); publicFiles.add('/index.html');
function publicPath(raw) {
  try {
    const u = new URL(raw);
    const safeQuery = [...u.searchParams].every(([key, value]) => key === 'v' && /^[A-Za-z0-9._-]{1,80}$/.test(value));
    return u.origin === BASE && !u.username && !u.password && safeQuery && publicFiles.has(u.pathname) ? u.pathname : null;
  } catch (_) { return null; }
}
// Match the public asset guard's scope, including additions, without touching data directories.
function publicAssets() {
  const files = [];
  function walk(rel) {
    for (const ent of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const p = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isSymbolicLink()) throw Error('Public asset symlink rejected');
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) files.push(p);
    }
  }
  for (const dir of ['js', 'css', 'fonts', 'img', 'vendor']) walk(dir);
  for (const ent of fs.readdirSync(ROOT, { withFileTypes: true })) if (ent.isFile() && ent.name.endsWith('.html')) files.push(ent.name);
  files.push('memo_injection.py', 'tests/font-gif-manifest.sha256');
  return Object.fromEntries([...new Set(files)].sort().map(p => { const b = read(p); return [p, { bytes: b.length, sha256: sha(b) }]; }));
}
function sourceHashes() {
  return Object.fromEntries([SELF, BEFORE + 'assets-sha256.json', ...ORIGINALS.map(p => BEFORE + p)].map(p => [p, sha(read(p))]));
}
const assetsBefore = publicAssets();
const sourcesBefore = sourceHashes();
if (assetsBefore[CSS[1]].bytes !== 20564 || assetsBefore[CSS[1]].sha256 !== FROZEN || CSS.reduce((n, p) => n + assetsBefore[p].bytes, 0) !== 30520) throw Error('Current product freeze mismatch');
for (const p of ORIGINALS) if (sha(read(BEFORE + p)) !== manifest[p]) throw Error('Source-before manifest mismatch');
const result = {
  started: new Date().toISOString(), purpose: 'Validity pilot only; n=1/group is not performance or no-regression evidence',
  base: BASE, viewport: { width: 1280, height: 800 }, theme: 'standard/light', contextLimit: 2, contextsCreated: 0,
  method: {
    order: ['baseline', 'current'], nPerGroup: 1, navigation: 'Startup only; no reload, retry, replacement sample or expansion to six contexts',
    baseline: 'Exact source-before index.html/ui-style.js/charts.js route bodies; remaining public assets shared. Three theme CSS routes are aborted if unexpectedly requested.',
    current: 'Real public-static HTTP including exact three theme links; response hashes checked against disk',
    safety: 'Fresh independent headless Edge contexts; GET/HEAD original manifest static allowlist only, no credentials or external origins. API/nonstatic requests aborted, not mocked or logged. No account/DB/CDP/9337/answer/save.',
    preferences: 'Only memo_ui_style=standard and theme=light in each new context; no other storage writes by harness',
    clock: 'Real Date/performance/timers/animations preserved; no clock installation, tick, resource forcing or screenshot',
    validity: 'Real post-bootstrap HEAD /index.html completed, initialized toolbar counts and welcome visible before actual settings dismissal. Full DOM tag/id/class/child-order fingerprint excludes only the three exact theme link IDs; text is never fingerprinted, including countdown text.',
    timing: 'Native raw navigation/resource timings, public static paths only; routing disables HTTP cache in both groups. Memory baseline fulfill is not network equivalent to a deployed old build. No performance threshold or improvement claim.'
  },
  provenance: { componentsSHA256: FROZEN, componentsBytes: 20564, shellBytes: 30520, sourcesBefore, publicAssetsBefore: assetsBefore },
  samples: [], failures: [], valid: false,
  limitations: ['One startup per group only tests evidence validity, not no regression.', 'No actual data charts/Live2D/account/business, CPU/GPU/memory/long-task or visual acceptance.', 'Settings dismissal may request public resources. OS/server caches and concurrent machine load uncontrolled.', 'Class differences, even attributed to theme paint, invalidate rather than relaxing fingerprint.']
};
fs.mkdirSync(OUT, { recursive: false });
const save = () => fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2) + '\n');
save();
function fail(code) { const e = new Error(code); e.pilotCode = code; throw e; }
const safeNames = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError', 'DOMException', 'TimeoutError']);
function safeError(error) {
  const locations = [];
  // Skip the message line entirely. Never serialize raw message, stack, function name or query.
  for (const line of String(error.stack || '').split('\n').slice(1)) {
    const match = line.match(/(?:\(|\s)(https?:\/\/[^\s)]+):(\d+):(\d+)\)?$/);
    if (!match) continue;
    const p = publicPath(match[1]);
    if (p && (p === '/' || /\.(js|html)$/.test(p))) locations.push({ path: p === '/' ? 'index.html' : p.slice(1), line: Number(match[2]), column: Number(match[3]) });
  }
  return { name: safeNames.has(error.name) ? error.name : 'Error', locations: locations.slice(0, 12) };
}
async function snapshot(page) {
  const s = await page.evaluate(({ ids, css }) => {
    const count = (sel, root = document) => root.querySelectorAll(sel).length;
    const visible = e => {
      if (!e) return false;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      for (let n = e; n; n = n.parentElement) { const v = getComputedStyle(n); if (n.hidden || v.display === 'none' || v.visibility === 'hidden') return false; }
      return true;
    };
    const omitted = e => e.tagName === 'LINK' && ids.includes(e.id);
    const census = {}, fullTagCensus = {};
    for (const e of document.querySelectorAll('*')) fullTagCensus[e.tagName] = (fullTagCensus[e.tagName] || 0) + 1;
    function tree(e) {
      if (omitted(e)) return null;
      census[e.tagName] = (census[e.tagName] || 0) + 1;
      return [e.tagName, e.id, e.getAttribute('class') || '', [...e.children].filter(c => !omitted(c)).map(tree)];
    }
    const structure = tree(document.documentElement);
    const tiles = [...document.querySelectorAll('#dashboard > .tile')];
    const controls = {
      tiles: tiles.length, chartSelectors: count('#dashboard .chart-selector'), layoutButtons: count('.layout-btn'), fullscreenButtons: count('#dashboard .tile-fullscreen'),
      perTile: tiles.map(e => ({ toolbars: count('.chart-toolbar, .ai-toolbar', e), buttons: count('.chart-toolbar button, .ai-toolbar button', e), selects: count('.chart-toolbar select, .ai-toolbar select', e), inputs: count('.chart-toolbar input, .ai-toolbar input', e) }))
    };
    const links = ids.map((id, i) => {
      const els = [...document.querySelectorAll('[id]')].filter(e => e.id === id), l = els[0];
      let rules = 0; try { rules = l?.sheet?.cssRules.length || 0; } catch (_) {}
      let correctPath = false;
      try { const u = new URL(l.href); correctPath = u.origin === location.origin && u.pathname === '/' + css[i] && !u.username && !u.password; } catch (_) {}
      return { id, count: els.length, isLink: l?.tagName === 'LINK', loaded: !!l?.sheet, nonempty: rules > 0, enabled: !!l && !l.disabled, correctPath };
    });
    const fields = ['startTime', 'duration', 'fetchStart', 'domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd', 'requestStart', 'responseStart', 'responseEnd', 'domInteractive', 'domContentLoadedEventStart', 'domContentLoadedEventEnd', 'domComplete', 'loadEventStart', 'loadEventEnd', 'transferSize', 'encodedBodySize', 'decodedBodySize'];
    const pick = e => Object.fromEntries(fields.filter(k => typeof e[k] === 'number').map(k => [k, e[k]]));
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      capturedAt: new Date().toISOString(), performanceNow: performance.now(), timeOrigin: performance.timeOrigin,
      structure, tagCensus: census, fullTagCensus, domCount: count('*'), bodyDOMCount: count('*', document.body), controls, links,
      standard: document.documentElement.dataset.uiStyle === 'standard', light: !document.body.classList.contains('dark'), singleLayout: document.querySelector('#dashboard')?.className === 'dashboard layout-single',
      targetVisible: visible(document.querySelector('#dashboard')) && visible(document.querySelector('#chart-0')) && visible(document.querySelector('.tile[data-tile="0"] .chart-selector')),
      welcomeVisible: visible(document.querySelector('#welcomeOverlay')), welcomeDismissed: !!document.querySelector('#welcomeOverlay')?.classList.contains('hidden'), settingsClosed: !document.querySelector('#settingsPanel')?.classList.contains('show'),
      fontsStatus: document.fonts.status, imageCount: document.images.length, imagesPending: [...document.images].filter(i => i.currentSrc && !i.complete).length, imagesFailed: [...document.images].filter(i => i.currentSrc && i.complete && !i.naturalWidth).length,
      echartsHosts: count('[_echarts_instance_]'), echartsInstances: [...document.querySelectorAll('[_echarts_instance_]')].filter(e => !!window.echarts?.getInstanceByDom(e)).length, canvasCount: count('canvas'),
      navigation: nav ? { type: nav.type, ...pick(nav) } : null,
      resources: performance.getEntriesByType('resource').map(e => ({ rawName: e.name, initiatorType: e.initiatorType, ...pick(e) }))
    };
  }, { ids: IDS, css: CSS });
  s.structuralSHA256 = sha(JSON.stringify(s.structure)); delete s.structure;
  s.resources = s.resources.flatMap(e => { const p = publicPath(e.rawName); if (!p) return []; const { rawName, ...rest } = e; return [{ path: p, ...rest }]; });
  return s;
}
const EXPECTED = { tiles: 4, chartSelectors: 4, layoutButtons: 4, fullscreenButtons: 4, perTile: [
  { toolbars: 1, buttons: 9, selects: 0, inputs: 0 },
  { toolbars: 1, buttons: 4, selects: 0, inputs: 0 },
  { toolbars: 0, buttons: 0, selects: 0, inputs: 0 },
  { toolbars: 1, buttons: 6, selects: 2, inputs: 2 }
] };
function shapeGate(s) { if (JSON.stringify(s.controls) !== JSON.stringify(EXPECTED)) fail('EXPECTED_CONTROL_SHAPE'); }
function finalGate(s, group) {
  shapeGate(s);
  if (!s.standard || !s.light || !s.singleLayout || !s.targetVisible || !s.welcomeDismissed || !s.settingsClosed || s.fontsStatus !== 'loaded' || s.imagesFailed || s.imagesPending) fail('FINAL_STATE_INVALID');
  if (!s.navigation || s.navigation.type !== 'navigate') fail('STARTUP_NAVIGATION_REQUIRED');
  if (group === 'current' ? s.links.some(l => l.count !== 1 || !l.isLink || !l.loaded || !l.nonempty || !l.enabled || !l.correctPath) : s.links.some(l => l.count !== 0)) fail('THEME_LINK_GATE');
}
(async () => {
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ executablePath: EDGE, headless: true });
    result.browserVersion = browser.version();
    for (const group of result.method.order) {
      if (result.contextsCreated >= 2) fail('CONTEXT_BUDGET');
      const row = { group, number: 1, phase: 'context', pageErrors: [], pageErrorCount: 0, allowedRequests: [], blockedNonstaticCount: 0, blockedMethodCount: 0, routeHits: [], httpAssets: [], headProbeCompleted: false, observations: [] };
      result.samples.push(row); save();
      let context, rejectStop, stopped = false;
      const stop = new Promise((_, reject) => { rejectStop = reject; });
      // Avoid an unhandled rejection if an event fires between awaited operations.
      stop.catch(() => {});
      const halt = code => { if (!stopped) { stopped = true; const e = new Error(code); e.pilotCode = code; rejectStop(e); } };
      const step = async (phase, action) => { row.phase = phase; save(); if (stopped) fail('ASYNC_INVALID'); return Promise.race([Promise.resolve().then(action), stop]); };
      try {
        context = await step('context', () => browser.newContext({ viewport: result.viewport, deviceScaleFactor: 1, colorScheme: 'light', serviceWorkers: 'block' }));
        result.contextsCreated++; save();
        await context.route('**/*', async route => {
          const req = route.request(), p = publicPath(req.url());
          const headers = req.headers();
          if (headers.authorization || headers.cookie || headers['proxy-authorization']) { row.blockedNonstaticCount++; halt('CREDENTIAL_REQUEST_REJECTED'); return route.abort(); }
          if (!['GET', 'HEAD'].includes(req.method())) { row.blockedMethodCount++; return route.abort(); }
          if (!p) { row.blockedNonstaticCount++; return route.abort(); }
          row.allowedRequests.push({ path: p, method: req.method(), resourceType: req.resourceType() });
          const original = p === '/' || p === '/index.html' ? 'index.html' : p.slice(1);
          if (group === 'baseline' && ['index.html', 'js/ui-style.js', 'js/charts.js'].includes(original)) {
            const body = read(BEFORE + original);
            row.routeHits.push({ path: p, method: req.method(), sha256: sha(body), bytes: body.length });
            return route.fulfill({ status: 200, contentType: original.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8', body: req.method() === 'HEAD' ? Buffer.alloc(0) : body });
          }
          if (group === 'baseline' && CSS.includes(original)) { halt('BASELINE_THEME_REQUEST'); return route.abort(); }
          return route.continue();
        });
        context.on('page', p => p.on('pageerror', error => {
          row.pageErrorCount++; row.pageErrors.push({ phase: row.phase, capturedAt: new Date().toISOString(), ...safeError(error) }); save(); halt('PAGE_ERROR');
        }));
        const page = await step('page', () => context.newPage());
        page.on('requestfinished', req => { if (req.method() === 'HEAD' && publicPath(req.url()) === '/index.html') row.headProbeCompleted = true; });
        const responseTasks = new Set();
        page.on('response', res => {
          const p = publicPath(res.url());
          if (!p) return;
          if (!res.ok()) { halt('PUBLIC_HTTP_STATUS'); return; }
          if (group !== 'current' || res.request().method() !== 'GET') return;
          const task = (async () => {
            const file = p === '/' ? 'index.html' : p.slice(1);
            const body = await res.body();
            const hash = sha(body);
            row.httpAssets.push({ path: p, bytes: body.length, sha256: hash });
            if (!assetsBefore[file] || hash !== assetsBefore[file].sha256) halt('HTTP_DISK_MISMATCH');
          })().catch(() => halt('PUBLIC_HTTP_READ'));
          responseTasks.add(task); task.finally(() => responseTasks.delete(task));
        });
        await page.addInitScript(() => { localStorage.setItem('memo_ui_style', 'standard'); localStorage.setItem('theme', 'light'); });
        await step('navigation', () => page.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 }));
        row.initial = await step('initial', () => snapshot(page)); save();
        await step('initialization', async () => {
          const deadline = Date.now() + 15000;
          while (!row.headProbeCompleted) { if (Date.now() > deadline) fail('INITIALIZATION_HEAD_TIMEOUT'); await page.waitForTimeout(100); if (stopped) fail('ASYNC_INVALID'); }
          await page.locator('#welcomeSettingsBtn').waitFor({ state: 'visible', timeout: 10000 });
          row.initialized = await snapshot(page); shapeGate(row.initialized);
          if (!row.initialized.welcomeVisible || !row.initialized.standard || !row.initialized.light) fail('INITIALIZATION_STATE');
        });
        await step('dismiss', async () => { await page.locator('#welcomeSettingsBtn').click(); await page.locator('#closeSettings').click(); });
        await step('settle', async () => {
          await page.waitForTimeout(700);
          await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].filter(i => i.currentSrc).map(i => i.decode().catch(() => {}))); });
          let previous, equal = 0;
          for (let i = 0; i < 15; i++) {
            const s = await snapshot(page); finalGate(s, group);
            const key = JSON.stringify([s.structuralSHA256, s.tagCensus, s.controls, s.imageCount, s.echartsHosts, s.echartsInstances, s.canvasCount]);
            row.observations.push({ capturedAt: s.capturedAt, domCount: s.domCount, tagCensus: s.tagCensus, structuralSHA256: s.structuralSHA256, controls: s.controls }); save();
            equal = key === previous ? equal + 1 : 1; previous = key;
            if (equal === 3) { row.final = s; return; }
            await page.waitForTimeout(200); if (stopped) fail('ASYNC_INVALID');
          }
          fail('STRUCTURE_NOT_STABLE');
        });
        await step('final', async () => {
          await Promise.all([...responseTasks]);
          finalGate(row.final, group);
          if (row.pageErrorCount) fail('PAGE_ERROR');
          if (group === 'current') {
            for (const p of ['/', ...CSS.map(x => '/' + x)]) if (!row.httpAssets.some(e => e.path === p && e.bytes > 0)) fail('CURRENT_HTTP_REQUIRED');
            const b = result.samples[0].final, c = row.final;
            result.sameExpectedShape = JSON.stringify(b.controls) === JSON.stringify(c.controls) && JSON.stringify(b.tagCensus) === JSON.stringify(c.tagCensus) && b.structuralSHA256 === c.structuralSHA256 && b.echartsHosts === c.echartsHosts && b.echartsInstances === c.echartsInstances && b.canvasCount === c.canvasCount;
            if (!result.sameExpectedShape) fail('CROSS_GROUP_STRUCTURE_MISMATCH');
          }
          row.valid = true;
        });
      } catch (error) {
        row.valid = false; row.failure = { phase: row.phase, code: error.pilotCode || 'OPERATION_FAILED', ...safeError(error) };
        result.failures.push({ group, ...row.failure }); throw error;
      } finally {
        row.phase = 'close';
        if (context) await context.close();
        if (row.pageErrorCount || stopped) { row.valid = false; if (!row.failure) { row.failure = { phase: 'close', code: 'ASYNC_INVALID' }; result.failures.push({ group, ...row.failure }); } }
        save();
      }
      if (!row.valid) fail('SAMPLE_INVALID');
    }
  } catch (error) {
    if (!result.failures.length) result.failures.push({ code: error.pilotCode || 'PILOT_FAILED', ...safeError(error) });
  } finally {
    try { if (browser) await browser.close(); } catch (_) { result.failures.push({ code: 'BROWSER_CLOSE_FAILED' }); }
    try {
      result.provenance.publicAssetsAfter = publicAssets(); result.provenance.sourcesAfter = sourceHashes();
      result.provenance.assetsUnchangedAfter = JSON.stringify(assetsBefore) === JSON.stringify(result.provenance.publicAssetsAfter);
      result.provenance.sourcesUnchangedAfter = JSON.stringify(sourcesBefore) === JSON.stringify(result.provenance.sourcesAfter);
      if (!result.provenance.assetsUnchangedAfter || !result.provenance.sourcesUnchangedAfter) result.failures.push({ code: 'PROVENANCE_CHANGED' });
    } catch (_) { result.failures.push({ code: 'FINAL_PROVENANCE_FAILED' }); }
    result.finished = new Date().toISOString();
    result.valid = result.contextsCreated === 2 && result.samples.length === 2 && result.samples.every(s => s.valid && !s.pageErrorCount) && result.sameExpectedShape === true && !result.failures.length;
    save();
    console.log(JSON.stringify({ valid: result.valid, contextsCreated: result.contextsCreated, failures: result.failures, conclusion: 'Validity pilot only; no performance/no-regression conclusion' }, null, 2));
    if (!result.valid) process.exitCode = 1;
  }
})().catch(() => { result.valid = false; result.failures.push({ code: 'PERSISTENCE_OR_CLEANUP_FAILURE' }); try { save(); } catch (_) {} process.exitCode = 1; });
