/* eslint-disable */
/**
 * 验证主主题作用域选择器在真实渲染中确实命中，且不命中手账主题。
 *
 * 这是重设计的前置探针：如果 `html[data-ui-style="standard"]` 不能可靠区分两套主题，
 * 第 7 节的隔离规则就无法成立，必须回到第 17 节问用户。
 */
'use strict';

const { chromium } = require('playwright');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

(async () => {
    const base = process.argv[2];
    if (!base) {
        console.error('用法: node probe_scope.js <baseUrl>');
        process.exit(2);
    }

    const browser = await chromium.launch({ executablePath: EDGE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

    for (const style of ['standard', 'notebook']) {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

        await page.addInitScript(function (value) {
            try { localStorage.setItem('memo_ui_style', value); } catch (e) {}
            try { localStorage.setItem('theme', 'light'); } catch (e) {}
        }, style);

        await page.goto(base, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(1500);

        const state = await page.evaluate(function () {
            const html = document.documentElement;
            const body = document.body;
            return {
                dataUiStyle: html.getAttribute('data-ui-style'),
                htmlClasses: html.className,
                bodyClasses: body.className,
                title: document.title,
                // 作用域选择器的真实命中数
                scopeStandard: document.querySelectorAll('html[data-ui-style="standard"]').length,
                scopeNotebook: document.querySelectorAll('html[data-ui-style="notebook"]').length,
                // 关键 CSS 是否真的加载
                loadedCss: Array.prototype.slice.call(document.querySelectorAll('link[rel=stylesheet]'))
                    .map(function (l) { return l.getAttribute('id') + ' <- ' + (l.getAttribute('href') || '').split('?')[0]; }),
                // 页面骨架是否渲染
                tileCount: document.querySelectorAll('.tile').length,
                topbarVisible: !!document.querySelector('.topbar'),
                bodyBg: getComputedStyle(body).backgroundColor
            };
        });

        console.log('=== style=' + style + ' ===');
        console.log('  data-ui-style   :', state.dataUiStyle);
        console.log('  html classes    :', JSON.stringify(state.htmlClasses));
        console.log('  body classes    :', JSON.stringify(state.bodyClasses));
        console.log('  title           :', state.title);
        console.log('  scope standard  :', state.scopeStandard, '| scope notebook:', state.scopeNotebook);
        console.log('  tiles rendered  :', state.tileCount);
        console.log('  topbar present  :', state.topbarVisible);
        console.log('  body bg         :', state.bodyBg);
        console.log('  css links       :');
        for (const item of state.loadedCss) console.log('     ', item);
        if (errors.length) console.log('  PAGE ERRORS     :', errors);

        await page.close();
    }

    await context.close();
    await browser.close();
})();