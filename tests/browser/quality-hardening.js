'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const scripts = ['ui-style', 'api', 'dashboard-core', 'charts', 'layout', 'study-shortcuts', 'study-lifecycle', 'study-content-editor', 'study-web', 'diary', 'live2d-companion'];
const study = '<!doctype html><body><div class="taro_page taro_page_show"><div class="rev-root"><div class="rev-top"><div class="wordspell" data-word="apple">apple</div></div></div></div><script>window.answers=0;document.addEventListener("keydown",e=>{if(e.key==="1")answers++})</script>';
const fixture = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/css/diary.css"></head><body>
<div id="dashboard"><div id="study"></div><div id="second"></div><div class="tile" data-tile="0" style="height:500px;min-height:500px;width:800px"><div id="chart-0" class="chart-container" style="height:500px"></div></div></div>
<div id="fullscreenModal" class="fullscreen-modal" style="height:600px"><button id="closeFullscreen" class="fullscreen-close">close</button><div id="fullscreenChart" class="fullscreen-chart" style="height:550px"></div></div>
<button id="companionModeBtn">companion</button><div id="companionStudy" hidden><button id="exitCompanionModeBtn">exit</button><button id="companionAskBtn">ask</button><div id="companionStudyFrame"></div><div id="companionLive2DHost" style="height:400px"><canvas id="companionLive2DCanvas"></canvas><img id="companionGifFallback"></div><span id="companionModelName"></span><p id="companionBubble"></p><p id="companionCurrentWord"></p><div id="companionSummary"></div><div id="companionBirthdayCard" hidden><button id="closeCompanionBirthdayCard">close</button></div></div>
<script>localStorage.clear();localStorage.setItem('token','fixture');window.chartOptions={};window.echarts={init(el){return {setOption(o){chartOptions[el.id]=o},getOption(){return chartOptions[el.id]},dispose(){el.innerHTML=''},resize(){}}}};</script>
${scripts.map(s => '<script src="/js/' + s + '.js"></script>').join('')}
<script>
window.test={creates:0,deletes:0,updates:0,profile:'A',epoch:0,createFails:true,modelsPending:[],aiPending:[],deferModels:false,deferAI:false};
window.fetch=async function(url,options={}){
 const ok=data=>({ok:true,status:200,json:async()=>data}); const fail=(status,error)=>({ok:false,status,json:async()=>({error})});
 if(url==='/api/maimemo-auth/status')return ok({connected:true,profile_id:test.profile,mode:'manual'});
 if(url==='/api/study-records')return ok({records:[{voc_id:'a',voc_spelling:'constructor',last_study_date:'2026-10-07T23:59:59.999+08:00'},{voc_id:'b',voc_spelling:'next',last_study_date:'2026-10-08T00:00:00+08:00'}]});
 if(url==='/api/live2d/models'){if(test.deferModels)return new Promise(r=>test.modelsPending.push(r));return ok({models:[],role_binding:{enforced:true,ready:false}})}
 if(url==='/proxy/ai'){
  test.lastAI=JSON.parse(options.body);
  if(test.deferAI)return new Promise(r=>test.aiPending.push(r));
  const words=test.lastAI.body.messages[1].content.split('单词列表：')[1].split(String.fromCharCode(10))[0].split(', ');
  return ok({choices:[{message:{content:JSON.stringify({'其他':words})}}]});
 }
 if(url.startsWith('/proxy/memo/vocabulary'))return ok({success:true,data:{voc:{id:'word-a'}}});
 if(url.startsWith('/proxy/memo/interpretations')){
  if(options.method==='DELETE'){test.deletes++;return ok({success:true,data:{}})}
  if(options.method==='POST'){
   if(url.endsWith('/public')){test.updates++;return fail(403,'权限不足')}
   test.creates++;if(test.createFails)return fail(429,'稍后重试');
   return ok({success:true,data:{interpretation:{id:'mine'}}});
  }
  return ok({success:true,data:{interpretations:[{id:test.createFails?'public':'mine',interpretation:'public definition',tags:[]}]}});
 }
 if(url.startsWith('/proxy/memo/notes'))return ok({success:true,data:{notes:[]}});
 throw new Error('Unexpected fixture request '+url);
};
window.TTS={stop(){test.stops=(test.stops||0)+1},isReady(){return false},getStatus(){return {}},preload(){return Promise.resolve(false)}};
window.reports=[];window.ready=MaimemoAPI.refreshConnection().then(()=>{window.instance=StudyWeb.render('study',{onStudyEvent:e=>reports.push(e)});Live2DCompanion.init()});
</script></body></html>`;
const server = http.createServer((req, res) => {
 const url = new URL(req.url, 'http://localhost');
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(fixture)}
 if(url.pathname.startsWith('/memo-tc/')){res.setHeader('Content-Type','text/html');return res.end(study)}
 if(/^\/(js|css)\/[a-z0-9-]+\.(js|css)$/.test(url.pathname)){
  res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':'text/css');
  return res.end(fs.readFileSync(path.join(root,url.pathname)));
 }
 res.statusCode=404;res.end();
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true,...(process.env.MEMO_BROWSER_CHANNEL?{channel:process.env.MEMO_BROWSER_CHANNEL}:{executablePath:process.env.EDGE_PATH||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'})});
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(()=>ready);
  await page.waitForSelector('#study[data-study-screen-active="true"]');
  assert.equal(await page.locator('#study iframe').getAttribute('title'),'墨墨背单词学习与账号登录');
  await page.locator('#study .study-content-edit-trigger').click();
  await page.locator('[data-editor-action="copy"]').click();
  const input=page.locator('textarea[name="interpretation"]');await input.fill('my draft');await input.press('End');await input.press('Space');await input.press('x');
  assert.equal(await input.inputValue(),'my draft x');assert.equal(await page.evaluate(()=>reports.filter(e=>e.type==='answer').length),0);
  await page.locator('[data-editor-form] button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('[data-editor-status]').dataset.state==='error');
  assert.equal(await input.inputValue(),'my draft x','429 must preserve the edited draft');
  await page.evaluate(()=>test.createFails=false);await page.locator('[data-editor-form] button[type="submit"]').click();
  await page.waitForSelector('[data-content-id="mine"]');
  page.once('dialog',d=>d.dismiss());await page.locator('[data-editor-action="delete"]').click();assert.equal(await page.evaluate(()=>test.deletes),0);
  page.once('dialog',d=>d.accept());await page.locator('[data-editor-action="delete"]').click();await page.waitForFunction(()=>test.deletes===1);
  await page.evaluate(()=>{document.querySelector('#study [data-close-content-editor]').click();test.profile='B';MaimemoAPI.refreshConnection()});
  await page.waitForFunction(()=>MaimemoAPI.connectionStatus().profile_id==='B');assert.equal(await page.locator('#study .study-content-editor').isVisible(),false);
  // A hidden earlier tile must not steal the visible tile's answer key.
  await page.evaluate(()=>{instance.dispose();document.querySelector('#study').style.display='none';window.secondInstance=StudyWeb.render('second',{onStudyEvent:e=>reports.push(e)})});
  await page.waitForSelector('#second[data-study-screen-active="true"]');await page.locator('body').click({position:{x:1,y:1}});await page.keyboard.press('1');
  assert.equal(await page.evaluate(()=>reports.filter(e=>e.type==='answer').length),1);
  // Recommendation refresh arriving after disposal must not replace another chart.
  await page.evaluate(()=>{RecommendAPI.getToday=async()=>({recommendations:[{id:'1" onclick="window.injected=true',word:'<img src=x onerror="window.injected=true">',level:'high" onclick="window.injected=true',level_color:'red;" onclick="window.injected=true',risk_score:'<img src=x>'}],summary:{}});ChartManager.render(0,'recommend')});
  await page.waitForSelector('.rec-card');
  assert.equal(await page.locator('.rec-card [onclick], .rec-card img').count(),0);
  assert.equal(await page.locator('.rec-score').textContent(),'0');
  await page.evaluate(()=>{RecommendAPI.getToday=async()=>({recommendations:[],summary:{}});ChartManager.render(0,'recommend')});
  await page.waitForSelector('.rec-refresh');
  await page.evaluate(()=>{RecommendAPI.getToday=()=>new Promise(r=>window.finishRecommendation=r);document.querySelector('.rec-refresh').click();ChartManager.disposeAll();document.getElementById('chart-0').textContent='replacement'});
  await page.evaluate(()=>finishRecommendation({recommendations:[],summary:{}}));assert.equal(await page.locator('#chart-0').textContent(),'replacement');
  // The original recommendation DOM and listener survive fullscreen and restoration.
  await page.evaluate(()=>{RecommendAPI.getToday=async()=>({recommendations:[],summary:{}});ChartManager.render(0,'recommend')});await page.waitForSelector('.rec-refresh');
  await page.evaluate(()=>{window.original=document.getElementById('chart-0');window.clicks=0;original.querySelector('.rec-refresh').addEventListener('click',()=>clicks++);LayoutManager.openFullscreen(0)});
  await page.waitForSelector('#fullscreenChart #chart-0');await page.locator('#fullscreenChart .rec-refresh').click();assert.equal(await page.evaluate(()=>clicks),1);
  await page.evaluate(()=>LayoutManager.closeFullscreen());assert.equal(await page.evaluate(()=>original===document.querySelector('.tile #chart-0')),true);
  await page.evaluate(()=>ChartManager.render(0,'diary'));
  await page.locator('.md-day-card').first().focus();await page.keyboard.press('Enter');await page.waitForSelector('.mydiary.is-detail',{state:'attached'});
  assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('md-back')),true);
  await page.evaluate(()=>{window.originalDiary=document.getElementById('chart-0');LayoutManager.openFullscreen(0)});await page.waitForSelector('#fullscreenChart .mydiary.is-detail');
  await page.evaluate(()=>LayoutManager.closeFullscreen());await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>originalDiary===document.querySelector('.tile #chart-0')),true);
  await page.locator('.md-back').click();assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('md-day-card')),true);
  const datedWords=await page.evaluate(()=>MaimemoAPI.getWordsFromStudyRecords('2026-10-07','2026-10-07','last_study_date',false));
  assert.deepEqual(datedWords.map(item=>item.word),['constructor']);
  // AI sends at most 200 distinct words and reports all omitted inputs.
  const counts=await page.evaluate(async()=>{AIAPI.setConfig({provider:'codex'});const result=await AIAPI.classifyWords(Array.from({length:250},(_,i)=>'word'+i));return result.statistics});
  assert.deepEqual(counts,{requested:250,submitted:200,classified:200,omitted:50});
  // Exercise the production App request boundary without starting its settings UI.
  const appSource=fs.readFileSync(path.join(root,'js/app.js'),'utf8');
  assert(appSource.includes('return { init };'));
  await page.addScriptTag({content:appSource.replace('return { init };','return { init, __testSetupAI: setupAIClassifyButton };')});
  await page.evaluate(()=>{document.body.insertAdjacentHTML('beforeend','<div class="tile"><div class="ai-toolbar"><select class="ai-source-select"><option value="notepad">notepad</option><option value="study">study</option></select><button class="ai-btn">classify</button><span class="ai-status"></span></div></div>');MaimemoAPI.getAllNotepadWords=async()=>[{word:'apple'}];AIAPI.classifyWords=()=>new Promise((resolve,reject)=>{window.finishClassify=resolve;window.failClassify=reject});App.__testSetupAI()});
  for(const changed of ['account','config','selection']){
   await page.locator('.ai-source-select').selectOption('notepad');await page.locator('.ai-btn').click();await page.waitForFunction(()=>typeof finishClassify==='function');
   await page.evaluate(async changed=>{if(changed==='account'){test.profile='C';await MaimemoAPI.refreshConnection()}if(changed==='config')AIAPI.setConfig({model:'changed-model'});if(changed==='selection')document.querySelector('.ai-source-select').value='study';if(changed==='selection')failClassify(new Error('late failure'));else finishClassify({'其他':['apple'],statistics:{requested:1,submitted:1,classified:1,omitted:0}});window.finishClassify=null},changed);
   await page.waitForFunction(()=>!document.querySelector('.ai-btn').disabled);
   assert.equal(await page.evaluate(()=>localStorage.getItem('ai_classification_cache')),null);
   assert.equal((await page.locator('.ai-status').textContent()).includes('分类完成'),false);
   assert.equal((await page.locator('.ai-status').textContent()).includes('✓ 输入'),false);
   assert.equal(await page.locator('.ai-status').textContent(),'条件已变更，请重新分类');
   assert.equal((await page.locator('.ai-status').textContent()).includes('late failure'),false);
  }
  await page.evaluate(()=>{test.deferModels=true;window.oldModels=Live2DModelManager.loadModels();window.newModels=Live2DModelManager.loadModels()});
  await page.waitForFunction(()=>test.modelsPending.length===2);
  await page.evaluate(()=>test.modelsPending[1]({ok:true,json:async()=>({models:[],role_binding:{enforced:true,ready:true,active_role_id:'B',active_role_name:'Role B'}})}));await page.evaluate(()=>newModels);
  await page.evaluate(()=>test.modelsPending[0]({ok:true,json:async()=>({models:[],role_binding:{enforced:true,ready:true,active_role_id:'A',active_role_name:'Role A'}})}));await page.evaluate(()=>oldModels);
  assert.equal(await page.evaluate(()=>Live2DModelManager.roleName()),'Role B');await page.evaluate(()=>test.modelsPending=[]);
  // Exiting during model-list fetch must not construct a late study instance.
  await page.evaluate(()=>{test.deferModels=true;window.entering=Live2DCompanion.enter()});await page.waitForFunction(()=>test.modelsPending.length===1);
  await page.evaluate(()=>{Live2DCompanion.exit();test.modelsPending.shift()({ok:true,json:async()=>({models:[],role_binding:{enforced:true,ready:false}})})});await page.evaluate(()=>entering);
  assert.equal(await page.locator('#companionStudyFrame iframe').count(),0);assert.equal(await page.evaluate(()=>Live2DCompanion.isOpen()),false);
  // A reply from a departed session remains ignored even if its fetch ignores abort.
  await page.evaluate(()=>{test.deferModels=false;test.deferAI=true;window.entering=Live2DCompanion.enter()});await page.evaluate(()=>entering);
  await page.locator('#companionAskBtn').click();await page.waitForFunction(()=>test.aiPending.length>0);
  const previous=await page.locator('#companionBubble').textContent();await page.evaluate(()=>{Live2DCompanion.exit();test.aiPending.shift()({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({text:'old session must not speak',mood:'cheer'})}}]})})});
  await page.waitForTimeout(100);assert.equal(await page.locator('#companionBubble').textContent(),previous);
  assert.deepEqual(errors,[]);console.log('QUALITY_BROWSER_PASS: editor draft/copy/save/delete, account switch, shortcut owner, disposal, fullscreen identity, AI coverage and companion late callbacks');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
