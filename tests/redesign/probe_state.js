/* eslint-disable */
/**
 * 一次性探针：确认首屏默认状态（欢迎层是否可见、磁贴显隐、图表是否渲染、溢出）。
 * 不修改 DOM，只读。
 *
 * 用法: node tests/redesign/probe_state.js <baseUrl> [theme]
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
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
    await page.addInitScript(function (v) {
        try { localStorage.setItem('memo_ui_style', v); } catch (e) {}
        try { localStorage.setItem('theme', 'light'); } catch (e) {}
    }, theme);
    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3000);
    const info = await page.evaluate(function () {
        const out = {};
        out.dataUiStyle = document.documentElement.getAttribute('data-ui-style');
        out.bodyClass = document.body.className;
        out.dashboardClass = document.getElementById('dashboard').className;
        out.welcome = (function () {
            const el = document.getElementById('welcomeOverlay');
            if (!el) return 'missing';
            const cs = getComputedStyle(el);
            return { className: el.className, display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
                     rect: el.getBoundingClientRect().toJSON() };
        })();
        out.settingsPanel = (function () {
            const el = document.getElementById('settingsPanel');
            const cs = getComputedStyle(el);
            return { className: el.className, display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
                     ariaHidden: el.getAttribute('aria-hidden') };
        })();
        out.tiles = Array.prototype.map.call(document.querySelectorAll('.tile'), function (t) {
            const r = t.getBoundingClientRect();
            const body = t.querySelector('.tile-body');
            const cc = t.querySelector('.chart-container');
            return {
                index: t.dataset.tile,
                display: getComputedStyle(t).display,
                inlineDisplay: t.style.display || '(none set)',
                rect: [Math.round(r.width), Math.round(r.height)],
                selectorValue: t.querySelector('.chart-selector') && t.querySelector('.chart-selector').value,
                title: (t.querySelector('.tile-title') || {}).textContent,
                chartInnerLen: cc ? cc.innerHTML.length : -1,
                canvas: cc ? cc.querySelectorAll('canvas').length : -1,
                canvasSize: cc && cc.querySelector('canvas')
                    ? [cc.querySelector('canvas').width, cc.querySelector('canvas').height] : null,
                iframe: cc ? cc.querySelectorAll('iframe').length : -1,
                iframeSrc: cc && cc.querySelector('iframe') ? cc.querySelector('iframe').src : null
            };
        });
        out.overflow = {
            docScrollW: document.documentElement.scrollWidth,
            docClientW: document.documentElement.clientWidth,
            bodyScrollW: document.body.scrollWidth,
            bodyClientW: document.body.clientWidth
        };
        out.themeBtnHidden = (function () {
            const b = document.getElementById('themeBtn');
            if (!b) return 'missing';
            const cs = getComputedStyle(b);
            return { hidden: b.hidden, display: cs.display, ariaHidden: b.getAttribute('aria-hidden') };
        })();
        out.visibleButtons = Array.prototype.slice.call(document.querySelectorAll('.topbar button, .tile button'))
            .filter(function (b) { return b.getBoundingClientRect().width > 0; })
            .map(function (b) { return (b.id || b.className) + '|' + (b.title || ''); }).slice(0, 30);
        return out;
    });
    console.log(JSON.stringify({ theme: theme, base: base, info: info, errors: errors }, null, 2));
    await browser.close();
})();
