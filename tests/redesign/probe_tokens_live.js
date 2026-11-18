/* eslint-disable */
/**
 * 验证令牌文件在真实浏览器里"能生效"且"不泄漏到禁区主题"。
 *
 * 为什么必须验证：CSS 语法错误、作用域写错、加载顺序错，都会让令牌静默失效——
 * 页面看起来"没变化"，但没有任何报错。这类失败只能靠量测发现。
 *
 * 方法：临时在页面里追加 <link> 指向令牌文件（**只改运行时 DOM，不改源码**），
 * 然后读 `getComputedStyle` 确认变量确实被解析。
 */
'use strict';

const { chromium } = require('playwright');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const TOKENS = '/css/theme-constructivist-tokens.css';

async function probe(page, label) {
    return page.evaluate(function (tokenHref) {
        return new Promise(function (resolve) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = tokenHref;
            link.onload = function () {
                const root = document.documentElement;
                const computedRoot = getComputedStyle(root);
                const body = document.body;
                const computedBody = getComputedStyle(body);

                // 关键：变量是否真的解析出来了
                const vars = [
                    '--c-paper', '--c-ink', '--c-vermilion',
                    '--f-display', '--f-serif', '--f-num',
                    '--fs-4xl', '--sp-9', '--rule-heavy', '--shadow-hard'
                ];
                const values = {};
                for (const v of vars) {
                    values[v] = computedRoot.getPropertyValue(v).trim();
                }

                // 用一个探针元素验证 font-family 真的应用了
                const probeEl = document.createElement('div');
                probeEl.style.fontFamily = 'var(--f-display)';
                probeEl.style.fontSize = 'var(--fs-2xl)';
                probeEl.style.color = 'var(--c-vermilion)';
                probeEl.textContent = 'x';
                document.body.appendChild(probeEl);
                const probeComputed = getComputedStyle(probeEl);
                const result = {
                    dataUiStyle: root.getAttribute('data-ui-style'),
                    varCount: Object.keys(values).filter(function (k) { return values[k]; }).length,
                    values: values,
                    probeFontFamily: probeComputed.fontFamily,
                    probeFontSize: probeComputed.fontSize,
                    probeColor: probeComputed.color,
                    bodyBgApplied: computedBody.backgroundColor,
                    bodyFontApplied: computedBody.fontFamily
                };
                probeEl.remove();
                link.remove();
                resolve(result);
            };
            link.onerror = function () { resolve({ error: 'link load failed' }); };
            document.head.appendChild(link);
        });
    }, TOKENS);
}

(async () => {
    const base = process.argv[2];
    const browser = await chromium.launch({ executablePath: EDGE });

    for (const theme of ['standard', 'notebook']) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await context.newPage();
        await page.addInitScript(function (value) {
            try { localStorage.setItem('memo_ui_style', value); } catch (e) {}
        }, theme);
        await page.goto(base, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(1200);

        const result = await probe(page, theme);
        console.log('======== ' + theme + ' ========');
        console.log('  data-ui-style    :', result.dataUiStyle);
        console.log('  解析出的变量数    :', result.varCount, '/ 10');
        console.log('  --c-paper        :', JSON.stringify(result.values['--c-paper']));
        console.log('  --c-ink          :', JSON.stringify(result.values['--c-ink']));
        console.log('  --c-vermilion    :', JSON.stringify(result.values['--c-vermilion']));
        console.log('  --f-display      :', JSON.stringify(result.values['--f-display']));
        console.log('  --f-num          :', JSON.stringify(result.values['--f-num']));
        console.log('  --fs-4xl         :', JSON.stringify(result.values['--fs-4xl']));
        console.log('  --sp-9           :', JSON.stringify(result.values['--sp-9']));
        console.log('  探针 font-family :', result.probeFontFamily);
        console.log('  探针 font-size   :', result.probeFontSize);
        console.log('  探针 color       :', result.probeColor);
        console.log('  body 背景        :', result.bodyBgApplied);
        console.log('  body 字体        :', String(result.bodyFontApplied).slice(0, 60));

        // 判据：standard 必须全部解析；notebook 必须全部解析为空（不泄漏）
        if (theme === 'standard') {
            console.log('  >>> 期望：10/10 变量解析成功、探针颜色为朱色');
        } else {
            console.log('  >>> 期望：0/10 变量（不泄漏）、body 背景保持手账纸色');
        }

        await context.close();
    }

    await browser.close();
})();