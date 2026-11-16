'use strict';
// TEST ONLY: static original GIF frame 0, never evidence of dynamic Live2D rendering.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '../..');
const OWN = path.join(ROOT, 'docs/redesign/deterministic-prep');
const BASE = 'http://127.0.0.1:55395';
const IDS = ['memo-constructivist-tokens', 'memo-constructivist-components'];
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || !process.argv[i + 1]) throw Error('Expected --key value');
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!args.out || !args.frames || !args.python) throw Error('Required: --out NEW_DIRECTORY --frames frames.json --python PYTHON_EXE');
const OUT = path.resolve(args.out);
if (path.relative(OWN, OUT).startsWith('..') || path.isAbsolute(path.relative(OWN, OUT))) throw Error('Output outside exclusive deterministic-prep scope');
if (fs.existsSync(OUT)) throw Error('Refusing to overwrite existing --out: ' + OUT);
const framesPath = path.resolve(args.frames);
const frames = JSON.parse(fs.readFileSync(framesPath, 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/redesign/source-before/assets-sha256.json'), 'utf8')).files;
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const routes = new Map();
for (const entry of frames.entries) {
  if (!entry.path.startsWith('img/') || !entry.path.endsWith('.gif') || entry.url_path !== '/' + entry.path || baseline[entry.path] !== entry.original_sha256) throw Error('Invalid exact allowlist entry');
  const original = path.resolve(ROOT, entry.path);
  if (path.relative(path.join(ROOT, 'img'), original).startsWith('..')) throw Error('Invalid original path');
  if (hash(fs.readFileSync(original)) !== entry.original_sha256) throw Error('Original hash changed: ' + entry.path);
  const png = path.resolve(path.dirname(framesPath), entry.frame_png);
  if (path.dirname(png) !== path.dirname(framesPath)) throw Error('Invalid PNG path');
  const body = fs.readFileSync(png);
  if (hash(body) !== entry.frame_png_sha256 || body.readUInt32BE(16) !== entry.original_size[0] || body.readUInt32BE(20) !== entry.original_size[1]) throw Error('Invalid frame PNG hash or size');
  routes.set(entry.url_path, { entry, body });
}
const expected = Object.keys(baseline).filter(k => k.endsWith('.gif')).map(k => '/' + k).sort();
if (JSON.stringify([...routes.keys()].sort()) !== JSON.stringify(expected)) throw Error('Frame allowlist does not exactly match source-before GIF list');
const sizes = (args.sizes || '1280x800').split(',').map(s => {
  if (!/^\d+x\d+$/.test(s)) throw Error('Bad size');
  const [width, height] = s.split('x').map(Number); return { width, height };
});
const states = (args.states || 'notebook-dashboard,standard-companion').split(',');
if (states.some(s => !/^(notebook-(dashboard|settings|article|companion)|standard-companion)$/.test(s))) throw Error('Only non-study forbidden-state tests are allowed');
if (sizes.length !== 1 || sizes[0].width !== 1280 || sizes[0].height !== 800 || JSON.stringify(states) !== JSON.stringify(['notebook-dashboard', 'standard-companion'])) throw Error('Preparation is limited to exactly two cases at 1280x800');
fs.mkdirSync(OUT, { recursive: true });
const result = { testOnly: true, mode: 'test-only deterministic', realCanvasProven: false, scope: 'Preparation only, not SA8 round 2; existing dynamic 18 pairs untouched', base: BASE, allowlist: frames.allowlist, frame_manifest: framesPath, frame_manifest_sha256: hash(fs.readFileSync(framesPath)), clockPolicy: 'Normal initialization, natural transitions and font/image load first; then install paused clock with fixed Date. Advance only for natural CSS transition completion after link toggles.', screenshotsUnmodified: true, apiMocked: false, rows: [], failures: [] };
const save = () => fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(result, null, 2));
async function inspect(page) {
  return page.evaluate(ids => {
    const visible = el => { if (!el) return false; const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; for (let p = el; p; p = p.parentElement) { const s = getComputedStyle(p); if (p.hidden || s.display === 'none' || s.visibility === 'hidden') return false; } return true; };
    const sheets = ids.map(id => {
      const el = document.getElementById(id), rules = [];
      function walk(items) { for (const r of items) { if (r.selectorText) { const selector = r.selectorText; let matches = null, error = null; try { matches = document.querySelectorAll(selector.replace(/::(before|after|placeholder|selection|marker|file-selector-button)/g, '')).length; } catch(e) { error = String(e); } rules.push({ selector, strictGuard: selector.includes('html[data-ui-style="standard"]:has(> body') && selector.includes(':not(.companion-mode)'), matches, error }); } if (r.cssRules) walk(r.cssRules); } }
      if (el?.sheet) walk(el.sheet.cssRules);
      return { id, present: !!el, disabled: el?.disabled, href: el?.getAttribute('href'), rules, selectorCount: rules.length, allStrictGuard: rules.length > 0 && rules.every(r => r.strictGuard), allZero: rules.length > 0 && rules.every(r => r.matches === 0 && !r.error) };
    });
    const canvas = document.querySelector('#companionLive2DCanvas');
    return { theme: document.documentElement.dataset.uiStyle, bodyClass: document.body.className, sheets, realCanvasProven: false, welcomeClosed: !visible(document.querySelector('#welcomeOverlay')), dashboardVisible: visible(document.querySelector('#dashboard')), companionVisible: visible(document.querySelector('#companionStudy')), bodyElementCount: document.body.querySelectorAll('*').length, countdown: document.querySelector('#autoRefreshCountdown')?.textContent, canvasVisible: visible(canvas), canvasSize: canvas ? [canvas.width, canvas.height] : null, fallbackVisible: visible(document.querySelector('#companionGifFallback')), companionText: document.querySelector('#companionStudy')?.innerText, date: new Date().toISOString(), images: [...document.images].filter(visible).map(i => ({ src: i.getAttribute('src'), naturalSize: [i.naturalWidth, i.naturalHeight], complete: i.complete })), animations: document.getAnimations().map(a => ({ playState: a.playState, currentTime: a.currentTime, endTime: a.effect?.getComputedTiming().endTime })) };
  }, IDS);
}
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    for (const viewport of sizes) for (const state of states) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: 'block' });
      const row = { state, viewport, testOnly: true, realCanvasProven: false, routeHits: [], clicks: [], roleBindings: [], errors: [] };
      result.rows.push(row);
      try {
        await context.route(url => url.origin === BASE && routes.has(url.pathname), async route => {
          const url = new URL(route.request().url());
          const item = routes.get(url.pathname);
          row.routeHits.push({ originalUrl: url.href, exactPath: url.pathname, originalSHA256: item.entry.original_sha256, pngSHA256: item.entry.frame_png_sha256, size: item.entry.original_size, frame: 0 });
          await route.fulfill({ status: 200, contentType: 'image/png', body: item.body });
        });
        const page = await context.newPage();
        page.on('pageerror', e => row.errors.push(String(e)));
        page.on('response', async response => { if (new URL(response.url()).pathname === '/api/live2d/models') try { row.roleBindings.push((await response.json()).role_binding); } catch(e) { row.errors.push(String(e)); } });
        await page.addInitScript(theme => { localStorage.setItem('memo_ui_style', theme); localStorage.setItem('theme', 'light'); }, state.split('-')[0]);
        await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
        if (await page.locator('#welcomeSettingsBtn').isVisible()) for (const id of ['welcomeSettingsBtn', 'closeSettings']) { await page.locator('#' + id).click(); row.clicks.push(id); await page.waitForTimeout(500); }
        const view = state.split('-')[1];
        if (view === 'companion') { await page.click('#companionModeBtn'); row.clicks.push('companionModeBtn'); }
        else {
          await page.click('.layout-btn[data-layout="single"]'); row.clicks.push('single layout');
          if (view === 'settings') { await page.click('#settingsBtn'); row.clicks.push('settingsBtn'); }
          if (view === 'article') { await page.click('#articleVocabBtn'); row.clicks.push('articleVocabBtn'); }
        }
        await page.waitForTimeout(2500);
        await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].filter(i => i.currentSrc).map(i => i.decode().catch(() => {}))); });
        await page.mouse.move(0, 0);
        await page.waitForTimeout(500);
        row.beforeClock = await inspect(page);
        if (!row.beforeClock.welcomeClosed || row.beforeClock.bodyElementCount < 100 || row.beforeClock.theme !== state.split('-')[0]) throw Error('Initialization incomplete');
        if (view === 'companion' ? !row.beforeClock.companionVisible || !row.beforeClock.fallbackVisible : !row.beforeClock.dashboardVisible) throw Error('Target UI absent; refusing vacuous evidence');
        if (row.beforeClock.images.some(i => !i.complete || !i.naturalSize[0])) throw Error('Visible image not loaded');
        if (!row.routeHits.length) throw Error('No original GIF replacement observed');
        row.steadyStateReachedBeforeClock = true;
        const fixed = new Date('2026-11-16T05:00:00.000Z');
        await page.clock.install({ time: fixed });
        await page.clock.pauseAt(new Date(fixed.getTime() + 1000));
        await page.clock.setFixedTime(fixed);
        await page.clock.runFor(1000);
        const stem = state + '@' + viewport.width + 'x' + viewport.height;
        row.enabled = await inspect(page);
        const first = path.join(OUT, stem + '-enabled.png');
        await page.screenshot({ path: first, animations: 'allow', caret: 'initial' });
        await page.evaluate(ids => ids.forEach(id => { const link = document.getElementById(id); if (link) link.disabled = true; }), IDS);
        await page.clock.runFor(1000);
        row.disabled = await inspect(page);
        const second = path.join(OUT, stem + '-disabled.png');
        await page.screenshot({ path: second, animations: 'allow', caret: 'initial' });
        const diffPath = path.join(OUT, stem + '-pixels.json');
        const processResult = spawnSync(args.python, [path.join(__dirname, 'freeze_gif_frames.py'), 'compare', '--first', first, '--second', second, '--out', diffPath], { stdio: 'inherit' });
        if (processResult.error || processResult.status !== 0) throw Error('Pixel compare failed: ' + (processResult.error || processResult.status));
        row.pixels = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
        row.companionAllRulesZero = view === 'companion' ? row.enabled.sheets.every(s => s.present && s.allStrictGuard && s.allZero) : null;
        row.originalsUnchanged = [...routes.values()].every(x => hash(fs.readFileSync(path.join(ROOT, x.entry.path))) === x.entry.original_sha256);
        if (!row.originalsUnchanged) throw Error('Source GIF changed');
        if (!row.pixels.equal) throw Error('Strict RGB difference: ' + row.pixels.changed_pixels);
        if (view === 'companion' && !row.companionAllRulesZero) throw Error('New companion rules must match zero elements');
        if (row.enabled.date !== row.disabled.date || row.enabled.countdown !== row.disabled.countdown) throw Error('Date/countdown not fixed across pair');
        if (row.enabled.sheets.some(s => s.present && s.disabled) || row.disabled.sheets.some(s => s.present && !s.disabled)) throw Error('CSS link toggle failed');
        if (row.errors.length) throw Error('Page errors present');
      } catch(e) { row.errors.push(String(e)); result.failures.push({ state, viewport, error: String(e) }); }
      finally { await context.close(); save(); }
    }
  } finally { await browser.close(); save(); }
  process.exitCode = result.failures.length ? 1 : 0;
  console.log(JSON.stringify(result.rows.map(r => ({ state: r.state, viewport: r.viewport, pixels: r.pixels, strictGuardAllZero: r.companionAllRulesZero, errors: r.errors })), null, 2));
})().catch(e => { result.failures.push({ fatal: String(e) }); save(); console.error(e); process.exitCode = 1; });
