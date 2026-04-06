# PERF-03 Output

<!-- BEAD_OUTPUT_COMPLETE -->

- Bead: PERF-03 — batch turn-completion SQLite writes
- Branch: fix/perf-03-turn-completion-transaction
- Commit: pending (recorded in result message after commit)
- Summary: Added `DurabilityEngine.completeTurn()` to batch session-token accumulation, checkpoint upsert, inbound completion, and terminal-op marking in one transaction, then routed both result handlers through it.

## Files Changed
- src/core/durability.ts
- src/runtimes/agent/runtime.ts
- src/runtimes/agent/outbound-queue.ts
- src/runtimes/agent/control-queue.ts
- tests/core/durability.test.ts
- tests/core/perf-prepared-statements.test.ts
- tests/runtimes/agent/runtime.test.ts
- tests/runtimes/agent/codex-turn-lifecycle.test.ts
- bead-output.md

## Verification
- `npx vitest run tests/runtimes/agent/runtime.test.ts tests/core/durability.test.ts tests/core/perf-prepared-statements.test.ts tests/runtimes/agent/codex-turn-lifecycle.test.ts --pool=forks` ✅
- `npm run typecheck` ✅
- `npx vitest run` ✅

## Notes
- `completeTurn()` uses a single explicit SQLite transaction (`BEGIN IMMEDIATE` / `COMMIT`) and rolls back on failure.
- `OutboundQueue`/`ControlQueue` gained `clearLastOpId()` so the result handlers can clear terminal bookkeeping without issuing an extra durability write.
- `tests/core/perf-prepared-statements.test.ts` now covers the added cached token-accumulation statement as part of the constructor cache set.
