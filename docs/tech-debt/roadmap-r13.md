# R13+R14+R15 — Tech-debt roadmap (29 fresh issues + 1 pre-existing labeled)

This roadmap groups the **30 tech-debt items** filed against `LucasQuiles/WhatSoup`
on 2026-07-24 across the R13, R14, and R15 batches into a single reviewable
batch. Each entry links to the source issue and summarises the proposed fix
at the level of detail a reviewer needs to triage.

**29 fresh issues + 1 pre-existing labeled = 30 items total.**

The issues are filed in this order: SSOT first, then SOC, then DRY. Within
each grouping, the most actionable items are listed first.

## R13 batch (13:14 UTC, 9 fresh issues)

### SSOT — Single source of truth (4 issues)

| # | Title | One-line summary | Migration cost |
|---|-------|------------------|----------------|
| [#2237](https://github.com/LucasQuiles/WhatSoup/issues/2237) | E.164 regex — 4 duplicate definitions | Move to single `E164_RE` constant; 4 files re-export | small (4 file changes) |
| [#2241](https://github.com/LucasQuiles/WhatSoup/issues/2241) | Adapter reason codes — 5 magic strings | Add `AdapterReasonCode` registry; type `AdapterHealth.reasonCode` | small (5 call-sites) |
| [#2244](https://github.com/LucasQuiles/WhatSoup/issues/2244) | `InboundStatus` vs `InboundProcessingStatus` drift | Single canonical union + open-set predicate | medium (operational drift) |
| [#2245](https://github.com/LucasQuiles/WhatSoup/issues/2245) | `ProviderParityProbeState` vs `ProviderProbeSnapshot.state` drift | Add `'headless_auth_inconclusive'` to canonical union | small |

### SOC — Separation of concerns (4 issues)

| # | Title | One-line summary | Migration cost |
|---|-------|------------------|----------------|
| [#2238](https://github.com/LucasQuiles/WhatSoup/issues/2238) | `src/fleet/index.ts` god-module (1113 lines) | Extract `lid-conflict.ts`, `routes/lid-sync.ts`, `auth-gates.ts` | medium (3 module extractions) |
| [#2239](https://github.com/LucasQuiles/WhatSoup/issues/2239) | `src/fleet/routes/ops.ts` god-module (1415 lines) | Extract `ops-config.ts`, `ops-lifecycle.ts`, `ops-messages.ts`, `auth-stream.ts` | medium (4 module extractions) |
| [#2242](https://github.com/LucasQuiles/WhatSoup/issues/2242) | `time-utils.ts` ring violation — 9 cross-ring imports | Move pure time/queries to shared ring; delete wrapper | medium (8 import updates) |
| [#2244](https://github.com/LucasQuiles/WhatSoup/issues/2244) | (also SOC) InboundStatus open-set split | Same fix as SSOT — addresses both | (see above) |

### DRY — Don't repeat yourself (2 issues)

| # | Title | One-line summary | Migration cost |
|---|-------|------------------|----------------|
| [#2240](https://github.com/LucasQuiles/WhatSoup/issues/2240) | HTTP test harness — 56 local copies | Use shared `tests/helpers/http-mocks.ts` | medium (56 file changes) |
| [#2243](https://github.com/LucasQuiles/WhatSoup/issues/2243) | Logger no-op mocks — 94 sites | New `tests/helpers/logger-mock.ts` | medium (94 file changes) |

## R14 batch (13:50 UTC, 5 fresh + 1 pre-existing labeled)

### SSOT (3 issues)

| # | Title | One-line summary | Migration cost |
|---|-------|------------------|----------------|
| [#2249](https://github.com/LucasQuiles/WhatSoup/issues/2249) | `CircuitState` triple-duplication across 3 files | Hoist the canonical union to `src/core/circuit-breaker.ts`; rename the incident record | small (symbol rename + import update) |
| [#2250](https://github.com/LucasQuiles/WhatSoup/issues/2250) | `getInboundStatus` widens to `string` | Tighten return type to `InboundStatus`; add SQL `CHECK` constraint | medium (operational drift) |
| [#2251](https://github.com/LucasQuiles/WhatSoup/issues/2251) | `PROBE_STATE_VALUES` validator set missing 2 type members | Replace inline set with derived-from-type set | small |

### SOC (1 issue, spans SSOT+SOC)

| # | Title | One-line summary | Migration cost |
|---|-------|------------------|----------------|
| [#2252](https://github.com/LucasQuiles/WhatSoup/issues/2252) | `xdgDir` SSOT re-implemented 5 times with 3 fallthrough operators | Move to `src/lib/paths.ts`; replace 5 inline sites | medium (5 call-sites + ring move) |

### DRY (1 issue)

| # | Title | One-line summary | Migration cost |
|---|-------|------------------|----------------|
| [#2253](https://github.com/LucasQuiles/WhatSoup/issues/2253) | `asRecord`/`requireString` validator clones across 6 files | Add throwing variants to `src/lib/type-guards.ts`; migrate 6 sites | medium (6 site migration) |

### Pre-existing (labeled, not fresh)

| # | Title | Note |
|---|-------|------|
| [#2248](https://github.com/LucasQuiles/WhatSoup/issues/2248) | observability: heartbeat watchdog ignores reachable degraded runtime health | **Pre-existing** issue; received `audit, refactor, SSOT, tech-debt` labels in R14. Not counted in fresh total. |

## R15 batch (14:30 UTC, 15 fresh issues — comprehensive scans)

### SSOT (7 issues)

| # | Title | One-line summary | Migration cost |
|---|-------|------------------|----------------|
| [#2264](https://github.com/LucasQuiles/WhatSoup/issues/2264) | AuthFailureClass/DisconnectClass parallel-union drift | Hoist the canonical union + 2 derived subsets | small (one symbol rename) |
| [#2265](https://github.com/LucasQuiles/WhatSoup/issues/2265) | Substrate MCP admin gate bypasses `isAdminPhone` SSOT | Replace `.has(phone)` with `isAdminPhone(phone, ...)` | small (security regression) |
| [#2266](https://github.com/LucasQuiles/WhatSoup/issues/2266) | Inline `GROUP_JID_RE` regex bypasses `isGroupJid()` SSOT | Delete the inline regex; use `isGroupJid` | small |
| [#2269](https://github.com/LucasQuiles/WhatSoup/issues/2269) | `/api/lines/...` URL pattern repeated 42 times | Add `console/src/lib/api/urls.ts` builder | medium (42 sites) |
| [#2270](https://github.com/LucasQuiles/WhatSoup/issues/2270) | Group-mode unions inlined 3 places | Export canonical from `src/mcp/tools/groups.ts` | small |
| [#2271](https://github.com/LucasQuiles/WhatSoup/issues/2271) | `PINECONE_API_KEY` literal fallback in 4 files | Use `envForService('pinecone')` SSOT | small (4 sites) |
| [#2272](https://github.com/LucasQuiles/WhatSoup/issues/2272) | HealCompletePayloadSchema = EmitHealResultSchema duplicates | Collapse to one schema; alias the other | small |

### SOC (1 issue)

| # | Title | One-line summary | Migration cost |
|---|-------|------------------|----------------|
| [#2267](https://github.com/LucasQuiles/WhatSoup/issues/2267) | `console/src/lib/api.ts` 595-line god-module (6 concerns) | Split into auth/probe/normalize/urls/index | medium (4 module extractions) |

### DRY (7 issues)

| # | Title | One-line summary | Migration cost |
|---|-------|------------------|----------------|
| [#2268](https://github.com/LucasQuiles/WhatSoup/issues/2268) | 11-site `AbortSignal.timeout` magic cluster (5000/15000/30000) | Define `TIMEOUTS` object at top of file | small (11 sites) |
| [#2273](https://github.com/LucasQuiles/WhatSoup/issues/2273) | `fakeInstance` test fixture duplicated in 37 files | Add helper to `tests/helpers/http-mocks.ts` | medium (37 files) |
| [#2274](https://github.com/LucasQuiles/WhatSoup/issues/2274) | `core/health.ts` writes raw `res.writeHead` 20 times | Replace with `jsonResponse()` helper | small (20 sites) |
| [#2275](https://github.com/LucasQuiles/WhatSoup/issues/2275) | `(err as NodeJS.ErrnoException).code` duplicated in 18 files | Export `errnoCode` from `src/lib/errno.ts` | small (18 sites) |
| [#2276](https://github.com/LucasQuiles/WhatSoup/issues/2276) | `JSON.parse(readFileSync)` duplicated 11 times for non-private path | Add `readJsonFileSync` to `src/lib/json-file.ts` | small (11 sites) |
| [#2277](https://github.com/LucasQuiles/WhatSoup/issues/2277) | JSON-body parsing copy-pasted 5× in fleet/routes/ops.ts | Add `parseJsonBody` to `src/lib/http.ts` | small (6 sites) |
| [#2278](https://github.com/LucasQuiles/WhatSoup/issues/2278) | 16 test files reimplement mockReq/mockRes | Import from `tests/helpers/http-mocks.ts` | medium (16 files) |

## Unique-ID accounting (de-duplicated)

Multi-category issues counted once in unique totals:
- **#2244** (InboundStatus) — listed in both R13-SSOT and R13-SOC; counts as 1 unique ID
- **#2252** (xdgDir) — listed in R14-SSOT and R14-SOC; counts as 1 unique ID

**Unique total: 30 items (29 fresh + 1 pre-existing labeled)** — same as the heading.

## Grouping strategy (PR-batches)

These 30 items form three natural PR-groups (one per category) for parallel
review:

- **PR-1: SSOT (16 items)** — #2237, #2241, #2244, #2245, #2249, #2250, #2251, #2252, #2264, #2265, #2266, #2269, #2270, #2271, #2272
- **PR-2: SOC god-modules (7 items)** — #2238, #2239, #2242, #2249, #2251, #2252, #2267
- **PR-3: DRY (10 items)** — #2240, #2243, #2253, #2268, #2273, #2274, #2275, #2276, #2277, #2278

(Items in multiple groups — #2244, #2249, #2251, #2252 — span both PR-1 and PR-2.)

Each PR-group can be merged independently.

## Audit lense — closed-issue audit (verified)

Per the goal's "monitoring for closed issues with an audit lense" clause,
4 closed issues were audited on **2026-07-24T18:11:14-16Z**:

| Closed issue | Audit comment | Verdict |
|---|---|---|
| [#1830](https://github.com/LucasQuiles/WhatSoup/issues/1830) | [comment 5073021495](https://github.com/LucasQuiles/WhatSoup/issues/1830#issuecomment-5073021495) | closure valid; latent risk for R15 god-module extractions past 2000 lines |
| [#2174](https://github.com/LucasQuiles/WhatSoup/issues/2174) | [comment 5073021827](https://github.com/LucasQuiles/WhatSoup/issues/2174#issuecomment-5073021827) | closure valid (production-side writeFileAtomic); complementary to R15 #2276 (test-side readJsonFileSync) |
| [#2175](https://github.com/LucasQuiles/WhatSoup/issues/2175) | [comment 5073021697](https://github.com/LucasQuiles/WhatSoup/issues/2175#issuecomment-5073021697) | closure valid (SSOT conversation-key); complementary to R15 SSOT issues |
| [#2176](https://github.com/LucasQuiles/WhatSoup/issues/2176) | [comment 5073021611](https://github.com/LucasQuiles/WhatSoup/issues/2176#issuecomment-5073021611) | closure valid (production-side proxyToInstance); complementary to R15 #2240 (test-side) |

**All 4 closures stand.** R13+R14+R15 batch is non-overlapping. See meta-issue
[#2247](https://github.com/LucasQuiles/WhatSoup/issues/2247) for the full audit verdict.

## Reference

- Worklog entry: `q-pi-worklog.md` (R13 + R14 + R15 batch entries)
- Issue bodies: each issue above links to its full body via the `#NNNN` reference
- Per-issue details: each row above links to the issue page (right-click
  the #NNNN in GitHub to see the body with file:line evidence, ESLint rule
  sketches, arch-ratchet test pseudocode, and migration path)
