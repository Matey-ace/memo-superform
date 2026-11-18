'use strict';
// Isolated fixture verification, never real-login acceptance or a credential reader.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..');
const cli = process.argv.slice(2);
assert.ok(cli.length===0 || (cli.length===2 && cli[0]==='--out' && cli[1]), 'Usage: node study-theme-isolation.js [--out DIRECTORY]');
const evidence = cli.length ? path.resolve(cli[1]) : path.join(root, 'docs/redesign/sa6');
fs.mkdirSync(evidence, {recursive:true});
const exported = JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-c',
    'import runpy,json; a=runpy.run_path("memo_injection.py"); b=runpy.run_path("docs/redesign/source-before/memo_injection.py"); print(json.dumps({"current":{k:v for k,v in a.items() if k.isupper()},"before":{k:v for k,v in b.items() if k.isupper()}}))'
], {cwd:root, encoding:'utf8'}));
const rows=[];
function pass(name, value) { assert.ok(value,name); rows.push({name,pass:true}); }
const cur=exported.current, old=exported.before;
for (const key of Object.keys(old)) if(key!=='MEMO_STUDY_THEME') pass('unchanged constant '+key,cur[key]===old[key]);
const source=fs.readFileSync(path.join(root,'memo_injection.py'),'utf8');
const sourceBefore=fs.readFileSync(path.join(root,'docs/redesign/source-before/memo_injection.py'),'utf8');
const additions=source.split('\n').filter(line=>line.includes("'var mainRedesign=false;"));
pass('exactly one added source line',additions.length===1);
pass('removing the guard restores entire source',source.replace(additions[0]+'\n','')===sourceBefore);
const css=fs.readFileSync(path.join(root,'css/maimemo-standard.css'),'utf8');
const cssBefore=fs.readFileSync(path.join(root,'docs/redesign/source-before/css/maimemo-standard.css'),'utf8');
pass('old CSS byte prefix preserved',css.startsWith(cssBefore));
const extra=css.slice(cssBefore.length);
pass('added CSS <=30KiB',Buffer.byteLength(extra)<=30720);
const stripped=extra.replace(/\/\*[\s\S]*?\*\//g,'');
for(const block of stripped.split('}')) {
    const selector=block.split('{')[0].trim(); if(!selector) continue;
    pass('scoped '+selector.split('\n')[0],selector.split(',').every(s=>s.trim().startsWith('html.memo-standard.memo-main-redesign')));
}
pass('no new layout or visibility declarations',!/(?:^|[;{])\s*(?:display|visibility|position|width|height|min-width|min-height|max-width|max-height|padding|margin|gap|order|pointer-events|font-size|line-height|z-index)\s*:/m.test(stripped));
pass('no remote assets/imports',!/@import|url\(/.test(stripped));
const effects=[...stripped.matchAll(/(?:^|[;{])\s*((?:backdrop-)?filter|transform|transition|mix-blend-mode)\s*:\s*([^;}]+)/gm)];
pass('effect declarations only neutralize with literal none',effects.every(m=>m[2].trim()==='none'));
pass('existing observer count', (cur.MEMO_STUDY_THEME.match(/new MutationObserver/g)||[]).length===(old.MEMO_STUDY_THEME.match(/new MutationObserver/g)||[]).length);
pass('no new timers',! /setInterval|setTimeout/.test(cur.MEMO_STUDY_THEME));
const fixture='<div class="rev-root"><div class="rev-top"><span class="spelling">example</span><span class="phonetic">test</span><div class="interp-ctn">definition</div></div><div class="rev-resp-btns"><button style="width:120px;height:48px">A</button><button style="width:120px;height:48px">B</button><button style="width:120px;height:48px">C</button></div></div>';
const instrument='<script>window.observerCount=0; const NativeMO=MutationObserver;window.MutationObserver=class extends NativeMO{constructor(fn){super(fn);window.observerCount++}};</script>';
const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type',req.url.startsWith('/css/')?'text/css':'text/html');
    if(req.url.startsWith('/css/maimemo-standard')) return res.end(css);
    if(req.url.startsWith('/css/')) return res.end('');
    if(req.url.startsWith('/frame')) return res.end('<!doctype html><html><head>'+instrument+cur.MEMO_STUDY_THEME+'</head><body>'+fixture+'</body></html>');
    if(req.url==='/standalone') return res.end('<!doctype html><html><head>'+cur.MEMO_STUDY_THEME+'</head><body>'+fixture+'</body></html>');
    res.end('<!doctype html><html data-ui-style="standard"><body><iframe id="study" src="/frame"></iframe><section id="companionStudy"><iframe id="companion" src="/frame"></iframe></section></body></html>');
});
(async()=>{
    let browser;
    try {
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        const base='http://127.0.0.1:'+server.address().port;
        browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
        const page=await browser.newPage();
        const errors=[];page.on('pageerror',e=>errors.push(e.message));
        await page.goto(base); await page.locator('#study').waitFor();
        const frame=page.frames().find(f=>f.name()==='study') || await page.locator('#study').elementHandle().then(h=>h.contentFrame());
        const companion=await page.locator('#companion').elementHandle().then(h=>h.contentFrame());
        async function state(f=frame){return f.evaluate(()=>({main:document.documentElement.classList.contains('memo-main-redesign'),notebook:document.documentElement.classList.contains('memo-notebook'),standard:document.documentElement.classList.contains('memo-standard'),skin:document.querySelector('#memo-study-skin').getAttribute('href'),skinCount:document.querySelectorAll('#memo-study-skin').length,fonts:document.querySelector('#memo-notebook-fonts')?.getAttribute('href')||null,observers:window.observerCount,bg:getComputedStyle(document.body).backgroundColor,paperToken:getComputedStyle(document.documentElement).getPropertyValue('--c-paper').trim(),buttonRects:[...document.querySelectorAll('.rev-resp-btns button')].map(b=>{const r=b.getBoundingClientRect();return {width:r.width,height:r.height,text:b.textContent}})}));}
        async function settle(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
        let s=await state();pass('explicit main enables guard',s.main&&s.standard&&!s.notebook);pass('skin id unique original path',s.skinCount===1&&s.skin==='/css/maimemo-standard.css?v=20260825-unified-ui');pass('standard has no notebook fonts',s.fonts===null);pass('only existing observer active',s.observers===1);pass('paper palette applies',s.bg==='rgb(239, 231, 214)');
        const rects=s.buttonRects;
        const companionState=await state(companion);pass('companion frame excluded without body mode',!companionState.main);pass('companion frame receives no new tokens',companionState.paperToken==='');
        await page.evaluate(()=>document.body.classList.add('companion-mode'));await settle();pass('enter companion removes class',!(await state()).main);
        await page.evaluate(()=>document.body.classList.remove('companion-mode'));await settle();pass('exit companion restores class',(await state()).main);
        await page.evaluate(()=>{document.documentElement.removeAttribute('data-ui-style');document.body.classList.toggle('sync-test');});await settle();pass('missing explicit attribute fails closed',!(await state()).main);
        await page.evaluate(()=>{document.documentElement.setAttribute('data-ui-style','notebook');document.body.classList.add('notebook-mode');});await settle();s=await state();pass('notebook removes redesign keeps original mode',!s.main&&s.notebook&&!s.standard);pass('notebook receives no new tokens',s.paperToken==='');pass('notebook original skin/font paths',s.skin==='/css/maimemo-notebook.css?v=20260825-unified-ui'&&s.fonts==='/css/fonts.css?v=20260825-unified-ui');
        await page.evaluate(()=>{document.documentElement.setAttribute('data-ui-style','standard');document.body.classList.remove('notebook-mode');});await settle();s=await state();pass('return standard restores unique link without fonts',s.main&&s.skinCount===1&&!s.fonts);pass('button sizes/order preserved',JSON.stringify(s.buttonRects)===JSON.stringify(rects));
        await frame.evaluate(()=>{document.documentElement.classList.add('memo-dark');window.dispatchEvent(new Event('pageshow'));});s=await state();pass('dark independent paper token applies',s.bg==='rgb(22, 19, 15)');
        await page.goto(base+'/standalone');pass('no frameElement fails closed',!await page.evaluate(()=>document.documentElement.classList.contains('memo-main-redesign')));
        const paintSamples=[];
        const paintPage=await browser.newPage();
        paintPage.on('pageerror',e=>errors.push(e.message));
        const variants=[
            {name:'tts',selector:'#memo-tts-exit',html:'<button id="memo-tts-exit">Exit</button>'},
            {name:'back-fallback',selector:'.taro-navigation-bar-back',mode:'memo-navigation-back-fallback',icon:'back'},
            {name:'back-icon',selector:'.taro-navigation-bar-back',mode:'taro-navigation-bar-back-icon',icon:'back'},
            {name:'home-icon',selector:'.taro-navigation-bar-home',mode:'taro-navigation-bar-home-icon',icon:'home'}
        ];
        for(const dark of [false,true]) for(const variant of variants) {
            const name=(dark?'dark ':'light ')+variant.name;
            const ink=dark?'rgb(236, 227, 207)':'rgb(26, 23, 20)';
            const paper=dark?'rgb(22, 19, 15)':'rgb(239, 231, 214)';
            const red=dark?'rgb(232, 99, 75)':'rgb(142, 36, 22)';
            // Exactly one navigation icon per document: no coincident back/home hit targets.
            const body=variant.html || '<div id="taro-navigation-bar" class="taro-navigation-bar-show '+variant.mode+'" style="height:64px"><button class="taro-navigation-bar-'+variant.icon+'">'+variant.icon+'</button></div>';
            await paintPage.setContent('<!doctype html><html class="memo-standard memo-main-redesign'+(dark?' memo-dark':'')+'"><head></head><body>'+body+'</body></html>');
            await paintPage.addStyleTag({content:css});
            const target=paintPage.locator(variant.selector);
            async function snapshot(state) {
                const result=await target.evaluate(e=>{
                    const s=getComputedStyle(e),r=e.getBoundingClientRect();
                    return {background:s.backgroundColor,color:s.color,border:s.borderColor,shadow:s.boxShadow,backdropFilter:s.backdropFilter,filter:s.filter,transform:s.transform,transitionProperty:s.transitionProperty,transitionDuration:s.transitionDuration,outlineColor:s.outlineColor,outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,focusVisible:e.matches(':focus-visible'),hover:e.matches(':hover'),active:e.matches(':active'),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
                });
                paintSamples.push({name,state,...result});
                return result;
            }
            await paintPage.mouse.move(1000,700);
            const normal=await snapshot('normal');
            pass(name+' normal ink/paper/border',normal.background===paper&&normal.color===ink&&normal.border===ink);
            async function assertClean(state,sample) {
                pass(name+' '+state+' no effects',sample.shadow==='none'&&sample.backdropFilter==='none'&&sample.filter==='none'&&sample.transform==='none');
                pass(name+' '+state+' same rectangle',JSON.stringify(sample.rect)===JSON.stringify(normal.rect));
                if(variant.name==='tts') pass(name+' '+state+' no transition',sample.transitionProperty==='none'&&sample.transitionDuration==='0s');
            }
            await assertClean('normal',normal);
            await target.hover();
            const hovered=await snapshot('hover');
            pass(name+' hover actually active',hovered.hover);
            pass(name+' hover readable red/paper',hovered.background===red&&hovered.color===paper&&hovered.border===ink);
            await assertClean('hover',hovered);
            await paintPage.mouse.down();
            try {
                const active=await snapshot('active');
                pass(name+' active actually active',active.active);
                pass(name+' active readable red/paper',active.background===red&&active.color===paper&&active.border===ink);
                await assertClean('active',active);
            } finally {await paintPage.mouse.up();}
            await paintPage.mouse.move(1000,700);
            // Real keyboard modality ensures :focus-visible, rather than testing :focus only.
            await paintPage.evaluate(()=>{document.body.tabIndex=-1;document.body.focus();});
            await paintPage.keyboard.press('Tab');
            const focused=await snapshot('focus');
            pass(name+' keyboard focus visible',focused.focusVisible);
            pass(name+' focus vermilion outline',focused.outlineColor===red&&focused.outlineStyle==='solid'&&focused.outlineWidth==='2px');
            pass(name+' focus ink/paper',focused.background===paper&&focused.color===ink);
            await assertClean('focus',focused);
        }
        await paintPage.setContent('<!doctype html><html class="memo-standard"><body><button id="memo-tts-exit">Exit</button></body></html>');
        await paintPage.addStyleTag({content:css});
        pass('guard absent preserves legacy TTS blur',await paintPage.locator('#memo-tts-exit').evaluate(e=>getComputedStyle(e).backdropFilter)==='blur(8px)');
        await paintPage.close();
        pass('no page errors',errors.length===0);
        const report={result:'PASS',checks:rows.length,rows,paintSamples,cssAddedBytes:Buffer.byteLength(extra),cssTotalBytes:Buffer.byteLength(css),sourceAddedLines:additions.length,realLoginSevenStates:'NOT VERIFIED BY THIS SCRIPT; fixtures test isolation and paint states only',notes:['Parent HTML-only attribute changes are observed on the next existing body mutation/pageshow, not by a new observer. Theme selection changes body classes in production.','No connection to port 55395, 9337 or any real account.','Navigation variants are separate documents with one icon each.']};
        fs.writeFileSync(path.join(evidence,'isolation-results.json'),JSON.stringify(report,null,2));
        fs.writeFileSync(path.join(evidence,'injection-addition.txt'),additions[0]+'\n');
        console.log(JSON.stringify({result:report.result,checks:report.checks,cssAddedBytes:report.cssAddedBytes}));
    } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
