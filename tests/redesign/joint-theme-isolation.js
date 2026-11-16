'use strict';
// Permanent joint-link isolation gate. Never clicks answer, save, login, or data controls.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'../..'),BASE='http://127.0.0.1:55395';
const args={};for(let i=2;i<process.argv.length;i+=2){assert.ok(process.argv[i].startsWith('--')&&process.argv[i+1],'Expected --key value');args[process.argv[i].slice(2)]=process.argv[i+1];}
assert.ok(args.out,'--out NEW_DIRECTORY required');
const OUT=path.resolve(args.out);assert.ok(!fs.existsSync(OUT),'Refusing existing --out');
const own=path.join(ROOT,'docs/redesign/sa4/fixes-round2');
assert.ok(OUT.startsWith(own+path.sep),'--out must be a new child of docs/redesign/sa4/fixes-round2');
const candidate=args.components?path.resolve(args.components):null;
const IDS=['memo-constructivist-tokens','memo-constructivist-components','memo-constructivist-layout'];
const FILES=['tokens','components','layout'].map(x=>'/css/theme-constructivist-'+x+'.css');
const GROUP='.setting-group:has(#companionLanguageSelect,#ttsStatusText,#live2dCatalogSearch)';
const SELECTOR=`#companionStudy,#companionStudy *,#companionModeBtn,${GROUP},${GROUP} *`;
const hash=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const summary={scope:'Independent Edge contexts, 55395 GET/HEAD only, no CDP/9337/DB/answer/save. Three fresh links toggled together.',candidate,selector:SELECTOR,rows:[],failures:[]};
fs.mkdirSync(OUT,{recursive:true});
const save=(name,data)=>fs.writeFileSync(path.join(OUT,name+'.json'),JSON.stringify(data,null,2),{flag:'wx'});
async function settle(p){await p.waitForTimeout(850);await p.evaluate(()=>document.fonts.ready);}
async function snapshot(p){return p.evaluate(sel=>[...document.querySelectorAll(sel)].map((el,i)=>({i,key:el.tagName+'#'+el.id+'.'+String(el.className),styles:['','::before','::after'].map(ps=>{const s=getComputedStyle(el,ps||null),out={};for(const k of s)if(!k.startsWith('--'))out[k]=s.getPropertyValue(k);return out;}),rect:el.getBoundingClientRect().toJSON()})),SELECTOR);}
function delta(a,b){const changes=[];let styles=0,rects=0;assert.equal(a.length,b.length);for(let i=0;i<a.length;i++){assert.equal(a[i].key,b[i].key);for(let j=0;j<3;j++)for(const k of new Set([...Object.keys(a[i].styles[j]),...Object.keys(b[i].styles[j])]))if(a[i].styles[j][k]!==b[i].styles[j][k]){styles++;changes.push({key:a[i].key,pseudo:j,property:k,before:a[i].styles[j][k],after:b[i].styles[j][k]});}for(const k of Object.keys(a[i].rect))if(a[i].rect[k]!==b[i].rect[k]){rects++;changes.push({key:a[i].key,property:'rect.'+k,before:a[i].rect[k],after:b[i].rect[k]});}}return{elements:a.length,styles,rects,total:styles+rects,beforeSHA256:hash(a),afterSHA256:hash(b),changes};}
async function links(p){return p.evaluate(async({ids,files})=>{for(const id of ids)document.getElementById(id)?.remove();await Promise.all(ids.map((id,i)=>new Promise((resolve,reject)=>{const l=document.createElement('link');l.id=id;l.rel='stylesheet';l.href=files[i]+'?joint-isolation=1';l.onload=resolve;l.onerror=()=>reject(Error('Stylesheet failed '+id));document.head.appendChild(l);})));return ids.map(id=>{const l=document.getElementById(id);return{id,loaded:!!l.sheet,rules:l.sheet.cssRules.length,disabled:l.disabled};});},{ids:IDS,files:FILES});}
async function pair(p,name,minimum){await settle(p);const topbar=()=>p.evaluate(()=>[...document.querySelectorAll('.topbar button,.topbar select')].map(el=>({key:el.id||el.className,rect:el.getBoundingClientRect().toJSON()})));const topbarBefore=await topbar();const before=await snapshot(p);assert.ok(before.length>=minimum,`Protected set shrank: ${before.length}<${minimum}`);await p.evaluate(ids=>{for(const id of ids)document.getElementById(id).disabled=true;},IDS);await settle(p);const after=await snapshot(p),d=delta(before,after),topbarAfter=await topbar();d.topbarRectChanges=topbarBefore.flatMap((el,i)=>Object.keys(el.rect).filter(k=>el.rect[k]!==topbarAfter[i]?.rect[k]).map(k=>({key:el.key,property:k,before:el.rect[k],after:topbarAfter[i]?.rect[k]})));d.total+=d.topbarRectChanges.length;save(name,{before,after,topbarBefore,topbarAfter,delta:d});summary.rows.push({name,...d,changes:undefined});await p.evaluate(ids=>{for(const id of ids)document.getElementById(id).disabled=false;},IDS);await settle(p);return d;}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const sizes=args.quick==='true'?[[1280,800]]:[[1280,800],[1440,900],[1920,1080]];
 const themes=args.quick==='true'?['light']:['light','dark'];
 for(const theme of themes)for(const [width,height] of sizes){let c;const suffix=`standard-${theme}@${width}x${height}`;try{
  c=await browser.newContext({viewport:{width,height},serviceWorkers:'block'});
  await c.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==BASE||!['GET','HEAD'].includes(req.method()))return route.abort();if(candidate&&u.pathname===FILES[1])return route.fulfill({status:200,contentType:'text/css',body:fs.readFileSync(candidate)});return route.continue();});
  const p=await c.newPage(),errors=[];p.on('pageerror',e=>errors.push(String(e)));
  await p.addInitScript(theme=>{localStorage.setItem('memo_ui_style','standard');localStorage.setItem('theme',theme);},theme);
  await p.goto(BASE,{waitUntil:'load'});await settle(p);
  if(await p.locator('#welcomeSettingsBtn').isVisible()){await p.click('#welcomeSettingsBtn');await p.click('#closeSettings');}
  await p.mouse.move(0,0);const loaded=await links(p);assert.ok(loaded.every(l=>l.loaded&&l.rules>0&&!l.disabled),'Three fresh enabled links required');
  await p.click('#settingsBtn');await settle(p);assert.ok(await p.locator('#settingsPanel').isVisible());
  assert.equal(await p.locator('body').evaluate(e=>e.classList.contains('companion-mode')),false);
  assert.equal(await p.locator('body').evaluate(e=>e.classList.contains('dark')),theme==='dark');
  const normal=await pair(p,'normal-settings@'+suffix,245);if(normal.total)summary.failures.push({name:'normal-settings@'+suffix,total:normal.total});
  await p.click('#closeSettings');await p.click('#companionModeBtn');await settle(p);assert.ok(await p.locator('body').evaluate(e=>e.classList.contains('companion-mode')));
  await p.click('#settingsBtn');await settle(p);assert.ok(await p.locator('#settingsPanel').isVisible());
  const companion=await pair(p,'companion-settings@'+suffix,323);if(companion.total)summary.failures.push({name:'companion-settings@'+suffix,total:companion.total});
  assert.deepEqual(errors,[]);console.log(suffix,normal.total,companion.total);
 }catch(e){summary.failures.push({name:suffix,error:String(e.stack)});console.error(String(e));}finally{if(c)await c.close();}}
 }finally{await browser.close();save('summary',summary);}
 process.exitCode=summary.failures.length?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
