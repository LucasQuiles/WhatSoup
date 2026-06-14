# Reliability Runner Feature Matrix

Status flow: DISCOVERED -> TRIAGED -> RESOLVED | DEFERRED | WONT_FIX.

Last updated: 2026-06-13.

| ID | Status | Feature / work item | Completion | Evidence | Completion gate |
|---|---|---:|---:|---|---|
| RR-001 | TRIAGED | BOT ERRORS reliability protocol finalization | 75% | `docs/sdlc/in-progress/bot-errors-reliability-20260531/state.md`; `docs/sdlc/in-progress/bot-errors-reliability-20260531/implementation-plan.md`; `deploy/scripts/README-bot-errors.md` | Finish remaining BE lanes, Q review, and one-machine-at-a-time fleet drills with receipt evidence. |
| RR-002 | TRIAGED | Fleet evidence matrix completion | 75% | runtime probes and current health evidence | Every reachable fleet row has runtime auth, provider, linked-device, and source/deploy proof. |
| RR-003 | TRIAGED | Linked-device/auth-bond lifecycle hardening | 60% | `src/transport/auth-bond.ts`; `src/lib/auth-bond-policy.ts`; BOT ERRORS health-check tests | Physical relink is recommended only after restore paths fail and terminal auth evidence exists. |
| RR-004 | TRIAGED | Provider fallback and health taxonomy completion | 70% | provider health/fallback tests; failure taxonomy work in open PRs | Active fallback degrades health, terminal fallback failures escalate, and quota/auth/keychain/billing/missing-credential classes are distinct. |
| RR-005 | TRIAGED | Primary bot host live/source drift reconciliation | 50% | local/live drift audit and open PR state | Live-only changes are bucketed as shipped, intentional, obsolete, or unsafe; intentional changes are promoted through PRs or explicitly blocked. |
| RR-006 | TRIAGED | Provider credential/keychain finalization | 55% | provider/keychain probes | Claude service-surface credential access is proven or unlock installed; unusable fallback entries are provisioned or disabled. |
| RR-007 | TRIAGED | Relay/profile role classification | 65% | local launchd/profile probes | Profile either matches relay-only reality or installs/verifies the on-demand agent service. |
| RR-008 | RESOLVED | Offline-host mapping and runtime verification | 100% | mesh SSH alias and health endpoint proof | Residual token/source drift is tracked under fleet/source reconciliation, not reachability. |
| RR-009 | TRIAGED | BOT ERRORS simulation matrix release gate | 80% | `scripts/bot-errors-simulation-matrix.ts`; release gate output | Every newly found reliability class gets executable anchors and the matrix remains required in release verification. |
| RR-010 | RESOLVED | Quarantined BOT ERRORS hub test disposition | 100% | `docs/reliability-runner/pending-bead-dispositions.md`; live BOT ERRORS script tests | Quarantined archives remain private historical records unless live coverage regresses. |
| RR-011 | TRIAGED | Artifact sweep consolidation and objective hygiene | 40% | `.sweep/20260613T051113Z/manifest.md`; instruction audit output | Current dry-run found 1817 matched artifacts; apply or explicitly defer artifact/memory cleanup with user approval, and keep tracked docs independent of ignored local artifacts. |
| RR-012 | TRIAGED | Historical pending-bead reconciliation | 90% | `docs/reliability-runner/pending-bead-dispositions.md`; `docs/current-program.md`; `docs/work-index.json` | Decide whether to rewrite historical bead markers or leave the tracked disposition ledger as the active source. |
| RR-013 | TRIAGED | Coverage ratchet to requested target | 0% | `vitest.config.ts`; latest `verify:release` coverage summary | Coverage is at least 98% for statements, branches, functions, and lines, and thresholds enforce it. |
| RR-014 | TRIAGED | Open PR/source landing | 85% | GitHub PR queue; local compose branch `integration/provider-hardening-compose-refresh-20260613T194657Z` | Validated local compose landing candidate has exact-head push-battery proof; code head `56086d44` has full-suite proof. Remaining gate is named approval to publish/split/merge, plus peer-owner disposition for draft PRs #828/#829, the non-authoritative full-compose scratch branch, and unrelated dirty worktrees. |
| RR-015 | RESOLVED | D18 fleet health-poller HTTP error policy | 100% | `tests/fleet/health-poller.test.ts` | A parseable non-OK `/health` body is reachability evidence: the poller preserves the body-derived `degraded` or `logged_out` state with `consecutiveFailures=0`; only unparseable/generic transport failures increment toward `unreachable`. |

## Current Gate Snapshot

The integrated release gate passed for the locally merged #804/#813/#816 heads on 2026-06-13, but repository coverage was below the requested target: statements 81.90%, branches 75.92%, functions 79.73%, lines 83.53%. The current enforced thresholds are lower, so the coverage objective remains open.

The fresh provider-hardening compose branch `integration/provider-hardening-compose-refresh-20260613T194657Z` passed targeted TS tests (612/612 before final cherry-proof; 239/239 for the two rescued branch tips), deploy Python pytest (302/302), changed-test Test Integrity, `guard:test-integrity`, static/doc/publication/runtime-manifest guards, runtime trace warning check (216/216, no `TimeoutNaNWarning`/`NaN` hits), full Vitest at code head `6dcae2ea` (590 files passed / 2 skipped; 9591 tests passed / 11 skipped), and exact-head `verify:push:branch` after the handoff commits plus sanitized private-host test fixtures. D20 keychain unlock policy then landed locally at branch head `56086d44`: red-first provider probe tests failed 4 assertions, then passed 13/13; deploy Python pytest passed 305/305; health-check TS integration passed 110/110; changed-test Test Integrity was clean; exact-head `verify:push:branch` and full Vitest both exited 0.
