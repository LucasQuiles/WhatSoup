# PERF-02 Output

<!-- BEAD_OUTPUT_COMPLETE -->

- Bead: PERF-02 — streaming buffer + stdout buffer + canonical map-key dedup
- Branch: fix/perf-02-streaming-buffer-optimization
- Commit: b17761f
- Summary: Replaced hot-path string concatenation in outbound streaming and session stdout handling, normalized non-sandbox per-chat session/queue lookups around a single per-message canonical map key, and added regressions for the new buffering/canonical reuse paths.

## Files Changed
- src/runtimes/agent/outbound-queue.ts
- src/runtimes/agent/runtime.ts
- src/runtimes/agent/session.ts
- tests/mcp/tools/heal.test.ts
- tests/runtimes/agent/control-timeout.test.ts
- tests/runtimes/agent/outbound-queue.test.ts
- tests/runtimes/agent/runtime.test.ts
- tests/runtimes/agent/session.test.ts
- tests/runtimes/agent/zombie-sessions.test.ts
- bead-output.md

## Verification
- `npx vitest run --pool=forks tests/runtimes/agent/outbound-queue.test.ts` ✅
- `npx vitest run --pool=forks tests/runtimes/agent/session.test.ts` ✅
- `npx vitest run --pool=forks tests/runtimes/agent/runtime.test.ts` ✅
- `npx vitest run --pool=forks tests/core/perf-prepared-statements.test.ts` ✅
- `npm run typecheck` ✅
- `npm run typecheck:all` ✅
- `npx vitest run --pool=forks` ✅ (199 files, 3,747 tests)

## Notes
- `OutboundQueue` now accumulates streaming fragments in `streamBufferParts` and joins once per flush/abort path.
- `SessionManager` now batches stdout chunks through `stdoutChunks`/`stdoutBufferStr`, draining complete lines and final crash/exit tails without repeated `chunk.toString()` concatenation.
- Non-sandbox `per_chat` now resolves one canonical map key per inbound message and threads it through queue/session reuse, while continuing to rely on the existing prepared-statement cache already present in `canonicalizeChatJid`.
