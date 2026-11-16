'use strict';
// Read-only capture after the user confirms manual login. No credential values,
// cookies, storage, HTML source, authentication URLs, or answer actions are read.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9337');
    const page = browser.contexts()[0].pages()[0];
    const label = process.argv[2] || 'authenticated-home';
    if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid evidence label');
    const out = path.resolve('docs/redesign/baseline', label);
    if (fs.existsSync(out)) throw new Error('Refusing to overwrite existing evidence');
    const frame = page.frames().find(f => f !== page.mainFrame());
    if (!frame) throw new Error('No study iframe');
    if (await frame.locator('input[type="password"]:visible').count()) {
        throw new Error('Login form still visible: screenshot refused');
    }
    fs.mkdirSync(out, { recursive: true });
    const rows = [];
    for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080]]) {
        await page.setViewportSize({ width, height });
        const state = await frame.evaluate(() => ({
            htmlClass: document.documentElement.className,
            bodyClass: document.body.className,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            reviewRoots: document.querySelectorAll('.rev-root').length,
            taroPages: document.querySelectorAll('.taro_page').length,
            skinLinks: [...document.querySelectorAll('link[id^="memo-"]')].map(l => ({
                id: l.id, path: (l.getAttribute('href') || '').split('?')[0]
            })),
            reviewElements: Object.fromEntries(['.rev-root', '.rev-top', '.rev-recall-mask', '.interp-ctn', '.rev-bottom', '.rev-resp-btns'].map(selector => {
                const el = document.querySelector(selector);
                if (!el) return [selector, null];
                const r = el.getBoundingClientRect(), s = getComputedStyle(el);
                return [selector, { visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden',
                    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
                    color: s.color, background: s.backgroundColor, font: s.fontFamily }];
            })),
            visibleControls: [...document.querySelectorAll('button,[role="button"],.rev-resp-btns > *')]
                .filter(el => el.getBoundingClientRect().width > 0)
                .map(el => {
                    const r = el.getBoundingClientRect();
                    return { tag: el.tagName, className: el.className,
                        text: (el.textContent || '').trim().slice(0, 60),
                        rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
                }).slice(0, 80),
            structure: [...document.querySelectorAll('body *')]
                .filter(el => !['SCRIPT', 'STYLE', 'LINK', 'META'].includes(el.tagName))
                .slice(0, 160).map(el => ({ tag: el.tagName, className: el.className }))
        }));
        const file = label + '@standard@' + width + 'x' + height + '.png';
        await page.screenshot({ path: path.join(out, file) });
        rows.push({ file, width, height, state });
    }
    fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({
        userConfirmedLogin: true,
        label,
        actions: 'Read-only capture of the user-selected state; no answer or content-save actions',
        note: 'State is evidenced by visible elements, not inferred from the label; not proof of the complete learning workflow', rows
    }, null, 2));
    console.log(JSON.stringify({ captures: rows.length,
        reviewRoots: rows.map(r => r.state.reviewRoots),
        taroPages: rows.map(r => r.state.taroPages),
        htmlClasses: rows.map(r => r.state.htmlClass) }));
    // Exiting detaches this CDP client; do not close the user's browser.
    process.exit(0);
})().catch(error => { console.error('Authenticated capture failed:', error.name, error.message.replace(/https?:\/\/\S+/g, '[URL]')); process.exit(1); });
