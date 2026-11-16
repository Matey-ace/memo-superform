// B 子智能体：隐藏重绘修复方案的最小等价性验证（Playwright route 改写 js/charts.js，不改磁盘文件）。
//
// 用法: node tests/perf/frontend-b-hidden-fix.js --count 50000 --rounds 5 \
//        --out tests/perf/results/frontend_hiddenfix.json
//
// 实验组：
//   baseline        原样 charts.js
//   guard-hidden    renderVisibleFromSelectors 在 #dashboard[hidden] 时只标 dirty，不 init/setOption
//   guard-hidden+cache  同上 + 恢复时复用 render() 的最新 options（不重建图表类型判定逻辑）
//
// 等价性判定（不是“看着一样”）：退出陪伴后比较
//   - 每块可见磁贴的 echarts getOption() 的 series 数据长度与摘要 hash
//   - canvas 数量、图表容器可见尺寸
//   - 磁贴标题、chart-selector 值
//   - 与 baseline 逐项比较（同数据、同主题、同布局）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const COUNT = parseInt(arg('count', '50000'), 10);
const ROUNDS = Math.max(1, parseInt(arg('rounds', '5'), 10));
const SEED = parseInt(arg('seed', '20261008'), 10);
const OUT = arg('out', path.join(ROOT, 'tests/perf/results/frontend_hiddenfix.json'));
const THEME = arg('theme', 'standard');
const TAG = arg('hf');

// ---- charts.js 补丁（行号对应工作树当前内容：1264-1285）----
const ORIGINAL_FN = `function renderVisibleFromSelectors(skipAI) {
        document.querySelectorAll('.tile').forEach(function(tile) {
            if (tile.style.display === 'none') return;`;

const PATCHED_FN = `function renderVisibleFromSelectors(skipAI) {
        // 仪表盘被 hidden（陪伴模式）时没有布局盒：echarts.init 会得到 0x0 画布，
        // 既画不出东西，又会在恢复后留下尺寸错误的实例。这里只标 dirty，恢复时补一次。
        var dashboardEl = document.getElementById('dashboard');
        if (dashboardEl && dashboardEl.hidden) { pendingVisibleRender = true; return; }
        pendingVisibleRender = false;
        document.querySelectorAll('.tile').forEach(function(tile) {
            if (tile.style.display === 'none') return;`;

// render() 是唯一创建实例的入口；同步加上“容器无布局盒就跳过”的兜底，
// 让除 renderVisibleFromSelectors 之外的调用（组合切换、主题切换）也不会在隐藏时建图。
const ORIGINAL_RENDER = `        const containerId = 'chart-' + tileIndex;
        const container = document.getElementById(containerId);
        if (!container) return null;`;
const PATCHED_RENDER = `        const containerId = 'chart-' + tileIndex;
        const container = document.getElementById(containerId);
        if (!container) return null;
        // 隐藏容器（display:none / 祖先 hidden / 零尺寸）下不建图：ECharts 会拿到 0x0 画布。
        if (!container.offsetParent && !container.getClientRects().length) { pendingVisibleRender = true; return null; }`;

// 恢复钩子：可见时把跳过的重绘补一次。挂在 renderVisibleFromSelectors 的 nextVisibleRender 上，
// 由调用方（exit()）已有的 renderVisibleFromSelectors 调用自然触发。
const DECL = `    let cachedNotepadWords = null;`;
const DECL_PATCHED = `    let cachedNotepadWords = null;
    // 隐藏期间被跳过的重绘请求；恢复可见后的第一次 renderVisibleFromSelectors 会消费它。
    let pendingVisibleRender = false;`;

function patchChartsJs(source, mode) {
  if (mode === 'baseline') return source;
  // 工作树里的 charts.js 是混合行尾（CRLF 1273 行 / LF 1330 行）。.js 语义不受行尾影响，
  // 这里先归一化成 LF 再匹配补丁锚点，避免锚点被 \r 打断。
  let out = source.replace(/\r\n/g, '\n');
  if (!out.includes(ORIGINAL_FN)) throw new Error('charts.js 中找不到 renderVisibleFromSelectors 的函数头');
  out = out.replace(ORIGINAL_FN, PATCHED_FN);
  if (!out.includes(DECL)) throw new Error('charts.js 中找不到 cachedNotepadWords 声明');
  out = out.replace(DECL, DECL_PATCHED);
  if (mode === 'guard-hidden') return out;
  if (mode === 'guard-hidden+cache') {
    if (!out.includes(ORIGINAL_RENDER)) throw new Error('charts.js 中找不到 render() 的容器检查');
    out = out.replace(ORIGINAL_RENDER, PATCHED_RENDER);
    return out;
  }
  throw new Error('未知 mode ' + mode);
}

const PROBE = function () {
  window.__probe = { initCalls: [], setOptionCalls: 0 };
  window.__probe.install = function () {
    if (!window.echarts || typeof window.echarts.init !== 'function' || window.echarts.__probed) return false;
    var origInit = window.echarts.init;
    window.echarts.init = function (dom) {
      var rect = null;
      try {
        var r = dom && dom.getBoundingClientRect ? dom.getBoundingClientRect() : null;
        rect = r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
      } catch (e) {}
      var inst = origInit.apply(this, arguments);
      window.__probe.initCalls.push({
        domId: dom && dom.id ? dom.id : null, rect: rect,
        visible: !!(dom && dom.offsetWidth > 0 && dom.offsetHeight > 0),
        dashboardHidden: !!(document.getElementById('dashboard') && document.getElementById('dashboard').hidden)
      });
      if (inst && inst.setOption) {
        var s = inst.setOption.bind(inst);
        inst.setOption = function () { window.__probe.setOptionCalls += 1; return s.apply(this, arguments); };
      }
      return inst;
    };
    window.echarts.__probed = true;
    return true;
  };
  // 图表快照：逐磁贴抽取 option 的关键结构，做稳定 hash。
  window.__snapshotCharts = function () {
    var out = [];
    document.querySelectorAll('.tile').forEach(function (tile) {
      var idx = tile.dataset.tile;
      var sel = tile.querySelector('.chart-selector');
      var inst = (typeof ChartManager !== 'undefined') ? ChartManager.getInstance(parseInt(idx, 10)) : null;
      var row = {
        tile: idx,
        display: tile.style.display || '',
        selector: sel ? sel.value : null,
        title: (tile.querySelector('.tile-title') || {}).textContent || null,
        canvases: tile.querySelectorAll('canvas').length,
        hasInstance: !!inst,
        size: (function () {
          var c = tile.querySelector('.chart-container');
          if (!c) return null;
          var r = c.getBoundingClientRect();
          return Math.round(r.width) + 'x' + Math.round(r.height);
        })()
      };
      if (inst && inst.getOption) {
        try {
          var opt = inst.getOption();
          var series = (opt.series || []).map(function (s) {
            var d = s.data;
            return {
              type: s.type || null,
              len: Array.isArray(d) ? d.length : null,
              // 前 3 条 + 后 3 条样本，避免整份数据进 JSON
              head: Array.isArray(d) ? d.slice(0, 3) : null,
              tail: Array.isArray(d) ? d.slice(-3) : null
            };
          });
          var digest = crypto && crypto.createHash ? null : null;
          row.series = series;
          row.seriesDigest = JSON.stringify(series).length + ':' + hashString(JSON.stringify(series));
        } catch (e) { row.optionError = String(e.message || e); }
      }
      out.push(row);
    });
    return out;
  };
  function hashString(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }
};

async function startServer() {
  const dataDir = path.join(ROOT, '_verification/perfvocab/B', TAG + '-' + COUNT + '-' + Date.now().toString(36));
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn('python', [path.join(__dirname, 'bench_server.py'),
    '--count', String(COUNT), '--seed', String(SEED), '--data-dir', dataDir],
  { cwd: ROOT, windowsHide: true, env: Object.assign({}, process.env, { MEMO_DATA_DIR: dataDir }) });
  const meta = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('bench server startup timeout')), 300000);
    child.stdout.on('data', chunk => {
      text += chunk;
      const url = text.match(/BENCH_URL=(\S+)/);
      const seeded = text.match(/BENCH_SEEDED=(\d+)/);
      if (url) { clearTimeout(timer); resolve({ url: url[1], seeded: seeded ? +seeded[1] : 0 }); }
    });
    child.stderr.on('data', () => {});
    child.on('exit', code => { clearTimeout(timer); reject(new Error('bench server exited ' + code)); });
  });
  let warmed = false;
  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch(meta.url + '/api/study-records');
      const body = await res.json();
      if (res.ok && body && body.count === meta.seeded) { warmed = true; break; }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 800));
  }
  if (!warmed) throw new Error('基准服务预热失败');
  return { child, ...meta };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 4000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.stdin.end('exit\n'); } catch (e) { child.kill(); resolve(); }
  });
}

async function newPage(browser, base, mode) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  await page.addInitScript(({ theme }) => {
    localStorage.setItem('memo_ui_style', theme);
    localStorage.setItem('theme', 'light');
    localStorage.setItem('auto_refresh_enabled', 'false');
  }, { theme: THEME });
  await page.addInitScript(PROBE);
  await page.route('**://*.maimemo.com/**', r => r.abort());
  await page.route('**://*.github.com/**', r => r.abort());
  await page.route('**/memo-**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>offline</body></html>' }));
  await page.route('**/api/app/update-status*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_version: '0.89', update_available: false, can_download: false, download: { state: 'idle' } }) }));
  await page.route('**/api/study-sync', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'idle', active: false }) }));
  await page.route('**/api/study-sync/status', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'idle', active: false, bootstrap_complete: true, local_record_count: 0 }) }));
  await page.route('**/proxy/**', r => r.abort());
  if (mode !== 'baseline') {
    await page.route(base + '/js/charts.js*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const patched = patchChartsJs(source, mode);
      await route.fulfill({ response, body: patched, headers: Object.assign({}, response.headers(), { 'content-length': String(Buffer.byteLength(patched)), 'cache-control': 'no-store' }) });
    });
  }
  return { context, page, errors };
}

async function waitRecords(page) {
  await page.waitForFunction((n) => {
    try {
      if (typeof ChartManager === 'undefined' || !ChartManager.getRecords) return false;
      const r = ChartManager.getRecords();
      return !!r && r.length === n;
    } catch (e) { return false; }
  }, COUNT, { timeout: 240000 });
  await page.waitForFunction(() => document.querySelectorAll('.tile canvas').length > 0, null, { timeout: 240000 });
}

async function run(browser, base, mode) {
  const { context, page, errors } = await newPage(browser, base, mode);
  try {
    await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
    await waitRecords(page);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__probe.install());

    const dashboardBaseline = await page.evaluate(() => window.__snapshotCharts());

    // 切到 4 格布局，让“多磁贴”路径也进入实验
    await page.evaluate(() => {
      const b = document.querySelector('.layout-btn[data-layout="grid4"]');
      if (b) b.click();
    });
    await page.waitForTimeout(600);
    const grid4Baseline = await page.evaluate(() => window.__snapshotCharts());

    // 进入陪伴模式
    await page.locator('#companionModeBtn').click();
    const entered = await page.waitForFunction(() => document.getElementById('dashboard').hidden === true, null, { timeout: 60000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(600);

    const hiddenRedraws = [];
    // 模拟隐藏期间的 3 次重绘入口（自动刷新 / 同步 / 云词本到达）
    for (let i = 0; i < 3; i++) {
      const r = await page.evaluate(() => {
        window.__probe.initCalls.length = 0;
        window.__probe.setOptionCalls = 0;
        const t0 = performance.now();
        ChartManager.renderVisibleFromSelectors(false);
        return {
          ms: Math.round((performance.now() - t0) * 100) / 100,
          initCalls: window.__probe.initCalls.slice(),
          setOptionCalls: window.__probe.setOptionCalls,
          canvases: document.querySelectorAll('.tile canvas').length
        };
      });
      hiddenRedraws.push(r);
      await page.waitForTimeout(80);
    }

    // 退出陪伴
    await page.evaluate(() => {
      window.__probe.initCalls.length = 0;
      window.__probe.setOptionCalls = 0;
      document.getElementById('exitCompanionModeBtn').click();
    });
    await page.waitForTimeout(1200);
    const exitInfo = await page.evaluate(() => ({
      initCalls: window.__probe.initCalls.slice(),
      setOptionCalls: window.__probe.setOptionCalls,
      dashboardHidden: document.getElementById('dashboard').hidden,
      canvases: document.querySelectorAll('.tile canvas').length
    }));
    const grid4After = await page.evaluate(() => window.__snapshotCharts());

    // 再切回单格，检查恢复后的常规路径仍然正确
    await page.evaluate(() => {
      const b = document.querySelector('.layout-btn[data-layout="single"]');
      if (b) b.click();
    });
    await page.waitForTimeout(700);
    const singleAfter = await page.evaluate(() => window.__snapshotCharts());

    return {
      mode, entered,
      hiddenRedraws,
      hiddenInitCount: hiddenRedraws.reduce((a, r) => a + r.initCalls.length, 0),
      hiddenSetOptionCount: hiddenRedraws.reduce((a, r) => a + r.setOptionCalls, 0),
      hiddenInitSizes: hiddenRedraws.flatMap(r => r.initCalls.map(c => (c.rect ? c.rect.w + 'x' + c.rect.h : 'n/a'))),
      exitInfo,
      dashboardBaseline, grid4Baseline, grid4After, singleAfter,
      errors: errors.slice(0, 5)
    };
  } finally { await context.close(); }
}

function compare(label, a, b) {
  // 逐磁贴比较可观测输出：display / selector / title / canvases / hasInstance / seriesDigest
  const keys = ['display', 'selector', 'title', 'canvases', 'hasInstance', 'seriesDigest'];
  const diffs = [];
  const byTile = rows => Object.fromEntries(rows.map(r => [r.tile, r]));
  const A = byTile(a), B = byTile(b);
  for (const tile of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const ra = A[tile], rb = B[tile];
    if (!ra || !rb) { diffs.push({ tile, field: 'missing', a: !!ra, b: !!rb }); continue; }
    for (const k of keys) if (ra[k] !== rb[k]) diffs.push({ tile, field: k, a: ra[k], b: rb[k] });
  }
  return { label, equal: diffs.length === 0, diffs };
}

(async () => {
  const report = {
    kind: 'frontend-hiddenfix', tag: TAG, generatedAt: new Date().toISOString(),
    count: COUNT, rounds: ROUNDS, theme: THEME, seed: SEED,
    methods: ['baseline', 'guard-hidden', 'guard-hidden+cache'],
    environment: { node: process.version, edge: EDGE, viewport: { width: 1440, height: 900 } },
    runs: []
  };
  let browser, server;
  try {
    browser = await chromium.launch({ headless: true, executablePath: EDGE });
    report.environment.browserVersion = await browser.version();
    server = await startServer();
    for (let round = 1; round <= ROUNDS; round++) {
      for (const mode of report.methods) {
        const r = await run(browser, server.url, mode);
        r.round = round;
        report.runs.push(r);
        console.log('round ' + round + ' ' + mode +
          ' hiddenInits=' + r.hiddenInitCount + '/' + (r.hiddenRedraws.length) +
          ' hiddenSetOption=' + r.hiddenSetOptionCount +
          ' exitInits=' + r.exitInfo.initCalls.length +
          ' canvasesAfterExit=' + r.exitInfo.canvases +
          ' hiddenSizes=' + JSON.stringify(r.hiddenInitSizes));
      }
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    }

    // 等价性：每个 mode 与 baseline 逐轮比较
    report.equivalence = [];
    for (const mode of report.methods) {
      for (let round = 1; round <= ROUNDS; round++) {
        const base = report.runs.find(r => r.round === round && r.mode === 'baseline');
        const cand = report.runs.find(r => r.round === round && r.mode === mode);
        if (!base || !cand) continue;
        report.equivalence.push({
          round, mode,
          grid4: compare('grid4After', base.grid4After, cand.grid4After),
          single: compare('singleAfter', base.singleAfter, cand.singleAfter),
          dashboard: compare('dashboardBaseline', base.dashboardBaseline, cand.dashboardBaseline)
        });
      }
    }
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log('FRONTEND_HIDDENFIX_DONE ' + OUT);
  } finally {
    if (browser) await browser.close();
    if (server) await stopServer(server.child);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
