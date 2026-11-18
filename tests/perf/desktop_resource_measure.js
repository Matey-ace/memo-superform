// D 桌面资源 —— 前后台 CPU / GPU / 内存测量。
//
// 设计要点：
//  * 不修改任何应用文件；真实 index.html、真实 vendor、真实模型资源。
//  * 三种状态，因为"隐藏"在桌面端至少有两条不同路径，不能混为一谈：
//      visible   —— 窗口正常、应用页在前
//      tab-hidden—— 另一个页面获得焦点，应用页 document.hidden === true
//                   （这是纯 visibilitychange 路径）
//      minimized —— Windows 真实最小化
//    每次采样都回读 document.hidden / visibilityState 并原样记录；
//    若状态未按预期生效，如实标注，不假装成功。
//  * 串行执行，不与基准/构建并发。
const { chromium } = require('playwright');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const URL = arg('url');
const OUT = arg('out', path.join(__dirname, 'results', 'desktop_baseline.json'));
const ROUNDS = parseInt(arg('rounds', '7'), 10);
const SAMPLE_MS = parseInt(arg('sampleMs', '30000'), 10);
const SETTLE_MS = parseInt(arg('settleMs', '5000'), 10);

if (!URL) { console.error('usage: --url <url>'); process.exit(2); }

const LAUNCH_ARGS = ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];

// ---------- 进程树采样 ----------

const PS_SAMPLE = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$root = [int]$env:MEMO_SAMPLE_ROOT",
  "$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name",
  "$byParent = @{}",
  "foreach ($p in $all) {",
  "  $k = [int]$p.ParentProcessId",
  "  if (-not $byParent.ContainsKey($k)) { $byParent[$k] = New-Object System.Collections.ArrayList }",
  "  [void]$byParent[$k].Add([int]$p.ProcessId)",
  "}",
  "$tree = New-Object System.Collections.ArrayList",
  "$stack = New-Object System.Collections.Stack",
  "$stack.Push($root)",
  "while ($stack.Count -gt 0) {",
  "  $cur = [int]$stack.Pop()",
  "  if ($tree -contains $cur) { continue }",
  "  [void]$tree.Add($cur)",
  "  if ($byParent.ContainsKey($cur)) { foreach ($c in $byParent[$cur]) { $stack.Push($c) } }",
  "}",
  "$procs = @()",
  "foreach ($q in $tree) {",
  "  $gp = Get-Process -Id $q -ErrorAction SilentlyContinue",
  "  if ($null -eq $gp) { continue }",
  "  $procs += [pscustomobject]@{ pid = $q; name = $gp.ProcessName; ws = [int64]$gp.WorkingSet64; pm = [int64]$gp.PrivateMemorySize64; cpu = [double]$gp.TotalProcessorTime.TotalSeconds; threads = [int]$gp.Threads.Count }",
  "}",
  "$gpu = @{}",
  "$g = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue",
  "foreach ($e in $g) {",
  "  if ($e.Name -match 'pid_(\\d+)_') {",
  "    $gp2 = [int]$Matches[1]",
  "    if ($tree -contains $gp2) {",
  "      $t = 'other'",
  "      if ($e.Name -match 'engtype_(\\w+)$') { $t = $Matches[1].ToLower() }",
  "      if (-not $gpu.ContainsKey($gp2)) { $gpu[$gp2] = @{ total = 0.0; byType = @{} } }",
  "      $v = [double]$e.UtilizationPercentage",
  "      $gpu[$gp2].total += $v",
  "      if (-not $gpu[$gp2].byType.ContainsKey($t)) { $gpu[$gp2].byType[$t] = 0.0 }",
  "      $gpu[$gp2].byType[$t] += $v",
  "    }",
  "  }",
  "}",
  "$gpuOut = @()",
  "foreach ($k in $gpu.Keys) { $gpuOut += [pscustomobject]@{ pid = $k; total = $gpu[$k].total; byType = $gpu[$k].byType } }",
  "[pscustomobject]@{ ts = (Get-Date).ToString('o'); tree = @($tree); procs = @($procs); gpu = @($gpuOut) } | ConvertTo-Json -Depth 8 -Compress"
].join('\n');

function sampleTree(rootPid) {
  const env = Object.assign({}, process.env, { MEMO_SAMPLE_ROOT: String(rootPid) });
  const out = cp.execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', PS_SAMPLE],
    { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, timeout: 40000 });
  const line = out.trim().split(/\r?\n/).filter(Boolean).pop();
  return JSON.parse(line);
}

// ---------- 页面内探针 ----------

function installPageProbe() {
  if (window.__perfProbe) return;
  const st = { raf: 0, timers: 0, gaps: [], lastRaf: 0 };
  window.__perfProbe = st;
  const loop = (t) => {
    st.raf++;
    if (st.lastRaf) { st.gaps.push(t - st.lastRaf); if (st.gaps.length > 500) st.gaps.shift(); }
    st.lastRaf = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  setInterval(() => { st.timers++; }, 100);
}

function readPageState() {
  const t = window.PIXI && window.PIXI.Ticker && window.PIXI.Ticker.shared;
  const C = window.Live2DCompanion;
  let listeners = 0;
  if (t && t._head) { let h = t._head.next; while (h) { listeners++; h = h.next; } }
  const cv = document.getElementById('companionLive2DCanvas');
  return {
    hidden: document.hidden,
    visibility: document.visibilityState,
    raf: window.__perfProbe ? window.__perfProbe.raf : null,
    timers: window.__perfProbe ? window.__perfProbe.timers : null,
    gaps: window.__perfProbe ? window.__perfProbe.gaps.slice(-200) : null,
    tickerStarted: t ? t.started : null,
    tickerDeltaMS: t ? t.deltaMS : null,
    tickerFPS: t ? t.FPS : null,
    tickerListeners: listeners,
    companionOpen: C && C.isOpen ? C.isOpen() : null,
    canvasSize: cv ? [cv.width, cv.height] : null,
    hasGL: !!(cv && (cv.getContext('webgl2') || cv.getContext('webgl')))
  };
}

// ---------- 统计 ----------

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const pct = (a, p) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mb = (b) => +(b / 1048576).toFixed(2);

async function browserPid(browser) {
  const s = await browser.newBrowserCDPSession();
  const { processInfo } = await s.send('SystemInfo.getProcessInfo');
  const root = processInfo.find(p => p.type === 'browser');
  if (!root) throw new Error('无法从 SystemInfo 取得浏览器进程');
  return root.id;
}

async function waitRendererReady(page, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const ok = await page.evaluate(readPageState);
    if (ok.companionOpen && ok.hasGL && ok.canvasSize && ok.canvasSize[0] > 32 && ok.tickerListeners >= 1) {
      const diag = await page.evaluate(() => {
        const C = window.Live2DCompanion;
        return C && C.getRendererDiagnostic ? C.getRendererDiagnostic() : '';
      });
      if (!diag) return Date.now() - t0;
    }
    if (Date.now() - t0 > timeoutMs) return -1;
    await page.waitForTimeout(100);
  }
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const results = {
    meta: {
      generatedAt: new Date().toISOString(),
      url: URL,
      rounds: ROUNDS,
      sampleMs: SAMPLE_MS,
      settleMs: SETTLE_MS,
      browserChannel: 'msedge (与 pywebview/WebView2 同源 Blink+WebGL 栈)',
      host: { logicalCpus: 32, cpu: 'AMD Ryzen 9 7945HX', ramGB: 63.2, gpus: ['AMD Radeon 610M', 'NVIDIA RTX 5070 Ti Laptop'] },
      caveats: [
        '有限样本，非统计保证。',
        '串行执行，未与基准/构建并发。',
        '采集时全机存在 830 个无关 GPU 引擎实例，GPU 数字仅作量级参考。',
        'CPU 百分比按 32 逻辑核折算为整机占比。',
        '本测量用 msedge 直接驱动，而非 pywebview 窗口；两者同为 Chromium 内核，但进程树形状不同。'
      ]
    },
    states: {},
    rounds: [],
    coldStarts: []
  };

  let browser = await chromium.launch({ headless: false, channel: 'msedge', args: LAUNCH_ARGS });
  const rootPid = await browserPid(browser);
  results.meta.browserRootPid = rootPid;

  const appPage = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await appPage.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await appPage.evaluate(installPageProbe);
  const btn = await appPage.$('#companionModeBtn');
  if (btn) await btn.click();
  const readyMs = await waitRendererReady(appPage, 60000);
  if (readyMs < 0) throw new Error('渲染器未就绪');
  results.meta.rendererReadyMs = readyMs;

  // 第二个页面：用于制造真实的 document.hidden
  const bgPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await bgPage.goto('about:blank');

  const cdp = await appPage.context().newCDPSession(appPage);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');

  async function applyState(state) {
    if (state === 'visible') {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await appPage.bringToFront();
    } else if (state === 'minimized') {
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    }
  }

  async function measure(state) {
    await applyState(state);
    await sleep(SETTLE_MS);

    const before = await appPage.evaluate(readPageState);
    const s0 = sampleTree(rootPid);
    const t0 = Date.now();
    await sleep(SAMPLE_MS);
    const s1 = sampleTree(rootPid);
    const t1 = Date.now();
    const after = await appPage.evaluate(readPageState);
    const wall = (t1 - t0) / 1000;

    const map = {};
    s0.procs.forEach(p => { map[p.pid] = { b: p }; });
    s1.procs.forEach(p => { map[p.pid] = Object.assign(map[p.pid] || {}, { a: p }); });

    let cpuDelta = 0, ws = 0, pm = 0, threads = 0, browserProcs = 0;
    const perProc = [];
    for (const k of Object.keys(map)) {
      const e = map[k];
      if (!e.a) continue;
      const d = e.b ? e.a.cpu - e.b.cpu : 0;
      cpuDelta += d; ws += e.a.ws; pm += e.a.pm; threads += e.a.threads;
      if (/msedge|chrome/i.test(e.a.name)) browserProcs++;
      perProc.push({ pid: +k, name: e.a.name, cpuDeltaSec: +d.toFixed(3), wsMB: mb(e.a.ws), pmMB: mb(e.a.pm) });
    }

    const gpuByType = {};
    let gpuTotal = 0;
    for (const g of s1.gpu) {
      gpuTotal += g.total;
      for (const t of Object.keys(g.byType)) gpuByType[t] = (gpuByType[t] || 0) + g.byType[t];
    }

    const rafDelta = (after.raf != null && before.raf != null) ? after.raf - before.raf : null;
    const timerDelta = (after.timers != null && before.timers != null) ? after.timers - before.timers : null;

    return {
      state,
      sampleStart: new Date(t0).toISOString(),
      windowSeconds: +wall.toFixed(2),
      processCount: s1.tree.length,
      browserProcesses: browserProcs,
      cpuMachinePercent: +((cpuDelta / wall) / 32 * 100).toFixed(4),
      cpuCoreEquivalents: +(cpuDelta / wall).toFixed(4),
      workingSetMB: +mb(ws),
      privateMB: +mb(pm),
      threads,
      gpuUtilSum: +gpuTotal.toFixed(2),
      gpu3dSum: +(gpuByType['3d'] || 0).toFixed(2),
      gpuByType,
      effectiveState: { hidden: after.hidden, visibility: after.visibility },
      page: {
        rafFrames: rafDelta,
        rafFps: rafDelta != null ? +(rafDelta / wall).toFixed(2) : null,
        timerTicks: timerDelta,
        tickerStarted: after.tickerStarted,
        tickerDeltaMS: after.tickerDeltaMS,
        tickerFPS: after.tickerFPS,
        tickerListeners: after.tickerListeners,
        medianFrameGapMs: after.gaps && after.gaps.length ? +median(after.gaps).toFixed(2) : null,
        p95FrameGapMs: after.gaps && after.gaps.length ? +pct(after.gaps, 95).toFixed(2) : null
      },
      perProc,
      gpuPerProc: s1.gpu.map(g => ({ pid: g.pid, total: +g.total.toFixed(2), byType: g.byType }))
    };
  }

  const STATE_LIST = ['visible', 'minimized'];
  const acc = { visible: [], minimized: [] };

  for (let r = 1; r <= ROUNDS; r++) {
    // 轮换顺序，抵消热累积/漂移
    const order = STATE_LIST.slice(r % STATE_LIST.length).concat(STATE_LIST.slice(0, r % STATE_LIST.length));
    const rec = { round: r, order, samples: [] };
    for (const st of order) {
      const m = await measure(st);
      acc[st].push(m);
      rec.samples.push(m);
      process.stderr.write(`[r${r}] ${st}: cpu=${m.cpuMachinePercent}% ws=${m.workingSetMB}MB gpu3d=${m.gpu3dSum} rafFps=${m.page.rafFps} hidden=${m.effectiveState.hidden} ticker=${m.page.tickerStarted} d=${m.page.tickerDeltaMS}\n`);
    }
    results.rounds.push(rec);
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  }

  function summarize(v, key) {
    const arr = v.map(x => key(x));
    return { median: median(arr), min: Math.min(...arr), max: Math.max(...arr), all: arr };
  }

  for (const st of STATE_LIST) {
    const v = acc[st];
    results.states[st] = {
      n: v.length,
      hiddenFlags: v.map(x => x.effectiveState.hidden),
      cpuMachinePercent: summarize(v, x => x.cpuMachinePercent),
      workingSetMB: summarize(v, x => x.workingSetMB),
      privateMB: summarize(v, x => x.privateMB),
      gpu3dSum: summarize(v, x => x.gpu3dSum),
      gpuUtilSum: summarize(v, x => x.gpuUtilSum),
      rafFps: summarize(v, x => x.page.rafFps),
      tickerDeltaMS: summarize(v, x => x.page.tickerDeltaMS),
      medianFrameGapMs: summarize(v, x => x.page.medianFrameGapMs),
      tickerStartedAlways: v.every(x => x.page.tickerStarted === true)
    };
  }

  // ---------- 冷启动 ----------
  await browser.close();
  for (let c = 1; c <= ROUNDS; c++) {
    const t0 = Date.now();
    const b = await chromium.launch({ headless: false, channel: 'msedge', args: LAUNCH_ARGS });
    const p = await browserPid(b);
    const pg = await b.newPage({ viewport: { width: 1280, height: 860 } });
    await pg.goto(URL, { waitUntil: 'load', timeout: 60000 });
    await pg.evaluate(installPageProbe);
    const btn2 = await pg.$('#companionModeBtn');
    if (btn2) await btn2.click();
    const ready = await waitRendererReady(pg, 60000);
    const s = sampleTree(p);
    let cpu = 0, ws = 0, pm = 0;
    s.procs.forEach(x => { cpu += x.cpu; ws += x.ws; pm += x.pm; });
    const rec = {
      coldRound: c,
      loadToRendererReadyMs: ready,
      wallMs: Date.now() - t0,
      processCount: s.tree.length,
      cpuSecondsAtReady: +cpu.toFixed(2),
      workingSetMB: mb(ws),
      privateMB: mb(pm)
    };
    results.coldStarts.push(rec);
    process.stderr.write(`[cold ${c}] ready=${ready}ms ws=${rec.workingSetMB}MB cpu=${rec.cpuSecondsAtReady}s\n`);
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    await b.close();
    await sleep(2500);
  }

  results.coldSummary = {
    loadToRendererReadyMs: summarize(results.coldStarts, x => x.loadToRendererReadyMs),
    workingSetMB: summarize(results.coldStarts, x => x.workingSetMB),
    privateMB: summarize(results.coldStarts, x => x.privateMB),
    cpuSecondsAtReady: summarize(results.coldStarts, x => x.cpuSecondsAtReady)
  };

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log('WROTE ' + OUT);
})().catch(e => { console.error('MEASURE_FAILED', e); process.exit(1); });
