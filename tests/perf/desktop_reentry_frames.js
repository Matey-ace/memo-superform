// 验证修复后：反复进入/退出陪伴模式时，渲染器是否持续可用且确实在出帧。
const { chromium } = require('playwright');
const URL = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ headless: false, channel: 'msedge',
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await b.newPage({ viewport: { width: 1280, height: 860 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message || e).slice(0, 160)));
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });

  const rows = [];
  for (let i = 1; i <= 8; i++) {
    const enter = await page.$('#companionModeBtn');
    await enter.click();
    await page.waitForTimeout(3000);
    const open = await page.evaluate(() => {
      const cv = document.getElementById('companionLive2DCanvas');
      const t = window.PIXI && window.PIXI.Ticker && window.PIXI.Ticker.shared;
      let listeners = 0; if (t && t._head) { let h = t._head.next; while (h) { listeners++; h = h.next; } }
      return {
        diag: window.Live2DCompanion.getRendererDiagnostic(),
        canvas: cv ? [cv.width, cv.height, cv.isConnected] : null,
        listeners,
        fallbackHidden: (document.getElementById('companionGifFallback') || {}).hidden
      };
    });
    // 记录 1.5s 内的 ticker 帧数，确认真的在动
    const before = await page.evaluate(() => {
      const t = window.PIXI.Ticker.shared; window.__tk = 0;
      const id = t.add(() => { window.__tk++; });
      return 0;
    });
    await page.waitForTimeout(1500);
    const ticks = await page.evaluate(() => window.__tk);
    const exit = await page.$('#exitCompanionModeBtn');
    await exit.click();
    await page.waitForTimeout(900);
    rows.push({ cycle: i, diag: open.diag || '(none)', canvas: open.canvas, listeners: open.listeners, ticksIn1500ms: ticks });
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
  console.log('pageErrors:', errs.length ? errs.slice(0, 5) : 'none');
  const bad = rows.filter(r => r.diag !== '(none)' || r.ticksIn1500ms < 30);
  console.log('FAILED_CYCLES:', bad.length);
  await b.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
