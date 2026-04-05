# Task: Remaining Production Hardening

**ID:** remaining-hardening-20260330
**Created:** 2026-03-30
**Status:** frame
**Phase:** 1-frame
**Complexity:** moderate
**Source:** `docs/audit-2026-03-30.md` (8 open findings), `docs/handoff-2026-03-30-production-hardening.md`

## Objective

Resolve the 8 remaining open audit findings (1 P1, 7 P2) plus test infrastructure cleanup. None are production-blocking, but all improve resilience, observability, and maintainability.

## Success Criteria

1. All 8 open audit findings resolved with tests
2. Test helper consolidation complete (19 files → `tests/helpers/`)
3. Full test suite green (1,972+ tests)
4. Clean typecheck

## Beads (Proposed)

| # | Bead | Audit # | Sev | Effort | Dependencies |
|---|------|---------|-----|--------|-------------|
| 1 | ChatRuntime send retry | 11 | P1 | 2h | None |
| 2 | `(connection as any).sock` → typed accessor | 10 | P1 | 3-4h | None |
| 3 | SQLite 999-param chunking | 19 | P2 | 30m | None |
| 4 | `rate_limits` cleanup + dedup guard | 15, 16 | P2 | 30m | None |
| 5 | Admin log message strings | 21 | P2 | 15m | None |
| 6 | `rowToMessage` consolidation | 26 | P2 | 1h | None |
| 7 | Clear-chat `all: true` handling | 14 | P2 | 1h | None |
| 8 | Auth lock file | 18 | P2 | 1h | None |
| 9 | Test helper consolidation | — | Low | 1-2h | None |
| 10 | Enrichment partial index (migration 9) | — | Low | 30m | None |
| 11 | `stripSelfMentions` extraction | — | Low | 30m | None |

## Priority Order

1. **P1 first:** Beads 1-2 (data loss prevention, coupling reduction)
2. **Quick P2 wins:** Beads 3-5 (< 30min each, high ROI)
3. **P2 refactors:** Beads 6-8 (structural improvements)
4. **Infrastructure:** Beads 9-11 (test DX, minor improvements)

## Estimated Total: ~11-12h
