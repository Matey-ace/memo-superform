// 重复切换 / 进入退出的资源稳定性压力场景。
// 使用：node tests/perf/lifecycle_stress.js --rounds 60 --count 10000 --tag baseline
//
// 观察目标（计划第 3 阶段）：重复进入退出学习/陪伴、布局与全屏切换后
// 监听、计时器、图表实例、iframe、DOM 是否持续增长；后 25 轮相对前 25 轮是否劣化。
// 隔离约束与 dashboard_benchmark.js 相同：独立数据目录、合成数据、随机端口、外部主机拦截。
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

const ROUNDS = Math.max(2, parseInt(arg('rounds', '60'), 10));
const COUNT = parseInt(arg('count', '10000'), 10);
const TAG = arg('tag', 'run');
const SEED = parseInt(arg('seed', '20261008'), 10);
const OUT = arg('out', path.join(ROOT, '_verification/workbuddy-optimization', 'lifecycle-stress-' + TAG + '.json'));

const INIT = function () {
  window.__perf = {
    chartsCreated: 0, chartsDisposed: 0, liveCharts: 0,
    listenersAdded: 0, listenersRemoved: 0,
    timersCreated: 0, timersCleared: 0,
    longTasks: [], longTaskSupported: true
  };
  try {
    new PerformanceObserver(function (list) {
      for (const e of list.getEntries()) window.__perf.longTasks.push(Math.round(e.duration * 100) / 100);
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { window.__perf.longTaskSupported = false; }

  // 监听目标用 WeakRef 记录：只统计“仍然挂在文档上”的目标，
  // 这样可以把“节点被替换后随之回收的监听”和“真正的长期增长”区分开。
  window.__targets = [];
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  window.__stackKeys = {};
  window.__netByKey = {};
  function labelOf(target) {
    if (target === document) return '#document';
    if (target === window) return '#window';
    const id = target && target.id;
    if (id) return '#' + id;
    return (target && target.nodeName ? target.nodeName.toLowerCase() : 'other');
  }
  EventTarget.prototype.addEventListener = function (type) {
    window.__perf.listenersAdded += 1;
    if (WeakRef && this instanceof Node) window.__targets.push(new WeakRef(this));
    try {
      const isDoc = this === document;
      const id = this && this.id;
      if (isDoc || id === 'companionStudyFrame' || id === 'chart-0') {
        const lines = ((new Error()).stack || '').split('\n');
        const key = (isDoc ? '#document' : '#' + id) + ' [' + type + '] ' + (lines[2] || lines[1] || '').trim();
        window.__stackKeys[key] = (window.__stackKeys[key] || 0) + 1;
      }
      const nk = labelOf(this) + ' [' + type + ']';
      window.__netByKey[nk] = (window.__netByKey[nk] || 0) + 1;
    } catch (e) { /* 忽略探针自身异常 */ }
    return add.apply(this, arguments);
  };
  EventTarget.prototype.removeEventListener = function (type) {
    window.__perf.listenersRemoved += 1;
    try {
      const nk = labelOf(this) + ' [' + type + ']';
      window.__netByKey[nk] = (window.__netByKey[nk] || 0) - 1;
    } catch (e) { /* 忽略探针自身异常 */ }
    return remove.apply(this, arguments);
  };
  const setT = window.setTimeout, clearT = window.clearTimeout;
  const setI = window.setInterval, clearI = window.clearInterval;
  window.setTimeout = function () { window.__perf.timersCreated += 1; return setT.apply(window, arguments); };
  window.clearTimeout = function () { window.__perf.timersCleared += 1; return clearT.apply(window, arguments); };
  window.setInterval = function () { window.__perf.timersCreated += 1; return setI.apply(window, arguments); };
  window.clearInterval = function () { window.__perf.timersCleared += 1; return clearI.apply(window, arguments); };

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
      return inst;
    };
    window.__perf.hooked = true;
    return true;
  };
};

function snapshot(page) {
  return page.evaluate(() => {
    const m = performance.memory;
    // 仍然连接在文档上的监听目标数：节点被替换后会被回收，因此该值应趋于平稳。
    let connectedTargets = 0, collected = 0;
    const kinds = {};
    for (const ref of window.__targets) {
      const node = ref.deref();
      if (!node) { collected += 1; continue; }
      if (!document.contains(node)) continue;
      connectedTargets += 1;
      const key = node.nodeName.toLowerCase() +
        (node.id ? '#' + node.id : '') +
        (node.className && typeof node.className === 'string' ? '.' + node.className.trim().split(/\s+/).join('.') : '');
      kinds[key] = (kinds[key] || 0) + 1;
    }
    if (window.__dumpTargets) {
      window.__connectedKinds = Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 25);
    }
    return {
      connectedListenerTargets: connectedTargets,
      collectedListenerTargets: collected,
      chartsCreated: window.__perf.chartsCreated,
      chartsDisposed: window.__perf.chartsDisposed,
      liveCharts: window.__perf.liveCharts,
      netListeners: window.__perf.listenersAdded - window.__perf.listenersRemoved,
      listenersAdded: window.__perf.listenersAdded,
      listenersRemoved: window.__perf.listenersRemoved,
      liveTimers: window.__perf.timersCreated - window.__perf.timersCleared,
      timersCreated: window.__perf.timersCreated,
      domNodes: document.getElementsByTagName('*').length,
      canvases: document.querySelectorAll('canvas').length,
      iframes: document.querySelectorAll('iframe').length,
      heap: m ? m.usedJSHeapSize : null
    };
  });
}

(async () => {
  const child = spawn('python', [path.join(__dirname, 'bench_server.py'), '--count', String(COUNT), '--seed', String(SEED)],
    { cwd: ROOT, windowsHide: true });
  let url = null, seeded = 0, dataDir = '';
  await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 180000);
    child.stdout.on('data', c => {
      text += c;
      const m = text.match(/BENCH_URL=(\S+)/);
      const s = text.match(/BENCH_SEEDED=(\d+)/);
      const dd = text.match(/BENCH_DATA_DIR=(.*)/);
      if (m) { url = m[1]; seeded = s ? +s[1] : 0; dataDir = dd ? dd[1].trim() : ''; clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', c => process.stderr.write('[server] ' + c));
  });
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url + '/api/study-records');
      const j = await r.json();
      if (r.ok && j.count === seeded) break;
    } catch (e) { /* 重试 */ }
    await new Promise(r => setTimeout(r, 500));
  }

  const browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--enable-precise-memory-info'] });
  const report = {
    tag: TAG, generatedAt: new Date().toISOString(), rounds: ROUNDS, count: COUNT, seed: SEED,
    dataDir, environment: { node: process.version, platform: process.platform + ' ' + process.arch, viewport: { width: 1440, height: 900 } },
    rounds_data: [], errors: []
  };
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', e => report.errors.push(String(e.message).slice(0, 200)));
    await page.addInitScript(INIT);
    await page.route('**://*.maimemo.com/**', r => r.abort());
    await page.route('**://*.github.com/**', r => r.abort());
    await page.route('**/memo-**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>offline study fixture</body></html>' }));
    await page.route('**/api/app/update-status*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_version: '0.89', update_available: false, can_download: false, download: { state: 'idle' } }) }));
    await page.route('**/api/study-sync', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'idle', active: false }) }));
    await page.route('**/api/study-sync/status', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'idle', active: false, bootstrap_complete: true }) }));
    await page.route('**/proxy/**', r => r.abort());

    await page.goto(url + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      try { return typeof ChartManager !== 'undefined' && (ChartManager.getRecords() || []).length > 0; } catch (e) { return false; }
    }, null, { timeout: 120000 });
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__installPerfHook());
    report.baseline = await snapshot(page);

    for (let round = 1; round <= ROUNDS; round++) {
      // 1) 进入 / 退出陪伴学习
      await page.evaluate(() => {
        const enter = document.getElementById('companionModeBtn');
        if (enter) enter.click();
      });
      await page.waitForTimeout(120);
      await page.evaluate(() => {
        const exit = document.getElementById('exitCompanionModeBtn');
        if (exit) exit.click();
      });
      await page.waitForTimeout(120);
      // 2) 布局切换（含田字格 -> 单格）
      for (const layout of ['split2', 'grid4', 'single']) {
        await page.evaluate((l) => {
          const b = document.querySelector('.layout-btn[data-layout="' + l + '"]');
          if (b) b.click();
        }, layout);
        await page.waitForTimeout(40);
      }
      // 3) 图表类型切换（含背单词磁贴，会创建 iframe）
      for (const type of ['trend', 'study-web', 'heatmap']) {
        await page.evaluate((t) => {
          const sel = document.querySelector('.tile[data-tile="0"] .chart-selector');
          if (sel) { sel.value = t; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        }, type);
        await page.waitForTimeout(120);
      }
      if (round % 5 === 0 || round === 1 || round === ROUNDS) {
        report.rounds_data.push(Object.assign({ round }, await snapshot(page)));
      }
    }
    await page.evaluate(() => { window.__dumpTargets = true; });
    report.final = await snapshot(page);
    report.connectedKinds = await page.evaluate(() => window.__connectedKinds || []);
    report.listenerStacks = await page.evaluate(() =>
      Object.entries(window.__stackKeys || {}).sort((a, b) => b[1] - a[1]).slice(0, 20));
    report.netListenersByKey = await page.evaluate(() =>
      Object.entries(window.__netByKey || {}).filter(e => e[1] !== 0)
        .sort((a, b) => b[1] - a[1]).slice(0, 20));
    report.longTasks = await page.evaluate(() => ({
      supported: window.__perf.longTaskSupported,
      count: window.__perf.longTasks.length,
      longest: window.__perf.longTasks.reduce((a, b) => Math.max(a, b), 0),
      sample: window.__perf.longTasks.slice(0, 50)
    }));
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => {
      const t = setTimeout(() => { child.kill(); resolve(); }, 4000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      try { child.stdin.end('exit\n'); } catch (e) { child.kill(); resolve(); }
    });
  }
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('LIFECYCLE_DONE ' + OUT);
})().catch(e => { console.error(e); process.exitCode = 1; });
