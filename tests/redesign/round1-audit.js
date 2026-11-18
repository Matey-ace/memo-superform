'use strict';
// SA-8 round 1 only. Product code is read-only. Raw PNG, no masks, no GIF pausing.
const fs=require('fs'),path=require('path'),http=require('http');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../..'),OUT=path.join(ROOT,'docs/redesign/round1');
const BASE='http://127.0.0.1:55395',EDGE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ids=['memo-constructivist-tokens','memo-constructivist-components'];
const result={started:new Date().toISOString(),scope:'round1 independent unauthenticated Edge; no connection to 9337',rows:[],isolation:[],failures:[],fixture:[]};
function save(name,data){fs.writeFileSync(path.join(OUT,name),JSON.stringify(data,null,2));}
async function toggle(p,disabled){await p.evaluate(({ids,disabled})=>ids.forEach(id=>{const l=document.getElementById(id);if(l)l.disabled=disabled;}),{ids,disabled});await p.waitForTimeout(280);}
async function full(p,kind){return p.evaluate(kind=>{
 const roots=kind==='all'?[document.documentElement]:[document.querySelector('#companionStudy'),document.querySelector('#companionModeBtn'),...[...document.querySelectorAll('.setting-group')].filter(n=>n.querySelector('#companionLanguageSelect,#ttsStatusText,#live2dCatalogSearch'))];
 const nodes=[...new Set(roots.filter(Boolean).flatMap(n=>[n,...n.querySelectorAll('*')]))];
 return nodes.map(el=>({key:el.tagName+'#'+el.id+'.'+String(el.className),styles:['','::before','::after'].map(pseudo=>{const s=getComputedStyle(el,pseudo||null),o={};for(const prop of s)if(!prop.startsWith('--'))o[prop]=s.getPropertyValue(prop);return o;}),rect:JSON.stringify(el.getBoundingClientRect().toJSON())}));
 },kind);}
function delta(a,b){let n=0,properties={},examples=[];for(let i=0;i<Math.max(a.length,b.length);i++){if(!a[i]||!b[i]){n++;continue;}for(let k=0;k<3;k++)for(const prop of Object.keys(a[i].styles[k]))if(a[i].styles[k][prop]!==b[i].styles[k][prop]){n++;properties[prop]=(properties[prop]||0)+1;if(examples.length<20)examples.push({node:a[i].key,pseudo:k,prop,before:a[i].styles[k][prop],after:b[i].styles[k][prop]});}if(a[i].rect!==b[i].rect){n++;properties.rect=(properties.rect||0)+1;}}return{elements:a.length,differences:n,properties,examples};}
async function inspect(p){return p.evaluate(()=>{
 function visible(el){const r=el.getBoundingClientRect(),s=getComputedStyle(el);if(!r.width||!r.height||s.visibility==='hidden'||s.display==='none')return false;let n=el;while(n){const c=getComputedStyle(n);if(c.display==='none'||c.visibility==='hidden')return false;n=n.parentElement;}return true;}
 function meta(el){const r=el.getBoundingClientRect(),s=getComputedStyle(el);return{key:el.tagName+'#'+el.id+'.'+String(el.className).slice(0,90),rect:r.toJSON(),color:s.color,bg:s.backgroundColor,radius:s.borderRadius,shadow:s.boxShadow,filter:s.filter,backdrop:s.backdropFilter,backgroundImage:s.backgroundImage,animation:s.animationName,duration:s.animationDuration,font:s.font,fontSize:s.fontSize,outline:s.outline,outlineOffset:s.outlineOffset};}
 const all=[...document.querySelectorAll('body *')].filter(visible),controls=all.filter(el=>el.matches('button,input:not([type=hidden]),select,[role=button],textarea'));
 const small=controls.filter(el=>{const r=el.getBoundingClientRect();return r.width<31.99||r.height<31.99;}).map(meta);
 const clipped=controls.filter(el=>{const r=el.getBoundingClientRect();if(r.x<-.5||r.right>innerWidth+.5)return true;let n=el.parentElement;while(n&&n!==document.body){const s=getComputedStyle(n),nr=n.getBoundingClientRect();if(['hidden','clip'].includes(s.overflowX)&&(r.x<nr.x-.5||r.right>nr.right+.5))return true;n=n.parentElement;}return false;}).map(meta);
 const styles=[];for(const sheet of document.styleSheets){if(!/theme-constructivist/.test(sheet.href||''))continue;const walk=rules=>{for(const r of rules){if(r.selectorText){let matches=[];try{matches=[...document.querySelectorAll(r.selectorText)];}catch(e){}styles.push({selector:r.selectorText,css:r.style.cssText,matches:matches.length,protectedMatches:matches.filter(el=>el.matches('#companionStudy,#companionStudy *,#companionModeBtn')).length});}if(r.cssRules)walk(r.cssRules);}};walk(sheet.cssRules);}
 return{theme:document.documentElement.dataset.uiStyle,bodyClass:document.body.className,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,links:[...document.querySelectorAll('link[rel=stylesheet]')].map(l=>({id:l.id,href:l.getAttribute('href'),disabled:l.disabled,loaded:!!l.sheet})),small,clipped,blur:all.filter(el=>{const s=getComputedStyle(el);return s.filter!=='none'||s.backdropFilter!=='none';}).map(meta),gradients:all.filter(el=>getComputedStyle(el).backgroundImage.includes('gradient')).map(meta),rounded:all.filter(el=>parseFloat(getComputedStyle(el).borderRadius)>2).map(meta),animations:all.filter(el=>getComputedStyle(el).animationName!=='none').map(meta),shadows:all.filter(el=>{const s=getComputedStyle(el).boxShadow;return s!=='none'&&!s.split(/,(?![^()]*\))/).every(x=>x.includes('inset'));}).map(meta),controls:controls.map(meta),keys:['.topbar','.tile','.settings-content','.article-vocab-overlay__dialog','#welcomeOverlay','.fullscreen-content','#fullscreenModal'].map(sel=>({sel,items:[...document.querySelectorAll(sel)].filter(visible).map(meta)})),rules:styles,emptyText:(document.querySelector('#dashboard')?.innerText||'').slice(0,400),canvas:[...document.querySelectorAll('canvas')].map(c=>({w:c.width,h:c.height})),companionModelText:(document.querySelector('#companionStudy')?.innerText||'').slice(0,400)};
 });}
async function capture(p,state,variant,size){
 const name=`${state}@${variant}@${size[0]}x${size[1]}`;
 await p.screenshot({path:path.join(OUT,name+'.png')});
 const metrics=await inspect(p);save(name+'.json',metrics);result.rows.push({name,metrics});console.log('CAPTURE',name,'dark='+metrics.bodyClass.includes('dark'),'small='+metrics.small.length,'clip='+metrics.clipped.length);
 if(variant==='notebook'){
 const before=await full(p,'all');await toggle(p,true);const after=await full(p,'all');await p.screenshot({path:path.join(OUT,name+'-disabled.png')});result.isolation.push({name,scope:'notebook full document incl pseudos',...delta(before,after)});await toggle(p,false);
 }
}
(async()=>{
 fs.mkdirSync(OUT,{recursive:true});
 const browser=await chromium.launch({executablePath:EDGE});
 try{
 if(!process.argv.includes('--supplement')) for(const variant of ['standard-light','standard-dark','notebook'])for(const size of [[1280,800],[1440,900],[1920,1080]]){
 const context=await browser.newContext({viewport:{width:size[0],height:size[1]},deviceScaleFactor:1});const p=await context.newPage(),errors=[];
 p.on('pageerror',e=>errors.push(String(e)));
 await p.addInitScript(v=>{localStorage.setItem('memo_ui_style',v==='notebook'?'notebook':'standard');localStorage.setItem('theme',v==='standard-dark'?'dark':'light');},variant);
 try{
 await p.goto(BASE,{waitUntil:'load'});await p.waitForTimeout(750);
 // Notebook keeps its original link set: absence of redesign links is itself recorded.
 await capture(p,'welcome',variant,size);
 if(await p.locator('#welcomeSettingsBtn').isVisible()){await p.click('#welcomeSettingsBtn');await p.click('#closeSettings');}
 await p.click('.layout-btn[data-layout="single"]');await capture(p,'dashboard',variant,size);
 await p.click('#settingsBtn');await capture(p,'settings',variant,size);
 if(variant!=='notebook') {const a=await full(p,'protected');await toggle(p,true);const b=await full(p,'protected');result.isolation.push({name:`settings@${variant}@${size}`,scope:'protected subtree, entrance and character settings',...delta(a,b)});await toggle(p,false);}
 await p.click('#closeSettings');await p.click('#articleVocabBtn');await capture(p,'article',variant,size);
 await p.keyboard.press('Tab');save(`focus@${variant}@${size}.json`,await p.evaluate(()=>{const e=document.activeElement,s=getComputedStyle(e);return{tag:e.tagName,id:e.id,class:e.className,focusVisible:e.matches(':focus-visible'),outline:s.outline,offset:s.outlineOffset};}));
 await p.keyboard.press('Escape');
 if(variant!=='notebook'){
 await p.click('.tile[data-tile="0"] .tile-fullscreen');await capture(p,'fullscreen',variant,size);await p.keyboard.press('Escape');
 await p.click('#companionModeBtn');await p.waitForTimeout(500);await p.click('#settingsBtn');
 const a=await full(p,'all');const m=await inspect(p);await p.screenshot({path:path.join(OUT,`companion@${variant}@${size}.png`)});await toggle(p,true);const b=await full(p,'all');await p.screenshot({path:path.join(OUT,`companion@${variant}@${size}-disabled.png`)});
 result.isolation.push({name:`companion@${variant}@${size}`,scope:'full document incl pseudos',matchingNewRules:m.rules.reduce((n,r)=>n+r.matches,0),...delta(a,b)});save(`companion@${variant}@${size}.json`,m);
 }
 }catch(e){result.failures.push({variant,size,error:String(e)});console.log('ERROR',variant,size,String(e));}
 finally{result.rows.filter(r=>r.name.includes('@'+variant+'@'+size.join('x'))).forEach(r=>r.errors=errors);await context.close();save('summary.json',result);}
 }
 // CSS fixture, not a real authenticated Maimemo page. No production DOM mutation.
 const css=fs.readFileSync(path.join(ROOT,'css/maimemo-standard.css'),'utf8');
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html class="memo-standard memo-main-redesign'+(req.url.includes('dark')?' memo-dark':'')+'"><head><style>'+css+'</style></head><body><div id="taro-navigation-bar" class="taro-navigation-bar-show taro-navigation-bar-back-icon"><button class="taro-navigation-bar-back">back</button><button class="taro-navigation-bar-home">home</button></div><button id="memo-tts-exit">返回</button></body></html>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const p=await browser.newPage();for(const mode of ['light','dark']){await p.goto('http://127.0.0.1:'+server.address().port+'/'+mode);for(const selector of ['#memo-tts-exit','.taro-navigation-bar-back','.taro-navigation-bar-home']){
 await p.mouse.move(1000,700);const measure=()=>p.locator(selector).evaluate(el=>{const s=getComputedStyle(el);return{color:s.color,bg:s.backgroundColor,backdrop:s.backdropFilter,shadow:s.boxShadow,transform:s.transform,outline:s.outline,offset:s.outlineOffset,radius:s.borderRadius};});
 const normal=await measure();await p.locator(selector).hover();await p.waitForTimeout(200);const hover=await measure();await p.mouse.down();await p.waitForTimeout(200);const active=await measure();await p.mouse.up();await p.keyboard.press('Tab');result.fixture.push({mode,selector,normal,hover,active,keyboardFocus:await p.evaluate(()=>({id:document.activeElement.id,outline:getComputedStyle(document.activeElement).outline}))});}}
 await p.close();}finally{server.close();}
 result.bytes={tokens:fs.statSync(path.join(ROOT,'css/theme-constructivist-tokens.css')).size,components:fs.statSync(path.join(ROOT,'css/theme-constructivist-components.css')).size,study:Buffer.byteLength(css),studyAddition:Buffer.byteLength(css)-fs.statSync(path.join(ROOT,'docs/redesign/source-before/css/maimemo-standard.css')).size};
 result.finished=new Date().toISOString();save('summary.json',result);console.log('ROUND1_CAPTURE_DONE',result.rows.length,'failures',result.failures.length);
 }finally{await browser.close();}
})().catch(e=>{result.failures.push({fatal:String(e)});save('summary.json',result);console.error(e);process.exitCode=1;});
