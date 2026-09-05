# 2026-09-04 Runtime Model Catalogues

## Public surface additions

- `GET /api/providers/:name/models` returns the selected execution adapter's
  provider-native model-catalogue receipt. Successful responses carry exact
  IDs, source provenance, and capture age; unavailable sources carry a typed
  reason. Unknown execution providers return `404` before any probe runs.

## Behavioral changes

- Console model fields now use runtime catalogue results as editable
  suggestions. Empty fields retain the runtime default, manual provider-native
  IDs remain valid, and request or provider failures are shown rather than
  replaced with a compiled fallback list.
- Console execution-provider selectors now render the fleet server's registry.
  A configured value that is not reported is preserved and identified instead
  of being silently replaced.
- Managed API and CLI-session catalogue requests preserve their distinct
  credential identities so one account's visible models are not presented as
  another account's catalogue.

## Release-readiness limitation

The published candidate `d3764288` has a successful hosted job status, but its
sentinel coverage step printed 97.78% against a 98% requirement and continued
to a success marker. The exact Node 24 job log confirms the discrepancy tracked
in [issue #3481](https://github.com/LucasQuiles/WhatSoup/issues/3481).
Hosted green therefore does not prove that coverage requirement. The gate
semantics and missing coverage must be resolved without lowering the threshold
merely to permit landing; this candidate is not merge-ready.

Local integration `c1be835a` includes canonical `3fc43aed` and passed 838 tests
across 30 affected/adjacent files on pinned Node 24.15.0, with three existing
scheduled-isolation expected failures retained explicitly. Source/test type
checking passed. These scoped results do not replace full release validation,
updated-revision CI, required review, or evidence-backed Git-estate disposition.

The latest canonical integrations have separate, revision-scoped receipts:

| Integration | Canonical target | Validation |
|---|---|---|
| `a2962ba6` | `79536789` | 551 tests in the 16 changed files; source/test type checks passed |
| `61b9fdb2` | `9500141a`, deferred-work retention hold | 40 tests in all four retention suites; source/test type checks passed |

Both merges were conflict-free; the checks used pinned Node 24.15.0. The latter run
checks the newly integrated retention change, not a repeat of the earlier
catalogue selection. Neither run includes the three scheduled-isolation
probes above. The 551-test run emitted two missing-keychain-item diagnostics:
credential-store isolation remains unproven despite passing assertions.

A controlled follow-up at `65caad9d` confirmed one fixture dependency without
accessing the host keychain. The existing non-routable model-pin test passed
with one platform-keyring command intercepted by the existing child-process
mock; a valid-primary control passed with zero process calls. Each run selected
one test and excluded 105, retaining both repository setup files. The fixture's
random nonexistent service prevents neither lookup nor host dependence.
This does not uniquely attribute both earlier diagnostics or prove whole-suite
isolation. The initial diagnostic failed during setup with zero tests collected;
only the corrected, nonzero runs support the finding.

Owner: this lane. Required follow-up: reuse the existing child-process fixture
at the unintended boundary, then validate the whole affected suite and retain
independent credential-resolution tests. A global hook or new guard framework
is not justified. The repair is pending design approval; neither production nor
test source changed during the diagnostic.

The sentinel gap was also reproduced locally: 170 tests passed at 97.78%
coverage with exit zero. Explicit precision made that same suite exit one;
a valid 57-test pin suite still exited zero at 99.61%. A 2,001-case comparator
sweep demonstrated that precision alone still accepts some unrounded totals
below 98%. No coverage threshold, validation logic, or test exclusion was
changed, and issue #3481 remains required before meaningful release green.

## Catalogue context audit

A no-harness-execution probe of the real catalogue adapter confirmed that its
three listing modes inherit the application working directory and environment.
AST inspection found that the shared resolver cache is keyed only by binary;
the pin and fleet callers do not pass an execution-directory context. A live
service and its configured agent directory differed, but the inspected project
file defined neither providers nor provider filters. Missing project-specific
models therefore remain an unproven explanation, not an implemented fix.

The [configuration precedence documentation](https://opencode.ai/docs/config/)
shows why directory context can matter. The matching reported CLI version's
[loader](https://github.com/anomalyco/opencode/blob/v1.18.27/packages/opencode/src/config/config.ts)
skips an empty configuration file, weakening a separate empty-file hypothesis.
File contents, an invoked binary's version, and a running process's loaded
configuration are different evidence. Effective default/plugin-free catalogue
parity remains unverified. No context guard, configuration rewrite, or plugin
change is justified by this audit alone. Source/capture labels must not be
presented as proof of upstream refresh or of the model that executed a turn.
