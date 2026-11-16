/* eslint-disable */
/**
 * 量测字体栈的实际渲染宽度，用来确定 `--f-display` / `--f-serif` / `--f-num`。
 *
 * 为什么必须量测：字体名写错时浏览器静默回退，页面看起来"正常"但完全不是雕版风格。
 * 用 canvas measureText 比较宽度，宽度与回退链末端相同 = 该字体没生效。
 */
'use strict';

const { chromium } = require('playwright');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

(async () => {
    const browser = await chromium.launch({ executablePath: EDGE });
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');

    const data = await page.evaluate(function () {
        function measure(family, text, weight, size) {
            const canvas = document.createElement('canvas').getContext('2d');
            canvas.font = weight + ' ' + size + 'px ' + family;
            return +canvas.measureText(text).width.toFixed(2);
        }

        const CJK = '\u58A8\u58A8\u6570\u636E\u78C1\u8D34'; // 墨墨数据磁贴
        const LATIN = 'Renaissance Serif 0123';
        const NUM = '0123456789';

        const candidates = {
            'serif 基准': 'serif',
            'sans-serif 基准': 'sans-serif',
            'Noto Serif SC': '"Noto Serif SC", serif',
            'SimSun': 'SimSun, serif',
            'KaiTi': 'KaiTi, serif',
            'STSong': 'STSong, serif',
            'Georgia': 'Georgia, serif',
            'Times New Roman': '"Times New Roman", serif',
            'Bahnschrift': 'Bahnschrift, sans-serif',
            'Consolas': 'Consolas, monospace',
            '不存在字体(阴性)': '"NoSuchFontXYZ123", serif'
        };

        const out = {};
        for (const name of Object.keys(candidates)) {
            const family = candidates[name];
            out[name] = {
                cjkBold: measure(family, CJK, 700, 40),
                latin: measure(family, LATIN, 400, 40),
                digits: measure(family, NUM, 400, 40)
            };
        }
        return out;
    });

    const names = Object.keys(data);
    console.log('字体'.padEnd(22), 'CJK粗体'.padStart(10), '拉丁'.padStart(10), '数字'.padStart(10));
    for (const name of names) {
        const row = data[name];
        console.log(
            name.padEnd(22),
            String(row.cjkBold).padStart(10),
            String(row.latin).padStart(10),
            String(row.digits).padStart(10)
        );
    }

    console.log();
    console.log('--- 判读 ---');
    const fallback = data['不存在字体(阴性)'];
    for (const name of names) {
        if (name.indexOf('基准') >= 0 || name.indexOf('阴性') >= 0) continue;
        const row = data[name];
        const resolved = Math.abs(row.latin - fallback.latin) > 0.5 ||
                         Math.abs(row.digits - fallback.digits) > 0.5;
        console.log((resolved ? '生效  ' : '未生效') + '  ' + name);
    }

    await browser.close();
})();