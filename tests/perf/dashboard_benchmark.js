// 大词库仪表盘性能基准。
// 使用：node tests/perf/dashboard_benchmark.js --scales 1000,10000,50000 --repeat 5 --tag baseline
//
// 隔离约束（与计划一致）：
//  - 数据目录由 bench_server.py 新建于 _verification/ 下，记录为固定种子的合成数据；
//  - 端口由系统分配（端口 0），只绑定 127.0.0.1；
//  - 拦截所有外部主机（墨墨云端、GitHub、AI 端点）与学习 iframe，不产生真实云端写入；
//  - 账号身份由 bench_server.py 的桩对象提供，不读取本机凭据，不触碰 data/。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function arg(name, fallback) {
  const idx = process.argv.indexOf('--' + name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const SCALES = arg('scales', '1000,10000,50000').split(',').map(s => parseInt(s, 10)).filter(Boolean);
const REPEAT = Math.max(1, parseInt(arg('repeat', '5'), 10));
const STARTUP_REPEAT = Math.max(1, parseInt(arg('startup-repeat', String(REPEAT)), 10));
const TAG = arg('tag', 'run');
const SEED = parseInt(arg('seed', '20261008'), 10);
const OUT = arg('out', path.join(ROOT, '_verification/workbuddy-optimization', 'dashboard-benchmark-' + TAG + '.json'));
const CHART_TYPES = (arg('charts', 'heatmap,trend,growth,memory,notepad') || '').split(',').filter(Boolean);

const PERF_INIT = function () {
  window.__perf = {
    drawMs: [], chartsCreated: 0, chartsDisposed: 0, liveCharts: 0,
    longTasks: [], longTaskSupported: true, setOptionCalls: 0
  };
  try {
    new PerformanceObserver(function (list) {
      for (const e of list.getEntries()) window.__perf.longTasks.push(Math.round(e.duration * 100) / 100);
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { window.__perf.longTaskSupported = false; }

  // echarts 以 UMD 方式先赋一个空对象再填充，赋值时 init 尚不存在，
  // 因此真正的包裹在页面就绪后由 installHook() 完成；这里只准备计数器。
  window.__perf.hooked = false;
  window.__installPerfHook = function () {
    if (window.__perf.hooked) return true;
    const value = window.echarts;
    if (!value || typeof value.init !== 'function') { window.__perf.hookFailed = true; return false; }
    const origInit = value.init;
    value.init = function () {
        const inst = origInit.apply(this, arguments);
        if (!inst) return inst;
        window.__perf.chartsCreated += 1;
        window.__perf.liveCharts += 1;
        const origDispose = inst.dispose.bind(inst);
        inst.dispose = function () {
          window.__perf.chartsDisposed += 1;
          window.__perf.liveCharts -= 1;
          return origDispose.apply(this, arguments);
        };
        const origSet = inst.setOption.bind(inst);
        inst.setOption = function () {
          const t0 = performance.now();
          const out = origSet.apply(this, arguments);
          window.__perf.drawMs.push(performance.now() - t0);
          window.__perf.setOptionCalls += 1;
          return out;
        };
        return inst;
      };
    window.__perf.hooked = true;
    return true;
  };
};

function stats(samples) {
  const values = samples.slice().sort((a, b) => a - b);
  const n = values.length;
  if (!n) return { n: 0 };
  const pick = p => values[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  return {
    n: n, min: values[0], max: values[n - 1],
    median: pick(0.5), p95: pick(0.95), mean: values.reduce((a, b) => a + b, 0) / n,
    samples: values
  };
}

async function startServer(count, seed) {
  const child = spawn('python', [path.join(__dirname, 'bench_server.py'), '--count', String(count), '--seed', String(seed)],
    { cwd: ROOT, windowsHide: true });
  const meta = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('bench server startup timeout')), 120000);
    child.stdout.on('data', chunk => {
      text += chunk;
      const url = text.match(/BENCH_URL=(\S+)/);
      const dir = text.match(/BENCH_DATA_DIR=(.*)/);
      const seeded = text.match(/BENCH_SEEDED=(\d+)/);
      if (url) { clearTimeout(timer); resolve({ url: url[1], dataDir: dir ? dir[1].trim() : '', seeded: seeded ? +seeded[1] : 0 }); }
    });
    child.stderr.on('data', chunk => process.stderr.write('[server] ' + chunk));
    child.on('exit', code => { clearTimeout(timer); reject(new Error('bench server exited ' + code)); });
  });
  // 预热：首个请求会并发创建 WAL 的 -wal/-shm，偶发 SQLITE_READONLY；
  // 先串行取一次，确保后续测量面对的是已就绪的数据库。
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(meta.url + '/api/study-records');
      const body = await res.json();
      if (res.ok && body && body.count === meta.seeded) break;
      console.log('warmup attempt ' + (attempt + 1) + ' status=' + res.status);
    } catch (e) {
      console.log('warmup attempt ' + (attempt + 1) + ' error=' + e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }
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

async function newPage(browser, base, requests) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  page.on('request', r => { if (r.url().startsWith(base)) requests.push(r.url()); });
  await page.addInitScript(PERF_INIT);
  // 与真实运行一致地保留本地接口；只切断外部主机与学习 iframe。
  await page.route('**://*.maimemo.com/**', route => route.abort());
  await page.route('**://*.github.com/**', route => route.abort());
  await page.route('**://*.githubusercontent.com/**', route => route.abort());
  await page.route('**/memo-**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>offline study fixture</body></html>' }));
  await page.route('**/api/app/update-status*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_version: '0.89', update_available: false, can_download: false, download: { state: 'idle' } }) }));
  await page.route('**/api/study-sync', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'idle', active: false }) }));
  // 同步状态接口会写同步运行记录；基准只测仪表盘渲染，避免它成为噪声与额外写入。
  await page.route('**/api/study-sync/status', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'idle', active: false, bootstrap_complete: true, local_record_count: 0 }) }));
  await page.route('**/proxy/**', route => route.abort());
  return { context, page, errors };
}

async function waitReady(page, expected, timeout = 180000) {
  // ChartManager 由 const 声明，只存在于全局词法环境，不是 window 属性。
  const marks = {};
  await page.waitForFunction((n) => {
    try {
      if (typeof ChartManager === 'undefined' || !ChartManager.getRecords) return false;
      const r = ChartManager.getRecords();
      return !!r && r.length === n;
    } catch (e) { return false; }
  }, expected, { timeout });
  marks.recordsReady = await page.evaluate(() => performance.now());
  await page.waitForFunction(() => document.querySelectorAll('.tile canvas').length > 0, null, { timeout });
  marks.chartsReady = await page.evaluate(() => performance.now());
  await page.waitForTimeout(400);
  const hooked = await page.evaluate(() => (window.__installPerfHook ? window.__installPerfHook() : false));
  if (!hooked) throw new Error('ECharts 探针未安装，无法分离绘制耗时');
  return marks;
}

function memory(page) {
  return page.evaluate(() => {
    const m = performance.memory;
    return m ? { usedJSHeapSize: m.usedJSHeapSize, totalJSHeapSize: m.totalJSHeapSize, limit: m.jsHeapSizeLimit } : null;
  });
}

async function measureRender(page, expression, repeat) {
  const samples = [];
  for (let i = 0; i < repeat; i++) {
    const r = await page.evaluate((expr) => {
      window.__perf.drawMs.length = 0;
      const before = window.__perf.chartsCreated;
      const t0 = performance.now();
      // eslint-disable-next-line no-eval
      eval(expr);
      const total = performance.now() - t0;
      const drew = window.__perf.drawMs.slice();
      return {
        total: total,
        draw: drew.reduce((a, b) => a + b, 0),
        drawCalls: drew.length,
        chartsCreated: window.__perf.chartsCreated - before,
        liveCharts: window.__perf.liveCharts
      };
    }, expression);
    samples.push(r);
  }
  return samples;
}

(async () => {
  const report = {
    tag: TAG, generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      edge: EDGE,
      viewport: { width: 1440, height: 900 },
      seed: SEED, repeat: REPEAT, startupRepeat: STARTUP_REPEAT,
      platform: process.platform + ' ' + process.arch
    },
    scales: []
  };
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--enable-precise-memory-info'] });
    for (const count of SCALES) {
      const server = await startServer(count, SEED);
      const scale = { count, dataDir: server.dataDir, seeded: server.seeded, scenarios: {}, raw: {} };
      const requests = [];
      try {
        // ---- 首屏启动 ----
        const startup = [];
        for (let i = 0; i < STARTUP_REPEAT; i++) {
          const { context, page, errors } = await newPage(browser, server.url, requests);
          const mem = [];
          const t0 = Date.now();
          await page.goto(server.url + '/index.html', { waitUntil: 'domcontentloaded' });
          let marks;
          try {
            marks = await waitReady(page, count, 90000);
          } catch (e) {
            // 首次请求偶发 500（WAL 初始化竞态），重载一次再试；仍失败则如实抛出。
            console.log('startup retry after: ' + e.message);
            await page.goto(server.url + '/index.html', { waitUntil: 'domcontentloaded' });
            marks = await waitReady(page, count, 90000);
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
              domContentLoaded: n.domContentLoadedEventEnd, loadEventEnd: n.loadEventEnd,
              responseEnd: n.responseEnd, paint, resources
            };
          });
          mem.push(await memory(page));
          startup.push({ wall, nav, marks, memAfter: mem[0], errors: errors.slice(0, 5) });
          await context.close();
        }
        scale.raw.startup = startup;
        scale.scenarios.startup = {
          wall: stats(startup.map(s => s.wall)),
          domContentLoaded: stats(startup.map(s => s.nav.domContentLoaded)),
          loadEventEnd: stats(startup.map(s => s.nav.loadEventEnd)),
          firstContentfulPaint: stats(startup.map(s => s.nav.paint['first-contentful-paint'] || 0)),
          recordsReady: stats(startup.map(s => s.marks.recordsReady)),
          chartsReady: stats(startup.map(s => s.marks.chartsReady))
        };
        // 首屏静态资源证据：按体积排序，以及学习记录接口的等待耗时。
        const last = startup[startup.length - 1];
        const res = (last.nav.resources || []);
        scale.firstPaintResources = res
          .filter(r => r.kind !== 'xmlhttprequest' && r.kind !== 'fetch')
          .sort((a, b) => b.decoded - a.decoded).slice(0, 15)
          .map(r => ({ name: r.name, kind: r.kind, decoded: r.decoded, transfer: r.transfer, duration: r.duration, start: r.start }));
        scale.staticTotals = res
          .filter(r => r.kind !== 'xmlhttprequest' && r.kind !== 'fetch')
          .reduce((acc, r) => {
            acc.count += 1; acc.decoded += r.decoded; acc.transfer += r.transfer;
            return acc;
          }, { count: 0, decoded: 0, transfer: 0 });
        scale.apiStudyRecords = res.filter(r => r.name.indexOf('/api/study-records') >= 0)
          .map(r => ({ duration: r.duration, decoded: r.decoded, transfer: r.transfer, start: r.start }));

        // ---- 稳定页面上的渲染场景 ----
        const { context, page, errors } = await newPage(browser, server.url, requests);
        await page.goto(server.url + '/index.html', { waitUntil: 'domcontentloaded' });
        await waitReady(page, count);

        const scenarios = {
          // 全部可见磁贴重绘（自动刷新/数据到达时的重绘路径）
          renderVisible: "ChartManager.renderVisibleFromSelectors(true)",
          // 逐图渲染
          chart_heatmap: "ChartManager.render(0,'heatmap',{})",
          chart_trend_30: "ChartManager.render(0,'trend',{days:30})",
          chart_trend_all: "ChartManager.render(0,'trend',{days:365})",
          chart_growth: "ChartManager.render(0,'growth',{})",
          chart_memory: "ChartManager.render(0,'memory',{})",
          chart_notepad: "ChartManager.render(0,'notepad',{})"
        };
        for (const [name, expr] of Object.entries(scenarios)) {
          if (name.startsWith('chart_') && !CHART_TYPES.includes(name.replace('chart_', '').split('_')[0])) continue;
          const samples = await measureRender(page, expr, REPEAT);
          scale.raw[name] = samples;
          scale.scenarios[name] = {
            total: stats(samples.map(s => s.total)),
            draw: stats(samples.map(s => s.draw)),
            processing: stats(samples.map(s => Math.max(0, s.total - s.draw))),
            drawCalls: samples[samples.length - 1].drawCalls,
            liveChartsAfter: samples[samples.length - 1].liveCharts
          };
        }

        // ---- 布局切换（单格 / 左右 / 三分 / 田字格）----
        const layoutSamples = [];
        for (let i = 0; i < REPEAT; i++) {
          for (const layout of ['split2', 'split3', 'grid4', 'single']) {
            const r = await page.evaluate((l) => {
              window.__perf.drawMs.length = 0;
              const btn = document.querySelector('.layout-btn[data-layout="' + l + '"]');
              if (!btn) return null;
              const t0 = performance.now();
              btn.click();
              const total = performance.now() - t0;
              const drew = window.__perf.drawMs.slice();
              return { layout: l, total, draw: drew.reduce((a, b) => a + b, 0), drawCalls: drew.length };
            }, layout);
            if (r) layoutSamples.push(r);
            await page.waitForTimeout(60);
          }
        }
        scale.raw.layoutSwitch = layoutSamples;
        for (const layout of ['split2', 'split3', 'grid4', 'single']) {
          const rows = layoutSamples.filter(r => r.layout === layout);
          scale.scenarios['layout_' + layout] = {
            total: stats(rows.map(r => r.total)), draw: stats(rows.map(r => r.draw))
          };
        }

        // ---- 日期/范围筛选（趋势 7/30/90/全部）----
        await page.evaluate(() => {
          const sel = document.querySelector('.tile[data-tile="0"] .chart-selector');
          if (sel) { sel.value = 'trend'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        });
        await page.waitForTimeout(300);
        const rangeSamples = [];
        for (let i = 0; i < REPEAT; i++) {
          for (const range of ['7', '30', '90', 'all']) {
            const r = await page.evaluate((rg) => {
              window.__perf.drawMs.length = 0;
              const btn = document.querySelector('.range-btn[data-range="' + rg + '"]');
              if (!btn) return null;
              const t0 = performance.now();
              btn.click();
              const total = performance.now() - t0;
              const drew = window.__perf.drawMs.slice();
              return { range: rg, total, draw: drew.reduce((a, b) => a + b, 0), drawCalls: drew.length };
            }, range);
            if (r) rangeSamples.push(r);
            await page.waitForTimeout(60);
          }
        }
        scale.raw.rangeSwitch = rangeSamples;
        for (const range of ['7', '30', '90', 'all']) {
          const rows = rangeSamples.filter(r => r.range === range);
          scale.scenarios['range_' + range] = { total: stats(rows.map(r => r.total)), draw: stats(rows.map(r => r.draw)) };
        }

        // ---- 资源与稳定性观察 ----
        scale.raw.observe = await page.evaluate(() => ({
          longTaskSupported: window.__perf.longTaskSupported,
          longTasks: window.__perf.longTasks.slice(0, 200),
          longTaskCount: window.__perf.longTasks.length,
          longestTask: window.__perf.longTasks.reduce((a, b) => Math.max(a, b), 0),
          chartsCreated: window.__perf.chartsCreated,
          chartsDisposed: window.__perf.chartsDisposed,
          liveCharts: window.__perf.liveCharts,
          domNodes: document.getElementsByTagName('*').length,
          canvases: document.querySelectorAll('canvas').length,
          iframes: document.querySelectorAll('iframe').length,
          listeners: (window.__perf.listenerCount || null)
        }));
        scale.memAfterScenarios = await memory(page);
        scale.pageErrors = errors.slice(0, 10);
        await context.close();
      } finally {
        scale.requestCount = requests.length;
        scale.requestSample = requests.slice(0, 12);
        await stopServer(server.child);
      }
      report.scales.push(scale);
      fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
      console.log('scale ' + count + ' done');
    }
  } finally {
    if (browser) await browser.close();
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('BENCH_DONE ' + OUT);
})().catch(e => { console.error(e); process.exitCode = 1; });
