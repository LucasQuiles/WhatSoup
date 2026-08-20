# PR #3242 — Merge Resolution Notes (QPI-2 producer handoff)

Branch: `fix/outbound-queue-quiescence-containment-resolved`
Base: `pr-3242` (`e0d416040`) merged with `origin/main` (`8c66317823`).
This is the merge-conflict resolution of PR #3242 "fix: contain poisoned outbound
queue scopes" against current main. NOT pushed. Worktree: `/tmp/opencode/mg3242-resolve`.

## Context: why it conflicted

PR #3242's head diverged from main by two main-merged fixes that rewrote the same
regions of `src/runtimes/agent/outbound-queue.ts`:

- **#3269** `fix(agent): flush waits for queue quiescence before the pending-work assert`
  — rewrote `flush()` to re-await until quiescent with a **spin cap**
  (`FLUSH_QUIESCENCE_MAX_SPINS = 200`, `FLUSH_QUIESCENCE_SPIN_MS = 25`) and added
  `assertDrainComplete()` / `assertEvidenceComplete()`. This cap is load-bearing: it
  preserves stuck-queue detection (a queue that never drains still reaches the
  poisoning assert).
- **#3271** `fix(agent): suppress minimal-mode pre-tool narration` — added a 3-arg
  `enqueueStreamingText(text, role, onCommit)` and a `hasBufferedVisibleText` +
  boolean-return `enqueueResultText`, deferring the `turnHasVisibleText` mark to the
  actual flush boundary.

PR #3242 independently introduced `rejectPostClosureEnqueue()` (reject enqueues after
queue closure), and refactored flush/evidence/shutdown/poll completion through an
uncapped `atStableBoundary()` loop.

## The 4 `outbound-queue.ts` conflict hunks and their resolutions

1. **`enqueueStreamingText` (~line 797)** — main pushed
   `{ text, onCommit, ...attribution }`; PR pushed `{ text, ...attribution }` and added
   `rejectPostClosureEnqueue()` + `turnHasVisibleText = true`.
   **Resolved:** keep main's `onCommit` in the push, add PR's `rejectPostClosureEnqueue()`
   guard, **drop** PR's `turnHasVisibleText = true` (see correction 1 below).

2. **`enqueueResultText` (~line 868)** — main: `boolean` return + `hasBufferedVisibleText`
   check; PR: `void` return + `rejectPostClosureEnqueue()` guard.
   **Resolved:** keep main's `boolean` return and `hasBufferedVisibleText`, add PR's
   `rejectPostClosureEnqueue()` (return `false` on guard).

3. **`flush()` (~line 1130)** — main: spin-loop quiescence + `assertDrainComplete()` +
   inline presentation cleanup; PR: `await this.atStableBoundary(() =>
   this.completeFlushPresentation())`.
   **Resolved:** keep main's spin-loop entirely. #3269's cap semantics are preserved;
   PR's uncapped `atStableBoundary` is not adopted for `flush()`.

4. **`assertDrainComplete` / `assertEvidenceComplete` (~line 1533)** — main added both;
   PR removed them.
   **Resolved:** keep main's both methods (required by the #3269 `flush()`). PR's
   `atStableBoundary()` / `completeFlushPresentation()` still survive, used by the
   auto-merged `shutdown()`, `completeTurnEvidence()`, and `enqueuePoll()` paths.

## Beyond-plan correction 1 — dropped optimistic `turnHasVisibleText`

My first pass faithfully carried PR's `this.turnHasVisibleText = true` into
`enqueueStreamingText`. This is a regression the PR author's tree did not expose
because #3271 did not exist when #3242 was written.

**Test that forced it** — `tests/runtimes/agent/outbound-queue.test.ts`
`minimal mode drops buffered pre-tool narration and still delivers the terminal result`:
the buffered pre-tool narration is discarded, then the terminal result must still be
delivered. With the optimistic mark, `enqueueResultText` saw `turnHasVisibleText === true`
and suppressed the terminal result → `calls` came back `[]` instead of
`['Workbook updated and verified.']`. #3271 deliberately marks `turnHasVisibleText`
only inside `flushStreamBuffer.flushGroup()` (on actual flush), so the pre-tool
narration never marks the turn visible. Resolution keeps #3271's deferred marking.

## Beyond-plan correction 2 — re-pinned manifest sha256

`deploy/bot-errors-runtime-manifest.json` pins a sha256 for
`src/lib/fault-taxonomy-registry.json`. The merged file's digest is **neither** main's
`69bf1f103a4df72b96ed2bfd3a9e6373feb6fdc501b8a23e8ad72a0274f9dbeb` nor PR's
`6af18b9238b9d2387906196bace3badf48c46d3e32c4546d06f3c66df122f819`.

**Re-pinned to:** `9e3d3e8c889ad201b3f5619982c4790e6593b37750a4ab35ed8a49ba7b1796ee`

**Test that forced it** — `tests/scripts/bot-errors-health-check.test.ts`
`keeps the checked-in BOT ERRORS runtime manifest aligned with scripts and markers`
(asserts `sha256File(path) === item.sha256`).

## Other 6 conflicting files (generated/bookkeeping)

- `docs/public-surface.md` — took main's row set, then inserted PR's `outboundQueuePoisoned`
  / `outboundQueuePoisonedScopes` sentence into the `http:health.status` row (the field is
  present in merged `src/core/health.ts:2206`, so the doc must document it).
- `tests/scripts/public-surface-drift-check.test.ts` — took main's `:1533` anchor
  (still within the ±5 drift-check window of the merged handler at `health.ts:1537`).
- `docs/publication-audit.md` — regenerated via `npm run guard:publication -- --write`
  (376 rows).
- `docs/work-index.{json,md}` — regenerated via `npm run work-index:regen` (122 rows).

## Verification results (real numbers)

- `npm run typecheck` → **PASS** (exit 0).
- `npx vitest run --pool=forks` on the proof set → **350 passed / 0 failed**:
  - `tests/runtimes/agent/outbound-queue.test.ts` — 159
  - `tests/runtimes/agent/control-timeout.test.ts` — 9
  - `tests/scripts/bot-errors-health-check.test.ts` — 158
  - `tests/scripts/public-surface-drift-check.test.ts` — 24
