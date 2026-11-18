# Performance Validity Pilot Design

Status: PREPARED, NOT RUN. Parent authorization is required before any collection. This preparation has not started a browser, server, background job, HTTP probe or pilot. The existing product freeze and historical failures remain unchanged.

## Scope

The new [pilot script](../../../tests/redesign/performance-pilot.js) is separate from [the old script](../../../tests/redesign/performance-proof.js) and [the historical performance report](../performance.md). Neither historical script, raw result, report nor hash lock is edited. This design follows [SA9's validity finding](../sa9-review.md) rather than treating the old missing HEAD/51-node difference as a uniquely diagnosed product defect.

The pilot has exactly two fresh, independent, headless Edge contexts in serial order: baseline once, current once. Both are 1280 x 800, standard/light, startup only. There is no reload, replacement, automatic rerun or expansion to six contexts. One sample per group is an evidence-validity pilot only, not performance evidence or a no-regression/improvement conclusion.

The frozen current components must be exactly 20564 bytes, SHA256 `3ad830841b35e3df402094b47d5031b1e498c5036acee44545042f1952befe2d`; the three shell sheets must total exactly 30520 bytes. All seven saved original copies must match the original manifest. Provenance records the script, original manifest/copies, and the complete public asset scope at start and finish, detecting additions/removals as well as content changes. This duplicates only the public asset enumeration scope, not private data or database reads.

## Authorization And Output

The parser requires both arguments, rejects unknown/duplicate arguments, and refuses an existing output. The output must be a direct new child named `pilot-*` under `docs/redesign/performance/`. No Playwright import or browser launch is reachable before the explicit authorization argument and offline preflight pass. The argument is a guard, not permission to self-authorize.

After separate explicit parent release only, a command would have this form; it has NOT been run:

```powershell
node tests/redesign/performance-pilot.js --out docs/redesign/performance/pilot-UNUSED-NAME --run-authorized yes
```

The script never starts a server. It uses only the existing `http://127.0.0.1:55395`. It never connects to CDP/9337, an existing browser or persistent profile. It does not read/export cookies, account state, storage-state, private voice, credentials or databases, and does not enter learning, answer or save flows.

## Network And Counterfactual

Both groups route only original-manifest public static file paths, plus root/index and the three explicitly declared shell CSS files. Only GET/HEAD may proceed. Foreign origins, URL credentials, credential request headers, nonstatic/auth/API paths and mutating methods are aborted without logging their URL, headers, body or response. Query admission is limited to public cache-version `v` with a bounded alphanumeric/dot/underscore/hyphen value; query and fragment are never persisted. Blocked requests are counters only. API requests are aborted, never mocked.

Baseline fulfills exact saved `source-before/index.html`, `js/ui-style.js` and `js/charts.js`; the other public assets remain shared. An unexpected baseline request for a new theme sheet aborts and invalidates, rather than fabricating empty CSS. Current receives real HTTP for document, scripts and three CSS; each observed current public GET response is hashed against the start snapshot, and nonempty HTTP responses for root plus all three shell sheets are mandatory. Baseline fulfill is not network-equivalent to deploying an old build, so timings are not interpreted as pure product costs.

Only a new context's `memo_ui_style=standard` and `theme=light` preferences are written by the harness. No business storage, API implementation, bootstrap code, Date, performance, timers, animation, chart resources or countdown is patched. Normal app initialization and API rejection handling remain real.

## Phases And Hard Gates

Errors are attributed to context/page/navigation/initial/initialization/dismiss/settle/final/close phases. An asynchronous error interrupts the active phase and terminates the pilot. There is no continue-to-current after invalid baseline and no replacement of an exceptional sample.

1. Capture the initial post-load state and native timings. This is an observation, not a claim that load alone completes initialization.
2. Wait for the real app's completed HEAD `/index.html` probe and visible welcome settings button. Check the initialized toolbar shape before dismissing. HEAD is a lifecycle observation, not proof of one specific historical failure cause; a missing probe times out invalid.
3. Click the real `welcomeSettingsBtn`, then the real `closeSettings`. No auth, learning or save control is clicked.
4. Wait 700 ms, real fonts.ready and current image decode; observe up to 15 times at 200 ms spacing. Require three consecutive equal full structural fingerprints, tag census, control counts, image count and chart/canvas counts. These are validity bounds, not performance thresholds. Do not wait for a chosen total body count.
5. Each settled observation must have four tiles, four chart selectors, four layout buttons and four tile fullscreen buttons. Per-tile toolbar/button/select/input counts are fixed from the actual public layout implementation: heatmap `1/9/0/0` (three navigation/today buttons plus six palette buttons), trend `1/4/0/0`, memory `0/0/0/0`, AI `1/6/2/2`. This detects missing dynamically generated toolbars instead of accepting any stable smaller DOM.
6. Final state must be standard, light, single layout, visible dashboard/chart-0/first chart selector, welcome dismissed, settings closed, fonts loaded, images pending zero, images failed zero, pageerror zero, and navigation type `navigate`. Current must have exactly one of each expected theme link, enabled, same-origin correct CSS path, loaded sheet and nonempty cssRules. Baseline must have zero of the three links. There is no disabled-sheet phase.
7. Baseline/current normalized tag census, complete structural fingerprint and control counts must match exactly, as must ECharts host/instance and canvas counts. Class equality is expected for paint-only differences; any class mismatch invalidates and is not relaxed.

The structural fingerprint walks every element (including hidden nodes, root and head), recording only tag, id, exact class string and recursive element-child order. It excludes only LINK elements with the exact three declared theme IDs. No other node, toolbar, count or countdown node is excluded. Text is not part of the fingerprint anywhere, avoiding countdown-text dependence without stripping its element. Both full and link-normalized tag censuses are recorded; no arbitrary DOM content or text is serialized.

## Safe Diagnostics And Preservation

Pageerror diagnostics retain a fixed safe built-in error name and up to twelve allowlisted public static stack locations (relative file path, line, column), tagged by phase and real timestamp. The stack message line and function names are discarded. No arbitrary message, raw stack, token, query, API path, console text or private response is saved. Unknown names reduce to `Error`; absent safe locations stay empty. The script does not guess a historical error cause. Harness failures use fixed public failure codes, not raw Playwright messages.

Initial, initialized and final state, stability observations, real UTC/performance timestamps, navigation timing, and allowlisted resource timing paths are retained. Error samples are retained in the new result; failure does not delete the directory or rewrite old raw evidence. Start/end hashes are attempted even on abnormal exit. Any changed public asset/source, missing final provenance or failed hard gate makes `valid=false` and exit 1. No duration threshold, percentage improvement or performance acceptance is computed.

## Preparation Verification

Preparation verification executed only `node --check tests/redesign/performance-pilot.js`: exit 0. No pilot/browser/server/background job was started. The unavailable `apply_patch` command was detected with a command lookup (exit 1, no file or product side effects); the two new files were created with the file tool. A syntax pass is not runtime, privacy, initialization, homomorphism or performance proof. Runtime behavior and all browser gates remain untested pending separate parent authorization. The pilot, even if later valid, cannot close SA9's performance no-regression gap or any unrelated static/dynamic/real-model/manual/business gate by itself.
