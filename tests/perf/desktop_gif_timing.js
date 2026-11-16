// 精确判定：GIF 到底在哪个时刻被请求？
const { chromium } = require('playwright');
const URL = process.argv[2];

(async () => {
  const b = await chromium.launch({ headless: false, channel: 'msedge',
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await b.newPage({ viewport: { width: 1280, height: 860 } });
  const reqs = [];
  page.on('request', r => { if (/gifs\/.*\.gif/i.test(r.url())) reqs.push({ when: page.__phase || '?', f: r.url().split('/').pop() }); });
  page.__phase = 'A-first-load';
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2000);
  console.log('after first paint, gif requests:', JSON.stringify(reqs));

  page.__phase = 'B-enter-companion';
  const enter = await page.$('#companionModeBtn');
  await enter.click();
  await page.waitForTimeout(4500);
  console.log('after entering companion (model loads OK), gif requests:', JSON.stringify(reqs));

  const st = await page.evaluate(() => ({
    diag: window.Live2DCompanion.getRendererDiagnostic(),
    fallbackHidden: (document.getElementById('companionGifFallback') || {}).hidden
  }));
  console.log('state:', JSON.stringify(st));
  await b.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
