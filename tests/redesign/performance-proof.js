'use strict';
// Bounded public-static evidence only; no connection to an existing browser.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');
const BASE = 'http://127.0.0.1:55395';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BEFORE = 'docs/redesign/source-before/';
const CSS = ['tokens', 'components', 'layout'].map(x => 'css/theme-constructivist-' + x + '.css');
const ORIGINALS = ['index.html', 'js/ui-style.js', 'js/charts.js', 'memo_injection.py', 'css/maimemo-standard.css', 'css/style.css', 'css/study-web-standard.css'];
const FROZEN = '69bb103297aed39edc301dea23222402363b2ee29a76210100348db9013870ae';
const argv = process.argv.slice(2);
if (argv.length === 2 && argv[0] === '--validate') {
 const file = path.resolve(ROOT, argv[1], 'result.json');
 const validationRel = path.relative(path.join(ROOT, 'docs/redesign/performance'), file);
 if (validationRel.startsWith('..') || path.isAbsolute(validationRel)) throw Error('Validation input must be under docs/redesign/performance/');
 const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
 const invalid = stored.samples.filter(s => s.failure || s.pageErrorCount > 0);
 const valid = stored.contextsCreated === 6 && stored.samples.length === 6 && stored.provenance.assetsUnchangedAfter && !stored.failures.length && !invalid.length && ['baseline', 'current'].every(g => stored.samples.filter(s => s.group === g && s.startup && s.reloadCacheDisabled).length === 3);
 console.log(JSON.stringify({ evidenceValidationPassed: valid, browserContextsCreatedByValidation: 0, originalResultModified: false, invalidSamples: invalid.map(s => ({ group: s.group, number: s.number, pageErrorCount: s.pageErrorCount, failure: s.failure })), note: 'Validation failure does not locate error cause or prove a product regression; no timing threshold or performance acceptance.' }, null, 2));
 process.exit(valid ? 0 : 1);
}
if (argv.length !== 2 || argv[0] !== '--out') throw Error('Required: --out NEW_DIRECTORY under docs/redesign/performance/, or --validate EXISTING_DIRECTORY');
const out = path.resolve(ROOT, argv[1]);
const rel = path.relative(path.join(ROOT, 'docs/redesign/performance'), out);
if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('Output must be a new child of docs/redesign/performance/');
if (fs.existsSync(out)) throw Error('Refusing to overwrite --out');
const read = p => fs.readFileSync(path.join(ROOT, p));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(read(BEFORE + 'assets-sha256.json')).files;
const frozenFiles = [...new Set([...Object.keys(manifest), ...CSS])];
const current = Object.fromEntries(frozenFiles.map(p => [p, sha(read(p))]));
if (current[CSS[1]] !== FROZEN) throw Error('Components frozen SHA mismatch');
const originals = ORIGINALS.map(p => {
 const b = read(BEFORE + p);
 if (sha(b) !== manifest[p]) throw Error('Original manifest mismatch: ' + p);
 return { path: p, beforeSHA256: sha(b), currentSHA256: sha(read(p)), beforeBytes: b.length, currentBytes: read(p).length };
});
const guard = spawnSync('python', ['tests/redesign/asset_guard.py', 'verify'], { cwd: ROOT, encoding: 'utf8' });
if (guard.error || guard.status !== 0) throw Error('Asset guard failed: ' + guard.status);
const guardResult = JSON.parse(guard.stdout);
const calls = s => Object.fromEntries(['setTimeout', 'setInterval', 'requestAnimationFrame', 'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'PerformanceObserver', 'import', 'require'].map(x => [x, (s.match(new RegExp('\\b' + x + '\\s*\\(', 'g')) || []).length]));
const cssBytes = CSS.map(p => ({ path: p, bytes: read(p).length, sha256: current[p] }));
const oldNative = read(BEFORE + 'css/maimemo-standard.css'), native = read('css/maimemo-standard.css');
if (!native.subarray(0, oldNative.length).equals(oldNative)) throw Error('Native CSS is not exact append');
const depsBefore = Object.keys(manifest).filter(p => /^(js|vendor)\/.*\.js$/.test(p));
const publicFiles = new Set(frozenFiles.filter(p => /^(js|css|fonts|img|vendor)\//.test(p) && /\.(js|css|woff2?|ttf|otf|png|ico|gif|jpg|jpeg|webp|svg)$/.test(p)).map(p => '/' + p));
publicFiles.add('/'); publicFiles.add('/index.html');
function publicPath(raw) {
 try { const u = new URL(raw); return u.origin === BASE && publicFiles.has(u.pathname) ? u.pathname : null; } catch (_) { return null; }
}
const result = {
 started: new Date().toISOString(), purpose: 'Independent limited performance/structure supplement, not SA9 or final acceptance',
 base: BASE, viewport: { width: 1280, height: 800 }, theme: 'standard light', contextLimit: 6, contextsCreated: 0,
 method: { nPerGroup: 3, order: ['baseline', 'current', 'current', 'baseline', 'baseline', 'current'],
 baseline: 'Unmodified source-before/index.html, js/ui-style.js and js/charts.js fulfilled by route; three new CSS empty if requested (normally not requested); every other preexisting dirty product asset shared unchanged.',
 current: 'Existing public static HTTP responses; index validated against disk and source-before; no source edits.',
 cache: 'Playwright routing disables HTTP cache for BOTH groups; service workers blocked. Fresh context initial navigation plus one cache-disabled reload in same context; reload is NOT an independent cold sample. Server/OS cache not cleared.',
 timing: 'Native Navigation/Resource Timing raw milliseconds, load event; resource timing filtered to public-static allowlist, query/hash stripped. Route baseline is an in-memory counterfactual, not network-equivalent deployed before build. No timing pass threshold.',
 settle: 'After load, UI welcomeSettingsBtn then closeSettings; wait 700 ms; fonts.ready and all current images decode, then 3 equal DOM element counts 200 ms apart (max 10 checks). No screenshot or computed-style sweep to induce hidden font work.',
 safety: 'Independent new headless Edge, no CDP endpoint, no credentials/cookies/storage-state read or export. Only allowlisted 55395 GET/HEAD reaches server; all API/nonstatic/external/mutating requests aborted without logging URL/header/body. No real DB, learning, answer or save.' },
 provenance: { componentsFrozenSHA256: FROZEN, manifestSHA256: sha(read(BEFORE + 'assets-sha256.json')), scriptSHA256: sha(read('tests/redesign/performance-proof.js')), originals, publicAssetsCurrentSHA256: current, assetGuard: guardResult },
 staticbytes: { css: cssBytes, shellCSSBytes: cssBytes.reduce((n, x) => n + x.bytes, 0), shellBudgetBytes: 40000,
 native: { beforeBytes: oldNative.length, currentBytes: native.length, appendedBytes: native.length - oldNative.length, exactOriginalPrefix: true, appendedSHA256: sha(native.subarray(oldNative.length)), budgetBytes: 30000 },
 js: ['js/ui-style.js', 'js/charts.js', 'memo_injection.py'].map(p => ({ path: p, beforeBytes: read(BEFORE + p).length, currentBytes: read(p).length, deltaBytes: read(p).length - read(BEFORE + p).length, beforeLexicalCallCounts: calls(read(BEFORE + p).toString()), currentLexicalCallCounts: calls(read(p).toString()) })),
 dependencyEvidence: { baselineJSFiles: depsBefore.length, currentSameSetHashed: true, addedProductionJSFiles: [], note: 'Asset guard enumerates current public assets and reports no added JS/vendor files; lexical call counts are source screening, not allocation/runtime instrumentation.' } },
 samples: [], failures: [], limitations: ['n=3 per group cannot prove no performance regression or precise improvement.', 'No GPU, memory, long-task/CPU profiling, real data ECharts paint, real Live2D model, authenticated account, real cloud or answer/save tested.', 'UI settings dismiss briefly opens existing settings; resulting font requests are included, not attributed to dashboard-only paint.', 'Concurrent machine/server workload, OS cache and route fulfillment affect timings; no statistical significance claim.']
};
fs.mkdirSync(out, { recursive: true });
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
save();
async function settle(page) {
 await page.waitForTimeout(700);
 await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].filter(i => i.currentSrc).map(i => i.decode().catch(() => {}))); });
 const counts = []; let stable = false;
 for (let i = 0; i < 10; i++) { counts.push(await page.locator('*').count()); if (counts.length >= 3 && counts.slice(-3).every(x => x === counts.at(-1))) { stable = true; break; } await page.waitForTimeout(200); }
 if (!stable) throw Error('DOM did not stabilize');
 return counts;
}
async function measure(page, row, phase) {
 const welcome = page.locator('#welcomeSettingsBtn');
 await welcome.waitFor({ state: 'visible', timeout: 10000 });
 await welcome.click(); await page.locator('#closeSettings').click();
 const stableDOMCounts = await settle(page);
 const data = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const fields = ['startTime', 'duration', 'fetchStart', 'domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd', 'requestStart', 'responseStart', 'responseEnd', 'domInteractive', 'domContentLoadedEventStart', 'domContentLoadedEventEnd', 'domComplete', 'loadEventStart', 'loadEventEnd', 'transferSize', 'encodedBodySize', 'decodedBodySize'];
  const pick = e => Object.fromEntries(fields.filter(k => typeof e[k] === 'number').map(k => [k, e[k]]));
  return { navigation: { type: nav.type, ...pick(nav) }, resources: performance.getEntriesByType('resource').map(e => ({ rawName: e.name, initiatorType: e.initiatorType, ...pick(e) })),
   domCount: document.querySelectorAll('*').length, bodyDOMCount: document.body.querySelectorAll('*').length,
   echartsInstances: [...document.querySelectorAll('[_echarts_instance_]')].filter(e => !!window.echarts?.getInstanceByDom(e)).length,
   echartsHosts: document.querySelectorAll('[_echarts_instance_]').length, canvasCount: document.querySelectorAll('canvas').length,
   fontsStatus: document.fonts.status, imageCount: document.images.length, imagesPending: [...document.images].filter(i => i.currentSrc && !i.complete).length,
   imagesFailed: [...document.images].filter(i => i.currentSrc && i.complete && !i.naturalWidth).length,
   standard: document.documentElement.dataset.uiStyle === 'standard', dark: document.body.classList.contains('dark'),
   dashboardVisible: !!document.querySelector('#dashboard')?.getBoundingClientRect().width,
   welcomeDismissed: document.querySelector('#welcomeOverlay').classList.contains('hidden'), settingsClosed: !document.querySelector('#settingsPanel').classList.contains('show'),
   newCSSLinks: [...document.querySelectorAll('link[id^="memo-constructivist-"]')].map(l => ({ id: l.id, loaded: !!l.sheet, disabled: l.disabled })) };
 });
 data.resources = data.resources.flatMap(e => { const p = publicPath(e.rawName); if (!p) return []; const { rawName, ...rest } = e; return [{ path: p, ...rest }]; });
 data.fontRequests = data.resources.filter(e => e.path.startsWith('/fonts/')).map(e => e.path);
 data.staticRequestCount = data.resources.length;
 data.staticUniquePaths = [...new Set(data.resources.map(e => e.path))];
 data.stableDOMCounts = stableDOMCounts;
 row[phase] = data;
 if (!data.standard || data.dark || !data.dashboardVisible || !data.welcomeDismissed || !data.settingsClosed || data.fontsStatus !== 'loaded' || data.imagesPending) throw Error('Invalid settled dashboard');
 if (row.group === 'current' && (data.newCSSLinks.length !== 3 || data.newCSSLinks.some(l => !l.loaded || l.disabled))) throw Error('Current CSS not active');
 if (row.group === 'baseline' && data.newCSSLinks.length) throw Error('Baseline CSS unexpectedly loaded');
}
(async () => {
 const browser = await chromium.launch({ executablePath: EDGE, headless: true });
 result.browserVersion = browser.version();
 try {
  for (const group of result.method.order) {
   if (result.contextsCreated >= 6) throw Error('Context budget exhausted');
   const row = { group, number: result.samples.filter(s => s.group === group).length + 1, allowedRequests: [], blockedNonstaticCount: 0, blockedMethodCount: 0, routeHits: [], pageErrorCount: 0 };
   result.samples.push(row);
   const context = await browser.newContext({ viewport: result.viewport, deviceScaleFactor: 1, colorScheme: 'light', serviceWorkers: 'block' });
   result.contextsCreated++; save();
   try {
    await context.route('**/*', async route => {
     const req = route.request(), p = publicPath(req.url());
     if (!['GET', 'HEAD'].includes(req.method())) { row.blockedMethodCount++; return route.abort(); }
     if (!p) { row.blockedNonstaticCount++; return route.abort(); }
     row.allowedRequests.push({ path: p, method: req.method(), resourceType: req.resourceType() });
     if (group === 'baseline') {
      const original = (p === '/' || p === '/index.html') ? 'index.html' : p.slice(1);
      if (['index.html', 'js/ui-style.js', 'js/charts.js'].includes(original)) {
       const body = read(BEFORE + original); row.routeHits.push({ path: p, sha256: sha(body), bytes: body.length });
       return route.fulfill({ status: 200, contentType: original.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8', body });
      }
      if (CSS.includes(original)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
     }
     return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', () => row.pageErrorCount++);
    await page.addInitScript(() => { localStorage.setItem('memo_ui_style', 'standard'); localStorage.setItem('theme', 'light'); });
    page.on('response', async res => {
     const p = publicPath(res.url());
     if (group === 'current' && (p === '/' || p === '/index.html') && res.request().resourceType() === 'document') {
      try { const b = await res.body(); row.currentDocumentSHA256 = sha(b); if (sha(b) !== current['index.html']) row.documentMismatch = true; } catch (_) { row.documentReadFailure = true; }
     }
    });
    await page.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
    await measure(page, row, 'startup');
    await page.reload({ waitUntil: 'load', timeout: 30000 });
    await measure(page, row, 'reloadCacheDisabled');
    if (row.documentMismatch || row.documentReadFailure) throw Error('HTTP document provenance mismatch');
    if (row.pageErrorCount > 0) throw Error('Page error invalidates sample: ' + row.pageErrorCount);
    console.log(group, row.number, 'startup/reload sampled');
   } catch (e) { row.failure = String(e); result.failures.push({ group, number: row.number, error: String(e) }); }
   finally { await context.close(); save(); }
  }
 } finally { await browser.close(); }
 result.provenance.assetsUnchangedAfter = frozenFiles.every(p => sha(read(p)) === current[p]);
 result.finished = new Date().toISOString();
 result.nPerGroup = Object.fromEntries(['baseline', 'current'].map(g => [g, result.samples.filter(s => s.group === g && !s.failure).length]));
 result.observed = Object.fromEntries(['baseline', 'current'].map(g => [g, Object.fromEntries(['startup', 'reloadCacheDisabled'].map(phase => [phase, result.samples.filter(s => s.group === g && s[phase]).map(s => ({ n: s.number, loadEventEnd: s[phase].navigation.loadEventEnd, domContentLoadedEventEnd: s[phase].navigation.domContentLoadedEventEnd, domCount: s[phase].domCount, echartsInstances: s[phase].echartsInstances, canvasCount: s[phase].canvasCount, fontRequestCount: s[phase].fontRequests.length, staticRequestCount: s[phase].staticRequestCount }))]))]));
 save();
 console.log(JSON.stringify({ contextsCreated: result.contextsCreated, nPerGroup: result.nPerGroup, failures: result.failures, staticbytes: result.staticbytes, observed: result.observed }, null, 2));
 if (result.failures.length || !result.provenance.assetsUnchangedAfter) process.exitCode = 1;
})().catch(e => { result.failures.push({ fatal: String(e) }); save(); console.error(String(e)); process.exitCode = 1; });
