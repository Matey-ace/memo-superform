'use strict';
// Finite main-control gate. No answer, article action, save, login, or account export.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');
const BASE = 'http://127.0.0.1:55395';
const OWN = path.join(ROOT, 'docs/redesign/sa4/fixes-round3');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--out', '--components'].includes(process.argv[i]) && process.argv[i + 1], 'Expected --out NEW_DIRECTORY [--components FILE]');
  assert.ok(!Object.hasOwn(args, process.argv[i].slice(2)), 'Duplicate argument');
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
assert.ok(args.out, '--out NEW_DIRECTORY required');
const OUT = path.resolve(args.out);
const relative = path.relative(OWN, OUT);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '--out must be a new child of docs/redesign/sa4/fixes-round3');
assert.ok(!fs.existsSync(OUT), 'Refuse existing output directory');
const candidate = args.components ? path.resolve(args.components) : null;
const css = candidate ? fs.readFileSync(candidate) : null;
const IDS = ['memo-constructivist-tokens', 'memo-constructivist-components', 'memo-constructivist-layout'];
const FILES = ['tokens', 'components', 'layout'].map(x => '/css/theme-constructivist-' + x + '.css');
const GROUP = '.setting-group:has(#companionLanguageSelect,#ttsStatusText,#live2dCatalogSearch)';
const GUARD = `#companionStudy,#companionStudy *,#companionModeBtn,${GROUP},${GROUP} *`;
const TOPBAR = '.topbar button,.topbar select';
const summary = {
  candidate, selector: GUARD,
  scope: 'Six independent Edge contexts, light/dark x1280/1440/1920. Same-origin 55395 GET/HEAD only. Actual product by default; optional components response route.',
  exemption: { selector: '#autoRefreshToggle', expectedWidth: 28, expectedHeight: 28, authority: 'User explicitly chose protected-entry zero displacement; this is the sole size exemption.' },
  limitations: ['No screenshots, hover/focus/disabled or business acceptance.', 'Notebook absence of theme links and exhaustive selector matching in companion mode are not tested.', 'Companion full computed/pseudo/rect isolation is tested, not real-model rendering.'],
  contexts: [], rows: [], failures: [], blockedRequests: 0
};
fs.mkdirSync(OUT, { recursive: true });
// Compact JSON retains complete guard evidence without multiplying indentation overhead.
const save = (name, data) => fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(data), { flag: 'wx' });
const fail = (name, detail) => summary.failures.push({ name, ...detail });
async function settle(p) { await p.waitForTimeout(900); await p.evaluate(() => document.fonts.ready); }
async function linkState(p) {
  return p.evaluate(({ ids, files }) => ids.map((id, i) => {
    const l = document.getElementById(id);
    return { id, exists: !!l, loaded: !!l?.sheet, disabled: l?.disabled, pathname: l ? new URL(l.href).pathname : null, expected: files[i], rules: l?.sheet?.cssRules.length || 0 };
  }), { ids: IDS, files: FILES });
}
async function guard(p) {
  return p.evaluate(sel => [...document.querySelectorAll(sel)].map((el, i) => ({
    i, key: el.tagName + '#' + el.id + '.' + String(el.className), rect: el.getBoundingClientRect().toJSON(),
    styles: ['', '::before', '::after'].map(ps => {
      const s = getComputedStyle(el, ps || null), values = {};
      for (const k of s) if (!k.startsWith('--')) values[k] = s.getPropertyValue(k);
      return values;
    })
  })), GUARD);
}
async function topbar(p) {
  return p.evaluate(sel => [...document.querySelectorAll(sel)].map((el, i) => ({ key: el.id || el.className, i, rect: el.getBoundingClientRect().toJSON() })), TOPBAR);
}
function difference(a, b) {
  assert.equal(a.length, b.length, 'Protected node count changed');
  const changes = []; let styles = 0, rects = 0;
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].key, b[i].key, 'Protected node identity changed');
    for (let j = 0; j < 3; j++) for (const k of new Set([...Object.keys(a[i].styles[j]), ...Object.keys(b[i].styles[j])])) {
      if (a[i].styles[j][k] !== b[i].styles[j][k]) { styles++; changes.push({ key: a[i].key, pseudo: j, property: k, before: a[i].styles[j][k], after: b[i].styles[j][k] }); }
    }
    for (const k of Object.keys(a[i].rect)) if (a[i].rect[k] !== b[i].rect[k]) { rects++; changes.push({ key: a[i].key, property: 'rect.' + k, before: a[i].rect[k], after: b[i].rect[k] }); }
  }
  return { elements: a.length, styles, rects, total: styles + rects, changes };
}
async function pair(p, name, minimum) {
  const loaded = await linkState(p);
  assert.ok(loaded.every(l => l.exists && l.loaded && l.rules > 0 && !l.disabled && l.pathname === l.expected), 'Three naturally loaded enabled theme links required');
  await p.mouse.move(0, 0);
  await p.evaluate(ids => ids.forEach(id => { document.getElementById(id).disabled = true; }), IDS);
  await settle(p);
  const before = await guard(p), topbarBefore = await topbar(p);
  assert.ok(before.length >= minimum, `Protected set shrank: ${before.length}<${minimum}`);
  await p.evaluate(ids => ids.forEach(id => { document.getElementById(id).disabled = false; }), IDS);
  await settle(p);
  const after = await guard(p), topbarAfter = await topbar(p), delta = difference(before, after);
  assert.equal(topbarBefore.length, topbarAfter.length, 'Topbar count changed');
  const topbarChanges = topbarBefore.flatMap((el, i) => {
    assert.equal(el.key, topbarAfter[i].key);
    return Object.keys(el.rect).filter(k => el.rect[k] !== topbarAfter[i].rect[k]).map(k => ({ key: el.key, property: k, before: el.rect[k], after: topbarAfter[i].rect[k] }));
  });
  // Non-protected topbar changes are evidence, not failures. Entry remains a hard gate.
  const entryChanges = topbarChanges.filter(x => x.key === 'companionModeBtn');
  save(name, { loaded, before, after, delta, topbarBefore, topbarAfter, topbarChanges, entryChanges });
  summary.rows.push({ name, elements: delta.elements, styles: delta.styles, rects: delta.rects, total: delta.total, topbarChanges, entryChanges });
  if (delta.total || entryChanges.length) fail(name, { guardTotal: delta.total, entryChanges });
}
const common = [
  ...['single', 'split2', 'split3', 'grid4'].map(x => ({ name: 'layout-' + x, selector: `.topbar .layout-btn[data-layout="${x}"]` })),
  { name: 'refresh-toggle-user-exemption', selector: '#autoRefreshToggle', exempt: true },
  { name: 'refresh-interval', selector: '#autoRefreshInterval' },
  { name: 'chart-selector-tile0', selector: '#dashboard .tile[data-tile="0"] .chart-selector' },
  { name: 'fullscreen-tile0', selector: '#dashboard .tile[data-tile="0"] .tile-fullscreen' }
];
async function measure(p, name, specs) {
  const targets = [];
  for (const spec of specs) {
    const locator = p.locator(spec.selector);
    assert.equal(await locator.count(), 1, 'Non-vacuous unique target required: ' + spec.name);
    assert.ok(await locator.isVisible(), 'Visible target required: ' + spec.name);
    targets.push(await locator.evaluate((el, spec) => {
      const s = getComputedStyle(el), rect = el.getBoundingClientRect().toJSON();
      return { ...spec, rect, role: el.getAttribute('role'), palette: { color: s.color, background: s.backgroundColor, border: s.borderColor, radius: s.borderRadius }, typography: { font: s.font, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing }, pass: spec.exempt ? rect.width === 28 && rect.height === 28 : rect.width >= 32 && rect.height >= 32 };
    }, spec));
  }
  save(name, { targets });
  summary.rows.push({ name, targets });
  for (const target of targets) if (!target.pass) fail(name, { target });
}
async function assertMode(p, theme, companion) {
  const mode = await p.evaluate(() => ({ style: document.documentElement.dataset.uiStyle, dark: document.body.classList.contains('dark'), companion: document.body.classList.contains('companion-mode') }));
  assert.equal(mode.style, 'standard'); assert.equal(mode.dark, theme === 'dark'); assert.equal(mode.companion, companion);
  return mode;
}
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080]]) {
      const suffix = `${theme}-${width}x${height}`, errors = [];
      let context;
      try {
        context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
        await context.route('**/*', route => {
          const req = route.request(), u = new URL(req.url());
          if (u.origin !== BASE || !['GET', 'HEAD'].includes(req.method())) { summary.blockedRequests++; return route.abort(); }
          if (css && u.pathname === FILES[1]) return route.fulfill({ status: 200, contentType: 'text/css', body: css });
          return route.continue();
        });
        const p = await context.newPage(); p.on('pageerror', e => errors.push(String(e)));
        await p.addInitScript(theme => { localStorage.setItem('memo_ui_style', 'standard'); localStorage.setItem('theme', theme); }, theme);
        await p.goto(BASE, { waitUntil: 'load' }); await settle(p);
        if (await p.locator('#welcomeSettingsBtn').isVisible()) { await p.click('#welcomeSettingsBtn'); await p.click('#closeSettings'); }
        await assertMode(p, theme, false);
        await p.click('.layout-btn[data-layout="single"]'); await settle(p);
        assert.ok(await p.locator('#dashboard').evaluate(e => e.classList.contains('layout-single')));
        await p.locator('#dashboard .tile[data-tile="0"] .chart-selector').selectOption('heatmap'); await settle(p);
        await pair(p, 'single-guard-' + suffix, 245);
        await measure(p, 'single-targets-' + suffix, common);
        await p.locator('#dashboard .tile[data-tile="0"] .chart-selector').selectOption('trend'); await settle(p);
        const ranges = ['7', '30', '90', 'all'].map(x => ({ name: 'trend-range-' + x, selector: `#dashboard .tile[data-tile="0"] .range-btn[data-range="${x}"]` }));
        await pair(p, 'trend-guard-' + suffix, 245);
        await measure(p, 'trend-targets-' + suffix, [...common, ...ranges]);
        await p.click('#articleVocabBtn'); await p.locator('[data-testid="article-vocab-text"]').waitFor({ state: 'visible' }); await settle(p);
        await pair(p, 'article-guard-' + suffix, 245);
        await measure(p, 'article-targets-' + suffix, [{ name: 'article-close', selector: '[data-testid="article-vocab-close"]' }, { name: 'article-initial-select-not-clicked', selector: '[data-testid="article-vocab-select"]' }]);
        await p.click('[data-testid="article-vocab-close"]');
        await p.click('#settingsBtn'); await settle(p); assert.ok(await p.locator('#settingsPanel').isVisible());
        await assertMode(p, theme, false); await pair(p, 'normal-settings-guard-' + suffix, 245);
        await p.click('#closeSettings'); await p.click('#companionModeBtn'); await settle(p);
        await assertMode(p, theme, true);
        await p.click('#settingsBtn'); await settle(p); assert.ok(await p.locator('#settingsPanel').isVisible());
        await pair(p, 'companion-settings-guard-' + suffix, 323);
        assert.deepEqual(errors, [], 'Page errors');
        summary.contexts.push({ suffix, mode: await assertMode(p, theme, true), pageerrors: errors, completed: true });
        console.log(suffix, 'completed');
      } catch (e) {
        fail(suffix, { error: String(e.stack), pageerrors: errors });
        summary.contexts.push({ suffix, completed: false, pageerrors: errors });
        console.error(suffix, String(e));
      } finally { if (context) await context.close(); }
    }
  } finally { await browser.close(); save('summary', summary); }
  process.exitCode = summary.failures.length ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
