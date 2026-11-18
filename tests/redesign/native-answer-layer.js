'use strict';
// Synthetic interaction fixture: never opens the user's logged-in browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const themes = JSON.parse(execFileSync('python', ['-c',
    'import runpy,json;print(json.dumps([runpy.run_path(p)["MEMO_STUDY_THEME"] for p in ["memo_injection.py","docs/redesign/source-before/memo_injection.py"]]))'
], { cwd: root, encoding: 'utf8' }));
const files = ['study-web.css', 'study-web-standard.css', 'theme-constructivist-tokens.css', 'theme-constructivist-components.css'];
const css = Object.fromEntries([...files, 'maimemo-standard.css'].map(f => [f, fs.readFileSync(path.join(root, 'css', f), 'utf8')]));
const server = http.createServer((req, res) => {
    if (req.url.startsWith('/css/')) {
        res.setHeader('Content-Type', 'text/css');
        return res.end(css[req.url.slice(5).split('?')[0]] || '');
    }
    if (req.url.startsWith('/frame')) {
        return res.end('<!doctype html><html><head><style>html,body{margin:0;height:100%}.rev-resp-btns{position:absolute;bottom:0;left:0;right:0;display:flex;height:64px}.rev-resp-btns button{width:33.333%;height:64px}.native-guide{position:absolute;inset:0;background:white;z-index:500}.native-guide button{position:absolute;bottom:85px;left:40%;width:20%;height:40px}</style>' +
            themes[req.url.includes('original') ? 1 : 0] + '</head><body>' +
            '<div class="rev-root"><div class="rev-top">example</div><div class="rev-resp-btns"><button>A</button><button>B</button><button>C</button></div></div>' +
            '<div class="native-guide"><button id="native-close">Close shortcuts</button></div>' +
            '<script>window.answers=0;window.closes=0;document.querySelectorAll(".rev-resp-btns button").forEach(b=>b.onclick=()=>window.answers++);document.querySelector("#native-close").onclick=()=>{window.closes++;document.querySelector(".native-guide").hidden=true}</script></body></html>');
    }
    res.end('<!doctype html><html data-ui-style="standard"><head>' + files.map(f => '<link rel="stylesheet" href="/css/' + f + '">').join('') +
        '</head><body class="standard-mode"><main id="dashboard" style="position:absolute;inset:0"><div class="study-web-container">' +
        '<iframe title="Native study" class="study-web-iframe" src="/frame"></iframe><div class="study-web-actions"><button class="study-web-btn">Duplicate A</button><button class="study-web-btn">Duplicate B</button><button class="study-web-btn">Duplicate C</button></div></div></main></body></html>');
});
(async () => {
    let browser, count = 0;
    const check = (actual, expected) => { assert.deepEqual(actual, expected); count++; };
    try {
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
        for (const [width, height] of [[1280,800], [1440,900], [1920,1080]]) for (const dark of [false,true]) {
            const page = await browser.newPage({ viewport: { width, height } });
            const errors = []; page.on('pageerror', e => errors.push(e.message));
            await page.goto('http://127.0.0.1:' + server.address().port);
            if (dark) await page.evaluate(() => document.body.classList.add('dark'));
            const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
            await frame.waitForFunction(() => document.documentElement.classList.contains('memo-main-redesign'));
            check(await page.locator('.study-web-actions').isVisible(), false);
            const nativeRects = () => frame.locator('.rev-resp-btns button').evaluateAll(nodes => nodes.map(b => {
                const r = b.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, text:b.textContent };
            }));
            const before = await nativeRects();
            check(await frame.locator('.rev-resp-btns button').count(), 3);
            const close = await frame.locator('#native-close').boundingBox();
            check(await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.tagName,
                {x:close.x+close.width/2,y:close.y+close.height/2}), 'IFRAME');
            await frame.locator('#native-close').click();
            check(await frame.evaluate(() => [window.closes,window.answers]), [1,0]);
            await frame.locator('.rev-resp-btns button').nth(0).click();
            check(await frame.evaluate(() => [window.closes,window.answers]), [1,1]);
            await frame.goto('http://127.0.0.1:' + server.address().port + '/frame?original');
            check(await nativeRects(), before);
            await page.evaluate(() => {
                const modal = document.createElement('div');
                modal.id = 'fullscreenModal';
                modal.style.cssText = 'position:absolute;inset:0';
                document.body.appendChild(modal);
                modal.appendChild(document.querySelector('.study-web-container'));
            });
            const fullscreenFrame = page.frameLocator('#fullscreenModal iframe');
            await fullscreenFrame.locator('#native-close').waitFor({ state:'visible' });
            check(await page.locator('#fullscreenModal .study-web-actions').isVisible(), false);
            const fullscreenClose = await fullscreenFrame.locator('#native-close').boundingBox();
            check(await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.tagName,
                {x:fullscreenClose.x+fullscreenClose.width/2,y:fullscreenClose.y+fullscreenClose.height/2}), 'IFRAME');
            await fullscreenFrame.locator('#native-close').click();
            check(await fullscreenFrame.locator('.rev-root').evaluate(() => [window.closes,window.answers]), [1,0]);
            check(await fullscreenFrame.locator('.rev-resp-btns button').count(), 3);
            await page.evaluate(() => document.body.classList.add('companion-mode'));
            check(await page.locator('.study-web-actions').isVisible(), true);
            await page.evaluate(() => {
                document.body.classList.remove('companion-mode');
                document.documentElement.setAttribute('data-ui-style','notebook');
            });
            check(await page.locator('.study-web-actions').isVisible(), true);
            check(errors, []);
            await page.close();
        }
        console.log('NATIVE_ANSWER_LAYER_PASS', count);
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(e => { console.error(e); process.exitCode=1; });
