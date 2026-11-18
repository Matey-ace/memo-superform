'use strict';
const { headReadiness } = require('./head-readiness-contract.cjs');

// Attach before goto. One observer is valid for exactly one startup navigation.
function observeHeadReadiness(page, { origin, now = () => performance.now() }) {
  const base = new URL(origin);
  if (base.origin !== origin || base.username || base.password) throw Error('EXACT_ORIGIN_REQUIRED');
  let navigation = null, response = null, failure = null, disposed = false;
  let pageErrors = 0, requestFailed = false, credentialRejected = false;
  const requestNavigations = new WeakMap();
  let committed = false, headResponses = 0;
  function onFrameNavigated(frame) {
    if (frame !== page.mainFrame()) return;
    if (!navigation || committed) return fail('UNEXPECTED_FRAME_NAVIGATION');
    committed = true;
  }
  const fail = code => { if (!failure) failure = code; };
  function publicHead(req) {
    try { const u = new URL(req.url()); return req.method() === 'HEAD' && u.origin === origin && u.pathname === '/index.html' && !u.search && !u.hash && !u.username && !u.password; }
    catch (_) { return false; }
  }
  function main(req) { try { return req.frame() === page.mainFrame(); } catch (_) { return false; } }
  function onRequest(req) {
    if (!main(req)) return;
    if (!req.isNavigationRequest()) {
      if (publicHead(req)) requestNavigations.set(req, committed ? navigation : null);
      return;
    }
    if (navigation) return fail('ADDITIONAL_NAVIGATION');
    const u = new URL(req.url());
    if (u.origin !== origin || !['/', '/index.html'].includes(u.pathname) || u.search || u.hash || req.redirectedFrom()) return fail('STARTUP_NAVIGATION_REJECTED');
    navigation = req;
  }
  function onPageError() { pageErrors++; fail('PAGE_ERROR'); }
  function onFailed(req) { if (main(req) && publicHead(req)) { requestFailed = true; fail('HEAD_REQUEST_FAILED'); } }
  function onClose() { fail('PAGE_CLOSED'); }
  function onCrash() { fail('PAGE_CRASHED'); }
  async function onResponse(res) {
    try {
      const req = res.request();
      if (!publicHead(req)) return;
      headResponses++;
      if (headResponses !== 1) return fail('DUPLICATE_HEAD_RESPONSE');
      const bound = requestNavigations.get(req);
      if (!main(req) || !navigation || bound !== navigation) return fail('HEAD_IDENTITY_MISMATCH');
      const headers = await req.allHeaders();
      if (disposed || failure) return;
      if (navigation !== bound) return fail('HEAD_IDENTITY_MISMATCH');
      if (headers.authorization || headers.cookie || headers['proxy-authorization']) {
        credentialRejected = true; return fail('CREDENTIAL_REQUEST_REJECTED');
      }
      if (req.redirectedFrom() || req.redirectedTo()) return fail('HEAD_REDIRECTED');
      if (res.status() < 200 || res.status() >= 300) return fail('HEAD_HTTP_STATUS');
      if (response) return fail('DUPLICATE_HEAD_RESPONSE');
      response = { page, navigation, method: 'HEAD', path: '/index.html', sameOrigin: true, credentialFree: true, redirected: false, status: res.status(), observedAt: now() };
    } catch (_) { fail('HEAD_OBSERVATION_FAILED'); }
  }
  const listeners = { request: onRequest, framenavigated: onFrameNavigated, response: onResponse, requestfailed: onFailed, pageerror: onPageError, close: onClose, crash: onCrash };
  for (const [event, listener] of Object.entries(listeners)) page.on(event, listener);
  return {
    // readDom must perform fresh DOM reads and full control-shape checks, not supply constants.
    async inspect(readDom) {
      if (disposed) return { ready: false, reason: 'OBSERVER_DISPOSED' };
      if (failure) return { ready: false, reason: failure };
      if (!response) return { ready: false, reason: 'HEAD_RESPONSE_PENDING' };
      const bound = navigation;
      let dom;
      try { dom = await readDom(page); } catch (_) { fail('DOM_OBSERVATION_FAILED'); }
      if (failure) return { ready: false, reason: failure };
      if (disposed) return { ready: false, reason: 'OBSERVER_DISPOSED' };
      if (navigation !== bound) return { ready: false, reason: 'NAVIGATION_CHANGED' };
      const decision = headReadiness({ expectedPage: page, expectedNavigation: bound, response,
        dom: { ...dom, page, navigation: bound, observedAt: now() }, pageErrors, requestFailed, credentialRejected });
      return decision;
    },
    dispose() { if (disposed) return; disposed = true; for (const [event, listener] of Object.entries(listeners)) page.off(event, listener); }
  };
}
module.exports = { observeHeadReadiness };
