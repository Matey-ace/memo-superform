// D 桌面资源 —— 渲染器可行性探针。
// 目的：确认在未修改的页面/资源上，真实 Live2D 渲染器能加载并持续出帧，
// 否则"前后台测量"无从谈起。不修改任何应用文件。
const { chromium } = require('playwright');

const URL = process.argv[2];
if (!URL) { console.error('usage: probe.js <url>'); process.exit(2); }

(async () => {
  // 桌面版 pywebview 使用 WebView2（Edge/Chromium 内核）。用本机 msedge
  // 与真实运行时同一套 Blink + WebGL 栈，比 Playwright 自带 Chromium 更贴近。
  const browser = await chromium.launch({
    headless: false,
    channel: 'msedge',
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });

  // 记录 rAF 频率与 ticker 状态
  await page.evaluate(() => {
    window.__probe = { frames: 0, t0: performance.now() };
    const raf = window.requestAnimationFrame.bind(window);
    // 只观测，不替换真实的 rAF 实现
    const tick = () => { window.__probe.frames++; raf(tick); };
    raf(tick);
  });

  const btn = await page.$('#companionModeBtn');
  console.log('companionModeBtn present:', !!btn);
  if (btn) { await btn.click(); }

  await page.waitForTimeout(6000);

  const state = await page.evaluate(() => {
    const C = window.Live2DCompanion;
    const L = window.Live2DModelManager;
    const canvas = document.getElementById('companionLive2DCanvas');
    const host = document.getElementById('companionLive2DHost');
    const shared = window.PIXI && window.PIXI.Ticker && window.PIXI.Ticker.shared;
    return {
      isOpen: C && C.isOpen ? C.isOpen() : null,
      diagnostic: C && C.getRendererDiagnostic ? C.getRendererDiagnostic() : null,
      modelLabel: (document.getElementById('companionModelName') || {}).textContent || '',
      fallbackHidden: (document.getElementById('companionGifFallback') || {}).hidden,
      hostSize: host ? [host.clientWidth, host.clientHeight] : null,
      canvasSize: canvas ? [canvas.width, canvas.height] : null,
      hasWebGL: !!(canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'))),
      currentModel: L && L.current ? (L.current() || {}).model_id : null,
      pixiVersion: window.PIXI ? window.PIXI.VERSION : null,
      ticker: shared ? {
        started: shared.started,
        count: shared.count,
        deltaMS: shared.deltaMS,
        FPS: shared.FPS,
        _protected: shared._protected,
        autoStart: shared.autoStart,
        head: (function () { let n = 0, h = shared._head; while (h && h.next) { n++; h = h.next; } return n; })()
      } : null,
      hidden: document.hidden,
      visibilityState: document.visibilityState,
      frames: window.__probe.frames,
      elapsedMs: performance.now() - window.__probe.t0
    };
  });

  state.probeFps = state.frames / (state.elapsedMs / 1000);
  console.log(JSON.stringify(state, null, 2));
  console.log('pageErrors:', errors.length ? errors.slice(0, 10) : 'none');

  await browser.close();
})().catch(e => { console.error('PROBE_FAILED', e); process.exit(1); });
