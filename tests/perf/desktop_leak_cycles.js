// D 桌面资源 —— 陪伴模式 进入/退出 循环泄漏测试。
//
// 目的：区分"已回收节点的累计分配"与"真实存活泄漏"。
// 做法：反复 enter/exit 陪伴模式，每轮后强制 GC（CDP HeapProfiler.collectGarbage）
// 与一次基线快照，观察：
//   * PIXI.Ticker.shared 的监听器数量是否回到基线（不回收即为泄漏）
//   * 进程私有字节 / 工作集是否单调上升并在 GC 后不回落
//   * WebGL 上下文数量是否累积
// 只观察，不修改应用文件。
const { chromium } = require('playwright');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const URL = process.argv[2];
const OUT = process.argv[3] || path.join(__dirname, 'results', 'desktop_leak_cycles.json');
const CYCLES = parseInt(process.argv[4] || '20', 10);
if (!URL) { console.error('usage: leak_cycles.js <url> [out] [cycles]'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LAUNCH_ARGS = ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];

const PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$root=[int]$env:MEMO_SAMPLE_ROOT",
  "$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId",
  "$bp=@{}",
  "foreach($p in $all){$k=[int]$p.ParentProcessId; if(-not $bp.ContainsKey($k)){$bp[$k]=New-Object System.Collections.ArrayList}; [void]$bp[$k].Add([int]$p.ProcessId)}",
  "$tree=New-Object System.Collections.ArrayList; $st=New-Object System.Collections.Stack; $st.Push($root)",
  "while($st.Count -gt 0){$c=[int]$st.Pop(); if($tree -contains $c){continue}; [void]$tree.Add($c); if($bp.ContainsKey($c)){foreach($x in $bp[$c]){$st.Push($x)}}}",
  "$o=[pscustomobject]@{procs=@(); pids=@($tree)}",
  "$list=@()",
  "foreach($q in $tree){$gp=Get-Process -Id $q -ErrorAction SilentlyContinue; if($gp){$list+=[pscustomobject]@{pid=$q;name=$gp.ProcessName;ws=[int64]$gp.WorkingSet64;pm=[int64]$gp.PrivateMemorySize64;cpu=[double]$gp.TotalProcessorTime.TotalSeconds}}}",
  "[pscustomobject]@{pids=@($tree);procs=@($list)} | ConvertTo-Json -Depth 6 -Compress"
].join('\n');

function sample(rootPid) {
  const env = Object.assign({}, process.env, { MEMO_SAMPLE_ROOT: String(rootPid) });
  const out = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS],
    { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024, timeout: 40000 });
  return JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop());
}

function readState() {
  const t = window.PIXI && window.PIXI.Ticker && window.PIXI.Ticker.shared;
  let listeners = 0;
  if (t && t._head) { let h = t._head.next; while (h) { listeners++; h = h.next; } }
  const C = window.Live2DCompanion;
  // 统计当前文档里所有 canvas 的 WebGL 上下文数量
  const canvases = Array.from(document.querySelectorAll('canvas'));
  let gl = 0;
  canvases.forEach(cv => { try { if (cv.getContext('webgl2') || cv.getContext('webgl')) gl++; } catch (e) {} });
  return {
    tickerListeners: listeners,
    tickerStarted: t ? t.started : null,
    companionOpen: C && C.isOpen ? C.isOpen() : null,
    canvasCount: canvases.length,
    glCanvasCount: gl,
    heapUsed: performance.memory ? performance.memory.usedJSHeapSize : null,
    heapTotal: performance.memory ? performance.memory.totalJSHeapSize : null
  };
}

(async () => {
  const b = await chromium.launch({ headless: false, channel: 'msedge', args: LAUNCH_ARGS });
  const s0 = await b.newBrowserCDPSession();
  const { processInfo } = await s0.send('SystemInfo.getProcessInfo');
  const rootPid = processInfo.find(p => p.type === 'browser').id;

  const page = await b.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');

  async function gc() {
    await cdp.send('HeapProfiler.collectGarbage');
    await sleep(600);
  }

  async function snapshot(label) {
    await gc();
    const st = await page.evaluate(readState);
    const sm = sample(rootPid);
    let ws = 0, pm = 0;
    sm.procs.forEach(p => { ws += p.ws; pm += p.pm; });
    return {
      label,
      tickerListeners: st.tickerListeners,
      tickerStarted: st.tickerStarted,
      companionOpen: st.companionOpen,
      canvasCount: st.canvasCount,
      glCanvasCount: st.glCanvasCount,
      heapUsedMB: st.heapUsed != null ? +(st.heapUsed / 1048576).toFixed(2) : null,
      wsMB: +(ws / 1048576).toFixed(2),
      pmMB: +(pm / 1048576).toFixed(2),
      processCount: sm.procs.length
    };
  }

  const out = { url: URL, generatedAt: new Date().toISOString(), cycles: CYCLES, samples: [] };

  out.samples.push(await snapshot('start'));

  for (let i = 1; i <= CYCLES; i++) {
    const btn = await page.$('#companionModeBtn');
    if (btn) { await btn.click(); await page.waitForTimeout(2500); }
    const exitBtn = await page.$('#exitCompanionModeBtn');
    if (exitBtn) { await exitBtn.click(); await page.waitForTimeout(1200); }
    const s = await snapshot('after-cycle-' + i);
    out.samples.push(s);
    process.stderr.write(`cycle ${i}: listeners=${s.tickerListeners} canvas=${s.canvasCount} gl=${s.glCanvasCount} heap=${s.heapUsedMB}MB ws=${s.wsMB}MB pm=${s.pmMB}MB procs=${s.processCount}\n`);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  }

  // 结尾再进一次并保持打开，检查"打开态"是否也稳定
  const btn = await page.$('#companionModeBtn');
  if (btn) { await btn.click(); await page.waitForTimeout(3000); }
  out.samples.push(await snapshot('final-open'));

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('WROTE ' + OUT);
  await b.close();
})().catch(e => { console.error('LEAK_FAILED', e); process.exit(1); });
