// B 前端性能子智能体：首屏基线测量（只测量，不改生产代码）。
//
// 用法：
//   node tests/perf/frontend-b-baseline.js --rounds 7 --scales 1000,10000,50000 \
//        --out tests/perf/results/frontend_baseline.json
//
// 隔离约束：
//   - 每个规模用 tests/perf/bench_server.py 起独立数据目录（--data-dir 指向
//     _verification/perfvocab/B/<唯一名>），固定种子合成数据，绝不读写 data/。
//   - 只绑定 127.0.0.1 + 端口 0（系统分配）。
//   - 拦截所有外部主机、更新检查、同步状态与学习 iframe。
//
// 指标：FCP、DOMContentLoaded、load、recordsReady（ChartManager 收到全部记录）、
//       chartsReady（首块 canvas 出现）、静态资源字节、长任务计数。
// 每配置 N 轮，原始样本全部保留。**有限样本，不是稳定 P95。**
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

const ROUNDS = Math.max(1, parseInt(arg('rounds', '7'), 10));
const SCALES = arg('scales', '1000,10000,50000').split(',').map(Number).filter(Boolean);
const SEED = parseInt(arg('seed', '20261008'), 10);
const THEMES = arg('themes', 'standard,notebook').split(',').filter(Boolean);
const OUT = arg('out', path.join(ROOT, 'tests/perf/results/frontend_baseline.json'));
const VARIANT = arg('variant', 'baseline');   // baseline | defer-echarts | no-live2d | lazy-live2d
const VIEWPORT = { width: 1440, height: 900 };
const TAG = arg('tag', 'b');

const PERF_INIT = function () {
  window.__perf = { longTasks: [], longTaskSupported: true };
  try {
    new PerformanceObserver(function (list) {
      for (const e of list.getEntries()) window.__perf.longTasks.push(Math.round(e.duration * 100) / 100);
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { window.__perf.longTaskSupported = false; }
  // 记录 LCP 与首屏绘制时刻，便于区分“有像素”与“有图表”。
  window.__perf.lcp = null;
  try {
    new PerformanceObserver(function (list) {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) window.__perf.lcp = { startTime: Math.round(last.startTime * 100) / 100, size: last.size };
    }).observe({ entryTypes: ['largest-contentful-paint'] });
  } catch (e) {}
};

async function startServer(count) {
  const dataDir = path.join(ROOT, '_verification/perfvocab/B', TAG + '-' + count + '-' + Date.now().toString(36));
  fs.mkdirSync(dataDir, { recursive: true });
  // MEMO_DATA_DIR 由 bench_server.py 在导入 db 之前写入进程环境；这里只传显式目录，
  // 保证绝不触碰真实 data/。
  const child = spawn('python', [path.join(__dirname, 'bench_server.py'),
    '--count', String(count), '--seed', String(SEED), '--data-dir', dataDir],
  { cwd: ROOT, windowsHide: true, env: Object.assign({}, process.env, { MEMO_DATA_DIR: dataDir }) });
  const meta = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('bench server startup timeout')), 300000);
    child.stdout.on('data', chunk => {
      text += chunk;
      const url = text.match(/BENCH_URL=(\S+)/);
      const dir = text.match(/BENCH_DATA_DIR=(.*)/);
      const seeded = text.match(/BENCH_SEEDED=(\d+)/);
      if (url) { clearTimeout(timer); resolve({ url: url[1], dataDir: dir ? dir[1].trim() : dataDir, seeded: seeded ? +seeded[1] : 0 }); }
    });
    child.stderr.on('data', chunk => process.stderr.write('[server] ' + chunk));
    child.on('exit', code => { clearTimeout(timer); reject(new Error('bench server exited ' + code)); });
  });
  // 预热：首个请求可能并发创建 WAL 的 -wal/-shm，偶发 SQLITE_READONLY。
  let warmed = false;
  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch(meta.url + '/api/study-records');
      const body = await res.json();
      if (res.ok && body && body.count === meta.seeded) { warmed = true; break; }
      console.log('warmup ' + (i + 1) + ' status=' + res.status + ' count=' + (body && body.count));
    } catch (e) {
      console.log('warmup ' + (i + 1) + ' error=' + e.message);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  if (!warmed) throw new Error('基准服务预热失败：/api/study-records 未返回 ' + meta.seeded + ' 条记录');
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

// ---- index.html 变体改写（A/B 用 route 拦截，不触碰磁盘上的生产文件）----
const ECHARTS_TAG = '<script src="vendor/echarts.min.js?v=40"></script>';
const LIVE2D_TAGS = [
  '<script src="vendor/live2d/live2d-2.1.min.js?v=072"></script>',
  '<script src="vendor/live2d/live2dcubismcore.min.js?v=072"></script>',
  '<script src="vendor/live2d/pixi-6.5.10.min.js?v=072"></script>',
  '<script src="vendor/live2d/pixi-live2d-display-0.4.0.min.js?v=072"></script>'
];

function rewriteIndexHtml(html, variant) {
  const applied = [];
  let out = html;
  if (variant === 'defer-echarts') {
    if (out.includes(ECHARTS_TAG)) { out = out.replace(ECHARTS_TAG, ECHARTS_TAG.replace('<script ', '<script defer ')); applied.push('defer-echarts'); }
  }
  if (variant === 'no-live2d' || variant === 'lazy-live2d') {
    let removed = 0;
    for (const tag of LIVE2D_TAGS) { if (out.includes(tag)) { out = out.replace(tag, ''); removed += 1; } }
    if (removed !== LIVE2D_TAGS.length) throw new Error('只移除了 ' + removed + '/' + LIVE2D_TAGS.length + ' 个 Live2D 标签');
    applied.push(variant + '(' + removed + ')');
    if (variant === 'lazy-live2d') {
      // 进入陪伴模式（#companionModeBtn click）时才按原顺序注入这四个库。
      // 加载失败必须显式报错，不能静默降级成“陪伴模式没角色”。
      const loader = `<script>
(function () {
  var SOURCES = ${JSON.stringify(LIVE2D_TAGS.map(t => t.match(/src="([^"]+)"/)[1]))};
  var loading = null;
  window.__live2dBundle = { state: 'idle', startedAt: null, finishedAt: null, error: null };
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
    if (loading) return loading;
    window.__live2dBundle.state = 'loading';
    window.__live2dBundle.startedAt = performance.now();
    loading = SOURCES.reduce(function (chain, src) {
      return chain.then(function () { return loadOne(src); });
    }, Promise.resolve()).then(function () {
      window.__live2dBundle.state = 'loaded';
      window.__live2dBundle.finishedAt = performance.now();
    }, function (error) {
      window.__live2dBundle.state = 'failed';
      window.__live2dBundle.error = error.message;
      throw error;
    });
    return loading;
  };
  var btn = document.getElementById('companionModeBtn');
  if (btn) {
    // capture 阶段先启动下载，再让 live2d-companion.js 的 enter() 继续；
    // enter() -> loadRenderer() 里对 window.PIXI 的检查发生在 await 之后，
    // 但为了确定性，enter 前先把 bundle 拉完（capture 里阻断一次冒泡）。
    btn.addEventListener('click', function (event) {
      if (window.__live2dBundle.state !== 'idle') return;
      event.stopImmediatePropagation();
      event.preventDefault();
      window.__loadLive2DBundle().then(function () { window.__live2dPendingResume = true; }, function () {});
      window.__loadLive2DBundle().catch(function () {}).then(function () {
        btn.dataset.ready = '';
        btn.click();
      });
    }, true);
  }
})();
</script>`;
      out = out.replace('<script>window.MemoUIStyle.activate(document);</script>',
        '<script>window.MemoUIStyle.activate(document);</script>\n' + loader);
    }
  }
  return { html: out, applied: applied };
}

async function newPage(browser, base, theme, variant) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const errors = [];
  const failedRequests = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  page.on('requestfailed', r => failedRequests.push(r.url().replace(/^https?:\/\/[^/]+/, '') + ' ' + (r.failure() || {}).errorText));
  await page.addInitScript(({ theme }) => {
    localStorage.setItem('memo_ui_style', theme);
    localStorage.setItem('theme', theme === 'notebook' ? 'light' : 'light');
  }, { theme });
  await page.addInitScript(PERF_INIT);
  await page.route('**://*.maimemo.com/**', r => r.abort());
  await page.route('**://*.github.com/**', r => r.abort());
  await page.route('**://*.githubusercontent.com/**', r => r.abort());
  await page.route('**/memo-**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>offline study fixture</body></html>' }));
  await page.route('**/api/app/update-status*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_version: '0.89', update_available: false, can_download: false, download: { state: 'idle' } }) }));
  await page.route('**/api/study-sync', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'idle', active: false }) }));
  await page.route('**/api/study-sync/status', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'idle', active: false, bootstrap_complete: true, local_record_count: 0 }) }));
  await page.route('**/api/study-sync/current', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'idle' }) }));
  await page.route('**/proxy/**', r => r.abort());
  let applied = [];
  if (variant && variant !== 'baseline') {
    await page.route(base + '/index.html', async route => {
      // app-update.js 会对 index.html 发一次 HEAD（正文为空），不能对它做改写。
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = await response.text();
      if (!body) return route.fulfill({ response });
      const result = rewriteIndexHtml(body, variant);
      applied = result.applied;
      await route.fulfill({ response, body: result.html, headers: Object.assign({}, response.headers(), { 'cache-control': 'no-store' }) });
    });
  }
  return { context, page, errors, failedRequests, getApplied: () => applied };
}

async function measure(browser, base, theme, variant, expected) {
  const session = await newPage(browser, base, theme, variant);
  const { context, page } = session;
  const t0 = Date.now();
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  let marks;
  try {
    await page.waitForFunction((n) => {
      try {
        if (typeof ChartManager === 'undefined' || !ChartManager.getRecords) return false;
        const r = ChartManager.getRecords();
        return !!r && r.length === n;
      } catch (e) { return false; }
    }, expected, { timeout: 240000 });
    marks = { recordsReady: await page.evaluate(() => performance.now()) };
    await page.waitForFunction(() => document.querySelectorAll('.tile canvas').length > 0, null, { timeout: 240000 });
    marks.chartsReady = await page.evaluate(() => performance.now());
  } catch (error) {
    await context.close();
    throw error;
  }
  const wall = Date.now() - t0;
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] || {};
    const paint = {};
    for (const p of performance.getEntriesByType('paint')) paint[p.name] = Math.round(p.startTime * 100) / 100;
    const resources = performance.getEntriesByType('resource').map(r => ({
      name: r.name.replace(/^https?:\/\/[^/]+/, ''),
      kind: r.initiatorType,
      start: Math.round(r.startTime * 100) / 100,
      duration: Math.round(r.duration * 100) / 100,
      transfer: r.transferSize || 0,
      decoded: r.decodedBodySize || 0
    }));
    return {
      domContentLoaded: n.domContentLoadedEventEnd,
      loadEventEnd: n.loadEventEnd,
      responseEnd: n.responseEnd,
      domInteractive: n.domInteractive,
      paint,
      resources,
      longTasks: window.__perf.longTasks.slice(0, 200),
      longTaskSupported: window.__perf.longTaskSupported,
      lcp: window.__perf.lcp,
      echartsLoaded: typeof window.echarts !== 'undefined',
      pixiLoaded: typeof window.PIXI !== 'undefined',
      vendorApplied: null
    };
  });
  nav.variantApplied = session.getApplied();
  const staticRes = nav.resources.filter(r => r.kind !== 'xmlhttprequest' && r.kind !== 'fetch' && r.kind !== 'beacon');
  const apiRes = nav.resources.filter(r => r.kind === 'xmlhttprequest' || r.kind === 'fetch');
  const groups = {};
  for (const r of staticRes) {
    const key = /^\/vendor\/live2d\//.test(r.name) ? 'vendor/live2d'
      : r.name === '/vendor/echarts.min.js' || /^\/vendor\/echarts/.test(r.name) ? 'vendor/echarts'
        : /^\/js\//.test(r.name) ? 'js'
          : /^\/css\//.test(r.name) ? 'css'
            : /^\/fonts\//.test(r.name) || /\.(woff2?|ttf|otf)(\?|$)/i.test(r.name) ? 'fonts'
              : /^\/img\//.test(r.name) ? 'img'
                : 'other';
    const row = groups[key] || (groups[key] = { count: 0, decoded: 0, transfer: 0, items: [] });
    row.count += 1; row.decoded += r.decoded; row.transfer += r.transfer;
    row.items.push({ name: r.name, decoded: r.decoded, transfer: r.transfer, start: r.start, duration: r.duration });
  }
  const totals = staticRes.reduce((a, r) => { a.count += 1; a.decoded += r.decoded; a.transfer += r.transfer; return a; }, { count: 0, decoded: 0, transfer: 0 });
  const sample = {
    theme, wall,
    fcp: nav.paint['first-contentful-paint'] ?? null,
    fp: nav.paint['first-paint'] ?? null,
    lcp: nav.lcp,
    domContentLoaded: nav.domContentLoaded,
    loadEventEnd: nav.loadEventEnd,
    responseEnd: nav.responseEnd,
    domInteractive: nav.domInteractive,
    recordsReady: marks.recordsReady,
    chartsReady: marks.chartsReady,
    staticCount: totals.count,
    staticDecoded: totals.decoded,
    staticTransfer: totals.transfer,
    apiDecoded: apiRes.reduce((a, r) => a + r.decoded, 0),
    longTaskCount: nav.longTasks.length,
    longestTask: nav.longTasks.reduce((a, b) => Math.max(a, b), 0),
    echartsLoaded: nav.echartsLoaded,
    pixiLoaded: nav.pixiLoaded,
    variantApplied: nav.variantApplied,
    errors: session.errors.slice(0, 5),
    failedRequests: session.failedRequests.slice(0, 5)
  };
  await context.close();
  return { sample, groups, resources: nav.resources };
}

function stats(values) {
  const v = values.filter(x => typeof x === 'number' && isFinite(x)).slice().sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0 };
  const pick = p => v[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
  return {
    n, min: Math.round(v[0] * 100) / 100, max: Math.round(v[n - 1] * 100) / 100,
    median: Math.round(pick(0.5) * 100) / 100, mean: Math.round(mean * 100) / 100,
    sd: Math.round(sd * 100) / 100,
    // 有限样本分位仅供参考：n=7 时 p95 实际取到的是最大值附近。
    p95_limited: Math.round(pick(0.95) * 100) / 100,
    samples: v.map(x => Math.round(x * 100) / 100)
  };
}

(async () => {
  const report = {
    kind: 'frontend-baseline', variant: VARIANT, tag: TAG,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version, edge: EDGE, platform: process.platform + ' ' + process.arch,
      viewport: VIEWPORT, seed: SEED, rounds: ROUNDS, scales: SCALES, themes: THEMES,
      headless: true,
      note: '本地 127.0.0.1 无网络时延；SimpleHTTPRequestHandler 不做 gzip，transfer≈decoded。'
    },
    methodology: {
      repeated: THEMES.length * SCALES.length * ROUNDS + ' 次全新浏览器上下文页面加载',
      ordering: '按轮次交错主题（round -> theme），减小机器漂移偏差',
      sampleLimit: '有限样本（每配置 ' + ROUNDS + ' 轮），p95_limited 不是稳定 P95',
      readiness: 'recordsReady=ChartManager.getRecords().length===N 的 performance.now()；chartsReady=首个 .tile canvas 出现'
    },
    configs: []
  };
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--enable-precise-memory-info'] });
    report.environment.browserVersion = await browser.version();
    for (const count of SCALES) {
      const server = await startServer(count);
      const config = { count, seeded: server.seeded, dataDir: server.dataDir, samples: [], resources: {}, groups: {} };
      try {
        for (let round = 1; round <= ROUNDS; round++) {
          for (const theme of THEMES) {
            let result;
            for (let attempt = 0; attempt < 2; attempt++) {
              try { result = await measure(browser, server.url, theme, VARIANT, count); break; } catch (e) {
                if (attempt === 1) throw e;
                console.log('retry ' + theme + '/' + count + ' after: ' + e.message);
              }
            }
            result.sample.round = round;
            result.sample.config = theme + '/' + count;
            config.samples.push(result.sample);
            config.resources[theme] = result.resources;
            config.groups[theme] = result.groups;
            console.log('round ' + round + ' ' + theme + '/' + count +
              ' fcp=' + (result.sample.fcp ?? 'n/a') + ' dcl=' + Math.round(result.sample.domContentLoaded) +
              ' recordsReady=' + Math.round(result.sample.recordsReady) +
              ' chartsReady=' + Math.round(result.sample.chartsReady) +
              ' staticKB=' + Math.round(result.sample.staticDecoded / 1024));
          }
        }
        config.summary = {};
        for (const theme of THEMES) {
          const rows = config.samples.filter(s => s.theme === theme);
          config.summary[theme] = {
            fcp: stats(rows.map(s => s.fcp)),
            fp: stats(rows.map(s => s.fp)),
            lcp: stats(rows.map(s => s.lcp && s.lcp.startTime)),
            domContentLoaded: stats(rows.map(s => s.domContentLoaded)),
            loadEventEnd: stats(rows.map(s => s.loadEventEnd)),
            recordsReady: stats(rows.map(s => s.recordsReady)),
            chartsReady: stats(rows.map(s => s.chartsReady)),
            wall: stats(rows.map(s => s.wall)),
            staticDecoded: stats(rows.map(s => s.staticDecoded)),
            apiDecoded: stats(rows.map(s => s.apiDecoded)),
            longestTask: stats(rows.map(s => s.longestTask)),
            longTaskCount: stats(rows.map(s => s.longTaskCount))
          };
        }
      } finally {
        await stopServer(server.child);
      }
      report.configs.push(config);
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
      console.log('config ' + count + ' done');
    }
  } finally {
    if (browser) await browser.close();
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('FRONTEND_BASELINE_DONE ' + OUT);
})().catch(e => { console.error(e); process.exitCode = 1; });
