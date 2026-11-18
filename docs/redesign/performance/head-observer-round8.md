# Round 8: Candidate HEAD Event Observer

## Scope

New test-only [observer](../../../tests/redesign/head-readiness-observer.cjs) and [event-sequence tests](../../../tests/redesign/head-readiness-observer.test.cjs). Not imported into a collector or product. No browser, HTTP probe, new capture or server was started. Historical scripts/results, product and SA9 verdict remain unchanged.

## Implementation

Attach before goto to a fresh independent page. Capture the startup navigation request and its first main-frame commit. Record each matching HEAD request in a WeakMap with the committed startup identity. HEAD responses without a recorded committed identity reject readiness. Later navigation requests or main-frame navigation events invalidate the observer, including same-document navigation. Subframes cannot supply readiness.

Inspect complete request headers through asynchronous allHeaders, not headers, before declaring credential-free. Never persist header values. Errors, crashes, closure, request failure and duplicate HEAD responses invalidate the candidate. Duplicate detection occurs synchronously before header awaiting, preventing an older successful response from bypassing an unvalidated second response. Recheck failure/dispose/navigation after awaits. Dispose removes all installed listeners.

The caller must still supply a fresh truthful DOM read and the full expected-control-shape decision; this adapter does not implement that DOM reader or the complete performance pipeline. No integration or runtime behavior is claimed. There is no automatic timeout scheduler: any future collector must retain its bounded deadline/first-failure stop and provenance/resource gates. A pure observer decision is not acceptance of charts, fonts, model, learning, rendering or performance.

## Review And Corrections

Independent read-only review found three initial candidate defects: headers() could omit Cookie, HEAD identity was assigned at response time rather than request/commit time, and same-document navigation was unobserved. All three received targeted changes and offline negative tests. A second review reproduced a further asynchronous duplicate-response race; synchronous response counting now rejects the second matching response before its header reader can run. These were defects in unconnected candidate test code, not proven product vulnerabilities or explanations of historical failure.

## Verification

`node --test tests/redesign/head-readiness-contract.test.cjs tests/redesign/head-readiness-observer.test.cjs`

Final local execution: 68 tests, 68 PASS, 0 FAIL, exit0. Intermediate local 56/63-test runs preceded review corrections and do not establish the final candidate's correctness. Tests use synthetic EventEmitter pages/requests, including delayed Promise resolution. Covered hidden Cookie in allHeaders, pre-startup and pre-commit HEAD, duplicate delayed headers, navigation/error/disposal during DOM/header await, request failure, two-page isolation, and listener cleanup. No browser event trace was collected; mock sequences cannot establish real Playwright ordering.

## Remaining Work

A truthful DOM/control-shape reader, real event ordering, navigation-commit behavior, bounded lifecycle integration and current runtime remain unverified. The independent reviewer confirmed that the final synchronous duplicate change closes the specific reproduced race in its code path; this was a narrow read-only review without rerunning unit tests, not SA9 acceptance. Before any separately decided finite browser trial, integrate and test those remaining observation boundaries without modifying the original pilot or weakening other gates.

Static matrix, dynamic zero-pixel, actual bound model, human visual, user learning/save and valid performance evidence remain incomplete. The user has left model and manual verification unaccepted; this round does not waive those requirements. Objective remains active, not complete.
