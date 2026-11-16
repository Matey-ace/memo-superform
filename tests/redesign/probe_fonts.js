/* eslint-disable */
/**
 * 验证系统衬线字体在真实浏览器里能否解析。
 *
 * 为什么必须实测：`--f-display` 若落到不存在的字体，浏览器会静默回退到
 * sans-serif，界面看起来"没问题"但完全不是雕版风格。这类失败没有报错，
 * 只能靠量测字体宽度差异来发现。
 *
 * 方法：同一段文字用不同 font-family 渲染，比较宽度。宽度相同 = 回退到了同一字体。
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
    'Consolas'
];

(async () => {
    const browser = await chromium.launch({ executablePath: EDGE });
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');

    const result = await page.evaluate(function (families) {
        // 基准：一个几乎肯定存在的无衬线字体，用于识别"回退"
        const BASE = 'sans-serif';
        function widthOf(family, text, weight, size) {
            const span = document.createElement('span');
            span.style.cssText =
                'position:absolute;visibility:hidden;white-space:pre;font-size:' + size + 'px;' +
                'font-weight:' + weight + ';font-family:' + family + ';';
            span.textContent = text;
            document.body.appendChild(span);
            const width = span.getBoundingClientRect().width;
            document.body.removeChild(span);
            return width;
        }

        const cjk = '墨墨数据磁贴雕版排版测试';
        const latin = 'Memo Superform 0123456789';

        const baseCjk = widthOf(BASE, cjk, 400, 40);
        const baseLatin = widthOf(BASE, latin, 400, 40);

        const out = [];
        for (const family of families) {
            // 字体名含空格时必须加引号
            const quoted = '"' + family + '"';
            const cjkWidth = widthOf(quoted + ',' + BASE, cjk, 400, 40);
            const latinWidth = widthOf(quoted + ',' + BASE, latin, 400, 40);
            // 同时测"完全不给回退"的情况：如果真的不存在，会落到浏览器默认
            const bareCjk = widthOf(quoted, cjk, 400, 40);
            out.push({
                family: family,
                cjkDelta: +(cjkWidth - baseCjk).toFixed(2),
                latinDelta: +(latinWidth - baseLatin).toFixed(2),
                // 和基准宽度不同 = 这个字体真的生效了
                cjkResolved: Math.abs(cjkWidth - baseCjk) > 0.5,
                latinResolved: Math.abs(latinWidth - baseLatin) > 0.5,
                bareWidth: +bareCjk.toFixed(2)
            });
        }
        return { baseCjk: +baseCjk.toFixed(2), baseLatin: +baseLatin.toFixed(2), rows: out };
    }, CANDIDATES);

    console.log('基准 sans-serif 宽度: CJK=' + result.baseCjk + '  Latin=' + result.baseLatin);
    console.log();
    console.log('family'.padEnd(24), 'CJK生效', 'Latin生效', 'CJK宽度差', 'Latin宽度差');
    for (const row of result.rows) {
        console.log(
            row.family.padEnd(24),
            (row.cjkResolved ? 'YES' : 'no ').padEnd(8),
            (row.latinResolved ? 'YES' : 'no ').padEnd(10),
            String(row.cjkDelta).padStart(10),
            String(row.latinDelta).padStart(11)
        );
    }

    await browser.close();
})();