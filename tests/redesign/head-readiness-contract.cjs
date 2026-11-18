'use strict';

// Candidate test-only gate. Not connected to a collector or product code.
function headReadiness(observation) {
  if (!observation || typeof observation !== 'object') return { ready: false, reason: 'MISSING_OBSERVATION' };
  const { response, dom, expectedPage, expectedNavigation, pageErrors, credentialRejected } = observation;
  if (pageErrors !== 0 || credentialRejected !== false || observation.requestFailed !== false) return { ready: false, reason: 'ERROR_OR_SAFETY_GATE' };
  if (!expectedPage || !expectedNavigation) return { ready: false, reason: 'MISSING_IDENTITY' };
  if (!response || !dom) return { ready: false, reason: 'MISSING_RESPONSE_OR_DOM' };
  if (response.page !== expectedPage || dom.page !== expectedPage ||
      response.navigation !== expectedNavigation || dom.navigation !== expectedNavigation) {
    return { ready: false, reason: 'IDENTITY_MISMATCH' };
  }
  if (response.method !== 'HEAD' || response.path !== '/index.html' ||
      response.sameOrigin !== true || response.credentialFree !== true ||
      response.redirected !== false || !Number.isInteger(response.status) ||
      response.status < 200 || response.status >= 300) {
    return { ready: false, reason: 'HEAD_RESPONSE_REJECTED' };
  }
  if (!Number.isFinite(response.observedAt) || !Number.isFinite(dom.observedAt) ||
      dom.observedAt < response.observedAt) return { ready: false, reason: 'OBSERVATION_ORDER' };
  if (dom.serverStatusCount !== 1 || dom.serverOnline !== true || dom.serverChecking !== false ||
      dom.serverOffline !== false || dom.welcomeVisible !== true || dom.expectedShape !== true) {
    return { ready: false, reason: 'APP_STATE_NOT_READY' };
  }
  return { ready: true, reason: 'HEAD_RESPONSE_AND_APP_STATE' };
}

module.exports = { headReadiness };
