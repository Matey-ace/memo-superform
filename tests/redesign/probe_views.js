/* eslint-disable */
/**
 * 探针：设置面板 + 8 种图表选项 是否都能真实渲染。
 *
 * 这决定 SA-2 能拍到多少视图。如果某个图表选项点了没反应或报错，
 * 必须在基线里如实记录，而不是假装拍到了。
 */
'use strict';

const { chromium } = require('playwright');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const CHARTS = ['heatmap', 'trend', 'memory', 'aiclass', 'notepad', 'growth', 'recommend'];

(async () => {
    const base = process.argv[2];
    const browser = await chromium.launch({ executablePath: EDGE });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const errors = [];
    page.on('pageerror', function (e) { errors.push('pageerror: ' + String(e).slice(0, 160)); });
    page.on('console', function (m) {
        if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160));
    });

    await page.addInitScript(function () {
        try { localStorage.setItem('memo_ui_style', 'standard'); } catch (e) {}
    });
    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2200);

    console.log('=== 逐图表选项渲染检查 ===');
    const selector = page.locator('.tile:not([style*="display: none"]) .chart-selector').first();

    for (const chart of CHARTS) {
        const before = errors.length;
        try {
            await selector.selectOption(chart);
            await selector.dispatchEvent('change');
        } catch (e) {
            console.log('  ' + chart.padEnd(10) + ' 选择失败: ' + String(e).slice(0, 90));
            continue;
        }
        await page.waitForTimeout(1600);

        const info = await page.evaluate(function () {
            const container = document.querySelector('.tile:not([style*="display: none"]) .chart-container');
            const canvas = container && container.querySelector('canvas');
            const svg = container && container.querySelector('svg');
            return {
                hasCanvas: !!canvas,
                canvasW: canvas ? canvas.width : 0,
                canvasH: canvas ? canvas.height : 0,
                hasSvg: !!svg,
                textLen: container ? (container.innerText || '').trim().length : -1,
                // ECharts 实例是否挂上（读内部属性是只读探测，不改变状态）
                echartsAttached: !!(container && container.getAttribute('_echarts_instance_'))
            };
        });
        const newErrors = errors.length - before;
        console.log('  ' + chart.padEnd(10) +
            ' canvas=' + (info.hasCanvas ? info.canvasW + 'x' + info.canvasH : 'no') +
            ' svg=' + info.hasSvg +
            ' text=' + info.textLen +
            ' echarts=' + info.echartsAttached +
            ' newErr=' + newErrors);
    }

    // 设置面板
    console.log('=== 设置面板 ===');
    await page.click('#settingsBtn').catch(function (e) { console.log('  点击失败:', String(e).slice(0, 80)); });
    await page.waitForTimeout(1200);

    const panel = await page.evaluate(function () {
        // 找刚出现的、覆盖层或面板
        const candidates = [];
        document.querySelectorAll('body *').forEach(function (el) {
            if (el.offsetWidth < 200 || el.offsetHeight < 150) return;
            const style = getComputedStyle(el);
            const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            if (!visible) return;
            if (el.offsetParent === null && style.position !== 'fixed') return;
            const zIndex = parseInt(style.zIndex, 10);
            const isOverlay = style.position === 'fixed' || style.position === 'absolute' || zIndex > 10;
            if (!isOverlay) return;
            if (el.classList.contains('topbar') || el.id === 'dashboard') return;
            candidates.push({
                tag: el.tagName, id: el.id || '', cls: (el.className || '').toString().slice(0, 60),
                w: el.offsetWidth, h: el.offsetHeight, position: style.position, zIndex: style.zIndex,
                textLen: (el.innerText || '').trim().length
            });
        });
        return { candidates: candidates.slice(0, 12), total: candidates.length };
    });
    console.log('  候选面板数:', panel.total);
    for (const c of panel.candidates) {
        console.log('   ', c.tag, '| id=' + c.id, '| cls=' + c.cls, '| ' + c.w + 'x' + c.h, '| pos=' + c.position, '| text=' + c.textLen);
    }

    console.log('=== 累计错误 ===');
    if (!errors.length) console.log('  无');
    for (const e of errors.slice(0, 15)) console.log('  ' + e);

    await browser.close();
})();