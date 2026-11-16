'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
    const css = fs.readFileSync(path.resolve('css/theme-constructivist-tokens.css'), 'utf8');
    const browser = await chromium.launch({
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    });
    let checks = 0;
    const equal = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
    try {
        const page = await browser.newPage();
        await page.setContent('<!doctype html><html data-ui-style="standard"><head></head><body>' +
            '<div id="sample" class="memo-double-frame memo-rule-heavy">Main</div>' +
            '<div id="shadow" style="box-shadow:var(--shadow-hard)">Shadow</div>' +
            '<section id="companionStudy"><div id="excluded" class="memo-double-frame">Protected</div></section>' +
            '</body></html>');
        await page.addStyleTag({ content: css });
        const state = () => page.evaluate(() => {
            const root = getComputedStyle(document.documentElement);
            const body = getComputedStyle(document.body);
            const sample = getComputedStyle(document.querySelector('#sample'));
            return { rootInk: root.getPropertyValue('--c-ink').trim(),
                bodyInk: body.getPropertyValue('--c-ink').trim(),
                paper: body.getPropertyValue('--c-paper').trim(),
                heavy: body.getPropertyValue('--rule-heavy').trim(),
                shadow: getComputedStyle(document.querySelector('#shadow')).boxShadow,
                sampleBorder: sample.borderTopColor, sampleWidth: sample.borderTopWidth,
                excludedWidth: getComputedStyle(document.querySelector('#excluded')).borderTopWidth,
                duration: root.getPropertyValue('--dur-base').trim() };
        });
        let s = await state();
        equal(s.rootInk, '#1A1714'); equal(s.bodyInk, '#1A1714');
        equal(s.paper, '#EFE7D6'); equal(s.sampleBorder, 'rgb(26, 23, 20)');
        equal(s.shadow, 'rgb(26, 23, 20) 4px 4px 0px 0px');
        equal(s.sampleWidth, '2px'); equal(s.excludedWidth, '0px');
        await page.evaluate(() => document.body.classList.add('dark'));
        s = await state();
        equal(s.rootInk, '#ECE3CF'); equal(s.bodyInk, '#ECE3CF');
        equal(s.paper, '#16130F'); equal(s.sampleBorder, 'rgb(236, 227, 207)');
        equal(s.shadow, 'rgb(236, 227, 207) 4px 4px 0px 0px');
        equal(s.heavy, '2px solid #ECE3CF');
        await page.evaluate(() => document.body.classList.add('companion-mode'));
        s = await state();
        equal(s.rootInk, ''); equal(s.bodyInk, ''); equal(s.sampleWidth, '0px');
        await page.evaluate(() => document.body.classList.remove('companion-mode'));
        equal((await state()).rootInk, '#ECE3CF');
        await page.evaluate(() => document.documentElement.setAttribute('data-ui-style', 'notebook'));
        s = await state(); equal(s.rootInk, ''); equal(s.sampleWidth, '0px');
        await page.evaluate(() => document.documentElement.removeAttribute('data-ui-style'));
        equal((await state()).rootInk, '');
        await page.evaluate(() => document.documentElement.setAttribute('data-ui-style', 'standard'));
        await page.emulateMedia({ reducedMotion: 'reduce' });
        equal((await state()).duration, '0ms');
        const selectors = await page.evaluate(() => {
            const result = [];
            const visit = rules => { for (const rule of rules) {
                if (rule.selectorText) result.push(rule.selectorText);
                else if (rule.cssRules) visit(rule.cssRules);
            } };
            for (const sheet of document.styleSheets) visit(sheet.cssRules);
            return result;
        });
        equal(selectors.length > 0, true);
        equal(selectors.every(s => s.startsWith('html[data-ui-style="standard"]') && s.includes(':has(')), true);
        console.log('TOKENS_ISOLATION_PASS', checks);
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
