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
Hosted green therefore does not prove that coverage requirement. The local
repair below addresses the gate and missing coverage without lowering the
threshold; the published candidate remains unchanged and is not merge-ready.

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
| `44e28489` | `bf4f4faa`, registered stop control and reap-outcome reporting | 222 passed and three existing expected failures in seven control/lifecycle suites; source/test type checks passed |
| `ba8b6550` | `0c78c09b`, service-inventory observations, archive census, and legacy receipt-mode repair | Existing full BOT ERRORS runner: 2,776 passed; separate sentinel gate: 717 passed with the unchanged coverage floors |

The merges were conflict-free. Node checks used pinned Node 24.15.0; the latest
Python checks used Python 3.12.13. The retention
run checks its canonical delta, not the earlier catalogue selection. The latest
control/lifecycle run includes the three scheduled-isolation probes, which remain
expected failures rather than protected outcomes. The 551-test run emitted two missing-keychain-item diagnostics:
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

The owner-approved test-only repair now reuses that existing process fixture
in the model-pin test file. The real credential classification, route decisions,
SQLite writes and all original assertions remain in place. No production code,
global hook, credential configuration or new guard framework changed.

Before the repair, a synthetic credential-present host caused the existing
non-routable selector assertion to fail: one unwanted preference row was written.
All three credential lookups were intercepted before reaching the operating
system. After the repair, the same case passed without reaching that diagnostic
boundary; the entire affected file passed all 106 tests. Nine independent
credential, process-helper and catalogue files passed 205 tests under the same
protective diagnostic. Those suites retain their explicit failure-path checks;
their expected error logs are not evidence of a host credential-store failure.
These are local fixture and routing results, not live-adapter or whole-suite
credential-isolation proof. Process-local diagnostic counters are not a
process-tree-wide credential census. Independent static review found no
code blocker and retained that evidence limitation.

Source/test type checking passed. Required Test Integrity passed with zero new
findings, retaining 81 baseline findings and three existing location drifts;
the baseline was unchanged. These bounded checks used pinned Node 24.15.0,
one test worker and the installed strict governor's default capacity. Earlier
single-slot refusals reflected this lane's narrower override, not a mandatory
global unit-test restriction. The separate full-release contract is unchanged.

The sentinel gap was also reproduced locally: 170 tests passed at 97.78%
coverage with exit zero. Explicit precision made that same suite exit one;
a valid 57-test pin suite still exited zero at 99.61%. A 2,001-case comparator
sweep demonstrated that precision alone still accepts some unrounded totals
below 98%. That investigation changed neither thresholds nor test exclusions.

### Local coverage-gate repair

The existing `pytest-runner.sh` now owns one `run_pytest_coverage` helper used
by all four coverage calls in `run-sentinel-tests.sh`. It preserves the original
pytest status, captures and replays output, and requires exactly one native
98%-floor success verdict. Missing, malformed, duplicate or contradictory
verdicts fail closed. Output-readback failure also blocks success without
replacing an original pytest failure. Explicit precision and uncoloured terminal
reporting stabilize the format; precision is not the enforcement by itself.

The causal tests execute the real enclosing gate with only its external test
commands replaced. All 64 negative cases stop at the intended coverage step
without the final success marker; both valid controls reach all seven Python
suites and that marker. Independent review found and verified repairs for
mixed-verdict acceptance and exit-status loss during failed output readback.

Six added fleet tests cover missing/unreadable probe metadata, absent probe
configuration, outbox scan errors that retain pending work, and malformed
retirement entries that preserve valid pins and stored bytes. The full real
sentinel gate passes 717 Python tests, including 176 fleet tests at 98.48%
combined statement/branch coverage. The other three measured totals are 99.61%,
98.23% and 99.56%; the 98% requirement is unchanged. No production sentinel
behavior, dependency, exclusion or test-integrity baseline changed.

Run `bash deploy/scripts/run-sentinel-tests.sh` locally; the existing Quality
workflow invokes the same entry point. These results used Python 3.12.13 and
pytest-cov 7.1.0 on macOS. The native terminal verdict compares the unrounded
total; unknown future output formats will fail closed. This is not a claim of
arbitrary version compatibility, Linux CI completion, or a gate around direct
ad-hoc pytest commands. Updated-revision CI and required review remain pending.

The coverage gate was rerun after canonical integration at `ba8b6550`; all
four native floor verdicts and the final success marker were present, with
exit zero. The separate full BOT ERRORS runner used its existing shared
curated-file exclusion list; no test selection or threshold was changed.
These results cover the integrated Python changes, not a full application
release. Canonical follow-ups under #2459 and #3501 remain open.

The standalone runtime-manifest check passed at 49 entries. An earlier combined
manifest/integrity request ran neither command after a single-slot refusal;
the later required Test Integrity result is recorded above. Documentation and
source-runtime trust checks passed at the canonical integration.

The resumed Git-estate gate returned zero against its current baseline, with
count-growth warnings: 32 branches, 32 worktrees and zero stashes. Foreign
detached, locked and dirty work remains. The baseline was not changed by this
lane; its acceptance does not establish repository convergence or authorize
deletion. The published head is still `d3764288`, so neither the integrated
source nor the repaired coverage gate has current published-revision CI.

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
