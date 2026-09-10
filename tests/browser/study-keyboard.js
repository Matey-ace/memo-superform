'use strict';
// Run with Playwright available through NODE_PATH; EDGE_PATH may override the browser.
const {chromium} = require('playwright');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const {execFileSync} = require('child_process');
const root = path.resolve(__dirname, '../..');
const injection = execFileSync(process.env.PYTHON || 'python', ['-c', 'from memo_injection import MEMO_STUDY_KEYS_JS; print(MEMO_STUDY_KEYS_JS)'], {cwd: root, encoding: 'utf8'});
const study = `<!doctype html><head>${injection}<style>.hidden{display:none}</style></head><body>
<div class="taro_page taro_page_show"><div class="rev-root"><div class="rev-top"><span data-word="first">first</span></div>
<div class="ask-spelling"><button class="reset-button">验证拼写</button></div>
<div class="verify-input hidden"><input></div><input id="search"><button id="other">Other</button></div></div>
<script>
window.starts=0; window.answers=0; window.waiting=true;
const input=document.querySelector('.verify-input input');
document.querySelector('.reset-button').onclick=()=>{starts++;waiting=false;document.querySelector('.verify-input').classList.remove('hidden');input.focus()};
// Reproduce the upstream keyup handler, including its event.key input seed.
document.addEventListener('keyup',event=>{
 if(event.key===' '&&waiting){input.value=event.key;document.querySelector('.reset-button').click()}
 if(event.key==='Enter'&&!waiting)input.value='';
 if(event.key==='Escape'&&!waiting){waiting=true;input.blur();document.querySelector('.verify-input').classList.add('hidden')}
 if(event.key==='1'){answers++;document.querySelector('[data-word]').setAttribute('data-word','next')}
});
window.reset=()=>{waiting=true;input.value='';input.blur();document.querySelector('.verify-input').classList.add('hidden');starts=0;answers=0;document.querySelector('[data-word]').setAttribute('data-word','first')};
</script></body>`;
const host = `<!doctype html><body><div id="study"></div><script>localStorage.clear();localStorage.setItem('token','local-test-fixture');window.reports=[];</script>
<script src="/js/study-shortcuts.js"></script><script src="/js/study-lifecycle.js"></script><script src="/js/study-web.js"></script>
<script>window.instance=StudyWeb.render('study',{onStudyEvent:e=>reports.push(e)});</script></body>`;
const server = http.createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(host)}
 if(req.url.startsWith('/memo-tc/webstudy/app')){res.setHeader('Content-Type','text/html');return res.end(study)}
 if(/^\/js\/[a-z-]+\.js$/.test(req.url)){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(root,req.url)))}
 res.statusCode=404;res.end();
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try {
  browser=await chromium.launch({headless:true, executablePath:process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const page=await browser.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('#study[data-study-screen-active="true"]');
  const frame=page.frames().find(f=>f.url().includes('/memo-tc/'));
  async function reset(){await frame.evaluate(()=>reset());await page.evaluate(()=>reports=[])}
  // Physical space inside the iframe must enter spelling with an empty value.
  await frame.locator('[data-word]').click();
  await page.keyboard.press('Space');
  assert.equal(await frame.locator('.verify-input input').inputValue(),'');
  assert.equal(await frame.evaluate(()=>starts),1);
  await page.keyboard.type('ice cream');
  assert.equal(await frame.locator('.verify-input input').inputValue(),'ice cream');
  await page.keyboard.press('Enter');
  assert.equal(await frame.locator('.verify-input input').inputValue(),'');
  await page.keyboard.press('Escape');
  assert.equal(await frame.evaluate(()=>waiting),true);
  await reset();
  // Parent shortcuts use a synthetic event pair; both paths must stay empty.
  await page.locator('body').click({position:{x:1,y:1}});
  await page.keyboard.press('Space');
  assert.equal(await frame.locator('.verify-input input').inputValue(),'');
  assert.equal(await frame.evaluate(()=>starts),1);
  assert.equal(await page.evaluate(()=>reports.filter(e=>e.type==='answer').length),0);
  await reset();
  await frame.locator('[data-word]').click();
  await page.keyboard.down('Space');
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  assert.equal(await frame.evaluate(()=>starts),1);
  assert.equal(await frame.locator('.verify-input input').inputValue(),'');
  await reset();
  await frame.locator('#search').fill('ice');
  await page.keyboard.press('End');await page.keyboard.press('Space');await page.keyboard.type('cream');
  assert.equal(await frame.locator('#search').inputValue(),'ice cream');
  assert.equal(await frame.evaluate(()=>starts),0);
  await reset();
  await page.locator('.study-web-btn[data-action="FAMILIAR"]').click();
  assert.equal(await frame.evaluate(()=>answers),1,'one button click must answer once');
  assert.deepEqual(await page.evaluate(()=>reports.filter(e=>e.type==='answer')), [{type:'answer',action:'FAMILIAR',word:'first'}]);
  await reset();
  await page.locator('body').click({position:{x:1,y:1}});await page.keyboard.press('s');
  assert.equal(await page.evaluate(()=>reports.filter(e=>e.type==='answer').length),0);
  await page.locator('.study-shortcut-toggle').click();
  const first=page.locator('[data-shortcut="FAMILIAR"]');await first.focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.shortcut),'VAGUE');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.study-shortcut-toggle').getAttribute('aria-expanded'),'false');
  // A custom start key is read live and survives navigation.
  await page.evaluate(()=>{const m=StudyShortcuts.loadShortcuts();m.START_SPELLING={key:'F2',modifiers:[],enabled:true};StudyShortcuts.saveShortcuts(m)});
  await frame.locator('[data-word]').click();await page.keyboard.press('F2');
  assert.equal(await frame.evaluate(()=>starts),1);
  assert.equal(await frame.locator('.verify-input input').inputValue(),'');
  await frame.goto(frame.url());
  assert.equal(await frame.evaluate(()=>JSON.parse(localStorage.getItem('shortcut_settings')).shortcuts.START_SPELLING.key),'F2');
  await frame.locator('[data-word]').click();await page.keyboard.press('F2');
  assert.equal(await frame.evaluate(()=>starts),1);
  // Composition events and hidden/inactive pages must never start spelling.
  await reset();
  await frame.evaluate(()=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',code:'F2',isComposing:true,bubbles:true,cancelable:true})));
  assert.equal(await frame.evaluate(()=>starts),0);
  await frame.evaluate(()=>document.querySelector('.taro_page').classList.add('taro_page_shade'));
  await frame.locator('[data-word]').click();await page.keyboard.press('F2');
  assert.equal(await frame.evaluate(()=>starts),0);
  assert.deepEqual(errors,[]);
  console.log('STUDY_BROWSER_PASS: native/synthetic space, phrase input, repeat, search, single answer, statistics, Tab/Esc, remapping, reload, IME and inactive page');
 } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve))}
})().catch(e=>{console.error(e);process.exitCode=1});
