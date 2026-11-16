/* eslint-disable */
/**
 * 验证系统字体可用性 —— 第二版。
 *
 * 第一版用 CJK 文本宽度判断，**方法是错的**：中文是全角等宽字形，
 * 12 个字每个 1em，任何字体都得到同一个宽度，全都显示"未生效"。
 * 正确做法用 `document.fonts.check()`，并用一个绝不存在的名字做阴性对照。
 *
 * 同时对拉丁文本测宽度作为交叉验证（拉丁字宽随字体不同而变化）。
 */
'use strict';

const { chromium } = require('playwright');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const CANDIDATES = [
    'Noto Serif SC',
    'Source Han Serif SC',
    'Songti SC',
    'SimSun',
    'KaiTi',
    'STSong',
    'MingLiU',
    'Georgia',
    'Times New Roman',
    'Bahnschrift',
    'DIN Alternate',
    'Segoe UI',
    'Microsoft YaHei',
    'Consolas',
    // 阴性对照：这个名字不可能存在
    'NoSuchFontXYZ123'
];

(async () => {
    const browser = await chromium.launch({ executablePath: EDGE });
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');

    const result = await page.evaluate(function (families) {
        function latinWidth(family) {
            const span = document.createElement('span');
            span.style.cssText =
                'position:absolute;visibility:hidden;white-space:pre;font-size:40px;' +
                'font-family:"' + family + '",monospace;';
            span.textContent = 'MMMMMWWWWWiiiii';
            document.body.appendChild(span);
            const w = span.getBoundingClientRect().width;
            document.body.removeChild(span);
            return w;
        }

        // monospace 基准
        const span = document.createElement('span');
        span.style.cssText =
            'position:absolute;visibility:hidden;white-space:pre;font-size:40px;font-family:monospace;';
        span.textContent = 'MMMMMWWWWWiiiii';
        document.body.appendChild(span);
        const monoBase = span.getBoundingClientRect().width;
        document.body.removeChild(span);

        return {
            monoBase: +monoBase.toFixed(2),
            rows: families.map(function (name) {
                let check = null;
                try {
                    check = document.fonts.check('16px "' + name + '"');
                } catch (e) {
                    check = 'error';
                }
                const w = latinWidth(name);
                return {
                    family: name,
                    fontsCheck: check,
                    latinWidth: +w.toFixed(2),
                    differsFromMono: Math.abs(w - monoBase) > 0.5
                };
            })
        };
    }, CANDIDATES);

    console.log('monospace 基准宽度 =', result.monoBase);
    console.log();
    console.log('family'.padEnd(24), 'fonts.check', '拉丁宽度', '与基准不同');
    for (const row of result.rows) {
        console.log(
            row.family.padEnd(24),
            String(row.fontsCheck).padEnd(12),
            String(row.latinWidth).padStart(10),
            row.differsFromMono ? 'YES' : 'no'
        );
    }

    await browser.close();
})();