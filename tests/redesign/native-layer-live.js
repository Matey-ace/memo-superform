'use strict';
// Read-only live evidence. Does not click answers, forms, or modal buttons.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
(async () => {
    const label = process.argv[2];
    if (!/^[a-z0-9-]+$/.test(label || '')) throw new Error('Evidence label required');
    const out = path.resolve('docs/redesign/native-answer-fix', label);
    if (fs.existsSync(out)) throw new Error('Refusing to overwrite evidence');
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9337');
    const page = browser.contexts()[0].pages()[0];
    const frame = page.frames().find(f => f !== page.mainFrame());
    const confirm = frame.locator('.taroify-dialog:has(.shortcut-help-content) .taroify-dialog__confirm');
    const box = await confirm.count() ? await confirm.boundingBox() : null;
    const rootBox = await page.locator('.study-web-iframe').boundingBox();
    const main = await page.evaluate(box => {
        const bar = document.querySelector('.study-web-actions');
        const hit = box && document.elementFromPoint(box.x+box.width/2, box.y+box.height/2);
        return { theme:document.documentElement.getAttribute('data-ui-style'),bodyClass:document.body.className,
            barDisplay:bar?getComputedStyle(bar).display:null,
            barVisible:!!bar&&bar.getBoundingClientRect().width>0&&bar.getBoundingClientRect().height>0,
            parentHit:hit?{tag:hit.tagName,className:hit.className}:null,
            loadedLinks:[...document.querySelectorAll('link[id^="memo-constructivist"]')].map(el=>el.id) };
    },box);
    const innerHit = box && await frame.evaluate(({box,rootBox}) => {
        const hit = document.elementFromPoint(box.x-rootBox.x+box.width/2,box.y-rootBox.y+box.height/2);
        return hit?{tag:hit.tagName,className:hit.className}:null;
    },{box,rootBox});
    const native = await frame.evaluate(() => ({
        htmlClass:document.documentElement.className,
        shortcutDialogs:document.querySelectorAll('.taroify-dialog:has(.shortcut-help-content)').length,
        buttons:[...document.querySelectorAll('.rev-resp-btns > *')].map(el=>{
            const r=el.getBoundingClientRect(),s=getComputedStyle(el);
            return {tag:el.tagName,className:el.className,text:el.innerText,
                rect:{x:r.x,y:r.y,width:r.width,height:r.height},
                style:{position:s.position,zIndex:s.zIndex,color:s.color,background:s.backgroundColor}};
        })
    }));
    const result={label,main,native,confirmBox:box,innerHit,
        note:'Read-only live state; no answer/save events or credential data collected'};
    fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify(result,null,2));
    await page.screenshot({path:path.join(out,'screen.png')});
    console.log(JSON.stringify(result));
    process.exit(0);
})().catch(e=>{console.error(e.name,e.message.replace(/https?:\/\/\S+/g,'[URL]'));process.exit(1)});
