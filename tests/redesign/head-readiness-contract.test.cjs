'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { headReadiness } = require('./head-readiness-contract.cjs');
const fixture = () => ({
  expectedPage: 'page-1', expectedNavigation: 'navigation-1', pageErrors: 0, credentialRejected: false, requestFailed: false,
  response: { page: 'page-1', navigation: 'navigation-1', method: 'HEAD', path: '/index.html', sameOrigin: true, credentialFree: true, redirected: false, status: 200, observedAt: 10 },
  dom: { page: 'page-1', navigation: 'navigation-1', observedAt: 11, serverStatusCount: 1, serverOnline: true, serverChecking: false, serverOffline: false, welcomeVisible: true, expectedShape: true }
});

test('successful response plus app state does not require requestfinished', () => {
  const o = fixture(); o.requestFinished = false;
  assert.equal(headReadiness(o).ready, true);
});
const rejected = [
  ['route hit alone', o => { delete o.response; o.routeHit = true; }],
  ['requestfinished alone', o => { delete o.response; o.requestFinished = true; }],
  ['online DOM alone', o => { delete o.response; }],
  ['response without DOM', o => { delete o.dom; }],
  ['GET instead of HEAD', o => { o.response.method = 'GET'; }],
  ['different public path', o => { o.response.path = '/'; }],
  ['cross-origin response', o => { o.response.sameOrigin = false; }],
  ['credentials present', o => { o.response.credentialFree = false; }],
  ['redirected response', o => { o.response.redirected = true; }],
  ['HTTP error', o => { o.response.status = 500; }],
  ['redirect status', o => { o.response.status = 302; }],
  ['missing status', o => { delete o.response.status; }],
  ['different response page', o => { o.response.page = 'page-2'; }],
  ['different DOM page', o => { o.dom.page = 'page-2'; }],
  ['previous response navigation', o => { o.response.navigation = 'navigation-0'; }],
  ['previous DOM navigation', o => { o.dom.navigation = 'navigation-0'; }],
  ['missing expected page', o => { delete o.expectedPage; }],
  ['missing expected navigation', o => { delete o.expectedNavigation; }],
  ['DOM predates response', o => { o.dom.observedAt = 9; }],
  ['invalid timestamp', o => { o.response.observedAt = NaN; }],
  ['duplicate status nodes', o => { o.dom.serverStatusCount = 2; }],
  ['status checking', o => { o.dom.serverChecking = true; }],
  ['status offline', o => { o.dom.serverOffline = true; }],
  ['not online', o => { o.dom.serverOnline = false; }],
  ['welcome missing', o => { o.dom.welcomeVisible = false; }],
  ['wrong controls', o => { o.dom.expectedShape = false; }],
  ['request failed', o => { o.requestFailed = true; }],
  ['missing request failure observation', o => { delete o.requestFailed; }],
  ['page error', o => { o.pageErrors = 1; }],
  ['missing page error observation', o => { delete o.pageErrors; }],
  ['credential rejection', o => { o.credentialRejected = true; }],
  ['missing safety observation', o => { delete o.credentialRejected; }]
];
for (const [name, change] of rejected) test('rejects ' + name, () => {
  const o = fixture(); change(o);
  assert.equal(headReadiness(o).ready, false);
});
test('rejects absent observation', () => assert.equal(headReadiness(null).ready, false));
test('decision leaves evidence unchanged', () => {
  const o = fixture(), before = JSON.stringify(o);
  headReadiness(o); assert.equal(JSON.stringify(o), before);
});
