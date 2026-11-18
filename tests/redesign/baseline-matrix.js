'use strict';
// SA-2 owns only this script and docs/redesign/baseline/**.
// Real UI actions only. No injected styles, DOM mutation, credentials or database access.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:55395';
const OUT_ARG = process.argv.indexOf('--out');
const ROOT = OUT_ARG < 0 ? path.resolve(__dirname, '../../docs/redesign/baseline') : path.resolve(process.argv[OUT_ARG + 1]);
const RUN = 'matrix-' + new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(ROOT, RUN);
const rows = [], failures = [];
const sizes = [[1280,800],[1440,900],[1920,1080]];
const variants = ['standard-light','standard-dark','notebook'];
const charts = ['heatmap','trend','memory','aiclass','notepad','growth','recommend'];
const STATES = ['welcome','layout-single','layout-split2','layout-split3','layout-grid4','settings','article-vocab',...charts.map(c=>'chart-'+c),'tile-fullscreen','companion-NO-MODEL-NOT-PROOF','study-UNAUTHENTICATED'];
const ALLOWED_ERROR = 'console: Failed to load resource: the server responded with a status of 401 (Unauthorized)';
const keyOf = r => `${r.state}@${r.variant}@${r.width}x${r.height}`;
const EXPECTED = variants.flatMap(variant=>sizes.flatMap(([width,height])=>STATES.map(state=>({state,variant,width,height}))));
const LIGHT_EXCEPTIONS = EXPECTED.filter(r=>r.variant==='standard-dark'&&['welcome','study-UNAUTHENTICATED'].includes(r.state)).map(keyOf);
function pngDimensions(file) {
 const b=fs.readFileSync(file);
 if(b.length<45||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||b.readUInt32BE(8)!==13||b.toString('ascii',12,16)!=='IHDR') throw Error('Invalid PNG header');
 let offset=8,ended=false;const idat=[];
 while(offset+12<=b.length) {
  const n=b.readUInt32BE(offset),type=b.toString('ascii',offset+4,offset+8);
  if(offset+12+n>b.length)throw Error('Truncated PNG chunk');
  if(type==='IDAT')idat.push(b.subarray(offset+8,offset+8+n));
  offset+=12+n;
  if(type==='IEND'){ended=true;break;}
 }
 if(!ended||!idat.length||offset!==b.length)throw Error('Incomplete PNG');
 require('zlib').inflateSync(Buffer.concat(idat),{maxOutputLength:64*1024*1024});
 return {width:b.readUInt32BE(16),height:b.readUInt32BE(20)};
}
function validateMatrix(folder, matrix, expected=EXPECTED) {
 const problems=[],seen=new Set(),allowed=new Set(expected.map(keyOf));
 const foundExceptions=[];
 const fail=s=>problems.push(s);
 if(!Array.isArray(matrix.rows)||!matrix.rows.length)fail('Empty or missing rows');
 if(!Array.isArray(matrix.failures)||matrix.failures.length)fail('Capture failures present or missing failures array');
 const data=Array.isArray(matrix.rows)?matrix.rows:[];
 if(data.length!==expected.length)fail(`Row count ${data.length}, expected ${expected.length}`);
 for(const r of data) {
  const key=keyOf(r),m=r.metrics||{};
  if(!allowed.has(key))fail('Unexpected combination: '+key);
  if(seen.has(key))fail('Duplicate combination: '+key);
  seen.add(key);
  if(!Array.isArray(r.errors)||r.errors.some(e=>e!==ALLOWED_ERROR))fail('Unapproved errors: '+key);
  if(m.overflow!==false||!Number.isFinite(m.scrollWidth)||!Number.isFinite(m.clientWidth)||m.scrollWidth>m.clientWidth)fail('Overflow or missing metrics: '+key);
  const classes=String(m.bodyClass||'').split(/\s+/);
  const lightException=LIGHT_EXCEPTIONS.includes(key);
  if(lightException)foundExceptions.push(key);
  const shouldDark=r.variant==='standard-dark'&&!lightException;
  if(classes.includes('dark')!==shouldDark)fail('Wrong actual dark state: '+key);
  if(m.theme!==(r.variant==='notebook'?'notebook':'standard'))fail('Wrong actual theme: '+key);
  if(r.state!=='welcome') {
   const welcome=m.keys&&m.keys['#welcomeOverlay'];
   if(!Array.isArray(welcome)||!welcome.length||welcome.some(x=>x.visible!==false))fail('Welcome not confirmed closed: '+key);
  }
  for(const [field,ext] of [['file','.png'],['metricsFile','.json']]) {
   try {
    if(typeof r[field]!=='string')throw Error('Missing path');
    const file=path.resolve(folder,'..',r[field]);
    if(path.dirname(file)!==path.resolve(folder)||path.basename(file)!==key+ext)throw Error('Path does not match row');
    if(!fs.statSync(file).isFile()||!fs.statSync(file).size)throw Error('Missing or empty file');
    if(ext==='.png') {const dim=pngDimensions(file);if(dim.width!==r.width||dim.height!==r.height)throw Error('PNG dimensions do not match row');}
    else {const side=JSON.parse(fs.readFileSync(file,'utf8'));if(keyOf(side)!==key||JSON.stringify(side.metrics)!==JSON.stringify(r.metrics)||JSON.stringify(side.errors)!==JSON.stringify(r.errors))throw Error('Sidecar does not match row');}
   }catch(e){fail(field+' '+key+': '+e.message);}
  }
 }
 for(const key of allowed)if(!seen.has(key))fail('Missing combination: '+key);
 return {ok:problems.length===0,shots:data.length,expected:expected.length,problems,allowedErrors:[...new Set(data.flatMap(r=>r.errors||[]).filter(e=>e===ALLOWED_ERROR))],historicalLightExceptionsNotDarkEvidence:foundExceptions,metricsScope:'Selected keys only; not full computed styles or iframe-control metrics'};
}
module.exports={validateMatrix,pngDimensions,EXPECTED,LIGHT_EXCEPTIONS,ALLOWED_ERROR};
function writeJson(name, data) { fs.writeFileSync(path.join(OUT,name), JSON.stringify(data,null,2)); }
async function shot(page, state, variant, size, errors) {
    await page.waitForTimeout(180);
    const name = `${state}@${variant}@${size[0]}x${size[1]}`;
    const metrics = await page.evaluate(() => {
        const selectors = ['body','.topbar','.topbar h1','#dashboard','.tile','.tile-header','.chart-container','.chart-selector','#settingsPanel','.settings-content','#articleVocabBtn','.article-vocab-overlay','#welcomeOverlay','#companionStudy','iframe'];
        const keys = {};
        for (const sel of selectors) {
            keys[sel] = [...document.querySelectorAll(sel)].slice(0,4).map(el => {
                const r = el.getBoundingClientRect(), s = getComputedStyle(el);
                return {rect:{x:r.x,y:r.y,width:r.width,height:r.height},visible:r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none',fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,letterSpacing:s.letterSpacing,color:s.color,background:s.backgroundColor,border:s.border,borderRadius:s.borderRadius,boxShadow:s.boxShadow,display:s.display};
            });
        }
        return {url:location.href,theme:document.documentElement.getAttribute('data-ui-style'),bodyClass:document.body.className,dashboardClass:document.querySelector('#dashboard').className,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,canvas:[...document.querySelectorAll('canvas')].map(c=>({width:c.width,height:c.height})),iframes:[...document.querySelectorAll('iframe')].map(f=>f.src),text:(document.querySelector('#dashboard').innerText||'').slice(0,1200),keys};
    });
    await page.screenshot({path:path.join(OUT,name+'.png'),fullPage:false});
    const row = {file:RUN+'/'+name+'.png',metricsFile:RUN+'/'+name+'.json',state,variant,width:size[0],height:size[1],time:new Date().toISOString(),errors:errors.slice(),metrics};
    writeJson(name+'.json',row);
    rows.push(row);
    console.log('SHOT',name,'errors='+errors.length,'overflow='+metrics.overflow);
}
async function attempt(label, fn) { try {await fn();} catch(e) { failures.push({label,error:String(e)}); console.log('FAILED',label,String(e).slice(0,160));} }
function report() {
    writeJson('matrix.json',{base:BASE,run:RUN,emptyData:true,rows,failures});
    const lines = ['# SA-2 Baseline Matrix','','## Evidence Scope','','Real Edge screenshots; existing isolated service only. No production-code changes, DOM edits, style injection, credentials, or real database access. All charts show **empty data**, not validated real study data. PNGs are unmodified viewport captures. Error counts are cumulative per browser configuration, not new errors per chart. IMPORTANT: welcome is captured before the dark toggle; standard-dark welcome is actually light. Study after companion reload is also light in standard-dark configurations. Actual bodyClass in JSON is authoritative; these are NOT dark welcome/login evidence.','',`Run: ${RUN}. Captures: ${rows.length}. Action failures: ${failures.length}.`,'','## Missing Evidence','','- Logged-in study start, word front/back, recognition actions, switching words, editor open/save, completion: no interactive account login performed in this capture run. Login permission alone is not an authenticated browser session.','- Real Live2D character rendering: no model installed in isolated data; any companion capture is explicitly no-model state, not evidence of real-character parity.','- Toast interaction not deliberately triggered: no network/data mutation used to force it.','- No visual/aesthetic approval by image-capable reviewer in this run.','- GIFs, countdowns and upstream login nonces are dynamic. Strict pixel equality cannot be inferred from these captures; screenshots are not altered to conceal dynamic areas.','','## Matrix','','| State | Variant | Resolution | Errors | Horizontal Overflow | Captured UTC | Screenshot | Metrics |','|---|---|---|---:|---|---|---|---|'];
    for(const r of rows) lines.push(`| ${r.state} | ${r.variant} | ${r.width}x${r.height} | ${r.errors.length} | ${r.metrics.overflow?'FAIL':'PASS'} (${r.metrics.scrollWidth}/${r.metrics.clientWidth}) | ${r.time} | [PNG](<${r.file}>) | [JSON](<${r.metricsFile}>) |`);
    lines.push('','## Quantitative Summary','','Each JSON records key element rectangles, visibility, font family/size/weight, line height, letter spacing, foreground/background, border, radius, shadow, canvas dimensions and global overflow.','', '| Variant / Resolution | Topbar H | Title Font / Size | Dashboard Rect |','|---|---:|---|---|');
    for(const r of rows.filter(x=>x.state==='layout-single')) { const k=r.metrics.keys,t=k['.topbar'][0],h=k['.topbar h1'][0],d=k['#dashboard'][0]; lines.push(`| ${r.variant} ${r.width}x${r.height} | ${t.rect.height} | ${h.fontFamily} / ${h.fontSize} | ${JSON.stringify(d.rect)} |`); }
    lines.push('','## Errors and Action Failures','');
    const errs=[...new Set(rows.flatMap(r=>r.errors))];
    lines.push(errs.length?errs.map(e=>'- '+e.replace(/\n/g,' ')).join('\n'):'No captured pageerror or console.error.');
    for(const f of failures) lines.push('- '+f.label+': '+f.error.replace(/\n/g,' '));
    lines.push('','## Reproduction','','From workspace root, with existing service still running:','','```powershell','node tests/redesign/baseline-matrix.js','```','','Theme initialized via localStorage only; dark state entered by clicking #themeBtn. Welcome captured first, then dismissed through #welcomeSettingsBtn and #closeSettings. Layout, settings, article vocabulary and chart states entered through actual controls. No data was seeded.','');
    fs.writeFileSync(path.join(ROOT,'index.md'),lines.join('\n'));
}
if(require.main===module) (async()=>{
 if(process.argv.includes('--verify')) {
  const arg=process.argv[process.argv.indexOf('--verify')+1];
  if(!arg||arg.startsWith('--'))throw Error('--verify requires a matrix folder');
  const folder=path.isAbsolute(arg)?arg:path.join(ROOT,arg);
  const m=JSON.parse(fs.readFileSync(path.join(folder,'matrix.json'),'utf8'));
  const summary=validateMatrix(folder,m);
  console.log(JSON.stringify(summary,null,2));
  process.exitCode=summary.ok?0:1;
  return;
 }
 fs.mkdirSync(OUT, {recursive:true});
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 try {
 for(const variant of variants) for(const size of sizes) {
  const context=await browser.newContext({viewport:{width:size[0],height:size[1]},deviceScaleFactor:1});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push('pageerror: '+String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push('console: '+m.text());});
  await page.addInitScript(v=>{localStorage.setItem('memo_ui_style',v==='notebook'?'notebook':'standard');localStorage.setItem('theme','light');},variant);
  try {
   await page.goto(BASE,{waitUntil:'load',timeout:30000});
   await page.waitForTimeout(600);
   if(await page.locator('#welcomeSettingsBtn').isVisible()) {
    await shot(page,'welcome',variant,size,errors);
    await page.click('#welcomeSettingsBtn');
    await page.click('#closeSettings');
   }
   if(variant==='standard-dark') {await page.click('#themeBtn'); if(!await page.evaluate(()=>document.body.classList.contains('dark')))throw Error('Dark toggle failed');}
   for(const layout of ['single','split2','split3','grid4']) {
    await page.click(`.layout-btn[data-layout="${layout}"]`);
    await shot(page,'layout-'+layout,variant,size,errors);
   }
   await page.click('.layout-btn[data-layout="single"]');
   await page.click('#settingsBtn');
   await shot(page,'settings',variant,size,errors);
   await page.click('#closeSettings');
   await page.click('#articleVocabBtn');
   await shot(page,'article-vocab',variant,size,errors);
   await page.keyboard.press('Escape');
   for(const chart of charts) {
    await page.locator('.tile[data-tile="0"] .chart-selector').selectOption(chart);
    await page.waitForTimeout(200);
    await shot(page,'chart-'+chart,variant,size,errors);
   }
   await page.click('.tile[data-tile="0"] .tile-fullscreen');
   await shot(page,'tile-fullscreen',variant,size,errors);
   await page.keyboard.press('Escape');
   await attempt('companion '+variant+' '+size,async()=>{
    await page.click('#companionModeBtn',{timeout:3000});
    await page.waitForTimeout(400);
    await shot(page,'companion-NO-MODEL-NOT-PROOF',variant,size,errors);
    await page.reload({waitUntil:'load'});
    await page.waitForTimeout(300);
    if(await page.locator('#welcomeSettingsBtn').isVisible()){await page.click('#welcomeSettingsBtn');await page.click('#closeSettings');}
   });
   await attempt('study login '+variant+' '+size,async()=>{
    await page.locator('.tile[data-tile="0"] .chart-selector').selectOption('study-web');
    const iframe=page.locator('.tile[data-tile="0"] iframe');
    await iframe.waitFor({state:'attached',timeout:10000});
    await page.waitForTimeout(3000);
    await shot(page,'study-UNAUTHENTICATED',variant,size,errors);
    const frames=[];
    for(const f of page.frames().filter(f=>f!==page.mainFrame())) {try {frames.push(await f.evaluate(()=>({url:location.href,htmlClass:document.documentElement.className,text:document.body.innerText.slice(0,1500),links:[...document.querySelectorAll('link[rel="stylesheet"]')].map(l=>({id:l.id,href:l.getAttribute('href')})),scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth})));}catch(e){frames.push({error:String(e)});}}
    writeJson(`frames@${variant}@${size.join('x')}.json`,frames);
   });
  } catch(e){failures.push({label:variant+' '+size,error:String(e)});console.log('CONFIG FAILED',variant,size,String(e).slice(0,180));}
  finally{await context.close();report();}
 }
 }finally {await browser.close();report();}
 console.log('BASELINE_DONE',rows.length,'failures',failures.length,'out',OUT);
 const summary=validateMatrix(OUT,{rows,failures});
 console.log(JSON.stringify(summary,null,2));
 process.exitCode=summary.ok?0:1;
})().catch(e=>{console.error(e);process.exitCode=1;});
