// 验证 data-deferred-src 惰性恢复：正常路径不加载 GIF，出错路径补上 src。
const { chromium } = require('playwright');
const URL = process.argv[2];

(async () => {
  const b = await chromium.launch({ headless: false, channel: 'msedge',
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await b.newPage({ viewport: { width: 1280, height: 860 } });
  const reqs = [];
  page.on('request', r => { if (/gifs\/.*\.gif/i.test(r.url())) reqs.push(r.url().split('/').pop()); });
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1500);

  const gifState = () => page.evaluate(() => {
    const img = document.querySelector('#companionGifFallback img');
    return {
      hasSrc: !!(img && img.getAttribute('src')),
      deferred: img ? img.getAttribute('data-deferred-src') : null,
      complete: img ? img.complete : null,
      naturalWidth: img ? img.naturalWidth : null,
      fallbackHidden: (document.getElementById('companionGifFallback') || {}).hidden
    };
  });

  console.log('A. at load (idle, no companion):', JSON.stringify(await gifState()));
  console.log('   gif requests so far:', reqs.length ? reqs : 'none');

  const enter = await page.$('#companionModeBtn');
  await enter.click();
  await page.waitForTimeout(4000);
  const opened = await page.evaluate(() => ({
    diag: window.Live2DCompanion.getRendererDiagnostic(),
    fallbackHidden: (document.getElementById('companionGifFallback') || {}).hidden,
    canvas: (() => { const c = document.getElementById('companionLive2DCanvas'); return c ? [c.width, c.height, c.isConnected] : null; })()
  }));
  console.log('B. companion open (model OK):', JSON.stringify(opened));
  console.log('   gif state:', JSON.stringify(await gifState()));

  // 强制错误路径：让模型地址失效，触发 L2D_LOAD_FAILED -> fallback 显示
  await page.evaluate(() => {
    window.__origAssetUrl = null;
    const M = window.Live2DModelManager;
    const cur = M.current();
    if (cur) cur.entry_file = 'missing.model.json';
  });
  await page.evaluate(() => window.Live2DCompanion.reloadModel());
  await page.waitForTimeout(3500);
  const failed = await page.evaluate(() => ({
    diag: window.Live2DCompanion.getRendererDiagnostic().split('\n')[0],
    fallbackHidden: (document.getElementById('companionGifFallback') || {}).hidden
  }));
  console.log('C. forced failure:', JSON.stringify(failed));
  console.log('   gif state:', JSON.stringify(await gifState()));
  console.log('   gif requests total:', reqs.length ? reqs : 'none');

  await b.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
