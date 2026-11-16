/* eslint-disable */
/**
 * 探针：主主题暗色模式 + 布局切换 是否可被真实点击驱动。
 *
 * 目的：SA-2 要拍这些状态，必须确认它们**真的可以由用户操作进入**，
 * 而不是靠改 DOM。如果只能靠改内部变量进入，那拍出来的基线就不代表用户所见。
 */
'use strict';

const { chromium } = require('playwright');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

(async () => {
    const base = process.argv[2];
    const browser = await chromium.launch({ executablePath: EDGE });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const errors = [];
    page.on('pageerror', function (e) { errors.push(String(e).slice(0, 200)); });

    await page.addInitScript(function () {
        try { localStorage.setItem('memo_ui_style', 'standard'); } catch (e) {}
    });

    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 1. 找出所有顶栏控件
    const controls = await page.evaluate(function () {
        const out = [];
        document.querySelectorAll('.topbar button, .topbar select, .topbar input').forEach(function (el) {
            out.push({
                tag: el.tagName,
                id: el.id || '',
                cls: el.className || '',
                title: el.getAttribute('title') || '',
                text: (el.textContent || '').trim().slice(0, 20),
                visible: !!(el.offsetWidth || el.offsetHeight)
            });
        });
        return out;
    });
    console.log('=== 顶栏控件 ===');
    for (const c of controls) {
        console.log(' ', c.tag, '| id=' + c.id, '| cls=' + c.cls, '| title=' + c.title, '| visible=' + c.visible);
    }

    // 2. 尝试真实点击切换暗色
    const darkBtn = page.locator('.topbar button').filter({ hasText: /暗|dark|月亮|🌙/ }).first();
    const themeToggleCandidates = await page.evaluate(function () {
        const found = [];
        document.querySelectorAll('button, [role=button], .icon-btn, .theme-toggle').forEach(function (el) {
            const t = (el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '');
            if (/主题|暗|深色|夜间|theme|dark|mode/i.test(t)) {
                found.push({
                    id: el.id || '',
                    cls: el.className || '',
                    label: t.trim().slice(0, 40),
                    visible: !!(el.offsetWidth || el.offsetHeight)
                });
            }
        });
        return found;
    });
    console.log('=== 主题相关控件 ===');
    for (const c of themeToggleCandidates) {
        console.log(' ', c.cls || c.id, '| label=' + c.label, '| visible=' + c.visible);
    }

    // 3. 布局切换按钮
    const layoutBtns = await page.evaluate(function () {
        return Array.prototype.slice.call(document.querySelectorAll('.layout-btn')).map(function (el) {
            return { text: (el.textContent || '').trim(), cls: el.className, visible: !!(el.offsetWidth || el.offsetHeight) };
        });
    });
    console.log('=== 布局按钮 ===');
    for (const b of layoutBtns) console.log(' ', JSON.stringify(b));

    // 4. 当前 body 状态
    const state = await page.evaluate(function () {
        return {
            bodyClass: document.body.className,
            dashboardClass: (document.querySelector('#dashboard') || {}).className || '',
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth
        };
    });
    console.log('=== 当前状态 ===', JSON.stringify(state));

    console.log('=== 页面错误 ===', errors.length ? errors : '无');
    await browser.close();
})();