// B 子智能体 EXP5：隐藏重绘的“旁路入口”取证。
//
// renderVisibleFromSelectors 不是唯一入口。以下调用在陪伴模式（#dashboard[hidden]）下
// 仍会直接走到 charts.js 的 render() -> echarts.init：
//   js/app.js:129   setupTheme 回调 -> ChartManager.renderAll()      （主题切换）
//   js/app.js:662   AI 分类完成   -> ChartManager.render(index,'aiclass')
//   js/layout.js:328/346          -> ChartManager.render(...)        （趋势范围 / 热力图月份）
// 本脚本在隐藏状态下逐个触发这些入口，统计 echarts.init 次数与容器尺寸。
//
// 用法: node tests/perf/frontend-b-hidden-bypass.js --count 10000 --out tests/perf/results/frontend_hidden_bypass.json
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
function arg(n, f) { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : f; }
const COUNT = parseInt(arg('count', '10000'), 10);
const SEED = parseInt(arg('seed', '20261008'), 10);
const OUT = arg('out', path.join(ROOT, 'tests/perf/results/frontend_hidden_bypass.json'));
const THEME = arg('theme', 'standard');

const PROBE = function () {
  window.__p = { inits: [] };
  window.__install = function () {
    if (!window.echarts || window.echarts.__p) return false;
    var o = window.echarts.init;
    window.echarts.init = function (dom) {
      var r = null;
      try { var b = dom.getBoundingClientRect(); r = Math.round(b.width) + 'x' + Math.round(b.height); } catch (e) {}
      var inst = o.apply(this, arguments);
      window.__p.inits.push({ domId: dom && dom.id, rect: r, dashboardHidden: !!(document.getElementById('dashboard') || {}).hidden });
      return inst;
    };
    window.echarts.__p = true; return true;
  };
};

async function startServer() {
  const dir = path.join(ROOT, '_verification/perfvocab/B', 'bypass-' + COUNT + '-' + Date.now().toString(36));
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

(async () => {
  const report = { kind: 'frontend-hidden-bypass', generatedAt: new Date().toISOString(), count: COUNT, theme: THEME, exits: {} };
  let browser, server;
  try {
    browser = await chromium.launch({ headless: true, executablePath: EDGE });
    report.browserVersion = await browser.version();
    server = await startServer();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message)));
    await page.addInitScript(({ theme }) => {
      localStorage.setItem('memo_ui_style', theme); localStorage.setItem('theme', 'light');
      localStorage.setItem('auto_refresh_enabled', 'false');
    }, { theme: THEME });
    await page.addInitScript(PROBE);
    await page.route('**://*.maimemo.com/**', r => r.abort());
    await page.route('**/memo-**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>offline</body></html>' }));
    await page.route('**/api/app/update-status*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_version: '0.89', update_available: false, can_download: false, download: { state: 'idle' } }) }));
    await page.route('**/api/study-sync', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'idle', active: false }) }));
    await page.route('**/api/study-sync/status', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'idle', active: false, bootstrap_complete: true, local_record_count: 0 }) }));
    await page.route('**/proxy/**', r => r.abort());

    await page.goto(server.url + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => { try { return typeof ChartManager !== 'undefined' && (ChartManager.getRecords() || []).length === n; } catch (e) { return false; } }, COUNT, { timeout: 240000 });
    await page.waitForFunction(() => document.querySelectorAll('.tile canvas').length > 0, null, { timeout: 240000 });
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__install());

    await page.evaluate(() => { const b = document.querySelector('.layout-btn[data-layout="grid4"]'); if (b) b.click(); });
    await page.waitForTimeout(500);

    await page.locator('#companionModeBtn').click();
    await page.waitForFunction(() => document.getElementById('dashboard').hidden === true, null, { timeout: 60000 });
    await page.waitForTimeout(600);

    const probes = {
      // app.js:129 主题切换回调 -> ChartManager.renderAll()
      themeSwitchRenderAll: () => { ChartManager.renderAll(); },
      // app.js:659-664 AI 分类完成后的逐磁贴重绘
      aiClassifyDirectRender: () => {
        for (const idx of [0, 1, 2, 3]) {
          if (ChartManager.getChartType(idx) === 'aiclass') ChartManager.render(idx, 'aiclass');
        }
        // 即使当前没有 aiclass 磁贴，也验证 render() 本身的行为
        ChartManager.render(0, 'aiclass');
      },
      // layout.js:328 趋势范围按钮
      trendRangeDirectRender: () => { ChartManager.render(1, 'trend', { days: 90 }); },
      // layout.js:346 热力图月份
      heatmapMonthDirectRender: () => { ChartManager.render(0, 'heatmap', { month: '2026-09' }); },
      // 组合切换 / 磁贴选择器直接改（layout.js:429 applyChartToTile 后 render）
      selectorDirectRender: () => { ChartManager.render(2, 'memory'); }
    };
    for (const [name, fn] of Object.entries(probes)) {
      const r = await page.evaluate(({ src }) => {
        window.__p.inits.length = 0;
        const t0 = performance.now();
        // eslint-disable-next-line no-new-func
        new Function('return (' + src + ')')()();
        return { ms: Math.round((performance.now() - t0) * 100) / 100, inits: window.__p.inits.slice() };
      }, { src: fn.toString() });
      report.exits[name] = r;
      await page.waitForTimeout(60);
    }
    report.hiddenInitTotal = Object.values(report.exits).reduce((a, e) => a + e.inits.length, 0);
    report.pageErrors = errors.slice(0, 5);
    // canvas 数：隐藏时 echarts 仍会插入 canvas 到容器
    report.canvasesWhileHidden = await page.evaluate(() => document.querySelectorAll('.tile canvas').length);
    await page.evaluate(() => document.getElementById('exitCompanionModeBtn').click());
    await page.waitForTimeout(1200);
    report.afterExit = await page.evaluate(() => ({
      canvases: document.querySelectorAll('.tile canvas').length,
      sizes: Array.from(document.querySelectorAll('.tile .chart-container')).map(c => {
        const r = c.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height);
      })
    }));
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    await context.close();
    console.log('BYPASS_DONE ' + OUT);
  } finally {
    if (browser) await browser.close();
    if (server) await stop(server.child);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
