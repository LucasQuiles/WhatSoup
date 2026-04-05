# Bead: B03-trivial-p2-fixes
**Status:** pending
**Type:** implement
**Runner:** unassigned
**Dependencies:** [B01]
**Scope:** src/core/database.ts, src/core/messages.ts, src/core/admin.ts
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** accidental
**Profile:** REPAIR
**Decision trace:** docs/sdlc/active/whatsoup-full-hardening-20260331/beads/B03-decision-trace.md
**Deterministic checks:** [vitest-full-suite, typecheck]
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}

## Input
Three trivial P2 fixes bundled:

1. **P2-17:** `src/core/database.ts` lines 464, 480, 493, 509 — four bare `catch {}` blocks in `importFromLegacyDb`. Add `(err)` binding and `log.warn({ err, table }, 'legacy import failed')`.

2. **P2-19:** `src/core/messages.ts:187-199` — `markMessagesProcessed` builds unbounded `IN (?,?,?...)`. Add chunking at 500 params.

3. **P2-21:** `src/core/admin.ts:26,59,116` — three `log.info(obj)` calls with no message string. Add message strings: `'access granted by admin'`, `'access blocked by admin'`, `'approval requested'`.

## Output
- All three issues fixed with minimal changes
- Tests for SQLite chunking (pass arrays of 1000+ PKs)
- Existing tests still green
