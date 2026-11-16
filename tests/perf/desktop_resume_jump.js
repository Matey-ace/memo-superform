// D 桌面资源 —— "恢复后是否跳帧"专项探针。
//
// 目的：直接回答"若在前台/后台之间切换，恢复瞬间是否出现时间突变"。
// 做法：最小化一段时间后恢复，记录恢复瞬间 PIXI.Ticker.shared.deltaMS 与
// 页面 rAF 间隔的最大值；若 deltaMS 被钳制在 ~100ms 且帧间隔很快回落，
// 说明没有因长时间暂停而累计出巨大 delta。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.argv[2];
const OUT = process.argv[3] || path.join(__dirname, 'results', 'resume_jump.json');
if (!URL) { console.error('usage: resume_jump.js <url> [out]'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LAUNCH_ARGS = ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];

function installSampler() {
  if (window.__rj) return;
  const st = { deltas: [], gaps: [], last: 0, t0: performance.now() };
  window.__rj = st;
  const t = window.PIXI && window.PIXI.Ticker && window.PIXI.Ticker.shared;
  if (t) {
    // 只观察，不改变优先级；用 LOW 旁听与渲染器同一次 tick 的 deltaMS
    t.add(() => { st.deltas.push({ t: performance.now(), deltaMS: t.deltaMS, elapsedMS: t.elapsedMS }); }, null, -1e9);
  }
  const loop = (ts) => {
    if (st.last) { st.gaps.push({ t: ts, gap: ts - st.last }); }
    st.last = ts;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

(async () => {
  const b = await chromium.launch({ headless: false, channel: 'msedge', args: LAUNCH_ARGS });
  const page = await b.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  const btn = await page.$('#companionModeBtn');
  if (btn) await btn.click();
  await page.waitForTimeout(8000);
  await page.evaluate(installSampler);

  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');

  const out = { url: URL, generatedAt: new Date().toISOString(), trials: [] };

  for (let trial = 1; trial <= 3; trial++) {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await page.bringToFront();
    await sleep(2500);

    await page.evaluate(() => { window.__rj.deltas = []; window.__rj.gaps = []; });

    const hiddenSeconds = 20;
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await sleep(hiddenSeconds * 1000);
    const hiddenInfo = await page.evaluate(() => ({
      hidden: document.hidden,
      visibility: document.visibilityState,
      ticks: window.__rj.deltas.length,
      gaps: window.__rj.gaps.length
    }));

    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await page.bringToFront();
    const resumeAt = Date.now();
    await sleep(4000);

    const after = await page.evaluate(() => {
      const d = window.__rj.deltas.slice();
      const g = window.__rj.gaps.slice();
      return { deltas: d, gaps: g };
    });

    const duringHidden = after.deltas.filter(x => x.deltaMS > 0);
    const maxDelta = Math.max(...duringHidden.map(x => x.deltaMS), 0);
    const maxGap = Math.max(...after.gaps.map(x => x.gap), 0);
    // 恢复后前 500ms 内的帧
    const tail = after.gaps.slice(-1 * 60);

    out.trials.push({
      trial,
      hiddenSeconds,
      hiddenStateVerified: hiddenInfo,
      hiddenTicks: hiddenInfo.ticks,
      totalTicks: after.deltas.length,
      maxDeltaMS: +maxDelta.toFixed(2),
      maxRafGapMs: +maxGap.toFixed(2),
      deltaHistogram: (() => {
        const h = {};
        after.deltas.forEach(x => {
          const k = x.deltaMS > 90 ? '>90' : x.deltaMS > 40 ? '40-90' : x.deltaMS > 20 ? '20-40' : '<=20';
          h[k] = (h[k] || 0) + 1;
        });
        return h;
      })(),
      lastGaps: tail.map(x => +x.gap.toFixed(2))
    });
    console.log(`trial ${trial}: hiddenTicks=${hiddenInfo.ticks} maxDeltaMS=${maxDelta.toFixed(2)} maxRafGap=${maxGap.toFixed(2)}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('WROTE ' + OUT);
  await b.close();
})().catch(e => { console.error('RESUME_FAILED', e); process.exit(1); });
