/* eslint-disable */
/**
 * 探针：通过真实点击布局按钮 + 选择图表，检查各图表是否真的渲染出画布。
 * 用法: node tests/redesign/probe_charts.js <baseUrl> [theme]
 */
'use strict';

const { chromium } = require('playwright');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

(async () => {
    const base = process.argv[2];
    const theme = process.argv[3] || 'standard';
    const browser = await chromium.launch({ executablePath: EDGE });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });
    page.on('dialog', async (d) => { errors.push('dialog: ' + d.message().slice(0, 100)); await d.dismiss(); });

    await page.addInitScript(function (v) {
        try { localStorage.setItem('memo_ui_style', v); } catch (e) {}
        try { localStorage.setItem('theme', 'light'); } catch (e) {}
    }, theme);
    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2500);

    // 真实点击：关掉欢迎层（点"去设置"再关掉设置），让仪表盘成为可交互状态
    await page.click('#welcomeSettingsBtn');
    await page.waitForTimeout(700);
    await page.click('#closeSettings');
    await page.waitForTimeout(700);

    // 真实点击：田字格布局，让 4 个磁贴同时可见
    await page.click('.layout-btn[data-layout="grid4"]');
    await page.waitForTimeout(2500);

    const afterLayout = await page.evaluate(function () {
        return Array.prototype.map.call(document.querySelectorAll('.tile'), function (t) {
            const cc = t.querySelector('.chart-container');
            return {
                i: t.dataset.tile,
                display: getComputedStyle(t).display,
                canvas: cc.querySelectorAll('canvas').length,
                innerLen: cc.innerHTML.length,
                text: (cc.innerText || '').replace(/\s+/g, ' ').slice(0, 100)
            };
        });
    });
    console.log('== 田字格后 ==');
    console.log(JSON.stringify(afterLayout, null, 2));

    // 逐个图表值：在磁贴 0 上切换
    const values = ['heatmap', 'trend', 'memory', 'aiclass', 'notepad', 'growth', 'recommend', 'study-web'];
    for (const v of values) {
        const sel = page.locator('.tile[data-tile="0"] .chart-selector');
        await sel.selectOption(v);
        await sel.dispatchEvent('change');
        await page.waitForTimeout(2200);
        const s = await page.evaluate(function () {
            const cc = document.querySelector('.tile[data-tile="0"] .chart-container');
            const fs = document.querySelector('.tile[data-tile="0"]').querySelector('.tile-fullscreen');
            return {
                title: document.querySelector('.tile[data-tile="0"] .tile-title').textContent,
                canvas: cc.querySelectorAll('canvas').length,
                canvasSize: cc.querySelector('canvas') ? [cc.querySelector('canvas').width, cc.querySelector('canvas').height] : null,
                innerLen: cc.innerHTML.length,
                iframe: cc.querySelectorAll('iframe').length,
                iframeSrc: cc.querySelector('iframe') ? cc.querySelector('iframe').src : null,
                text: (cc.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
                fullscreenBtnVisible: !!fs && fs.getBoundingClientRect().width > 0,
                toolbar: (document.querySelector('.tile[data-tile="0"] .chart-toolbar, .tile[data-tile="0"] .ai-toolbar') || {}).className || null,
                scrollW: document.documentElement.scrollWidth,
                clientW: document.documentElement.clientWidth
            };
        });
        console.log(v, JSON.stringify(s));
    }
    console.log('errors:', JSON.stringify(errors, null, 2));
    await browser.close();
})();
