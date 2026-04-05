# Task: WhatSoup Full Hardening + Documentation

**ID:** whatsoup-full-hardening-20260331
**Created:** 2026-03-31
**Status:** complete
**Phase:** 5-synthesize
**Profile:** BUILD
**Complexity:** complex
**Cynefin:** complicated (known-unknowns — audit prescribes fixes, doc gaps are enumerable)

## Objective

Complete production hardening of WhatSoup: fix all P0 issues, address P1/P2 findings, and fill documentation gaps. WhatSoup has fully replaced whatsapp-bot + whatsapp-mcp (moved to ~/LAB/DEAD/).

## Prior SDLC Context

Four prior tasks exist from 2026-03-30 sessions — partially executed, uncommitted work in tree:
- `audit-remediation-20260330` — Phase 4 (execute), Wave 1 dispatched but not landed
- `p0-production-blockers-20260330` — Framed, beads pending
- `remaining-hardening-20260330` — Framed, 11 beads proposed
- `p1p2-production-hardening-20260330` — Empty (no state.md)

Uncommitted changes: 8 files (+444/-27 lines) touching SIGTERM, session error handling, access-policy, agent-sandbox. 28 test failures in access-policy.test.ts.

**Decision:** Subsume all 4 prior tasks into this unified task. Prior work in working tree will be assessed and either completed or reverted per bead.

## Scope

### Code Fixes (from audit-2026-03-30.md)
1. **P0-1:** SIGTERM/SIGINT handler (partially in uncommitted main.ts)
2. **P0-2:** per_chat shared state race (partially in uncommitted runtime.ts)
3. **P0-3:** Enrichment retry durability
4. **P0-4:** Child process spawn error handling (partially in uncommitted session.ts)
5. **P0-5:** Conversation key edge cases
6. **P0-6:** Null session guard
7. **P1s:** MCP logging, socket error catch, NaN config, sock abstraction, empty JID
8. **P2s:** From remaining-hardening task (11 items)

### Documentation Gaps
1. MCP tool API reference (117 tools)
2. Environment variable guide
3. Troubleshooting / operational runbook
4. Durability recovery algorithm docs

## Success Criteria

1. All P0 issues fixed with tests — zero test failures
2. P1 issues fixed with tests
3. Documentation gaps filled (at minimum: tool reference, env guide, ops runbook)
4. Full test suite green (2000+ tests)
5. Clean typecheck
6. All 4 systemd instances healthy after changes

## Bead Manifest

### Wave 1 — Fix test failures (serialize, must land first)
| Bead | Type | Priority | Cynefin | Depends |
|------|------|----------|---------|---------|
| B01-fix-test-failures | REPAIR | P0 | clear | none |

### Wave 2 — Remaining code fixes (parallelize B02 + B03)
| Bead | Type | Priority | Cynefin | Depends |
|------|------|----------|---------|---------|
| B02-chatruntime-send-retry | REPAIR | P1 | complicated | B01 |
| B03-trivial-p2-fixes | REPAIR | P2 | clear | B01 |

### Wave 3 — Documentation (all parallel, no code deps)
| Bead | Type | Priority | Cynefin | Depends |
|------|------|----------|---------|---------|
| B04-docs-configuration | BUILD | — | clear | none |
| B05-docs-tool-reference | BUILD | — | clear | none |
| B06-docs-runbook | BUILD | — | clear | none |
| B07-docs-durability | BUILD | — | clear | none |

## Scout Findings

24 of 28 audit findings already FIXED in committed code. Only 4 remain:
- P1-11: ChatRuntime send retry → B02
- P2-17: Silent catch blocks → B03
- P2-19: SQLite 999-param limit → B03
- P2-21: Admin log message strings → B03

## Phase Log

| Phase | Status | Notes |
|-------|--------|-------|
| 0-normalize | complete | Prior state assessed, 4 tasks subsumed |
| 1-frame | complete | Mission brief defined |
| 2-scout | complete | 24/28 fixed, 4 open, 4 doc gaps mapped |
| 3-architect | complete | 7 beads in 3 waves |
| 4-execute | complete | All 7 beads merged. 2062 tests, clean typecheck |
| 5-synthesize | complete | Verified, CLAUDE.md updated, ready to commit |
