# WhatSoup Reliability Runner

Status: active. Updated: 2026-06-13.

## Trunk

Mission: restore and harden WhatSoup supervision so Q can triage fleet failures from runtime evidence without false relink conclusions, silent fallback degradation, stale/noisy alerts, or unsafe live deployments.

Expectations: runtime proof first; preserve dirty hosts; require terminal auth evidence before physical relink; separate local tests, release gates, live validation, and Q notification; close every item as resolved, active, deferred, blocked, or WONT_FIX.

Standards: evidence names host, instance, source, time, state, and confidence; alerts include failure class, evidence, recovery state, and next action; recovery clears require real health/outbound proof; cleanup must not hide active work.

Progression: orient -> gather runtime evidence -> classify gaps -> fix narrowly -> verify locally -> validate live -> notify Q -> reconcile source/live state -> close, defer, or block with evidence.

## Branch / Leaf References

- BOT ERRORS reliability: `docs/sdlc/closed/bot-errors-reliability-20260531/state.md`; `docs/sdlc/closed/bot-errors-reliability-20260531/implementation-plan.md`; `deploy/scripts/README-bot-errors.md`.
- Fleet evidence matrix: `docs/reliability-runner/feature-matrix.md` rows RR-002, RR-005, RR-008; private runtime notes remain local until promoted.
- Linked-device/auth-bond lifecycle: `docs/reliability-runner/feature-matrix.md` row RR-003; `src/transport/auth-bond.ts`; `src/lib/auth-bond-policy.ts`.
- Provider fallback/taxonomy: `docs/reliability-runner/feature-matrix.md` row RR-004; `src/runtimes/agent/failure-taxonomy.ts`; provider fallback tests under `tests/runtimes/agent/`.
- Artifact and historical-work finalization: `docs/reliability-runner/feature-matrix.md` rows RR-010 through RR-012; `docs/reliability-runner/pending-bead-dispositions.md`.
- Verification and release gates: `package.json` `verify:release`; `vitest.config.ts`; `scripts/bot-errors-simulation-matrix.ts`; release logs captured in the validating session.

## Completion Rule

The runner is complete only when `docs/reliability-runner/feature-matrix.md` has no active reliability item without evidence, source/live drift is reconciled or explicitly blocked, all relevant PRs are merged, release and live validation pass, the requested coverage target is enforced, and ignored/private artifacts no longer act as the canonical source for tracked documentation.
