'use strict';
// Independent two-case candidate. Never replaces round3/run01 or its verdicts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');
const BASE = 'http://127.0.0.1:55395';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const IDS = ['memo-constructivist-tokens', 'memo-constructivist-components', 'memo-constructivist-layout'];
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--out', '--python', '--frames', '--freeze-released'].includes(key) || !process.argv[i + 1] || args[key.slice(2)]) throw Error('Invalid or duplicate argument');
  args[key.slice(2)] = process.argv[i + 1];
}
if (!args.out || args['freeze-released'] !== 'yes') throw Error('Requires --out NEW_DIRECTORY --freeze-released yes; run only after parent explicitly releases round3 freeze');
const OUT = path.resolve(args.out);
const relative = path.relative(path.join(ROOT, 'round3'), OUT);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !/^clock-recheck-[^\\/]+(?:[\\/].+)?$/.test(relative)) throw Error('Output must be inside a new round3/clock-recheck-* root');
const rootName = relative.split(/[\\/]/)[0];
if (fs.existsSync(path.join(ROOT, 'round3', rootName))) throw Error('Refusing an existing clock-recheck root');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const result = {
  scope: 'Two existing positions only: notebook dashboard/settings, 1280x800, natural links; independent Edge; GET/HEAD 55395 only',
  clockPolicy: 'Page-sampled epoch, setFixedTime only. Public semantics fix Date and keep timers running; Playwright may install wrappers internally. Existing business closure and timers are not rewritten.',
  priorVerdicts: 'Does not supersede round3 invalid or dynamic failed evidence',
  started: new Date().toISOString(), cases: [], blockedRequests: [], failures: [], realCanvasProven: false
};
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/redesign/source-before/assets-sha256.json'), 'utf8')).files;
const productFiles = [...new Set([...Object.keys(baseline), 'index.html', 'js/app.js', 'js/study-sync-ui.js', 'js/ui-style.js', 'js/charts.js', 'memo_injection.py', ...['tokens', 'components', 'layout'].map(x => 'css/theme-constructivist-' + x + '.css')])].sort();
const provenance = () => productFiles.map(file => ({ file, sha256: hash(fs.readFileSync(path.join(ROOT, file))) }));
result.provenanceBefore = provenance();
result.scriptSHA256 = hash(fs.readFileSync(__filename));
function loadFrames() {
  const manifest = path.resolve(ROOT, args.frames || 'docs/redesign/deterministic-prep/frames-verified-20261116/frames.json');
  const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const routes = new Map();
  if (parsed.testOnly !== true || parsed.mode !== 'test-only deterministic original frame 0' || parsed.source_manifest_sha256 !== hash(fs.readFileSync(path.join(ROOT, 'docs/redesign/source-before/assets-sha256.json'))) || !Array.isArray(parsed.entries) || parsed.entries.length !== 22) throw Error('Expected verified test-only exact 22 frame entries');
  for (const e of parsed.entries) {
    if (!e.path.startsWith('img/') || !e.path.endsWith('.gif') || e.frame_index !== 0 || e.expected_sha256 !== e.original_sha256 || e.url_path !== '/' + e.path || routes.has(e.url_path) || baseline[e.path] !== e.original_sha256 || fs.statSync(path.join(ROOT, e.path)).size !== e.original_bytes || hash(fs.readFileSync(path.join(ROOT, e.path))) !== e.original_sha256) throw Error('Invalid original GIF allowlist');
    const png = path.resolve(path.dirname(manifest), e.frame_png);
    if (path.dirname(png) !== path.dirname(manifest)) throw Error('Invalid PNG path');
    const body = fs.readFileSync(png);
    if (body.length < 24 || body.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || hash(body) !== e.frame_png_sha256 || body.readUInt32BE(16) !== e.original_size[0] || body.readUInt32BE(20) !== e.original_size[1]) throw Error('Invalid verified frame PNG');
    routes.set(e.url_path, { entry: e, body });
  }
  if (JSON.stringify([...routes.keys()].sort()) !== JSON.stringify(Object.keys(baseline).filter(f => f.endsWith('.gif')).map(f => '/' + f).sort())) throw Error('GIF allowlist differs from baseline');
  result.frameManifest = { file: manifest, sha256: hash(fs.readFileSync(manifest)), count: routes.size };
  return routes;
}
const routes = loadFrames();
fs.mkdirSync(OUT, { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2), { flag: 'wx' });
async function settle(p, ms) {
  await p.waitForTimeout(ms);
  await p.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter(i => i.currentSrc).map(i => i.decode().catch(() => {})));
  });
}
async function snapshot(p) {
  return p.evaluate(ids => {
    const visible = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      for (let n = el; n; n = n.parentElement) { const s = getComputedStyle(n); if (n.hidden || s.display === 'none' || s.visibility === 'hidden') return false; }
      return true;
    };
    const nodes = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
    const computed = nodes.map(el => ({
      key: el.tagName + '#' + el.id + '.' + String(el.className),
      styles: ['', '::before', '::after'].map(ps => {
        const s = getComputedStyle(el, ps || null), o = {};
        for (const prop of s) if (!prop.startsWith('--')) o[prop] = s.getPropertyValue(prop);
        return o;
      }), rect: el.getBoundingClientRect().toJSON()
    }));
    return { computed, metrics: {
      date: new Date().toISOString(), epoch: Date.now(), performanceNow: performance.now(), timeOrigin: performance.timeOrigin,
      countdown: document.querySelector('#autoRefreshCountdown')?.textContent,
      fontStatus: document.fonts.status,
      fontFaces: [...document.fonts].map(f => ({ family: f.family, style: f.style, weight: f.weight, status: f.status })),
      bodyElements: document.body.querySelectorAll('*').length, theme: document.documentElement.dataset.uiStyle,
      welcomeVisible: visible(document.querySelector('#welcomeOverlay')), dashboardVisible: visible(document.querySelector('#dashboard')), settingsVisible: visible(document.querySelector('#settingsPanel')),
      sheets: ids.map(id => ({ id, present: !!document.getElementById(id), disabled: document.getElementById(id)?.disabled ?? null })),
      images: [...document.images].filter(visible).map(i => ({ src: i.getAttribute('src'), complete: i.complete, width: i.naturalWidth, height: i.naturalHeight }))
    } };
  }, IDS);
}
function summary(s) { return { ...s.metrics, allElements: s.computed.length, allComputedSHA256: hash(JSON.stringify(s.computed)), includesHiddenAndPseudo: true }; }
function delta(a, b) {
  let differences = 0;
  const examples = [];
  const record = v => { differences++; if (examples.length < 30) examples.push(v); };
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (!a[i] || !b[i] || a[i].key !== b[i].key) { record({ i, nodeMismatch: true }); continue; }
    for (let k = 0; k < 3; k++) for (const prop of new Set([...Object.keys(a[i].styles[k]), ...Object.keys(b[i].styles[k])])) if (a[i].styles[k][prop] !== b[i].styles[k][prop]) record({ node: a[i].key, pseudo: k, prop, before: a[i].styles[k][prop], after: b[i].styles[k][prop] });
    for (const prop of Object.keys(a[i].rect)) if (a[i].rect[prop] !== b[i].rect[prop]) record({ node: a[i].key, prop: 'rect.' + prop, before: a[i].rect[prop], after: b[i].rect[prop] });
  }
  return { elements: a.length, afterElements: b.length, differences, examples, beforeSHA256: hash(JSON.stringify(a)), afterSHA256: hash(JSON.stringify(b)) };
}
function stable(a, b, epoch) {
  return a.metrics.epoch === epoch && b.metrics.epoch === epoch && a.metrics.date === b.metrics.date && a.metrics.countdown === b.metrics.countdown && /^\d+:\d{2}$/.test(b.metrics.countdown || '') && a.metrics.fontStatus === 'loaded' && b.metrics.fontStatus === 'loaded' && JSON.stringify(a.metrics.fontFaces) === JSON.stringify(b.metrics.fontFaces) && hash(JSON.stringify(a.computed)) === hash(JSON.stringify(b.computed));
}
function validate(s, view, row) {
  const m = s.metrics;
  if (m.theme !== 'notebook' || m.bodyElements < 100 || m.fontStatus !== 'loaded' || m.welcomeVisible || !m.dashboardVisible || m.settingsVisible !== (view === 'settings') || !row.routeHits.length || m.images.some(i => !i.complete || !i.width || !i.height) || m.sheets.some(s => s.present)) throw Error('Nonempty natural notebook initialization gate failed');
}
function pixels(first, second) {
  const dest = first.replace(/-enabled\.png$/, '-pixels.json');
  const code = 'from PIL import Image\nimport numpy as np,json,sys\na,b=[np.asarray(Image.open(p).convert("RGB")) for p in sys.argv[1:3]]\nassert a.shape==b.shape\nd=np.any(a!=b,axis=2)\nv={"equal":not bool(d.any()),"changed_pixels":int(d.sum()),"total_pixels":int(d.size),"max_channel_delta":int(np.abs(a.astype("int16")-b.astype("int16")).max()),"method":"strict RGB, no threshold/mask/crop"}\nwith open(sys.argv[3],"x",encoding="utf8") as f: json.dump(v,f,indent=2)\nprint(json.dumps(v))';
  const r = spawnSync(args.python || 'python', ['-c', code, first, second, dest], { stdio: 'inherit' });
  if (r.error || r.status !== 0) throw Error('Pixel comparator failed: ' + (r.error || r.status));
  return JSON.parse(fs.readFileSync(dest, 'utf8'));
}
async function runCase(browser, view) {
  const name = 'notebook-' + view + '@1280x800@natural';
  const row = { name, forced: false, routeHits: [], errors: [], stability: [], passed: false };
  result.cases.push(row);
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const req = route.request(), u = new URL(req.url());
      const headers = req.headers();
      if (u.origin !== BASE || u.username || u.password || headers.authorization || headers.cookie || !['GET', 'HEAD'].includes(req.method())) { result.blockedRequests.push({ origin: u.origin, path: u.pathname, method: req.method(), credentialsPresent: !!(u.username || u.password || headers.authorization || headers.cookie) }); return route.abort(); }
      if (routes.has(u.pathname)) { const item = routes.get(u.pathname); row.routeHits.push({ path: u.pathname, frame: 0, sha256: item.entry.frame_png_sha256 }); return route.fulfill({ status: 200, contentType: 'image/png', body: item.body }); }
      return route.continue();
    });
    const p = await context.newPage();
    p.on('pageerror', e => row.errors.push(String(e)));
    await p.addInitScript(() => { localStorage.setItem('memo_ui_style', 'notebook'); localStorage.setItem('theme', 'light'); });
    await p.goto(BASE, { waitUntil: 'load', timeout: 30000 });
    await settle(p, 1300);
    if (await p.locator('#welcomeSettingsBtn').isVisible()) { await p.click('#welcomeSettingsBtn'); await p.click('#closeSettings'); }
    await p.click('.layout-btn[data-layout="single"]');
    if (view === 'settings') await p.click('#settingsBtn');
    await settle(p, 2600);
    await p.mouse.move(0, 0);
    // Force complete style/font realization, including hidden nodes and pseudos, before sampling real epoch.
    let warm = await snapshot(p);
    await settle(p, 1100);
    let previous = await snapshot(p);
    row.preclock = { warm: summary(warm), ready: summary(previous) };
    validate(previous, view, row);
    const sampled = await p.evaluate(() => Date.now());
    row.sampledEpoch = sampled;
    await p.clock.setFixedTime(new Date(sampled));
    // First natural tick reconciles any pre-freeze rendered second. No business timer is reset.
    await settle(p, 1100);
    previous = await snapshot(p);
    row.reconciled = summary(previous);
    for (let tick = 1; tick <= 2; tick++) {
      const started = Date.now();
      await settle(p, 1100);
      const current = await snapshot(p);
      const elapsedRealMs = Date.now() - started;
      const equal = stable(previous, current, sampled);
      row.stability.push({ tick, elapsedRealMs, before: summary(previous), after: summary(current), equal });
      if (elapsedRealMs < 1100 || !equal) throw Error('Natural-tick stability gate failed at tick ' + tick);
      previous = current;
    }
    validate(previous, view, row);
    const before = previous;
    row.enabled = summary(before);
    const first = path.join(OUT, name + '-enabled.png'), second = path.join(OUT, name + '-disabled.png');
    await p.screenshot({ path: first, animations: 'allow', caret: 'initial' });
    await p.evaluate(ids => ids.forEach(id => { const link = document.getElementById(id); if (link) link.disabled = true; }), IDS);
    await settle(p, 2200);
    const after = await snapshot(p);
    row.disabled = summary(after);
    row.computed = delta(before.computed, after.computed);
    save(name + '-computed.json', { before: before.computed, after: after.computed, delta: row.computed });
    await p.screenshot({ path: second, animations: 'allow', caret: 'initial' });
    row.pixels = pixels(first, second);
    row.originalsUnchanged = [...routes.values()].every(x => hash(fs.readFileSync(path.join(ROOT, x.entry.path))) === x.entry.original_sha256);
    validate(after, view, row);
    if (!stable(before, after, sampled) || row.computed.differences || !row.pixels.equal || !row.originalsUnchanged || row.errors.length) throw Error('Strict pair gate failed (Date/countdown/fonts/computed/RGB/originals/pageerror)');
    row.passed = true;
  } catch (e) { row.errors.push(String(e)); result.failures.push({ name, error: String(e) }); }
  finally { if (context) await context.close(); save(name + '.json', row); }
}
(async () => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: EDGE, headless: true });
    for (const view of ['dashboard', 'settings']) await runCase(browser, view);
  } catch (e) { result.failures.push({ name: 'fatal', error: String(e) }); }
  finally {
    if (browser) await browser.close();
    result.provenanceAfter = provenance();
    result.provenanceUnchanged = JSON.stringify(result.provenanceBefore) === JSON.stringify(result.provenanceAfter);
    if (!result.provenanceUnchanged) result.failures.push({ name: 'provenance', error: 'Product/assets changed during capture' });
    result.passed = result.cases.length === 2 && result.cases.every(c => c.passed) && !result.failures.length;
    result.finished = new Date().toISOString();
    result.processExitCode = result.passed ? 0 : 1;
    save('summary.json', result);
    process.exitCode = result.processExitCode;
    console.log('CLOCK_RECHECK_DONE', JSON.stringify({ cases: result.cases.length, passed: result.passed, failures: result.failures.length }));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
