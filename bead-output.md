# PERF-01 Output

<!-- BEAD_OUTPUT_COMPLETE -->

- Bead: PERF-01 — cache DurabilityEngine prepared statements
- Branch: fix/perf-01-durability-prepared-stmts
- Commit: pending (recorded in result message after commit)
- Summary: Cached all fixed-SQL DurabilityEngine statements in the constructor, cached canonicalizeChatJid's LID lookup per database instance, and added regression coverage to prove statements are prepared once and reused.

## Files Changed
- src/core/durability.ts
- src/core/jid-constants.ts
- tests/core/perf-prepared-statements.test.ts
- bead-output.md

## Verification
- `npx vitest run tests/core/perf-prepared-statements.test.ts --pool=forks` ✅
- `npm run typecheck` ✅
- `npx vitest run` ✅

## Notes
- All 40 fixed SQL statements in `DurabilityEngine` are now prepared once in the constructor and reused across inbound, outbound, recovery, and health-stat code paths.
- No dynamic SQL exceptions remain in `src/core/durability.ts`.
- `canonicalizeChatJid` now invalidates and rebuilds its cached LID lookup statement when the database instance changes.
