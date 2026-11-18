// 定向验证：进入/退出陪伴模式后，静态 canvas 是否仍可重新绑定 WebGL。
// 只观察，不修改应用文件。
const { chromium } = require('playwright');

const URL = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ headless: false, channel: 'msedge',
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await b.newPage({ viewport: { width: 1280, height: 860 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e && e.message || e).slice(0, 200)));
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });

  const state = () => page.evaluate(() => {
    const cv = document.getElementById('companionLive2DCanvas');
    const C = window.Live2DCompanion;
    let gl = null, glErr = '';
    if (cv) { try { gl = !!(cv.getContext('webgl2') || cv.getContext('webgl')); } catch (e) { glErr = String(e.message || e); } }
    return {
      canvasInDom: !!cv,
      canvasConnected: cv ? cv.isConnected : null,
      canvasSize: cv ? [cv.width, cv.height] : null,
      hasGL: gl,
      glError: glErr,
      open: C && C.isOpen ? C.isOpen() : null,
      diagnostic: C && C.getRendererDiagnostic ? C.getRendererDiagnostic() : null,
      fallbackHidden: (document.getElementById('companionGifFallback') || {}).hidden,
      modelLabel: (document.getElementById('companionModelName') || {}).textContent || ''
    };
  });

  console.log('initial:', JSON.stringify(await state()));

  for (let i = 1; i <= 5; i++) {
    const enter = await page.$('#companionModeBtn');
    if (enter) { await enter.click(); await page.waitForTimeout(3500); }
    const sOpen = await state();
    const exit = await page.$('#exitCompanionModeBtn');
    if (exit) { await exit.click(); await page.waitForTimeout(1500); }
    const sClosed = await state();
    console.log(`cycle ${i} OPEN  :`, JSON.stringify(sOpen));
    console.log(`cycle ${i} CLOSED:`, JSON.stringify(sClosed));
  }
  console.log('pageErrors:', errs.length ? errs.slice(0, 6) : 'none');
  await b.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
