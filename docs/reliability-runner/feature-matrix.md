# Reliability Runner Feature Matrix

Status flow: DISCOVERED -> TRIAGED -> RESOLVED | DEFERRED | WONT_FIX.

Last updated: 2026-06-14.

| ID | Status | Feature / work item | Completion | Evidence | Completion gate |
|---|---|---:|---:|---|---|
| RR-001 | TRIAGED | BOT ERRORS reliability protocol finalization | 75% | `docs/sdlc/in-progress/bot-errors-reliability-20260531/state.md`; `docs/sdlc/in-progress/bot-errors-reliability-20260531/implementation-plan.md`; `deploy/scripts/README-bot-errors.md` | Finish remaining BE lanes, Q review, and one-machine-at-a-time fleet drills with receipt evidence. |
| RR-002 | TRIAGED | Fleet evidence matrix completion | 75% | runtime probes and current health evidence | Every reachable fleet row has runtime auth, provider, linked-device, and source/deploy proof. |
| RR-003 | TRIAGED | Linked-device/auth-bond lifecycle hardening | 60% | `src/transport/auth-bond.ts`; `src/lib/auth-bond-policy.ts`; BOT ERRORS health-check tests | Physical relink is recommended only after restore paths fail and terminal auth evidence exists. |
| RR-004 | TRIAGED | Provider fallback and health taxonomy completion | 75% | provider health/fallback tests; PR #829 merged as `95bee767` | Active fallback degrades health, terminal fallback failures escalate, and quota/auth/keychain/billing/missing-credential classes are distinct. |
| RR-005 | TRIAGED | Primary bot host live/source drift reconciliation | 50% | local/live drift audit and open PR state | Live-only changes are bucketed as shipped, intentional, obsolete, or unsafe; intentional changes are promoted through PRs or explicitly blocked. |
| RR-006 | TRIAGED | Provider credential/keychain finalization | 55% | provider/keychain probes | Claude service-surface credential access is proven or unlock installed; unusable fallback entries are provisioned or disabled. |
| RR-007 | TRIAGED | Relay/profile role classification | 65% | local launchd/profile probes | Profile either matches relay-only reality or installs/verifies the on-demand agent service. |
| RR-008 | RESOLVED | Offline-host mapping and runtime verification | 100% | mesh SSH alias and health endpoint proof | Residual token/source drift is tracked under fleet/source reconciliation, not reachability. |
| RR-009 | TRIAGED | BOT ERRORS simulation matrix release gate | 80% | `scripts/bot-errors-simulation-matrix.ts`; release gate output | Every newly found reliability class gets executable anchors and the matrix remains required in release verification. |
| RR-010 | RESOLVED | Quarantined BOT ERRORS hub test disposition | 100% | `docs/reliability-runner/pending-bead-dispositions.md`; live BOT ERRORS script tests | Quarantined archives remain private historical records unless live coverage regresses. |
| RR-011 | TRIAGED | Artifact sweep consolidation and objective hygiene | 40% | `.sweep/20260614T031744Z/manifest.md`; instruction audit output | Current dry-run found 1953 matched artifacts, 1493 report-only, 1295 low-confidence, and 0 swept; apply or explicitly defer artifact/memory cleanup with user approval, and keep tracked docs independent of ignored local artifacts. |
| RR-012 | TRIAGED | Historical pending-bead reconciliation | 90% | `docs/reliability-runner/pending-bead-dispositions.md`; `docs/current-program.md`; `docs/work-index.json` | Decide whether to rewrite historical bead markers or leave the tracked disposition ledger as the active source. |
| RR-013 | TRIAGED | Coverage ratchet to requested target | 0% | `vitest.config.ts`; latest `verify:release` coverage summary | Coverage is at least 98% for statements, branches, functions, and lines, and thresholds enforce it. |
| RR-014 | RESOLVED | Open PR/source landing | 100% | PR #830 `97e60757`; PR #828 `28ed0dba`; PR #829 `95bee767`; no remaining code PRs in that landing queue after #829 | Provider-hardening compose and both patch-positive follow-ups landed on `main`; older local compose/full-compose worktrees remain preserved because they contain unmerged local-only work. |
| RR-015 | RESOLVED | D18 fleet health-poller HTTP error policy | 100% | `tests/fleet/health-poller.test.ts` | A parseable non-OK `/health` body is reachability evidence: the poller preserves the body-derived `degraded` or `logged_out` state with `consecutiveFailures=0`; only unparseable/generic transport failures increment toward `unreachable`. |

## Current Gate Snapshot

The full release gate passed for PR #829 head `f9bbc0a0` before merge on 2026-06-14: 592 test files, 9610 tests, one expected skip, BOT ERRORS drills 147/147, coverage check, and console production build. Repository coverage remains below the requested target: statements 82.31%, branches 76.27%, functions 80.40%, lines 83.96%. The current enforced thresholds are lower, so the coverage objective remains open.

The provider-hardening compose work landed through PR #830 as `97e60757` and post-merge main CI finished 5/5 green. PR #828 landed timestamp normalization as `28ed0dba`. PR #829 landed OpenCode primary model run probes as `95bee767` after current-base merge, targeted tests, test-integrity, branch push guard, full release verification, and GitHub CodeQL/Quality Node 24/25. After #829, the remaining visible GitHub PR was this documentation consolidation update.
