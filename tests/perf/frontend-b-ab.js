// B 子智能体 A/B 实验：隐藏重绘取证 + 依赖加载变体对照（只测，不改生产代码）。
//
// 用法：
//   node tests/perf/frontend-b-ab.js --count 50000 --rounds 7 \
//        --out tests/perf/results/frontend_ab.json
//
// 变体（用 Playwright route 改写 index.html 响应，磁盘文件不动）：
//   baseline       原样
//   defer-echarts  vendor/echarts.min.js 加 defer
//   no-live2d      删掉四个 Live2D vendor 标签（上界估计）
//   lazy-live2d    删标签 + 首次点击陪伴按钮时才按原顺序注入
//
// 隐藏重绘取证（EXP1）：
//   进入陪伴模式 -> 仪表盘 hidden、图表被 disposeAll 清空 ->
//   触发“数据变化后的重绘入口” ChartManager.renderVisibleFromSelectors(false) ->
//   记录 echarts.init 次数、容器 getBoundingClientRect 尺寸、console 警告。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const COUNT = parseInt(arg('count', '50000'), 10);
const ROUNDS = Math.max(1, parseInt(arg('rounds', '7'), 10));
const SEED = parseInt(arg('seed', '20261008'), 10);
const OUT = arg('out', path.join(ROOT, 'tests/perf/results/frontend_ab.json'));
const VARIANTS = arg('variants', 'baseline,defer-echarts,no-live2d,lazy-live2d').split(',').filter(Boolean);
const THEME = arg('theme', 'standard');
const TAG = arg('tag', 'ab');

// ---------- 页面内探针 ----------
const PROBE = function () {
  window.__probe = {
    initCalls: [], longTasks: [], longTaskSupported: true, setOptionCalls: 0
  };
  try {
    new PerformanceObserver(function (list) {
      for (const e of list.getEntries()) window.__probe.longTasks.push(Math.round(e.duration * 100) / 100);
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { window.__probe.longTaskSupported = false; }

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
        at: Math.round(performance.now() * 100) / 100,
        domId: dom && dom.id ? dom.id : null,
        rect: rect,
        // offsetParent === null 表示容器没有布局盒（hidden / display:none / 零尺寸）
        hasLayoutBox: !!(dom && dom.offsetParent),
        dashboardHidden: !!(document.getElementById('dashboard') && document.getElementById('dashboard').hidden),
        visible: !!(dom && dom.offsetWidth > 0 && dom.offsetHeight > 0)
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
};

// ---------- index.html 变体改写 ----------
const ECHARTS_TAG = '<script src="vendor/echarts.min.js?v=40"></script>';
const LIVE2D_SOURCES = [
  'vendor/live2d/live2d-2.1.min.js?v=072',
  'vendor/live2d/live2dcubismcore.min.js?v=072',
  'vendor/live2d/pixi-6.5.10.min.js?v=072',
  'vendor/live2d/pixi-live2d-display-0.4.0.min.js?v=072'
];
const LIVE2D_TAGS = LIVE2D_SOURCES.map(s => '<script src="' + s + '"></script>');

function rewriteIndexHtml(html, variant) {
  if (!variant || variant === 'baseline') return html;
  let out = html;
  if (variant === 'defer-echarts') {
    if (!out.includes(ECHARTS_TAG)) throw new Error('找不到 echarts 标签');
    return out.replace(ECHARTS_TAG, ECHARTS_TAG.replace('<script ', '<script defer '));
  }
  let removed = 0;
  for (const tag of LIVE2D_TAGS) { if (out.includes(tag)) { out = out.replace(tag, ''); removed += 1; } }
  if (removed !== LIVE2D_TAGS.length) throw new Error('只移除 ' + removed + '/' + LIVE2D_TAGS.length + ' 个 Live2D 标签');
  if (variant === 'no-live2d') return out;
  if (variant !== 'lazy-live2d') throw new Error('未知变体 ' + variant);

  // 按需加载：在陪伴模式入口点击时按原顺序串行注入四个库。
  // live2d-companion.js 的 enter() 先 disposeAll + hidden=true，再 await loadModels()，
  // 之后才 loadRenderer() 读 window.PIXI；因此在 capture 阶段先注入不会改变它的判定顺序。
  const loader = `<script>
(function () {
  var SOURCES = ${JSON.stringify(LIVE2D_SOURCES)};
  var bundle = window.__live2dB = { state: 'idle', startedAt: null, finishedAt: null, error: null };
  var pending = null;
  function loadOne(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = function () { resolve(src); };
      el.onerror = function () { reject(new Error('Live2D 运行库加载失败: ' + src)); };
      document.head.appendChild(el);
    });
  }
  window.__loadLive2DBundle = function () {
    if (pending) return pending;
    bundle.state = 'loading';
    bundle.startedAt = Math.round(performance.now() * 100) / 100;
    pending = SOURCES.reduce(function (chain, src) {
      return chain.then(function () { return loadOne(src); });
    }, Promise.resolve()).then(function () {
      bundle.state = 'loaded';
      bundle.finishedAt = Math.round(performance.now() * 100) / 100;
      return true;
    }, function (error) {
      bundle.state = 'failed';
      bundle.error = String(error && error.message || error);
      throw error;
    });
    return pending;
  };
  var btn = document.getElementById('companionModeBtn');
  if (btn) btn.addEventListener('click', function (event) {
    if (bundle.state !== 'idle') return;
    // 阻断本次点击，等库就绪后重新派发一次，让 live2d-companion.js 的 enter() 正常跑。
    event.stopImmediatePropagation();
    event.preventDefault();
    window.__loadLive2DBundle().catch(function () {}).then(function () { btn.click(); });
  }, true);
})();
</script>`;
  out = out.replace('<script>window.MemoUIStyle.activate(document);</script>',
    '<script>window.MemoUIStyle.activate(document);</script>\n' + loader);
  if (out === html) throw new Error('未能插入 Live2D 懒加载器');
  return out;
}

// ---------- 服务器 ----------
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
  return { child, ...meta, dataDir };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 4000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.stdin.end('exit\n'); } catch (e) { child.kill(); resolve(); }
  });
}

async function newPage(browser, base, variant) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const consoleMessages = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') consoleMessages.push(m.type() + ': ' + m.text().slice(0, 200)); });
  await page.addInitScript(({ theme }) => {
    localStorage.setItem('memo_ui_style', theme);
    localStorage.setItem('theme', 'light');
    localStorage.setItem('auto_refresh_enabled', 'false'); // 隐藏重绘由实验显式触发，避免 10 分钟定时器干扰
  }, { theme: THEME });
  await page.addInitScript(PROBE);
  await page.route('**://*.maimemo.com/**', r => r.abort());
  await page.route('**://*.github.com/**', r => r.abort());
  await page.route('**/memo-**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>offline</body></html>' }));
  await page.route('**/api/app/update-status*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_version: '0.89', update_available: false, can_download: false, download: { state: 'idle' } }) }));
  await page.route('**/api/study-sync', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'idle', active: false }) }));
  await page.route('**/api/study-sync/status', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'idle', active: false, bootstrap_complete: true, local_record_count: 0 }) }));
  await page.route('**/proxy/**', r => r.abort());
  if (variant && variant !== 'baseline') {
    await page.route(base + '/index.html', async route => {
      // app-update.js 会对 index.html 发一次 HEAD（正文为空），不能对它做改写。
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = await response.text();
      if (!body) return route.fulfill({ response });
      await route.fulfill({ response, body: rewriteIndexHtml(body, variant), headers: Object.assign({}, response.headers(), { 'cache-control': 'no-store' }) });
    });
  }
  return { context, page, errors, consoleMessages };
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

// ---------- EXP1：隐藏重绘取证 ----------
async function hiddenRedraw(browser, base, variant) {
  const { context, page, errors, consoleMessages } = await newPage(browser, base, variant);
  try {
    await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
    await waitRecords(page);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__probe.install());

    const before = await page.evaluate(() => ({
      instances: (function () { try { return Object.keys(ChartManager.getRecords() || {}).length; } catch (e) { return null; } })(),
      canvases: document.querySelectorAll('.tile canvas').length,
      initCount: window.__probe.initCalls.length
    }));

    // 进入陪伴模式（与用户点击同一个入口）
    await page.locator('#companionModeBtn').click();
    const entered = await page.waitForFunction(() => {
      const d = document.getElementById('dashboard');
      return !!d && d.hidden === true;
    }, null, { timeout: 60000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(600);

    const afterEnter = await page.evaluate(() => ({
      dashboardHidden: document.getElementById('dashboard').hidden,
      canvases: document.querySelectorAll('.tile canvas').length,
      initCount: window.__probe.initCalls.length,
      live2dState: window.__live2dB ? window.__live2dB.state : null
    }));

    // 触发“数据变化后的重绘入口”——自动刷新 / 同步 / 云词本到达都走这里
    const redraw = await page.evaluate(() => {
      window.__probe.initCalls.length = 0;
      window.__probe.setOptionCalls = 0;
      const t0 = performance.now();
      ChartManager.renderVisibleFromSelectors(false);
      const ms = performance.now() - t0;
      return {
        ms: Math.round(ms * 100) / 100,
        initCalls: window.__probe.initCalls.slice(),
        setOptionCalls: window.__probe.setOptionCalls,
        dashboardHidden: document.getElementById('dashboard').hidden
      };
    });

    // 同时确认 app.js 的 setTimeout(...,100) 包装路径也是同一入口
    const redrawViaApp = await page.evaluate(() => new Promise(resolve => {
      window.__probe.initCalls.length = 0;
      const t0 = performance.now();
      ChartManager.setRecords(ChartManager.getRecords());
      ChartManager.renderVisibleFromSelectors(false);
      setTimeout(() => resolve({
        ms: Math.round((performance.now() - t0) * 100) / 100,
        initCount: window.__probe.initCalls.length,
        hiddenSizes: window.__probe.initCalls.map(c => c.rect && c.rect.w + 'x' + c.rect.h),
        visibleFlags: window.__probe.initCalls.map(c => c.visible)
      }), 150);
    }));

    // 退出陪伴模式，观察恢复路径的重绘次数
    const exitPath = await page.evaluate(() => {
      window.__probe.initCalls.length = 0;
      document.getElementById('exitCompanionModeBtn').click();
      return new Promise(resolve => setTimeout(() => resolve({
        initCount: window.__probe.initCalls.length,
        initSizes: window.__probe.initCalls.map(c => (c.rect ? c.rect.w + 'x' + c.rect.h : 'n/a')),
        visibleFlags: window.__probe.initCalls.map(c => c.visible),
        canvases: document.querySelectorAll('.tile canvas').length,
        dashboardHidden: document.getElementById('dashboard').hidden
      }), 900));
    });

    return {
      count: COUNT, variant, before, entered, afterEnter,
      redraw: { ms: redraw.ms, initCalls: redraw.initCalls, setOptionCalls: redraw.setOptionCalls, dashboardHidden: redraw.dashboardHidden },
      redrawViaApp, exitPath,
      consoleWarnings: consoleMessages.filter(m => /echarts|width or height|Can't get/i.test(m)).slice(0, 10),
      allConsole: consoleMessages.slice(0, 12),
      pageErrors: errors.slice(0, 5)
    };
  } finally { await context.close(); }
}

// ---------- EXP2：依赖加载变体 A/B ----------
async function loadSample(browser, base, variant) {
  const { context, page, errors } = await newPage(browser, base, variant);
  try {
    const t0 = Date.now();
    await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
    await waitRecords(page);
    const wall = Date.now() - t0;
    const marks = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0] || {};
      const paint = {};
      for (const p of performance.getEntriesByType('paint')) paint[p.name] = Math.round(p.startTime * 100) / 100;
      const res = performance.getEntriesByType('resource').map(r => ({
        name: r.name.replace(/^https?:\/\/[^/]+/, ''), kind: r.initiatorType,
        start: Math.round(r.startTime * 100) / 100, duration: Math.round(r.duration * 100) / 100,
        decoded: r.decodedBodySize || 0, transfer: r.transferSize || 0
      }));
      return {
        fcp: paint['first-contentful-paint'] ?? null,
        dcl: n.domContentLoadedEventEnd,
        domInteractive: n.domInteractive,
        loadEventEnd: n.loadEventEnd,
        responseEnd: n.responseEnd,
        recordsReady: performance.now(),
        resources: res,
        longTasks: window.__probe.longTasks.slice(0, 100),
        echartsLoaded: typeof window.echarts !== 'undefined',
        pixiLoaded: typeof window.PIXI !== 'undefined'
      };
    });
    const staticRes = marks.resources.filter(r => r.kind !== 'xmlhttprequest' && r.kind !== 'fetch');
    const firstCanvasMs = await page.evaluate(() => performance.now());
    return {
      variant, wall, fcp: marks.fcp, dcl: marks.dcl, domInteractive: marks.domInteractive,
      loadEventEnd: marks.loadEventEnd, responseEnd: marks.responseEnd,
      recordsReady: marks.recordsReady, chartsReady: firstCanvasMs,
      staticDecoded: staticRes.reduce((a, r) => a + r.decoded, 0),
      staticCount: staticRes.length,
      longTaskCount: marks.longTasks.length,
      longestTask: marks.longTasks.reduce((a, b) => Math.max(a, b), 0),
      echartsLoaded: marks.echartsLoaded, pixiLoaded: marks.pixiLoaded,
      errors: errors.slice(0, 5)
    };
  } finally { await context.close(); }
}

// ---------- EXP3：lazy-live2d 等价性（进入陪伴后库是否真的到位） ----------
async function lazyEquivalence(browser, base) {
  const results = {};
  for (const variant of ['baseline', 'lazy-live2d']) {
    const { context, page, errors, consoleMessages } = await newPage(browser, base, variant);
    try {
      await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
      await waitRecords(page);
      const beforeClick = await page.evaluate(() => ({
        pixi: typeof window.PIXI !== 'undefined',
        live2dRuntime: typeof window.Live2D !== 'undefined',
        cubismCore: typeof window.Live2DCubismCore !== 'undefined',
        bundleState: window.__live2dB ? window.__live2dB.state : null
      }));
      // 记录本次是否真的发生过 Live2D 库的网络请求
      const live2dRequests = [];
      page.on('request', r => { if (/vendor\/live2d\//.test(r.url())) live2dRequests.push(r.url().replace(/^https?:\/\/[^/]+/, '')); });
      await page.locator('#companionModeBtn').click();
      const entered = await page.waitForFunction(() => document.getElementById('dashboard').hidden === true, null, { timeout: 60000 }).then(() => true).catch(() => false);
      await page.waitForTimeout(2500);
      const after = await page.evaluate(() => ({
        dashboardHidden: document.getElementById('dashboard').hidden,
        pixi: typeof window.PIXI !== 'undefined',
        pixiPlugin: !!(window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Live2DModel),
        live2dRuntime: typeof window.Live2D !== 'undefined',
        cubismCore: typeof window.Live2DCubismCore !== 'undefined',
        bundleState: window.__live2dB ? window.__live2dB.state : null,
        bundleError: window.__live2dB ? window.__live2dB.error : null,
        diagnostic: (function () {
          try { return window.Live2DCompanion.getRendererDiagnostic(); } catch (e) { return null; }
        })(),
        modelName: (function () { const el = document.getElementById('companionModelName'); return el ? el.textContent : null; })(),
        bubble: (function () { const el = document.getElementById('companionBubble'); return el ? el.textContent.slice(0, 120) : null; })()
      }));
      results[variant] = { beforeClick, entered, after, live2dRequests, pageErrors: errors.slice(0, 5), consoleWarnings: consoleMessages.slice(0, 10) };
    } finally { await context.close(); }
  }
  return results;
}

function stats(values) {
  const v = values.filter(x => typeof x === 'number' && isFinite(x)).slice().sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0 };
  const pick = p => v[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
  return { n, min: v[0], median: pick(0.5), max: v[n - 1], mean: Math.round(mean * 100) / 100, sd: Math.round(sd * 100) / 100, samples: v };
}

(async () => {
  const report = {
    kind: 'frontend-ab', tag: TAG, generatedAt: new Date().toISOString(),
    count: COUNT, rounds: ROUNDS, theme: THEME, seed: SEED, variants: VARIANTS,
    environment: { node: process.version, edge: EDGE, viewport: { width: 1440, height: 900 } },
    experiments: {}
  };
  let browser, server;
  try {
    browser = await chromium.launch({ headless: true, executablePath: EDGE });
    report.environment.browserVersion = await browser.version();
    server = await startServer();
    const base = server.url;

    // EXP1 隐藏重绘取证（baseline 与 lazy-live2d 各做一次，确认变异不改变结论）
    report.experiments.hiddenRedraw = {};
    for (const variant of ['baseline', 'lazy-live2d']) {
      report.experiments.hiddenRedraw[variant] = await hiddenRedraw(browser, base, variant);
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
      console.log('EXP1 hiddenRedraw ' + variant + ' done');
    }

    // EXP2 加载变体，按轮次交错，避免机器漂移
    const samples = {};
    for (const v of VARIANTS) samples[v] = [];
    for (let round = 1; round <= ROUNDS; round++) {
      for (const variant of VARIANTS) {
        const s = await loadSample(browser, base, variant);
        s.round = round;
        samples[variant].push(s);
        console.log('EXP2 round ' + round + ' ' + variant + ' fcp=' + s.fcp + ' dcl=' + Math.round(s.dcl) +
          ' recordsReady=' + Math.round(s.recordsReady) + ' staticKB=' + Math.round(s.staticDecoded / 1024) +
          ' longestTask=' + s.longestTask);
      }
    }
    report.experiments.load = {};
    for (const variant of VARIANTS) {
      const rows = samples[variant];
      report.experiments.load[variant] = { raw: rows, summary: {} };
      for (const key of ['fcp', 'dcl', 'domInteractive', 'loadEventEnd', 'responseEnd', 'recordsReady', 'chartsReady', 'staticDecoded', 'longestTask', 'wall']) {
        const st = stats(rows.map(r => r[key]));
        report.experiments.load[variant].summary[key] = Object.assign({}, st, { samples: st.samples.map(x => Math.round(x * 100) / 100) });
      }
    }
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

    // EXP3 lazy-live2d 等价性
    report.experiments.lazyEquivalence = await lazyEquivalence(browser, base);
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log('FRONTEND_AB_DONE ' + OUT);
  } finally {
    if (browser) await browser.close();
    if (server) await stopServer(server.child);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
