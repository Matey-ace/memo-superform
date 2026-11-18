// 首屏静态资源与多磁贴聚合的对照实验（只测量，不改生产代码）。
//  A/B：拦截 img/icon.png 与 img/gifs/anon-think.gif，比较首屏与 load 指标。
//  多磁贴：在田字格布局下测量一次全量重绘，判断聚合是否随可见磁贴数线性叠加。
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
const REPEAT = Math.max(1, parseInt(arg('repeat', '5'), 10));
const SEED = parseInt(arg('seed', '20261008'), 10);
const OUT = arg('out', path.join(ROOT, '_verification/workbuddy-optimization', 'first-paint-experiment.json'));
const BLOCK = ['img/icon.png', 'img/gifs/anon-think.gif'];

async function startServer() {
  const child = spawn('python', [path.join(__dirname, 'bench_server.py'), '--count', String(COUNT), '--seed', String(SEED)],
    { cwd: ROOT, windowsHide: true });
  const meta = await new Promise((resolve, reject) => {
    let text = '';
    const t = setTimeout(() => reject(new Error('server timeout')), 180000);
    child.stdout.on('data', c => {
      text += c;
      const m = text.match(/BENCH_URL=(\S+)/);
      const s = text.match(/BENCH_SEEDED=(\d+)/);
      if (m) { clearTimeout(t); resolve({ url: m[1], seeded: s ? +s[1] : 0 }); }
    });
    child.stderr.on('data', c => process.stderr.write('[server] ' + c));
  });
  let warmed = false;
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(meta.url + '/api/study-records');
      const j = await r.json();
      if (r.ok && j.count === meta.seeded) { warmed = true; break; }
      console.log('warmup ' + (i + 1) + ' status=' + r.status + ' count=' + (j && j.count));
    } catch (e) {
      console.log('warmup ' + (i + 1) + ' error=' + e.message);
    }
    await new Promise(r => setTimeout(r, 800));
  }
  if (!warmed) throw new Error('基准服务预热失败：/api/study-records 未返回 ' + meta.seeded + ' 条记录');
  return { child, ...meta };
}

async function measureLoad(browser, url, count, blockBig) {
  const samples = [];
  for (let i = 0; i < REPEAT; i++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.route('**://*.maimemo.com/**', r => r.abort());
    await page.route('**://*.github.com/**', r => r.abort());
    await page.route('**/memo-**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>offline</body></html>' }));
    await page.route('**/api/app/update-status*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_version: '0.89', update_available: false, can_download: false, download: { state: 'idle' } }) }));
    await page.route('**/api/study-sync', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'idle', active: false }) }));
    await page.route('**/api/study-sync/status', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'idle', active: false }) }));
    await page.route('**/proxy/**', r => r.abort());
    if (blockBig) {
      for (const frag of BLOCK) await page.route('**/' + frag, r => r.abort());
    }
    await page.goto(url + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => {
      try { return typeof ChartManager !== 'undefined' && (ChartManager.getRecords() || []).length === n; } catch (e) { return false; }
    }, count, { timeout: 120000 });
    const recordsReady = await page.evaluate(() => performance.now());
    await page.waitForFunction(() => document.querySelectorAll('.tile canvas').length > 0, null, { timeout: 120000 });
    const chartsReady = await page.evaluate(() => performance.now());
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0] || {};
      const paint = {};
      for (const p of performance.getEntriesByType('paint')) paint[p.name] = Math.round(p.startTime * 100) / 100;
      const res = performance.getEntriesByType('resource').filter(r => r.initiatorType !== 'xmlhttprequest' && r.initiatorType !== 'fetch');
      return {
        dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, paint,
        staticCount: res.length, staticBytes: res.reduce((a, r) => a + (r.decodedBodySize || 0), 0)
      };
    });
    samples.push({ recordsReady, chartsReady, ...nav });
    await context.close();
  }
  return samples;
}

function stats(v) {
  const s = v.slice().sort((a, b) => a - b);
  const pick = p => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
  return { n: s.length, min: s[0], median: pick(0.5), p95: pick(0.95), max: s[s.length - 1], samples: s };
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--enable-precise-memory-info'] });
  const report = { count: COUNT, repeat: REPEAT, generatedAt: new Date().toISOString(), blocked: BLOCK };
  try {
    report.withAll = await measureLoad(browser, server.url, COUNT, false);
    report.withoutBigImages = await measureLoad(browser, server.url, COUNT, true);

    // 多磁贴聚合：田字格下的一次全量重绘
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.route('**://*.maimemo.com/**', r => r.abort());
    await page.route('**/memo-**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>offline</body></html>' }));
    await page.route('**/api/app/update-status*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_version: '0.89', update_available: false, can_download: false, download: { state: 'idle' } }) }));
    await page.route('**/api/study-sync', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'idle', active: false }) }));
    await page.route('**/proxy/**', r => r.abort());
    await page.addInitScript(() => {
      window.__d = [];
      window.__installPerfHook = function () {
        if (window.echarts && !window.echarts.__hooked) {
          const orig = window.echarts.init;
          window.echarts.init = function () {
            const inst = orig.apply(this, arguments);
            const s = inst.setOption.bind(inst);
            inst.setOption = function () {
              const t0 = performance.now(); const r = s.apply(this, arguments);
              window.__d.push(performance.now() - t0); return r;
            };
            return inst;
          };
          window.echarts.__hooked = true;
        }
        return !!(window.echarts && window.echarts.__hooked);
      };
    });
    await page.goto(server.url + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => {
      try { return typeof ChartManager !== 'undefined' && (ChartManager.getRecords() || []).length === n; } catch (e) { return false; }
    }, COUNT, { timeout: 120000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__installPerfHook());
    const multi = {};
    for (const layout of ['single', 'split2', 'grid4']) {
      const rows = [];
      for (let i = 0; i < REPEAT; i++) {
        const r = await page.evaluate((l) => {
          const btn = document.querySelector('.layout-btn[data-layout="' + l + '"]');
          if (btn) btn.click();
          window.__d.length = 0;
          const t0 = performance.now();
          ChartManager.renderVisibleFromSelectors(true);
          const total = performance.now() - t0;
          const draw = window.__d.reduce((a, b) => a + b, 0);
          return { total, draw, drawCalls: window.__d.length };
        }, layout);
        rows.push(r);
        await page.waitForTimeout(80);
      }
      multi[layout] = {
        total: stats(rows.map(r => r.total)),
        draw: stats(rows.map(r => r.draw)),
        processing: stats(rows.map(r => Math.max(0, r.total - r.draw))),
        drawCalls: rows[rows.length - 1].drawCalls
      };
    }
    report.multiTileRender = multi;
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => {
      const t = setTimeout(() => { server.child.kill(); resolve(); }, 4000);
      server.child.once('exit', () => { clearTimeout(t); resolve(); });
      try { server.child.stdin.end('exit\n'); } catch (e) { server.child.kill(); resolve(); }
    });
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('FIRST_PAINT_DONE ' + OUT);
})().catch(e => { console.error(e); process.exitCode = 1; });
