# R13–R15 Tech-debt Review Map

**Status:** Completed — review snapshot captured on 2026-07-24. The R13 and R14 issue
inventories below were rechecked against GitHub; the R15 identifiers are
quarantined observations because they are currently unavailable.

This document preserves a review map, not an implementation schedule. Live
issue state, evidence, overlap, and current-main scope must be refreshed before
claiming a lane. Labels are overlapping review lenses, not prescribed pull
request boundaries.

## Live inventory

The live inventory contains 16 open items: nine R13 issues, six fresh R14
issues, and one pre-existing R14 issue.

### R13: nine open issues

The R13 issues were filed in numeric order with SSOT, SOC, and DRY findings
interleaved. The GitHub title fields for #2237–#2245 contain body-like text
beginning with `## Summary`; the table therefore uses **Finding** rather than
claiming those summaries are issue titles.

| Issue | Finding | Exact topical labels | Evidence-backed implementation scope |
|---|---|---|---|
| [#2237](https://github.com/LucasQuiles/WhatSoup/issues/2237) | E.164 regex has no canonical definition | `SSOT`, `refactor`, `tech-debt`, `type-safety` | Four definition sites: three exported constants plus one inline regex. A fifth existing file, the cross-transport validator, imports Twilio's copy. Consolidation therefore affects five existing files, plus a new module only if an existing file is not chosen as the canonical home; only three sites are re-exports. |
| [#2238](https://github.com/LucasQuiles/WhatSoup/issues/2238) | `src/fleet/index.ts` mixes routing, LID resolution, and auth/server concerns | `SOC`, `audit`, `refactor`, `tech-debt` | Review three proposed extractions independently and eliminate the reach-through database cast without changing HTTP behavior. |
| [#2239](https://github.com/LucasQuiles/WhatSoup/issues/2239) | `src/fleet/routes/ops.ts` mixes config, lifecycle, messaging, and auth-stream concerns | `SOC`, `audit`, `refactor`, `tech-debt` | Separate the auth-stream and route concerns while preserving handler contracts and process-lifecycle behavior. |
| [#2240](https://github.com/LucasQuiles/WhatSoup/issues/2240) | Fleet route tests duplicate the shared HTTP harness | `DRY`, `audit`, `refactor`, `tech-debt` | The reported 56 is a count of local helper definitions (28 `mockReq`, 17 `mockRes`, and 11 dependency builders), not 56 files. The issue identifies 32+ not-yet-migrated test files and 24 already-migrated files. |
| [#2241](https://github.com/LucasQuiles/WhatSoup/issues/2241) | Adapter reason codes are repeated as unrestricted magic strings | `SSOT`, `audit`, `refactor`, `tech-debt` | Introduce a typed registry and migrate five literal call sites across three production adapters and the in-memory test adapter. |
| [#2242](https://github.com/LucasQuiles/WhatSoup/issues/2242) | Pure time and FTS helpers live in the fleet composition ring | `SSOT`, `SOC`, `audit`, `refactor`, `tech-debt` | The issue reports nine upward imports: eight for time helpers and one for the FTS helper. Move or extract only the pure helpers, then remove the wrapper workaround. |
| [#2243](https://github.com/LucasQuiles/WhatSoup/issues/2243) | No-op logger fixtures are repeated across tests | `DRY`, `audit`, `refactor`, `tech-debt` | Add one typed helper, migrate the byte-identical fixtures first, and validate variants before consolidation. |
| [#2244](https://github.com/LucasQuiles/WhatSoup/issues/2244) | Inbound status unions and open-status predicates drift | `SSOT`, `SOC`, `audit`, `refactor`, `tech-debt` | Reconcile the domain union, query return type, and open-state predicate without treating the SSOT and SOC labels as separate fixes. |
| [#2245](https://github.com/LucasQuiles/WhatSoup/issues/2245) | Provider parity snapshot state diverges from its exported union | `SSOT`, `audit`, `refactor`, `tech-debt` | Make the exported state union complete and type the snapshot field against it before adding a declaration ratchet. |

### R14: six fresh issues and one pre-existing issue

The following state and labels were rechecked directly on 2026-07-24. The
remote roadmap omitted #2254 and overstated #2248's labels; both are corrected
here.

| Issue | Finding | Exact topical labels | Review note |
|---|---|---|---|
| [#2248](https://github.com/LucasQuiles/WhatSoup/issues/2248) | Heartbeat watchdog ignores reachable degraded runtime health | `audit`, `SSOT` | Pre-existing issue; exclude it from the fresh-issue count. |
| [#2249](https://github.com/LucasQuiles/WhatSoup/issues/2249) | `CircuitState` has three definitions and a name collision | `audit`, `refactor`, `SSOT`, `tech-debt` | Resolve the domain-name collision before choosing the canonical export. |
| [#2250](https://github.com/LucasQuiles/WhatSoup/issues/2250) | `getInboundStatus` widens the canonical union to `string` | `audit`, `refactor`, `SSOT`, `tech-debt`, `type-safety` | Treat SQL/runtime compatibility as part of the migration proof. |
| [#2251](https://github.com/LucasQuiles/WhatSoup/issues/2251) | `PROBE_STATE_VALUES` omits two valid type members | `audit`, `refactor`, `SSOT`, `tech-debt` | Align the runtime validator with the canonical type without inventing a second list. |
| [#2252](https://github.com/LucasQuiles/WhatSoup/issues/2252) | `xdgDir` is reimplemented with different fallthrough semantics | `audit`, `refactor`, `SSOT`, `tech-debt`, `SOC` | Preserve both the SSOT and ring-placement concerns. |
| [#2253](https://github.com/LucasQuiles/WhatSoup/issues/2253) | Throwing record/string validators are cloned across six files | `audit`, `refactor`, `DRY`, `SSOT`, `tech-debt` | Extend the shared type-guard surface before migrating callers. |
| [#2254](https://github.com/LucasQuiles/WhatSoup/issues/2254) | JSON round-trip deep cloning appears at 14 sites | `audit`, `refactor`, `DRY`, `tech-debt` | Validate value semantics before replacing sites with `structuredClone()`. |

## Review packets

These packets are navigation aids for parallel review. They do not authorize
combining issues into category-wide implementation PRs:

1. **Domain identifiers and state:** #2237, #2241, #2244, #2245, and
   #2249–#2251.
2. **Fleet module seams and paths:** #2238, #2239, and #2252.
3. **Test and helper deduplication:** #2240, #2243, #2253, and #2254.
4. **Operational-health observation:** #2248.

Each issue should begin as an independently reviewable implementation lane.
Combine issues only when a refreshed current-main diff demonstrates an atomic
dependency and the validation surface remains bounded.

## R15 remote candidate observations

The independently advanced PR branch described #2264–#2278 as live R15 issues.
Every identifier returned 404 when this reconciliation was performed on
2026-07-24. They are excluded from live totals and must not be recreated without
explicit owner approval.

The descriptions are retained only as unverified discovery leads:

| Former identifier | Candidate observation |
|---|---|
| `#2264` | Authentication/disconnect failure-class unions may drift. |
| `#2265` | A substrate admin gate may bypass the canonical phone check. |
| `#2266` | A group-JID regex may bypass the canonical predicate. |
| `#2267` | The console API module may mix unrelated concerns. |
| `#2268` | Abort-signal timeout literals may form a repeated policy cluster. |
| `#2269` | Console line-URL construction may be repeated. |
| `#2270` | Group-mode unions may be duplicated. |
| `#2271` | Pinecone environment-key lookup may bypass its service helper. |
| `#2272` | Heal-result schemas may duplicate one another. |
| `#2273` | `fakeInstance` test fixtures may be repeated broadly. |
| `#2274` | Health routes may bypass the shared JSON response helper. |
| `#2275` | Errno-code extraction may be repeated. |
| `#2276` | Non-private JSON-file reads may lack a shared helper. |
| `#2277` | JSON-body parsing may be duplicated in fleet operations routes. |
| `#2278` | Request/response test mocks may remain duplicated. |

Fresh current-main observation, deduplication against the live backlog, and
owner authorization are required before any of these leads becomes issue or
implementation work.

## Closed-issue audit

The audit requested for R13 is recorded in
[#2247](https://github.com/LucasQuiles/WhatSoup/issues/2247). Four closed issues
were checked against the R13 findings:

| Closed issue | R13 intersection | Recorded verdict |
|---|---|---|
| [#1830](https://github.com/LucasQuiles/WhatSoup/issues/1830) | File-size ratchet behavior relevant to #2238 and #2239 | Closure remains valid. The audit records a latent risk that a first over-budget extraction could mask a sibling violation. |
| [#2176](https://github.com/LucasQuiles/WhatSoup/issues/2176) | Production-side proxy/read consolidation adjacent to #2240 | Closure remains valid; #2240 is test-harness work and is complementary. |
| [#2175](https://github.com/LucasQuiles/WhatSoup/issues/2175) | Conversation-key SSOT adjacent to the R13 SSOT findings | Closure remains valid; the R13 issues cover different domain invariants. |
| [#2174](https://github.com/LucasQuiles/WhatSoup/issues/2174) | Production atomic-write deduplication adjacent to #2243 | Closure remains valid; #2243 concerns test logger fixtures. |

The audit found no R13 duplicate that requires reopening those four issues.
This review map does not extend that verdict to R14 or the quarantined R15
observations.

## Use and refresh rules

- Read the linked issue body before implementation; this document is a review
  map, not a substitute for issue evidence.
- Refresh file paths, counts, overlap, labels, and open PRs against current
  `main` before claiming a lane.
- Preserve multi-label ownership rather than manufacturing separate fixes for
  each label.
- Keep implementation receipts and merge evidence in their PRs rather than
  appending volatile queue state here.
