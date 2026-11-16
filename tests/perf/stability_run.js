// 短时负载稳定性：连续操作指定时长，周期性采样，比较前半段与后半段。
// 使用：node tests/perf/stability_run.js --minutes 20 --count 10000 --tag optimized
// 隔离约束与 dashboard_benchmark.js 相同。结论只称为“短时验证”，长期运行仍待验收。
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
const MINUTES = Math.max(1, parseInt(arg('minutes', '20'), 10));
const COUNT = parseInt(arg('count', '10000'), 10);
const TAG = arg('tag', 'run');
const SEED = parseInt(arg('seed', '20261008'), 10);
const SAMPLE_MS = Math.max(10000, parseInt(arg('sample-ms', '30000'), 10));
const OUT = arg('out', path.join(ROOT, '_verification/workbuddy-optimization', 'stability-run-' + TAG + '.json'));

const INIT = function () {
  window.__perf = { chartsCreated: 0, chartsDisposed: 0, liveCharts: 0, longTasks: [], hooked: false };
  try {
    new PerformanceObserver(function (list) {
      for (const e of list.getEntries()) window.__perf.longTasks.push(Math.round(e.duration * 100) / 100);
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { window.__perf.longTaskSupported = false; }
  window.__installPerfHook = function () {
    if (window.__perf.hooked) return true;
    const v = window.echarts;
    if (!v || typeof v.init !== 'function') return false;
    const orig = v.init;
    v.init = function () {
      const inst = orig.apply(this, arguments);
      if (!inst) return inst;
      window.__perf.chartsCreated += 1;
      window.__perf.liveCharts += 1;
      const d = inst.dispose.bind(inst);
      inst.dispose = function () { window.__perf.chartsDisposed += 1; window.__perf.liveCharts -= 1; return d.apply(this, arguments); };
      return inst;
    };
    window.__perf.hooked = true;
    return true;
  };
};

function median(v) {
  const s = v.slice().sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
}

(async () => {
  const child = spawn('python', [path.join(__dirname, 'bench_server.py'), '--count', String(COUNT), '--seed', String(SEED)],
    { cwd: ROOT, windowsHide: true });
  const meta = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('server timeout')), 180000);
    child.stdout.on('data', c => {
      text += c;
      const m = text.match(/BENCH_URL=(\S+)/); const s = text.match(/BENCH_SEEDED=(\d+)/);
      if (m) { clearTimeout(timer); resolve({ url: m[1], seeded: s ? +s[1] : 0 }); }
    });
    child.stderr.on('data', c => process.stderr.write('[server] ' + c));
  });
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(meta.url + '/api/study-records'); const j = await r.json();
      if (r.ok && j.count === meta.seeded) break;
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 800));
  }

  const browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--enable-precise-memory-info'] });
  const report = {
    tag: TAG, minutes: MINUTES, count: COUNT, seed: SEED, sampleMs: SAMPLE_MS,
    generatedAt: new Date().toISOString(), samples: [], errors: [], operations: 0
  };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', e => report.errors.push(String(e.message).slice(0, 200)));
    await page.addInitScript(INIT);
    await page.route('**://*.maimemo.com/**', r => r.abort());
    await page.route('**://*.github.com/**', r => r.abort());
    await page.route('**/memo-**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>offline</body></html>' }));
    await page.route('**/api/app/update-status*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_version: '0.89', update_available: false, can_download: false, download: { state: 'idle' } }) }));
    await page.route('**/api/study-sync', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'idle', active: false }) }));
    await page.route('**/api/study-sync/status', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'idle', active: false }) }));
    await page.route('**/proxy/**', r => r.abort());
    await page.goto(meta.url + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => {
      try { return typeof ChartManager !== 'undefined' && (ChartManager.getRecords() || []).length === n; } catch (e) { return false; }
    }, COUNT, { timeout: 120000 });
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__installPerfHook());

    const deadline = Date.now() + MINUTES * 60 * 1000;
    let nextSample = Date.now() + SAMPLE_MS;
    const layouts = ['split2', 'split3', 'grid4', 'single'];
    const types = ['heatmap', 'trend', 'growth', 'memory', 'study-web', 'heatmap'];
    let step = 0;
    while (Date.now() < deadline) {
      const layout = layouts[step % layouts.length];
      const type = types[step % types.length];
      await page.evaluate(({ l, t }) => {
        const btn = document.querySelector('.layout-btn[data-layout="' + l + '"]');
        if (btn) btn.click();
        const sel = document.querySelector('.tile[data-tile="0"] .chart-selector');
        if (sel) { sel.value = t; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        ChartManager.renderVisibleFromSelectors(true);
      }, { l: layout, t: type });
      step += 1;
      report.operations += 1;
      if (Date.now() >= nextSample) {
        report.samples.push(await page.evaluate(() => {
          const m = performance.memory;
          return {
            at: Math.round(performance.now()),
            liveCharts: window.__perf.liveCharts,
            chartsCreated: window.__perf.chartsCreated,
            chartsDisposed: window.__perf.chartsDisposed,
            domNodes: document.getElementsByTagName('*').length,
            canvases: document.querySelectorAll('canvas').length,
            iframes: document.querySelectorAll('iframe').length,
            heap: m ? m.usedJSHeapSize : null,
            longTaskCount: window.__perf.longTasks.length,
            longestTask: window.__perf.longTasks.reduce((a, b) => Math.max(a, b), 0)
          };
        }));
        nextSample = Date.now() + SAMPLE_MS;
      }
      await page.waitForTimeout(400);
    }
    report.final = await page.evaluate(() => {
      const m = performance.memory;
      return {
        liveCharts: window.__perf.liveCharts, chartsCreated: window.__perf.chartsCreated,
        chartsDisposed: window.__perf.chartsDisposed, domNodes: document.getElementsByTagName('*').length,
        heap: m ? m.usedJSHeapSize : null, longTaskCount: window.__perf.longTasks.length,
        longestTask: window.__perf.longTasks.reduce((a, b) => Math.max(a, b), 0)
      };
    });
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => {
      const t = setTimeout(() => { child.kill(); resolve(); }, 4000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      try { child.stdin.end('exit\n'); } catch (e) { child.kill(); resolve(); }
    });
  }
  const s = report.samples;
  if (s.length >= 2) {
    const half = Math.floor(s.length / 2);
    const pick = arr => arr.map(x => x.heap).filter(Boolean);
    report.trend = {
      sampleCount: s.length,
      heapFirstHalfMedian: median(pick(s.slice(0, half))),
      heapSecondHalfMedian: median(pick(s.slice(half))),
      domFirstHalfMedian: median(s.slice(0, half).map(x => x.domNodes)),
      domSecondHalfMedian: median(s.slice(half).map(x => x.domNodes)),
      liveChartsMax: Math.max(...s.map(x => x.liveCharts)),
      liveChartsMin: Math.min(...s.map(x => x.liveCharts)),
      longestTask: Math.max(...s.map(x => x.longestTask))
    };
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('STABILITY_DONE ' + OUT);
})().catch(e => { console.error(e); process.exitCode = 1; });
