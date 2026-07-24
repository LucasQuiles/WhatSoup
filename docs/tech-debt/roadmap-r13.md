# R13 — Tech-debt roadmap (issues #2237-#2245)

This roadmap groups the 9 new tech-debt issues filed against `LucasQuiles/WhatSoup`
on 2026-07-24 into a single reviewable batch. Each entry links to the source issue
and summarises the proposed fix at the level of detail a reviewer needs to triage.

The issues are filed in this order: SSOT first, then SOC, then DRY. Within each
grouping, the most actionable items are listed first.

## SSOT — Single source of truth (4 issues)

| # | Title | One-line summary | Migration cost |
|---|-------|------------------|----------------|
| [#2237](https://github.com/LucasQuiles/WhatSoup/issues/2237) | E.164 regex — 4 duplicate definitions | Move to single `E164_RE` constant; 4 files re-export | small (4 file changes) |
| [#2241](https://github.com/LucasQuiles/WhatSoup/issues/2241) | Adapter reason codes — 5 magic strings | Add `AdapterReasonCode` registry; type `AdapterHealth.reasonCode` | small (5 call-sites) |
| [#2244](https://github.com/LucasQuiles/WhatSoup/issues/2244) | `InboundStatus` vs `InboundProcessingStatus` drift | Single canonical union + open-set predicate | medium (operational drift) |
| [#2245](https://github.com/LucasQuiles/WhatSoup/issues/2245) | `ProviderParityProbeState` vs `ProviderProbeSnapshot.state` drift | Add `'headless_auth_inconclusive'` to canonical union | small |

## SOC — Separation of concerns (4 issues)

| # | Title | One-line summary | Migration cost |
|---|-------|------------------|----------------|
| [#2238](https://github.com/LucasQuiles/WhatSoup/issues/2238) | `src/fleet/index.ts` god-module (1113 lines) | Extract `lid-conflict.ts`, `routes/lid-sync.ts`, `auth-gates.ts` | medium (3 module extractions) |
| [#2239](https://github.com/LucasQuiles/WhatSoup/issues/2239) | `src/fleet/routes/ops.ts` god-module (1415 lines) | Extract `ops-config.ts`, `ops-lifecycle.ts`, `ops-messages.ts`, `auth-stream.ts` | medium (4 module extractions) |
| [#2242](https://github.com/LucasQuiles/WhatSoup/issues/2242) | `time-utils.ts` ring violation — 9 cross-ring imports | Move pure time/queries to shared ring; delete wrapper | medium (8 import updates) |
| [#2244](https://github.com/LucasQuiles/WhatSoup/issues/2244) | (also SOC) InboundStatus open-set split | Same fix as SSOT — addresses both | (see above) |

## DRY — Don't repeat yourself (2 issues)

| # | Title | One-line summary | Migration cost |
|---|-------|------------------|----------------|
| [#2240](https://github.com/LucasQuiles/WhatSoup/issues/2240) | HTTP test harness — 56 local copies | Use shared `tests/helpers/http-mocks.ts` | medium (56 file changes) |
| [#2243](https://github.com/LucasQuiles/WhatSoup/issues/2243) | Logger no-op mocks — 94 sites | New `tests/helpers/logger-mock.ts` | medium (94 file changes) |

## Grouping strategy

These 9 issues form three natural PR-groups (one per category) for parallel
review:

- **PR-1: SSOT** — #2237, #2241, #2244, #2245 (4 small, low-risk changes)
- **PR-2: SOC god-modules** — #2238, #2239 (2 medium refactors, but high value)
- **PR-3: SOC ring + DRY** — #2242, #2240, #2243 (3 medium refactors, ring-positioning + test infra)

Each PR-group can be merged independently. Within a group, the fixes are
independent and can be applied in any order.

## Audit lense — checking for closure candidates

The following already-closed issues have audits attached that should be
re-checked against this batch:

- (None yet — audit lense is a future-batch activity, see worklog deferred
  items.)

## Reference

- Worklog entry: `~/LAB/q-pi-worklog.md` "R13 BATCH" section
- Issue bodies: each issue above links to its full body via the `#NNNN` reference
- Per-issue details: each row above links to the issue page (right-click
  the #NNNN in GitHub to see the body with file:line evidence, ESLint rule
  sketches, arch-ratchet test pseudocode, and migration path)
