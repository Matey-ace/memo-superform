# Round 7: HEAD Readiness Contract

## Status

Offline preparation only. No new browser, HTTP probe, account access, matrix, performance sample or server was started. Product and the historical pilot script/result remain unchanged. SA9 remains NOT ACCEPTED; this document is not a performance result.

## Evidence Review

The [old collector](../../../tests/redesign/performance-pilot.js#L183) records routeHits before awaiting route.fulfill. Its saved original HTML byte length is not the HEAD response body size: the HEAD fulfill explicitly supplies an empty body. The [old result](pilot-01/result.json) records one matching HEAD route hit but headProbeCompleted=false, no saved HEAD response status, and no saved serverStatus state. Initial shape and welcome visibility cannot supply those missing observations. A separate read-only reviewer independently confirmed these limits.

The [application](../../../js/app.js#L141) awaits fetch HEAD and reads resp.ok; it does not consume a body. The old test waits for requestfinished, a different completion observation. This establishes a contract mismatch, not a uniquely diagnosed cause of the missing event. Browser behavior, routing and timing remain unproven possible explanations. The old pilot stays INVALID/exit1.

## Candidate Contract

The new [pure candidate gate](../../../tests/redesign/head-readiness-contract.cjs) is NOT imported by any collector or product module. A future adapter would have to observe the actual same-origin credential-free, nonredirected HEAD /index.html 2xx response, bind it to the same independent page and startup navigation, and then observe exactly one online/nonchecking/nonoffline serverStatus node with the expected welcome and control shape. The DOM observation must follow the response observation. Page errors, request failures, credential rejection, missing identities and missing safety observations all reject readiness. requestfinished alone, route fulfillment alone and an online DOM alone do not pass. requestfinished is diagnostic, not proof of successful application readiness.

No response, DOM state, response status, identity or safety flag may be synthesized in a browser adapter to satisfy this gate. Adapter correctness, event ordering, navigation binding, timeouts and real DOM observation remain unimplemented and unverified. The pure predicate assumes truthful observations; its tests cannot prove that assumption. Existing full shape/hash, image/font, HTTP provenance and cross-group isolation gates would remain mandatory. This is only one initialization condition, not a replacement for the entire performance validity pipeline.

A future adapter must listen before navigation, reject requestfailed/non-2xx and timeouts, retain sanitized diagnostics, and preserve first-failure stop semantics. Observing successful HEAD headers does not claim body download or completed chart/model initialization. No future browser run is authorized by this document.

## Offline Verification

Command: `node --test tests/redesign/head-readiness-contract.test.cjs`.

Final result: 35 tests, 35 PASS, 0 FAIL, exit0. Includes success without requestfinished and negative route-only, event-only, DOM-only, wrong method/path/origin/status, redirect, credential, wrong page/navigation, stale observation, missing/duplicate/checking/offline status, shape/welcome failures, request/page errors and absent safety observations. Also checks that evaluation leaves its input unchanged. These are synthetic test inputs, not recorded browser samples.

The first 33-test version passed before explicit requestFailed and missing-requestFailed negative cases were added; the final 35-test run supersedes only that unit-test iteration, never any captured evidence.

## Remaining Acceptance

No complete static matrix pass, dynamic zero-pixel proof, actual bound Live2D model, human visual acceptance, user-controlled learning/save acceptance or valid performance comparison was obtained this round. User choices to leave model and manual work unaccepted remain in force. Do not label the objective complete or silently reclassify historical failures. Next methodological work, before any separately authorized finite run, is a reviewed real-observation adapter and its event/identity failure tests; not another blind capture.
