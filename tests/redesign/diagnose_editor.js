'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9337');
    const page = browser.contexts()[0].pages()[0];
    const out = path.resolve('docs/redesign/baseline/editor-conflict-before');
    if (fs.existsSync(out)) throw new Error('Evidence exists');
    const state = await page.evaluate(() => {
        const selectors = ['.topbar', '#dashboard', '.tile:not([hidden])', '.study-web-container',
            '.study-web-iframe', '.study-web-actions', '.study-content-edit-trigger',
            '.study-content-editor', '.study-content-editor-head', '.study-content-editor-body',
            '.study-shortcut-toggle', '.study-shortcut-panel', '#settingsPanel', '.article-vocab-overlay'];
        const describe = el => ({ tag: el.tagName, id: el.id, className: el.className });
        const elements = [];
        for (const selector of selectors) for (const el of document.querySelectorAll(selector)) {
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            const x = Math.min(innerWidth - 1, Math.max(0, r.x + r.width / 2));
            const y = Math.min(innerHeight - 1, Math.max(0, r.y + r.height / 2));
            elements.push({ selector, ...describe(el), hidden: el.hidden, inert: el.inert,
                rect: { x:r.x, y:r.y, width:r.width, height:r.height },
                scrollWidth:el.scrollWidth, clientWidth:el.clientWidth,
                scrollHeight:el.scrollHeight, clientHeight:el.clientHeight,
                style: { display:s.display, visibility:s.visibility, position:s.position,
                    zIndex:s.zIndex, overflow:s.overflow, overflowY:s.overflowY,
                    pointerEvents:s.pointerEvents, transform:s.transform },
                centerHit: r.width && r.height ? document.elementsFromPoint(x,y).slice(0,6).map(describe) : [] });
        }
        const editor = document.querySelector('.study-content-editor');
        const controls = editor ? [...editor.querySelectorAll('button,input,textarea')].map(el => {
            const r=el.getBoundingClientRect();
            const hit = r.width && r.height ? document.elementFromPoint(r.x+r.width/2,r.y+r.height/2) : null;
            return {...describe(el),rect:{x:r.x,y:r.y,width:r.width,height:r.height},
                centerHit:hit?describe(hit):null,hitOwns:!!hit&&(el===hit||el.contains(hit))};
        }) : [];
        return { viewport:{width:innerWidth,height:innerHeight},
            theme:document.documentElement.getAttribute('data-ui-style'),bodyClass:document.body.className,
            newCssLoaded:!!document.querySelector('#memo-constructivist-components'),elements,controls };
    });
    fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify(state,null,2));
    await page.screenshot({path:path.join(out,'screen.png')});
    console.log(JSON.stringify({viewport:state.viewport,newCssLoaded:state.newCssLoaded,
        editor:state.elements.filter(x=>x.selector.startsWith('.study-content')),
        controls:state.controls}));
    process.exit(0);
})().catch(e=>{console.error(e.name);process.exit(1)});
