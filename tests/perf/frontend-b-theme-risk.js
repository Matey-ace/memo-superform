// B 子智能体 EXP6：修复方案的回归风险定向测试。
//
// 场景：进入陪伴模式 -> 隐藏期间切换主题 -> 退出陪伴。检查退出后各磁贴图表是否
// 采用了新主题的配色（而不是停留在旧主题）。这是 guard 补丁最可能引入的回归。
//
// 用法: node tests/perf/frontend-b-theme-risk.js --count 5000 --out tests/perf/results/frontend_theme_risk.json
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
function arg(n, f) { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : f; }
const COUNT = parseInt(arg('count', '5000'), 10);
const SEED = parseInt(arg('seed', '20261008'), 10);
const OUT = arg('out', path.join(ROOT, 'tests/perf/results/frontend_theme_risk.json'));

const ORIGINAL_FN = `function renderVisibleFromSelectors(skipAI) {
        document.querySelectorAll('.tile').forEach(function(tile) {
            if (tile.style.display === 'none') return;`;
const PATCHED_FN = `function renderVisibleFromSelectors(skipAI) {
        var dashboardEl = document.getElementById('dashboard');
        if (dashboardEl && dashboardEl.hidden) { pendingVisibleRender = true; return; }
        pendingVisibleRender = false;
        document.querySelectorAll('.tile').forEach(function(tile) {
            if (tile.style.display === 'none') return;`;
const DECL = `    let cachedNotepadWords = null;`;
const DECL_PATCHED = `    let cachedNotepadWords = null;
    let pendingVisibleRender = false;`;

// 变体 A（保守）：只 guard renderVisibleFromSelectors
const ORIGINAL_RENDER = `        const containerId = 'chart-' + tileIndex;
        const container = document.getElementById(containerId);
        if (!container) return null;`;
const PATCHED_RENDER = `        const containerId = 'chart-' + tileIndex;
        const container = document.getElementById(containerId);
        if (!container) return null;
        if (!container.offsetParent && !container.getClientRects().length) { pendingVisibleRender = true; return null; }`;

function patch(src, mode) {
  if (mode === 'baseline') return src;
  let out = src.replace(/\r\n/g, '\n');
  if (!out.includes(ORIGINAL_FN)) throw new Error('anchor missing: renderVisibleFromSelectors');
  if (!out.includes(DECL)) throw new Error('anchor missing: cachedNotepadWords');
  out = out.replace(ORIGINAL_FN, PATCHED_FN).replace(DECL, DECL_PATCHED);
  if (mode === 'guard-both') {
    if (!out.includes(ORIGINAL_RENDER)) throw new Error('anchor missing: render container');
    out = out.replace(ORIGINAL_RENDER, PATCHED_RENDER);
  } else if (mode !== 'guard-visible') {
    throw new Error('bad mode ' + mode);
  }
  return out;
}

async function startServer() {
  const dir = path.join(ROOT, '_verification/perfvocab/B', 'themerisk-' + COUNT + '-' + Date.now().toString(36));
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn('python', [path.join(__dirname, 'bench_server.py'), '--count', String(COUNT), '--seed', String(SEED), '--data-dir', dir],
    { cwd: ROOT, windowsHide: true, env: Object.assign({}, process.env, { MEMO_DATA_DIR: dir }) });
  const meta = await new Promise((res, rej) => {
    let t = ''; const timer = setTimeout(() => rej(new Error('timeout')), 300000);
    child.stdout.on('data', c => { t += c; const m = t.match(/BENCH_URL=(\S+)/); const s = t.match(/BENCH_SEEDED=(\d+)/); if (m) { clearTimeout(timer); res({ url: m[1], seeded: s ? +s[1] : 0 }); } });
    child.stderr.on('data', () => {});
    child.on('exit', c => { clearTimeout(timer); rej(new Error('exit ' + c)); });
  });
  for (let i = 0; i < 8; i++) {
    try { const r = await fetch(meta.url + '/api/study-records'); const j = await r.json(); if (r.ok && j.count === meta.seeded) break; } catch (e) {}
    await new Promise(r => setTimeout(r, 800));
  }
  return { child, ...meta };
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(r => { const t = setTimeout(() => { child.kill(); r(); }, 4000); child.once('exit', () => { clearTimeout(t); r(); }); try { child.stdin.end('exit\n'); } catch (e) { child.kill(); r(); } });
}

async function run(browser, base, mode) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.addInitScript(() => {
    localStorage.setItem('memo_ui_style', 'standard');
    localStorage.setItem('theme', 'light');
    localStorage.setItem('auto_refresh_enabled', 'false');
  });
  await page.route('**://*.maimemo.com/**', r => r.abort());
  await page.route('**/memo-**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>offline</body></html>' }));
  await page.route('**/api/app/update-status*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_version: '0.89', update_available: false, can_download: false, download: { state: 'idle' } }) }));
  await page.route('**/api/study-sync', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'idle', active: false }) }));
  await page.route('**/api/study-sync/status', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'idle', active: false, bootstrap_complete: true, local_record_count: 0 }) }));
  await page.route('**/proxy/**', r => r.abort());
  if (mode !== 'baseline') {
    await page.route(base + '/js/charts.js*', async route => {
      const response = await route.fetch();
      const src = await response.text();
      const out = patch(src, mode);
      await route.fulfill({ response, body: out, headers: Object.assign({}, response.headers(), { 'content-length': String(Buffer.byteLength(out)), 'cache-control': 'no-store' }) });
    });
  }
  try {
    await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => { try { return typeof ChartManager !== 'undefined' && (ChartManager.getRecords() || []).length === n; } catch (e) { return false; } }, COUNT, { timeout: 240000 });
    await page.waitForFunction(() => document.querySelectorAll('.tile canvas').length > 0, null, { timeout: 240000 });
    await page.waitForTimeout(400);

    // 记录轻色主题下热力图某个格子的颜色（配色指纹）
    const fingerprint = () => page.evaluate(() => {
      try {
        const inst = ChartManager.getInstance(0);
        if (!inst) return null;
        const opt = inst.getOption();
        const s = (opt.series || [])[0];
        if (!s || !Array.isArray(s.data)) return null;
        // 取前 5 个有颜色的格子 itemStyle.color + 标题颜色
        const colors = s.data.slice(0, 5).map(d => (d && d.itemStyle && d.itemStyle.color) || null);
        const titleColor = opt.title && opt.title[0] && opt.title[0].textStyle && opt.title[0].textStyle.color;
        return { colors, titleColor, dark: document.body.classList.contains('dark') };
      } catch (e) { return { error: String(e.message || e) }; }
    });

    const light = await fingerprint();

    await page.locator('#companionModeBtn').click();
    await page.waitForFunction(() => document.getElementById('dashboard').hidden === true, null, { timeout: 60000 });
    await page.waitForTimeout(300);

    // 陪伴模式中切换主题（topbar 的 themeBtn 仍可用）
    await page.evaluate(() => { const b = document.getElementById('themeBtn'); if (b) b.click(); });
    await page.waitForTimeout(400);
    const themeWhileHidden = await page.evaluate(() => ({ dark: document.body.classList.contains('dark') }));

    await page.evaluate(() => document.getElementById('exitCompanionModeBtn').click());
    await page.waitForTimeout(1400);
    const dark = await fingerprint();
    return { mode, light, themeWhileHidden, dark, errors: errors.slice(0, 3) };
  } finally { await context.close(); }
}

(async () => {
  const report = { kind: 'frontend-theme-risk', generatedAt: new Date().toISOString(), count: COUNT, modes: ['baseline', 'guard-visible', 'guard-both'], runs: [] };
  let browser, server;
  try {
    browser = await chromium.launch({ headless: true, executablePath: EDGE });
    report.browserVersion = await browser.version();
    server = await startServer();
    for (const mode of report.modes) {
      const r = await run(browser, server.url, mode);
      report.runs.push(r);
      const changed = r.light && r.dark && JSON.stringify(r.light.colors) !== JSON.stringify(r.dark.colors);
      console.log(mode + ' darkApplied=' + (r.dark && r.dark.dark) + ' colorsChangedByTheme=' + changed +
        ' lightTitle=' + (r.light && r.light.titleColor) + ' darkTitle=' + (r.dark && r.dark.titleColor));
    }
    // 交叉比较：退出后各 mode 的深色指纹是否一致
    const base = report.runs.find(r => r.mode === 'baseline');
    report.crossCheck = report.runs.map(r => ({
      mode: r.mode,
      matchesBaseline: JSON.stringify(r.dark) === JSON.stringify(base.dark),
      dark: r.dark
    }));
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log('THEME_RISK_DONE ' + OUT);
  } finally {
    if (browser) await browser.close();
    if (server) await stop(server.child);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
