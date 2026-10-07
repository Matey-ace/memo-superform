const fs=require('fs'),path=require('path'),assert=require('assert');
const {spawn}=require('child_process');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../..');
const output=path.join(root,'_verification');fs.mkdirSync(output,{recursive:true});
(async()=>{
 let browser,child=spawn('python',[path.join(__dirname,'dashboard-server.py')],{cwd:root,windowsHide:true});
 try{
  const base=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('Server startup timeout')),15000);child.stdout.on('data',chunk=>{text+=chunk;const match=text.match(/DASHBOARD_URL=(\S+)/);if(match){clearTimeout(timer);resolve(match[1])}});child.on('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code))})});
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const results=[];
  for(const [style,theme] of [['standard','light'],['standard','dark'],['notebook','light']]){
   const context=await browser.newContext({viewport:{width:1280,height:800}}),page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(({style,theme})=>{localStorage.setItem('memo_ui_style',style);localStorage.setItem('theme',theme)}, {style,theme});
   await page.route('**/memo-**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body>Offline study fixture</body></html>'}));
   await page.route('**/api/app/update-status*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({current_version:'0.88',update_available:false,can_download:false,download:{state:'idle'}})}));
   await page.goto(base+'/index.html',{waitUntil:'networkidle'});
   await page.waitForTimeout(200);
   assert.equal(await page.evaluate(()=>typeof MaimemoAPI.refreshConnection),'function');
   for(const width of [1280,960,640]){
    await page.setViewportSize({width,height:800});
    for(const zoom of [1,1.25,1.5,2]){
     await page.evaluate(zoom=>document.body.style.zoom=String(zoom),zoom);
     await page.waitForTimeout(50);
     const visible=await page.locator('#settingsBtn').isVisible();
     assert(visible,'Settings must remain present');
     results.push({style,theme,width,zoom});
    }
   }
   await page.evaluate(()=>document.body.style.zoom='1');await page.setViewportSize({width:1280,height:800});
   await page.screenshot({path:path.join(output,`dashboard-${style}-${theme}.png`),fullPage:true});
   await page.locator('#welcomeSettingsBtn').click();await page.waitForSelector('#settingsPanel.show');await page.locator('#closeSettings').click();assert.equal(await page.evaluate(()=>document.activeElement.id),'settingsBtn');
   assert.deepEqual(errors,[]);
   await context.close();
  }
  fs.writeFileSync(path.join(output,'dashboard-smoke.json'),JSON.stringify({passed:true,scenarios:results},null,2));
  console.log('DASHBOARD_SMOKE_PASS: actual source server and application startup, 3 themes x 3 widths x 4 zooms');
 }finally{if(browser)await browser.close();if(child.exitCode===null){await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve()},3000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.stdin.end('exit\n')})}}
})().catch(e=>{console.error(e);process.exitCode=1});
