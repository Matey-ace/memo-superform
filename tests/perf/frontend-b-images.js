// B 子智能体 EXP4：首屏两个大图的成本（Playwright route 拦截，不改磁盘文件）。
//
// 观测到的事实（来自 frontend_baseline.json 的资源清单）：
//   /img/gifs/anon-think.gif  1766KB  start≈11ms  —— index.html:201，位于 hidden 的 #companionStudy 内
//   /img/icon.png             2081KB  start≈168ms —— index.html:4，<link rel="icon">
// 合计 3847KB，占 standard 主题 6325KB 静态资源的 61%。
//
// 变体：
//   baseline        原样
//   no-hidden-gif   拦截 anon-think.gif
//   no-favicon      拦截 icon.png
//   no-both         两个都拦
//   lazy-live2d     （对照）Live2D 按需加载
//
// 用法: node tests/perf/frontend-b-images.js --count 50000 --rounds 7 \
//        --out tests/perf/results/frontend_images.json
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
const OUT = arg('out', path.join(ROOT, 'tests/perf/results/frontend_images.json'));
const THEME = arg('theme', 'standard');
const TAG = arg('img');
const VARIANTS = arg('variants', 'baseline,no-hidden-gif,no-favicon,no-both').split(',').filter(Boolean);

// 1x1 透明 PNG：只替换字节，不改变 DOM 结构与事件
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const BLANK_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const PROBE = function () {
  window.__probe = { longTasks: [], longTaskSupported: true };
  try {
    new PerformanceObserver(function (list) {
      for (const e of list.getEntries()) window.__probe.longTasks.push(Math.round(e.duration * 100) / 100);
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { window.__probe.longTaskSupported = false; }
};

async function startServer() {
  const dataDir = path.join(ROOT, '_verification/perfvocab/B', TAG + '-' + COUNT + '-' + Date.now().toString(36));
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn('python', [path.join(__dirname, 'bench_server.py'),
    '--count', String(COUNT), '--seed', String(SEED), '--data-dir', dataDir],
  { cwd: ROOT, windowsHide: true, env: Object.assign({}, process.env, { MEMO_DATA_DIR: dataDir }) });
  const meta = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 300000);
    child.stdout.on('data', chunk => {
      text += chunk;
      const url = text.match(/BENCH_URL=(\S+)/);
      const seeded = text.match(/BENCH_SEEDED=(\d+)/);
      if (url) { clearTimeout(timer); resolve({ url: url[1], seeded: seeded ? +seeded[1] : 0 }); }
    });
    child.stderr.on('data', () => {});
    child.on('exit', code => { clearTimeout(timer); reject(new Error('server exited ' + code)); });
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
  if (!warmed) throw new Error('预热失败');
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

async function newPage(browser, base, variant) {
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
  // 用等价空白图替换，而不是 abort：abort 会让浏览器报 ERR_FAILED 并可能触发 <img> onerror 路径，
  // 那样测的就不是“图变小了”，而是“图坏了”。这里保持 DOM 与事件路径不变，只把字节降到最小。
  if (variant === 'no-hidden-gif' || variant === 'no-both') {
    await page.route('**/img/gifs/anon-think.gif*', r => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK_GIF }));
  }
  if (variant === 'no-favicon' || variant === 'no-both') {
    await page.route('**/img/icon.png*', r => r.fulfill({ status: 200, contentType: 'image/png', body: BLANK_PNG }));
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

async function sample(browser, base, variant) {
  const { context, page, errors } = await newPage(browser, base, variant);
  try {
    const t0 = Date.now();
    await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
    await waitRecords(page);
    const wall = Date.now() - t0;
    const m = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0] || {};
      const paint = {};
      for (const p of performance.getEntriesByType('paint')) paint[p.name] = Math.round(p.startTime * 100) / 100;
      const res = performance.getEntriesByType('resource').map(r => ({
        name: r.name.replace(/^https?:\/\/[^/]+/, ''), kind: r.initiatorType,
        start: Math.round(r.startTime * 100) / 100, duration: Math.round(r.duration * 100) / 100,
        decoded: r.decodedBodySize || 0
      }));
      const stat = res.filter(r => r.kind !== 'xmlhttprequest' && r.kind !== 'fetch');
      return {
        fcp: paint['first-contentful-paint'] ?? null,
        dcl: n.domContentLoadedEventEnd,
        loadEventEnd: n.loadEventEnd,
        recordsReady: performance.now(),
        staticDecoded: stat.reduce((a, r) => a + r.decoded, 0),
        staticCount: stat.length,
        imgDecoded: stat.filter(r => r.kind === 'img' || r.kind === 'other').reduce((a, r) => a + r.decoded, 0),
        longestTask: window.__probe.longTasks.reduce((a, b) => Math.max(a, b), 0),
        img: res.filter(r => /anon-think|icon\.png/.test(r.name)).map(r => ({ name: r.name, decoded: r.decoded, start: r.start, dur: r.duration }))
      };
    });
    return { variant, wall, ...m, errors: errors.slice(0, 3) };
  } finally { await context.close(); }
}

function stats(values) {
  const v = values.filter(x => typeof x === 'number' && isFinite(x)).slice().sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0 };
  const pick = p => v[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
  return { n, min: v[0], median: pick(0.5), max: v[n - 1], sd: Math.round(sd * 100) / 100, samples: v };
}

(async () => {
  const report = {
    kind: 'frontend-images', tag: TAG, generatedAt: new Date().toISOString(),
    count: COUNT, rounds: ROUNDS, theme: THEME, variants: VARIANTS,
    note: '用等价 1x1 图替换原图（不 abort），保持 DOM 与事件路径不变。',
    environment: { node: process.version, edge: EDGE, viewport: { width: 1440, height: 900 } },
    load: {}
  };
  let browser, server;
  try {
    browser = await chromium.launch({ headless: true, executablePath: EDGE });
    report.environment.browserVersion = await browser.version();
    server = await startServer();
    const samples = {};
    for (const v of VARIANTS) samples[v] = [];
    for (let round = 1; round <= ROUNDS; round++) {
      for (const variant of VARIANTS) {
        const s = await sample(browser, server.url, variant);
        s.round = round;
        samples[variant].push(s);
        console.log('round ' + round + ' ' + variant + ' fcp=' + s.fcp + ' staticKB=' + Math.round(s.staticDecoded / 1024) +
          ' imgKB=' + Math.round(s.imgDecoded / 1024) + ' recordsReady=' + Math.round(s.recordsReady));
      }
    }
    for (const v of VARIANTS) {
      const rows = samples[v];
      report.load[v] = { raw: rows, summary: {} };
      for (const key of ['fcp', 'dcl', 'loadEventEnd', 'recordsReady', 'staticDecoded', 'imgDecoded', 'longestTask', 'wall']) {
        report.load[v].summary[key] = stats(rows.map(r => r[key]));
      }
    }
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log('FRONTEND_IMAGES_DONE ' + OUT);
  } finally {
    if (browser) await browser.close();
    if (server) await stopServer(server.child);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
