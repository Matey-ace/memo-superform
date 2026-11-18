'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { observeHeadReadiness } = require('./head-readiness-observer.cjs');
const ORIGIN = 'http://127.0.0.1:55395';
const dom = () => ({ serverStatusCount: 1, serverOnline: true, serverChecking: false, serverOffline: false, welcomeVisible: true, expectedShape: true });
function setup() {
  const page = new EventEmitter(), frame = {};
  page.mainFrame = () => frame;
  let time = 0;
  const observer = observeHeadReadiness(page, { origin: ORIGIN, now: () => ++time });
  const inspect = observer.inspect.bind(observer);
  observer.inspect = async read => { await Promise.resolve(); return inspect(read); };
  const req = (overrides = {}) => ({ url: () => ORIGIN + '/index.html', method: () => 'HEAD', frame: () => frame,
    headers: () => ({}), allHeaders: async () => ({}), isNavigationRequest: () => false, redirectedFrom: () => null, redirectedTo: () => null, ...overrides });
  const nav = () => {
    page.emit('request', req({ method: () => 'GET', isNavigationRequest: () => true }));
    page.emit('framenavigated', frame);
  };
  const head = (overrides, status = 200) => {
    const request = req(overrides);
    page.emit('request', request);
    page.emit('response', { request: () => request, status: () => status });
  };
  return { page, observer, req, nav, head };
}
test('response and fresh DOM pass without requestfinished', async () => {
  const s=setup(); s.nav(); s.head(); assert.equal((await s.observer.inspect(dom)).ready,true); s.observer.dispose();
});
test('request alone never passes', async () => {
  const s=setup(); s.nav(); s.page.emit('request',s.req()); assert.equal((await s.observer.inspect(dom)).ready,false); s.observer.dispose();
});
const cases = [
  ['response before navigation', s=>s.head()],
  ['second navigation', s=>{s.nav();s.head();s.nav();}],
  ['HTTP failure', s=>{s.nav();s.head({},500);}],
  ['HEAD redirect', s=>{s.nav();s.head({redirectedFrom:()=>({})});}],
  ['credential header', s=>{s.nav();s.head({allHeaders:async()=>({authorization:'NOT_A_REAL_TOKEN'})});}],
  ['subframe response', s=>{s.nav();s.head({frame:()=>({})});}],
  ['duplicate response', s=>{s.nav();s.head();s.head();}],
  ['page exception', s=>{s.nav();s.head();s.page.emit('pageerror',new Error('synthetic'));}],
  ['HEAD request failure', s=>{s.nav();s.head();s.page.emit('requestfailed',s.req());}],
  ['closed page', s=>{s.nav();s.head();s.page.emit('close');}],
  ['crashed page', s=>{s.nav();s.head();s.page.emit('crash');}],
  ['foreign HEAD ignored', s=>{s.nav();s.head({url:()=> 'https://example.invalid/index.html'});}],
  ['GET ignored', s=>{s.nav();s.head({method:()=> 'GET'});}],
  ['wrong shape', s=>{s.nav();s.head();}]
];
for (const [name,act] of cases) test('rejects '+name,async()=>{
  const s=setup();act(s); const decision=await s.observer.inspect(()=>({...dom(),expectedShape:name!=='wrong shape'}));
  assert.equal(decision.ready,false);s.observer.dispose();
});
test('page error during async DOM read cannot race into pass',async()=>{
  const s=setup();s.nav();s.head(); const d=await s.observer.inspect(async()=>{s.page.emit('pageerror');return dom();});
  assert.equal(d.ready,false);s.observer.dispose();
});
test('navigation during async DOM read cannot race into pass',async()=>{
  const s=setup();s.nav();s.head(); const d=await s.observer.inspect(async()=>{s.nav();return dom();});
  assert.equal(d.ready,false);s.observer.dispose();
});
test('DOM read failure stays failed',async()=>{
  const s=setup();s.nav();s.head();assert.equal((await s.observer.inspect(()=>{throw Error('synthetic');})).ready,false);
  assert.equal((await s.observer.inspect(dom)).ready,false);s.observer.dispose();
});
test('dispose removes all listeners and prevents further readiness',async()=>{
  const s=setup();s.nav();s.head();s.observer.dispose();s.observer.dispose();
  for(const e of ['request','framenavigated','response','requestfailed','pageerror','close','crash'])assert.equal(s.page.listenerCount(e),0);
  assert.equal((await s.observer.inspect(dom)).ready,false);
});
test('hidden Cookie in complete headers rejects readiness', async()=>{
  const s=setup();s.nav();s.head({headers:()=>({}),allHeaders:async()=>({cookie:'SYNTHETIC'})});
  assert.equal((await s.observer.inspect(dom)).ready,false);s.observer.dispose();
});
test('pre-startup HEAD cannot be rebound to startup',async()=>{
  const s=setup(),h=s.req();s.page.emit('request',h);s.nav();
  s.page.emit('response',{request:()=>h,status:()=>200});
  assert.equal((await s.observer.inspect(dom)).ready,false);s.observer.dispose();
});
test('HEAD before initial commit is rejected',async()=>{
  const s=setup();s.page.emit('request',s.req({method:()=> 'GET',isNavigationRequest:()=>true}));
  s.head();s.page.emit('framenavigated',s.page.mainFrame());
  assert.equal((await s.observer.inspect(dom)).ready,false);s.observer.dispose();
});
for(const event of ['framenavigated','pageerror','dispose','requestfailed'])test('delayed DOM read rejects '+event,async()=>{
  const s=setup();s.nav();s.head();await Promise.resolve();
  let resolve;const pending=s.observer.inspect(()=>new Promise(r=>{resolve=r;}));
  await Promise.resolve();
  if(event==='dispose')s.observer.dispose();
  else s.page.emit(event,event==='framenavigated'?s.page.mainFrame():s.req());
  resolve(dom());assert.equal((await pending).ready,false);s.observer.dispose();
});
for(const event of ['framenavigated','pageerror','dispose'])test('delayed complete headers cannot pass after '+event,async()=>{
  const s=setup();s.nav();let resolve;
  s.head({allHeaders:()=>new Promise(r=>{resolve=r;})});
  if(event==='dispose')s.observer.dispose();else s.page.emit(event,s.page.mainFrame());
  resolve({});await Promise.resolve();
  assert.equal((await s.observer.inspect(dom)).ready,false);s.observer.dispose();
});
test('second response with delayed headers cannot use earlier success',async()=>{
  const s=setup();s.nav();s.head();await Promise.resolve();let resolve;
  s.head({allHeaders:()=>new Promise(r=>{resolve=r;})});
  assert.equal((await s.observer.inspect(dom)).ready,false);
  // Duplicate rejection happens before the asynchronous header reader is invoked.
  assert.equal(resolve,undefined);s.observer.dispose();
});
test('second response during DOM await invalidates earlier success',async()=>{
  const s=setup();s.nav();s.head();await Promise.resolve();
  let resolve;const pending=s.observer.inspect(()=>new Promise(r=>{resolve=r;}));await Promise.resolve();
  s.head({allHeaders:async()=>({cookie:'SYNTHETIC'})});resolve(dom());
  assert.equal((await pending).ready,false);s.observer.dispose();
});
test('separate observers do not share events',async()=>{
  const a=setup(),b=setup();a.nav();a.head();assert.equal((await a.observer.inspect(dom)).ready,true);
  assert.equal((await b.observer.inspect(dom)).ready,false);a.observer.dispose();b.observer.dispose();
});
