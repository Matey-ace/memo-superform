/* eslint-disable */
/**
 * 基线 / 对比截图工具。
 *
 * 只通过 localStorage 切换主题，不触碰任何源码，因此可安全用于禁区主题的截图取证。
 *
 * 用法：
 *   node tests/redesign/capture.js --base <url> --out <dir> [--tag before|after]
 *
 * 产出：
 *   <out>/<view>@<theme>@<WxH>.png
 *   <out>/index.json   —— 每张图的尺寸、主题、加载的 CSS、页面错误
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        out[key] = argv[i + 1];
    }
    return out;
}

const RESOLUTIONS = [
    { w: 1280, h: 800 },
    { w: 1440, h: 900 },
    { w: 1920, h: 1080 }
];

// 主主题下需要取证的视图。切换靠真实点击顶栏/导航，不靠改 DOM。
const VIEWS = [
    { name: 'dashboard', setup: async () => {} }
];

async function collectState(page) {
    return page.evaluate(function () {
        const html = document.documentElement;
        return {
            dataUiStyle: html.getAttribute('data-ui-style'),
            bodyClasses: document.body.className,
            title: document.title,
            css: Array.prototype.slice.call(document.querySelectorAll('link[rel=stylesheet]'))
                .map(function (l) {
                    return {
                        id: l.getAttribute('id'),
                        href: (l.getAttribute('href') || '').split('?')[0]
                    };
                }),
            hidden: (function () {
                const blocked = [];
                document.querySelectorAll('[hidden]').forEach(function (n) {
                    blocked.push(n.id || n.className || n.tagName);
                });
                return blocked.slice(0, 20);
            })()
        };
    });
}

(async () => {
    const args = parseArgs(process.argv);
    if (!args.base || !args.out) {
        console.error('用法: node capture.js --base <url> --out <dir> [--tag before|after]');
        process.exit(2);
    }
    const tag = args.tag || 'shot';
    const outDir = path.resolve(args.out);
    fs.mkdirSync(outDir, { recursive: true });

    const browser = await chromium.launch({ executablePath: EDGE });
    const manifest = [];

    for (const theme of ['standard', 'notebook']) {
        for (const res of RESOLUTIONS) {
            const context = await browser.newContext({
                viewport: { width: res.w, height: res.h },
                deviceScaleFactor: 1
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', function (e) { errors.push(String(e).slice(0, 300)); });
            page.on('console', function (m) {
                if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200));
            });

            await page.addInitScript(function (value) {
                try { localStorage.setItem('memo_ui_style', value); } catch (e) {}
                try { localStorage.setItem('theme', 'light'); } catch (e) {}
            }, theme);

            await page.goto(args.base, { waitUntil: 'load', timeout: 30000 });
            // 等磁贴与图表首次渲染稳定。
            await page.waitForTimeout(2600);

            for (const view of VIEWS) {
                await view.setup(page);
                await page.waitForTimeout(400);
                const file = tag + '-' + view.name + '@' + theme + '@' + res.w + 'x' + res.h + '.png';
                await page.screenshot({ path: path.join(outDir, file), fullPage: false });
                const state = await collectState(page);
                manifest.push({
                    file: file,
                    view: view.name,
                    theme: theme,
                    width: res.w,
                    height: res.h,
                    state: state,
                    errors: errors.slice(0, 10)
                });
                console.log('shot', file, '| errors:', errors.length);
            }

            await context.close();
        }
    }

    fs.writeFileSync(path.join(outDir, 'index.json'),
        JSON.stringify({ tag: tag, base: args.base, shots: manifest }, null, 2));
    await browser.close();
    console.log('DONE', manifest.length, 'shots ->', outDir);
})();