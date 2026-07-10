# Architecture and Verification Quality Implementation Plan

**Status:** Pending implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the highest-value implementation clones and module cycle, replace shape-only repository guards with semantic negative controls, and make the release harness quieter, deterministic, and honest about missing browser dependencies and commit identity.

**Architecture:** Converge behavior only after characterization: the agent runtime receives one context-adapted event reducer, deployment scripts import one hardened private-filesystem library, and repository gates parse or execute the behavior they protect. Small independent refactors remain separate PRs so a low-risk helper consolidation never waits on the runtime reducer.

**Tech Stack:** TypeScript, TypeScript compiler API, Vitest, React, SQLite, Python 3, pytest, npm lockfiles, GitHub Actions.

## Global Constraints

- Start every PR from a freshly fetched `origin/main`; the audited base was `7330bafb`.
- Do not begin WS-D01 until PR #1716 and the reconstructed replacement for PR #1717 have landed or been closed.
- Do not begin WS-D02 until PRs #1715 and #1716 have landed or been closed.
- Before declaring an existing branch superseded, run both `git range-diff` and `git cherry -v`; no branch deletion belongs to these plans.
- Preserve observable behavior in WS-D01, WS-D02, WS-D04, and WS-D05. A behavior correction discovered during characterization gets its own PR.
- Keep WS-D01 through WS-D07 as seven independently reviewable PRs. Use the commit boundaries named below.
- Run all Node/npm commands through the pinned wrappers.
- Never publish, push, merge, or change repository settings as part of plan execution without explicit operator authorization.

---

## File Structure

### WS-D01 — One agent event reducer

- Modify `src/runtimes/agent/runtime.ts` — replace the twin event switches with one context-adapted reducer.
- Create `src/runtimes/agent/event-context.ts` — types and pure accessors that distinguish shared and per-chat state.
- Create `src/runtimes/agent/event-reducer-parity.ts` — temporary in-memory, low-cardinality comparison counters.
- Create `tests/runtimes/agent/event-handler-characterization.test.ts` — event/state parity matrix.
- Modify `tests/runtimes/agent/runtime.test.ts` — end-to-end shared and per-chat regression cases.
- Modify `tests/runtimes/agent/health-snapshot.test.ts` and `docs/runbook.md` — surface and document the temporary parity snapshot.

### WS-D02 — Python private-filesystem SSOT

- Create `deploy/scripts/lib/bot_errors_private_fs.py` — hardened directory, atomic JSON, append, and parent-fsync operations.
- Modify the seven scripts named by `tests/scripts/bot-errors-python-atomic-write-guard.test.ts` — import the SSOT and delete local copies.
- Modify `deploy/scripts/bot-errors-selfcheck.py` and `deploy/scripts/bot-errors-sentinel.py` — import the same primitives while preserving test patch points.
- Create `deploy/scripts/tests/test_bot_errors_private_fs.py` — direct behavior and fault-injection tests.
- Modify `tests/scripts/bot-errors-python-atomic-write-guard.test.ts` — test imports and SSOT behavior instead of copied source strings.
- Modify `deploy/bot-errors-runtime-manifest.json` and its generated/checking tests so the new runtime library is deployed and hash-pinned.

### WS-D03 — Semantic quality guards

- Create `scripts/orphan-export-guard.ts` — TypeScript/TSX production reachability analysis.
- Replace `tests/scripts/orphan-export-guard.test.ts` — fixture-driven negative and real-repository checks.
- Modify `scripts/guard-test-coverage-check.ts` — require a companion test to import, invoke, and assert a guard failure path.
- Modify `tests/scripts/guard-test-coverage-check.test.ts` — no-op/comment-only negative controls.
- Modify `scripts/agent-decision-polls-guard.ts` and `tests/scripts/agent-decision-polls-guard.test.ts` — structured wiring checks and executable hook fixtures.
- Modify `src/runtimes/agent/route-events.ts` and `tests/runtimes/agent/route-events.test.ts` — remove the production-orphaned delegation receipt API, unless a separately approved product PR wires it.
- Modify `package.json` and `docs/public-surface.md` — expose and wire the orphan guard.

### WS-D04 — Console cycle removal

- Modify `console/src/components/ConfirmDialog.tsx` — import Modal and Button modules directly.
- Create `tests/console/module-cycle.test.ts` — TypeScript-AST relative-import cycle detector for `console/src`.
- Retain `tests/console/confirm-dialog.test.tsx` and `tests/console/menu.test.tsx` as behavior proofs.

### WS-D05 — Substrate lookup helper

- Modify `src/core/substrate/poller.ts` — replace `lastHashFor` and `lastUrlHashFor` with `lastStringFor`.
- Modify `tests/core/substrate/poller.test.ts` — preserve ordering, status filter, missing key, non-string, and malformed JSON behavior.

### WS-D06 — Release-harness maintenance

- Modify `src/core/database.ts` and `tests/core/database.test.ts` — aggregate migration logs and avoid an expected in-memory WAL warning.
- Create `scripts/check-browser-readiness.ts` and `tests/scripts/check-browser-readiness.test.ts` — actionable executable preflight.
- Modify `package.json`, `package-lock.json`, and safeguard/public-surface docs/tests — wire the preflight and repair dependency paths.
- Modify `tests/fleet/index.test.ts`, `tests/fleet/routes/feed.test.ts`, and `tests/mcp/tools/media.test.ts` — replace deprecated recursive `rmdir` calls.

### WS-D07 — Commit identity procedure

- Create `scripts/merge-message-preflight.ts` and `tests/scripts/merge-message-preflight.test.ts` — validate an explicitly supplied squash subject/body and approved author identity.
- Modify `package.json`, `.github/workflows/quality.yml`, and `docs/contributing/quality-guardrails-checklist.md` — document and test the guarded merge path and post-merge detection boundary.
- Modify `scripts/repo-hygiene-guard.ts` and `tests/scripts/repo-hygiene-guard.test.ts` — share commit-message validation and remove comments that imply the server-generated message is already controlled.

---

## WS-D01 — Converge the Agent Event State Machine

### Task 1: Characterize both event handlers before extraction

**Files:**

- Create: `tests/runtimes/agent/event-handler-characterization.test.ts`
- Reference: `src/runtimes/agent/runtime.ts`

- [ ] **Step 1: Enumerate every `AgentEvent['type']` handled by either switch**

Build the event table directly from the union and fail when a new type lacks a fixture:

```ts
const CASES = {
  init: () => ({ type: 'init', sessionId: 'session-1' }),
  assistant_text: () => ({ type: 'assistant_text', text: 'hello' }),
  tool_start: () => ({ type: 'tool_start', id: 'tool-1', name: 'Read', input: {} }),
  tool_result: () => ({ type: 'tool_result', id: 'tool-1', content: 'ok', isError: false }),
  result: () => ({ type: 'result', subtype: 'success', result: 'done' }),
} satisfies Partial<Record<AgentEvent['type'], () => AgentEvent>>;

type MissingEvent = Exclude<AgentEvent['type'], keyof typeof CASES>;
const _allEventsCovered: MissingEvent extends never ? true : never = true;
```

Extend the literal with every compiler-reported missing event; do not silence `MissingEvent` with a cast.

- [ ] **Step 2: Capture an effect trace for shared and per-chat contexts**

Use real `OutboundQueue`/session doubles and record only observable calls:

```ts
interface EventTrace {
  queue: Array<{ method: string; args: unknown[] }>;
  session: string[];
  tracker: string[];
  durability: Array<{ method: string; args: unknown[] }>;
  state: Record<string, unknown>;
}

it.each(Object.entries(CASES))('%s preserves shared/per-chat effects', (_type, makeEvent) => {
  const shared = runLegacyHandler('shared', makeEvent());
  const perChat = runLegacyHandler('per_chat', makeEvent());
  expect(shared).toMatchSnapshot();
  expect(perChat).toMatchSnapshot();
});
```

Include separate fixtures for post-turn gate, silent compact, system result, route-marker buffering, replay actor, tool error, provider error, interrupted result, and missing queue.

- [ ] **Step 3: Run and commit the characterization baseline**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/runtimes/agent/event-handler-characterization.test.ts --pool=forks --fileParallelism=false
git add tests/runtimes/agent/event-handler-characterization.test.ts
git commit -m "test(agent): characterize event handler contexts"
```

Expected: PASS against legacy code, with reviewed snapshots containing no raw conversation identifiers.

### Task 2: Introduce the explicit context adapter

**Files:**

- Create: `src/runtimes/agent/event-context.ts`
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `tests/runtimes/agent/event-handler-characterization.test.ts`

- [ ] **Step 1: Add the context contract**

```ts
import type { IOutboundQueue } from './outbound-queue.ts';
import type { SessionManager } from './session.ts';

export type AgentEventMode = 'shared' | 'per_chat';

export interface AgentEventContext {
  mode: AgentEventMode;
  queue: IOutboundQueue;
  session: SessionManager | null;
  conversationKey?: string;
  inboundSeq?: number;
  mapKey?: string;
  toolScopeKey: string;
  isSystemResult: boolean;
}

export function contextStateKey(ctx: AgentEventContext): string | undefined {
  return ctx.mode === 'per_chat' ? ctx.mapKey : undefined;
}
```

Keep runtime-owned mutation in `AgentRuntime`; this module owns only context data and pure accessors.

- [ ] **Step 2: Add one constructor for each mode**

In `runtime.ts`, add `sharedEventContext()` and this exact per-chat constructor:

```ts
private perChatEventContext(
  queue: IOutboundQueue,
  session: SessionManager | null,
  conversationKey?: string,
  inboundSeq?: number,
  mapKey?: string,
  toolScopeKey: string = mapKey ?? GLOBAL_TOOL_SCOPE_KEY,
  isSystemResult: boolean = false,
): AgentEventContext {
  return {
    mode: 'per_chat',
    queue,
    session,
    conversationKey,
    inboundSeq,
    mapKey,
    toolScopeKey,
    isSystemResult,
  };
}
```

Each constructor must choose queue, session, tracker key, actor key, route-marker storage, and post-turn gate key explicitly. Do not infer mode from a missing `mapKey` inside the reducer.

- [ ] **Step 3: Assert adapter construction without changing dispatch**

Add tests that shared mode uses `GLOBAL_TOOL_SCOPE_KEY`, per-chat mode preserves its `mapKey`, and missing shared queue returns `null`.

- [ ] **Step 4: Run focused proof**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/runtimes/agent/event-handler-characterization.test.ts tests/runtimes/agent/runtime.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: PASS with legacy dispatch still active.

### Task 3: Extract one reducer case-family at a time

**Files:**

- Modify: `src/runtimes/agent/runtime.ts`
- Create: `src/runtimes/agent/event-reducer-parity.ts`
- Modify: `tests/runtimes/agent/event-handler-characterization.test.ts`
- Modify: `tests/runtimes/agent/health-snapshot.test.ts`
- Modify: `docs/runbook.md`

- [ ] **Step 1: Add the single reducer entrypoint**

```ts
private reduceAgentEvent(event: AgentEvent, ctx: AgentEventContext): void {
  switch (event.type) {
    // Cases move here mechanically; no case remains in the two wrappers.
  }
}

private handleEventWithContext(
  event: AgentEvent,
  queue: IOutboundQueue,
  session: SessionManager | null,
  conversationKey?: string,
  inboundSeq?: number,
  mapKey?: string,
  toolScopeKey: string = mapKey ?? GLOBAL_TOOL_SCOPE_KEY,
  isSystemResult: boolean = false,
): void {
  this.reduceAgentEvent(
    event,
    this.perChatEventContext(
      queue,
      session,
      conversationKey,
      inboundSeq,
      mapKey,
      toolScopeKey,
      isSystemResult,
    ),
  );
}

private handleEvent(event: AgentEvent): void {
  const ctx = this.sharedEventContext();
  if (ctx) this.reduceAgentEvent(event, ctx);
}
```

- [ ] **Step 2: Move cases in four reviewable commits**

Move and verify in this order:

1. `init`, status, and text streaming;
2. tool start/progress/result;
3. terminal result/provider-failure/interruption;
4. routing, poll, compaction, and remaining control events.

For state that differs by mode, add a named adapter accessor. Do not place `if (ctx.mode === ...)` ladders throughout case bodies.

- [ ] **Step 3: Record temporary parity diagnostics**

Record one low-cardinality in-memory snapshot through `EventReducerParity` and expose it under the existing agent runtime health details:

```ts
import type { AgentEventMode } from './event-context.ts';
import type { AgentEvent } from './stream-parser.ts';

export type EventReducerDivergenceReason =
  | 'effect-name'
  | 'effect-order'
  | 'terminal-decision'
  | 'state-transition';

export class EventReducerParity {
  private compared = 0;
  private readonly divergences = new Map<string, number>();

  recordComparison(): void {
    this.compared += 1;
  }

  record(input: {
    mode: AgentEventMode;
    eventType: AgentEvent['type'];
    reason: EventReducerDivergenceReason;
  }): void {
    const key = `${input.mode}:${input.eventType}:${input.reason}`;
    this.divergences.set(key, (this.divergences.get(key) ?? 0) + 1);
  }

  snapshot(): { compared: number; divergenceTotal: number; byKey: Record<string, number> } {
    const byKey = Object.fromEntries(this.divergences);
    return {
      compared: this.compared,
      divergenceTotal: Object.values(byKey).reduce((sum, count) => sum + count, 0),
      byKey,
    };
  }
}

this.eventReducerParity.record({
  mode: ctx.mode,
  eventType: event.type,
  reason: divergence.reason,
});

// getHealthSnapshot().details
eventReducerParity: this.eventReducerParity.snapshot(),
```

Never label by chat, sender, session, tool input, or message content. Shadow comparison records normalized decision/effect names, not duplicated side effects.

- [ ] **Step 4: Prove every move**

After each case-family commit, run:

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/runtimes/agent/event-handler-characterization.test.ts tests/runtimes/agent/runtime.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:all
```

Expected: all characterization traces remain byte-for-byte stable and the legacy switch count decreases until only the reducer switch remains.

- [ ] **Step 5: Remove legacy handlers and commit**

```bash
rg -n "switch \(event\.type\)" src/runtimes/agent/runtime.ts
```

Expected: exactly one event switch in the reducer.

```bash
git add src/runtimes/agent/runtime.ts src/runtimes/agent/event-context.ts src/runtimes/agent/event-reducer-parity.ts docs/runbook.md tests/runtimes/agent/event-handler-characterization.test.ts tests/runtimes/agent/health-snapshot.test.ts tests/runtimes/agent/runtime.test.ts
git commit -m "refactor(agent): converge event handling on one reducer"
```

### Task 4: Remove the shadow counter only after operational evidence

- [ ] **Step 1: Run a canary with both shared and per-chat instances**

Acceptance evidence: at least one normal turn, one tool call, one interrupted turn, one provider failure, and one reconnect per mode; zero unexplained divergence.

- [ ] **Step 2: Remove shadow-only code in a follow-up commit**

Retain permanent event-stage metrics, remove only comparison machinery, and rerun the full release gate.

---

## WS-D02 — Centralize Python Private Filesystem Operations

### Task 5: Lock the shared filesystem contract with red tests

**Files:**

- Create: `deploy/scripts/tests/test_bot_errors_private_fs.py`

- [ ] **Step 1: Add positive and adversarial cases**

```py
def test_atomic_write_json_is_private_and_durable(tmp_path, monkeypatch):
    target = tmp_path / "state" / "status.json"
    fsyncs = []
    monkeypatch.setattr(os, "fsync", lambda fd: fsyncs.append(fd))
    atomic_write_json(target, {"ok": True})
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert json.loads(target.read_text()) == {"ok": True}
    assert len(fsyncs) >= 2

@pytest.mark.parametrize("operation", [atomic_write_json, append_private_jsonl])
def test_refuses_symlink_target(tmp_path, operation):
    real = tmp_path / "real"
    real.write_text("unchanged")
    link = tmp_path / "link"
    link.symlink_to(real)
    with pytest.raises(OSError):
        operation(link, {"ok": True})
    assert real.read_text() == "unchanged"
```

Also cover non-directory parents, existing non-regular targets, replace failure cleanup, partial write, append ordering, mode repair, and parent-fsync open failure.

- [ ] **Step 2: Confirm RED**

```bash
bash scripts/run-tokenomics-pytests.sh deploy/scripts/tests/test_bot_errors_private_fs.py
```

Expected: FAIL because `deploy/scripts/lib/bot_errors_private_fs.py` does not exist.

### Task 6: Implement and migrate the shared library

**Files:**

- Create: `deploy/scripts/lib/bot_errors_private_fs.py`
- Modify: all scripts listed under WS-D02 File Structure
- Modify: `tests/scripts/bot-errors-python-atomic-write-guard.test.ts`

- [ ] **Step 1: Implement the SSOT**

The module exports exactly:

```py
__all__ = [
    "append_private_jsonl",
    "assert_regular_or_missing",
    "atomic_write_json",
    "ensure_private_dir",
    "fsync_parent",
]
```

`atomic_write_json` must create the parent at `0700`, use an exclusive no-follow temporary file at `0600`, flush and fsync the file, `os.replace`, chmod the destination to `0600`, fsync the parent, and unlink the temp on failure. `append_private_jsonl` must validate the target with `lstat`, open using `O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW`, chmod to `0600`, perform a complete newline-terminated write, and fsync.

- [ ] **Step 2: Preserve monkeypatch surfaces**

Each migrated script imports module symbols into its namespace:

```py
from lib.bot_errors_private_fs import (
    append_private_jsonl,
    atomic_write_json,
    ensure_private_dir,
    fsync_parent,
)
```

Existing tests that patch `module.atomic_write_json` therefore remain valid.

- [ ] **Step 3: Replace the string guard with behavior/parity checks**

The TypeScript guard test must verify each managed script imports the SSOT and does not define the protected functions locally. Direct security behavior belongs to the Python test, not repeated substring assertions.

- [ ] **Step 4: Update runtime manifests and run proof**

```bash
bash scripts/run-tokenomics-pytests.sh deploy/scripts/tests/test_bot_errors_private_fs.py
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/bot-errors-python-atomic-write-guard.test.ts tests/scripts/check-bot-errors-runtime-manifest.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run guard:deployer-static
```

Expected: PASS; a deliberate symlink fixture fails closed without modifying its referent.

- [ ] **Step 5: Commit**

```bash
git add deploy/scripts/lib/bot_errors_private_fs.py deploy/scripts/bot-errors-*.py deploy/scripts/tests/test_bot_errors_private_fs.py tests/scripts/bot-errors-python-atomic-write-guard.test.ts deploy/bot-errors-runtime-manifest.json
git commit -m "refactor(bot-errors): centralize private filesystem operations"
```

---

## WS-D03 — Make Quality Guards Semantic

### Task 7: Replace orphan text counting with production reachability

**Files:**

- Create: `scripts/orphan-export-guard.ts`
- Replace: `tests/scripts/orphan-export-guard.test.ts`
- Modify: `package.json`
- Modify: `docs/public-surface.md`

- [ ] **Step 1: Add negative-control fixtures**

Create temporary repos in the test with `.ts` and `.tsx` production files. These must be classified exactly:

```ts
it.each([
  ['comment only', '// orphanExport\n', true],
  ['string only', 'const note = "orphanExport";\n', true],
  ['test only', 'orphanExport();\n', true],
  ['tsx import', 'import { liveExport } from "./lib"; export const View = () => <>{liveExport()}</>;', false],
  ['production call', 'import { liveExport } from "./lib"; liveExport();', false],
])('%s', (_name, consumer, orphaned) => {
  const result = scanOrphanExports(makeRepo(consumer));
  expect(result.orphans.some((entry) => entry.name.endsWith('Export'))).toBe(orphaned);
});
```

- [ ] **Step 2: Implement AST-aware reachability**

Use the TypeScript compiler API to enumerate exported value declarations in `src/**/*.{ts,tsx}`, build edges from static imports/re-exports, and count identifier references only in production AST nodes. Tests, comments, and string literals do not satisfy reachability. Keep an explicit, path-qualified public API allowlist.

- [ ] **Step 3: Decide the production orphan**

`emitDelegationReceipt` is referenced only by tests. Unless a separately approved product design wires a real delegation receipt emission path, delete the interface/function and its isolated tests in this PR. Do not add it to the allowlist.

- [ ] **Step 4: Wire and run**

```bash
bash scripts/run-with-pinned-npm.sh run guard:orphan-exports
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/orphan-export-guard.test.ts tests/runtimes/agent/route-events.test.ts --pool=forks --fileParallelism=false
```

Expected: comment/string/test-only fixtures fail; TSX and production imports pass; current production tree has no unexplained orphan.

### Task 8: Reject no-op companion tests

**Files:**

- Modify: `scripts/guard-test-coverage-check.ts`
- Modify: `tests/scripts/guard-test-coverage-check.test.ts`

- [ ] **Step 1: Change the result taxonomy**

```ts
export type GuardTestCoverageReason =
  | 'no-test'
  | 'test-not-wired'
  | 'test-does-not-import-guard'
  | 'test-does-not-exercise-failure';
```

- [ ] **Step 2: Parse companion tests**

Using TypeScript AST, require the test to import the guard module, call an imported analyzer/check/run symbol, and assert a failing result, non-empty findings, thrown error, or non-zero exit outcome. A marker in a comment or string must not count.

- [ ] **Step 3: Add the negative controls**

The existing generated `it("noop", () => {})` fixture must now fail with `test-does-not-import-guard`. A fixture that imports the guard but never invokes it must fail. A fixture that invokes only a success path must fail with `test-does-not-exercise-failure`.

- [ ] **Step 4: Run**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/guard-test-coverage-check.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run guard:guard-test-coverage
```

Expected: all real guard tests demonstrate a failure path or receive a narrowly documented temporary exception that names the broader negative-control suite and an expiry issue/PR.

### Task 9: Replace raw decision-poll anchors with structured checks

**Files:**

- Modify: `scripts/agent-decision-polls-guard.ts`
- Modify: `tests/scripts/agent-decision-polls-guard.test.ts`

- [ ] **Step 1: Add source mutations that must fail**

Fixtures must prove that placing `AskUserQuestion`, `multiSelect`, or hook names in comments does not pass; removing the MCP schema description fails; and a lint hook that always exits zero fails its executable negative fixture.

- [ ] **Step 2: Parse the TypeScript wiring and execute the hook fixture**

Use AST checks for the exported prompt constant, MCP schema description call, and workspace hook registration object. Run `poll-interaction-lint.mjs` against one accepted and one prohibited synthetic transcript; require exit 0 and non-zero respectively.

- [ ] **Step 3: Run and commit WS-D03**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/orphan-export-guard.test.ts tests/scripts/guard-test-coverage-check.test.ts tests/scripts/agent-decision-polls-guard.test.ts tests/runtimes/agent/route-events.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
git add scripts/orphan-export-guard.ts scripts/guard-test-coverage-check.ts scripts/agent-decision-polls-guard.ts tests/scripts/orphan-export-guard.test.ts tests/scripts/guard-test-coverage-check.test.ts tests/scripts/agent-decision-polls-guard.test.ts src/runtimes/agent/route-events.ts tests/runtimes/agent/route-events.test.ts package.json docs/public-surface.md
git commit -m "fix(quality): make orphan and guard coverage checks semantic"
```

---

## WS-D04 — Break the Console ESM Cycle

### Task 10: Prove and remove the cycle

**Files:**

- Create: `tests/console/module-cycle.test.ts`
- Modify: `console/src/components/ConfirmDialog.tsx`

- [ ] **Step 1: Add a TypeScript-AST cycle detector test**

Scan relative imports in `console/src/**/*.{ts,tsx}`, resolve `file`, `file.ts`, `file.tsx`, and `file/index.ts`, then depth-first search with an active stack. The pre-change failure must include:

```text
components/ConfirmDialog.tsx -> components/primitives/index.ts -> components/primitives/Menu.tsx -> components/ConfirmDialog.tsx
```

- [ ] **Step 2: Confirm RED**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/console/module-cycle.test.ts --pool=forks --fileParallelism=false
```

- [ ] **Step 3: Import leaf modules directly**

```ts
import { Modal, ModalHeader, ModalBody, ModalFooter } from './primitives/Modal';
import { Button } from './primitives/Button';
```

Do not modify the public `ConfirmDialogProps` contract or the primitives barrel exports.

- [ ] **Step 4: Verify and commit**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/console/module-cycle.test.ts tests/console/confirm-dialog.test.tsx tests/console/menu.test.tsx --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh --prefix console run build
git add console/src/components/ConfirmDialog.tsx tests/console/module-cycle.test.ts
git commit -m "refactor(console): break confirm dialog module cycle"
```

Expected: no relative-import cycles and unchanged dialog/menu behavior.

---

## WS-D05 — Consolidate the Substrate String Lookup

### Task 11: Characterize and replace the duplicate helpers

**Files:**

- Modify: `src/core/substrate/poller.ts`
- Modify: `tests/core/substrate/poller.test.ts`

- [ ] **Step 1: Add focused behavior cases**

For both `hash` and `urlHash`, insert runs with equal timestamps and increasing IDs; assert the highest ID wins. Add missing output, absent key, numeric key, malformed JSON, failed status, and successful/noop status cases.

- [ ] **Step 2: Introduce one helper**

```ts
private lastStringFor(triggerId: number, key: string): string | null {
  const row = this.db.prepare(
    `SELECT output_json FROM trigger_runs
     WHERE trigger_id = ? AND status IN ('ok','noop')
     ORDER BY started_at DESC, id DESC
     LIMIT 1`,
  ).get(triggerId) as { output_json: string | null } | undefined;
  if (!row?.output_json) return null;
  try {
    const parsed = JSON.parse(row.output_json) as Record<string, unknown>;
    return typeof parsed[key] === 'string' ? parsed[key] : null;
  } catch {
    return null;
  }
}
```

Replace calls with `lastStringFor(t.id, 'hash')` and `lastStringFor(t.id, 'urlHash')`; delete both old helpers.

- [ ] **Step 3: Verify and commit**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/substrate/poller.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:all
git add src/core/substrate/poller.ts tests/core/substrate/poller.test.ts
git commit -m "refactor(substrate): consolidate last string lookup"
```

---

## WS-D06 — Make Release Verification Quiet and Explicit

### Task 12: Aggregate expected database logs

**Files:**

- Modify: `src/core/database.ts`
- Modify: `tests/core/database.test.ts`

- [ ] **Step 1: Add log-call assertions**

Mock the logger and assert opening a current schema emits no per-migration info calls; migrating versions 3 through 7 emits one aggregate info event `{ count: 5, firstVersion: 3, lastVersion: 7 }`; `:memory:` does not warn when SQLite reports `journal_mode=memory`; a file database still warns on a non-WAL mode.

- [ ] **Step 2: Aggregate migrations**

Have `runPendingMigrations` return its applied version list. Emit per-version messages at debug and one aggregate info event after success. Store whether the database path is in-memory and suppress only the expected `memory` journal mode for that path.

- [ ] **Step 3: Verify**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/core/database.test.ts tests/core/migration-safety.test.ts --pool=forks --fileParallelism=false
```

### Task 13: Fail browser verification with an actionable preflight

**Files:**

- Create: `scripts/check-browser-readiness.ts`
- Create: `tests/scripts/check-browser-readiness.test.ts`
- Modify: `package.json`
- Modify: `scripts/safeguard-diagnostics.ts`
- Modify: `tests/scripts/safeguard-diagnostics.test.ts`
- Modify: `docs/public-surface.md`

- [ ] **Step 1: Add red tests for missing and present executables**

Inject `executablePath` and `existsSync`; require the missing case to exit non-zero and print one command:

```text
npx playwright install chromium
```

The message must not claim browser tests ran.

- [ ] **Step 2: Implement and wire the preflight**

```json
{
  "guard:browser-readiness": "bash scripts/run-with-pinned-node.sh scripts/check-browser-readiness.ts",
  "test:browser": "npm run guard:browser-readiness && vitest run --config vitest.browser.config.ts",
  "test:browser:motion": "npm run guard:browser-readiness && vitest run --config vitest.browser.motion.config.ts"
}
```

Update safeguard diagnostics to require this order.

- [ ] **Step 3: Prove both paths**

Run the fixture test, then the guard against the installed browser. Temporarily point the injected test dependency to a missing path and prove the browser runner is never spawned.

### Task 14: Repair maintenance warnings and the advisory

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/fleet/index.test.ts`
- Modify: `tests/fleet/routes/feed.test.ts`
- Modify: `tests/mcp/tools/media.test.ts`

- [ ] **Step 1: Replace deprecated removals**

Use `rmSync(path, { recursive: true, force: true })` for recursive cleanup and `rmdirSync(path)` only for a known-empty directory. Remove obsolete `rmdirSync` imports.

- [ ] **Step 2: Remove the obsolete Vite/esbuild override**

Delete the nested `"vite": { "esbuild": "^0.28.1" }` override. `tsx` remains the owner of its supported esbuild version.

- [ ] **Step 3: Refresh only the affected lock path**

```bash
bash scripts/run-with-pinned-npm.sh install --package-lock-only --ignore-scripts
bash scripts/run-with-pinned-npm.sh update brace-expansion --package-lock-only --ignore-scripts
npm ls brace-expansion --all
npm audit --audit-level=moderate
npm audit --omit=dev --audit-level=moderate
```

Expected: the 5.x path resolves to at least `5.0.6`; no audit report for GHSA-jxxr-4gwj-5jf2; production audit remains clean. Review the complete lockfile diff and reject unrelated major-version movement.

- [ ] **Step 4: Measure log reduction and commit**

Run the pinned full suite once before and once after, capturing output to files. Record line and byte counts in the PR body; require a material reduction without hiding errors or warnings from unexpected paths.

```bash
bash scripts/run-with-pinned-npm.sh test -- --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run typecheck:all
git add src/core/database.ts tests/core/database.test.ts scripts/check-browser-readiness.ts tests/scripts/check-browser-readiness.test.ts package.json package-lock.json scripts/safeguard-diagnostics.ts tests/scripts/safeguard-diagnostics.test.ts docs/public-surface.md tests/fleet/index.test.ts tests/fleet/routes/feed.test.ts tests/mcp/tools/media.test.ts
git commit -m "chore(verification): reduce noise and preflight browser dependencies"
```

---

## WS-D07 — Align Commit Identity Enforcement

### Task 15: Add a guarded squash-message preflight

**Files:**

- Create: `scripts/merge-message-preflight.ts`
- Create: `tests/scripts/merge-message-preflight.test.ts`
- Modify: `scripts/repo-hygiene-guard.ts`
- Modify: `package.json`

- [ ] **Step 1: Add failing identity/message fixtures**

Reject all co-author trailers, automation/model attribution, an unapproved author name/email, an empty subject, and a body that was not explicitly supplied. Accept only the repository's approved public author identity plus a clean subject/body.

- [ ] **Step 2: Implement a read-only preflight**

```ts
export interface MergeMessageInput {
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
}

export function validateMergeMessage(input: MergeMessageInput): GuardIssue[] {
  return [
    ...validateApprovedAuthor(input.authorName, input.authorEmail),
    ...scanCommitMessage(`${input.subject}\n\n${input.body}`),
  ];
}
```

The CLI reads subject/body files and author arguments, prints no credential data, performs no network call, and exits non-zero on any issue.

- [ ] **Step 3: Expose the command**

```json
"guard:merge-message": "bash scripts/run-with-pinned-node.sh scripts/merge-message-preflight.ts"
```

### Task 16: Document the enforceable boundary honestly

**Files:**

- Modify: `docs/contributing/quality-guardrails-checklist.md`
- Modify: `.github/workflows/quality.yml`
- Modify: `tests/scripts/repo-hygiene-guard.test.ts`

- [ ] **Step 1: Document the operator-controlled merge path**

The procedure must:

1. capture the exact head SHA;
2. create explicit subject/body files;
3. run `guard:merge-message` and `guard:repo:commit-msg` on them;
4. require explicit authorization before the external merge command;
5. pass the reviewed subject/body and `--match-head-commit` to the merge client;
6. fetch main and run `guard:repo:commit-authors` against the landed commit.

State plainly that the preflight cannot prevent someone from using an unguarded web merge and that a post-merge workflow detects but cannot undo a bad generated commit.

- [ ] **Step 2: Add post-merge detection**

On pushes to `main`, keep the commit-author guard and add a focused test that scans the pushed commit range rather than excluding all commits already reachable from `origin/main`. Pull-request jobs retain the branch-diff behavior.

- [ ] **Step 3: Verify and commit**

```bash
bash scripts/run-with-pinned-npm.sh test -- tests/scripts/merge-message-preflight.test.ts tests/scripts/repo-hygiene-guard.test.ts --pool=forks --fileParallelism=false
bash scripts/run-with-pinned-npm.sh run guard:repo:commit-authors
bash scripts/run-with-pinned-npm.sh run typecheck:scripts
git add scripts/merge-message-preflight.ts tests/scripts/merge-message-preflight.test.ts scripts/repo-hygiene-guard.ts tests/scripts/repo-hygiene-guard.test.ts package.json .github/workflows/quality.yml docs/contributing/quality-guardrails-checklist.md
git commit -m "chore(repo): align squash identity enforcement"
```

---

## Final Verification for Each PR

- [ ] **Step 1: Run the PR-specific tests named above from a clean index**
- [ ] **Step 2: Run type validation**

```bash
bash scripts/run-with-pinned-npm.sh run typecheck:all
bash scripts/run-with-pinned-npm.sh run guard:lint:src
```

- [ ] **Step 3: Run the full release gate**

```bash
bash scripts/run-with-pinned-npm.sh run verify:release
```

Expected: exit 0, with browser file/test counts greater than zero. A missing browser, skipped dependency, killed process, masked command, or zero-test tail is inconclusive and must be reported as such.

- [ ] **Step 4: Inspect the actual branch delta**

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git log --format='%h %an <%ae>%n%B' origin/main..HEAD
```

Expected: only the intended PR scope, approved author identity, no co-author trailer, and no attribution string prohibited by repository policy.

- [ ] **Step 5: Record residual proof gaps**

WS-D01 needs live canary parity before shadow removal. WS-D02 needs a deployment-host smoke test for filesystem semantics. WS-D07 cannot claim prospective server-side prevention unless repository settings gain an enforceable pre-receive equivalent.
