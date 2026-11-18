/* eslint-disable */
/**
 * 探针：验证"真实用户路径"能否把欢迎层收掉并让磁贴/图表渲染出来。
 * 只用真实点击，不改 DOM、不加样式。
 *
 * 用法: node tests/redesign/probe_path.js <baseUrl> [theme]
 */
'use strict';

const { chromium } = require('playwright');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

async function snapshot(page, label) {
    const s = await page.evaluate(function () {
        const w = document.getElementById('welcomeOverlay');
        const sp = document.getElementById('settingsPanel');
        return {
            welcome: { className: w.className, display: getComputedStyle(w).display },
            settings: { className: sp.className, display: getComputedStyle(sp).display,
                        ariaHidden: sp.getAttribute('aria-hidden') },
            tiles: Array.prototype.map.call(document.querySelectorAll('.tile'), function (t) {
                const cc = t.querySelector('.chart-container');
                return {
                    i: t.dataset.tile,
                    display: getComputedStyle(t).display,
                    innerLen: cc ? cc.innerHTML.length : -1,
                    canvas: cc ? cc.querySelectorAll('canvas').length : -1,
                    iframeSrc: cc && cc.querySelector('iframe') ? cc.querySelector('iframe').src : null,
                    text: cc ? (cc.innerText || '').replace(/\s+/g, ' ').slice(0, 80) : ''
                };
            }),
            serverStatus: (document.getElementById('serverStatus') || {}).textContent,
            scrollW: document.documentElement.scrollWidth,
            clientW: document.documentElement.clientWidth
        };
    });
    console.log('== ' + label + ' ==');
    console.log(JSON.stringify(s, null, 2));
    return s;
}

(async () => {
    const base = process.argv[2];
    const theme = process.argv[3] || 'standard';
    const browser = await chromium.launch({ executablePath: EDGE });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
    page.on('dialog', async (d) => { errors.push('dialog: ' + d.type() + ' ' + d.message().slice(0, 120)); await d.dismiss(); });

    await page.addInitScript(function (v) {
        try { localStorage.setItem('memo_ui_style', v); } catch (e) {}
        try { localStorage.setItem('theme', 'light'); } catch (e) {}
    }, theme);

    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3000);
    await snapshot(page, 'A 首屏');

    // 真实点击：欢迎层上的"去设置 ->"
    await page.click('#welcomeSettingsBtn');
    await page.waitForTimeout(1500);
    await snapshot(page, 'B 点过去设置');

    // 真实点击：关闭设置
    await page.click('#closeSettings');
    await page.waitForTimeout(800);
    await snapshot(page, 'C 关闭设置后');

    // 真实点击：刷新数据
    await page.click('#refreshBtn');
    await page.waitForTimeout(6000);
    await snapshot(page, 'D 点过刷新');

    console.log('errors:', JSON.stringify(errors, null, 2));
    await browser.close();
})();
