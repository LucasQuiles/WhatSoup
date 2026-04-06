# Bead: RACE-04 — Isolate `activeToolNames` Per Session

**BeadID:** RACE-04

**Status:** pending
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: `activeToolNames` shared across all per_chat sessions — cross-session corruption on /new and concurrent turns
**Output:** Per-session tool name tracking
**Cynefin domain:** complicated
**Security sensitive:** false
**Profile:** REPAIR
**Deterministic checks:** `npm run typecheck`, `npx vitest run`
**Turbulence:** L0: 0, L1: 0, L2: 1
**Loop depth:** L0 + L1 + L2 + L2.5
**Status:** pending → running → submitted → verified → proven → hardened → reliability-proven → merged
**Current loop:** —
**Bridge sync:** false

## Root Cause

`activeToolNames` at runtime.ts:527 is a single `Map<string, string>` shared by ALL sessions:

```typescript
private activeToolNames: Map<string, string> = new Map();
```

Two confirmed issues:

1. **`/new` command:** When `/new` kills the old session and starts a new one, the dying session's late `result` event calls `this.activeToolNames.clear()` — wiping the new session's in-progress tool tracking. The new session's `tool_result` events then report `toolName = 'unknown'`.

2. **Concurrent per_chat turns:** Two different chats running tool calls simultaneously both write to the same map. While UUID tool IDs make collisions unlikely, the `result` event from chat A calls `.clear()` which wipes chat B's entries.

## Implementation Spec

Move `activeToolNames` to per-session or per-mapKey scope:

```typescript
// Replace single shared map with per-mapKey maps:
private activeToolNames: Map<string, Map<string, string>> = new Map();

// Helper:
private getToolNames(mapKey: string): Map<string, string> {
  let names = this.activeToolNames.get(mapKey);
  if (!names) { names = new Map(); this.activeToolNames.set(mapKey, names); }
  return names;
}
```

Update all call sites to use `this.getToolNames(mapKey)` instead of `this.activeToolNames`:
- `tool_use` event: `this.getToolNames(mapKey).set(event.toolId, event.toolName)`
- `tool_result` event: `const name = this.getToolNames(mapKey).get(event.toolId) ?? 'unknown'`
- `result` event: `this.activeToolNames.delete(mapKey)` (delete entire per-session map)

For single/shared mode, use a constant key (e.g., `'_global'`).

Add `activeToolNames` to the `cleanupPerChatState` helper from LEAK-01.

## Maybe I'm Wrong

### Assumption: Late events from dying sessions actually reach activeToolNames
**Validation:** After `/new`, the old session's child is killed. If it emits buffered events before dying, those events route through the old `onEvent` closure which calls `handleEvent`/`handleEventWithContext`. Both write to `this.activeToolNames` (the shared map). The `result` event calls `.clear()`.
**Verdict: Confirmed.** Node.js stdout buffering means events can arrive after kill signal.

### Assumption: Per-chat tool name isolation is needed
**Validation:** In per_chat mode with concurrent sessions, tool IDs are UUIDs. Collision probability is negligible. The real issue is `.clear()` on `result` — which is called per-chat but clears ALL chats' entries.
**Verdict: The `.clear()` is the smoking gun.** Even without UUID collisions, `.clear()` is a cross-session side effect.

## Required Tests

### Test 1: /new doesn't wipe new session's tool names
```
GIVEN session A has tool_use events with toolId 'tool-A'
AND /new creates session B which emits tool_use with toolId 'tool-B'
WHEN session A's late result event fires
THEN session B's tool 'tool-B' is still tracked (not cleared)
```

### Test 2: Concurrent per_chat result doesn't affect other chats
```
GIVEN chat A and chat B both have active tools
WHEN chat A's result event fires
THEN chat B's active tools are untouched
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] `activeToolNames` scoped per mapKey (not global)
- [ ] `result` event only clears the specific session's tool names
- [ ] Added to `cleanupPerChatState` helper
- [ ] 2 new tests pass
- [ ] Typecheck + all existing tests pass

## Loop Protocol

### L0 — Implementation
- Worker implements the spec in an isolated clone
- Must produce `bead-output.md` with `<!-- BEAD_OUTPUT_COMPLETE -->` sentinel
- Must pass: `npm run typecheck && npx vitest run`
- Bridge advances: `running` → `submitted`

### L1 — Sentinel Review  
- Different-model agent reviews the implementation
- Validates: code matches spec, tests are durable/repeatable/observable/provable, no regressions
- Bridge advances: `submitted` → `verified`

### L2 — Oracle Consensus
- Third-model agent validates architectural correctness
- Confirms: no unintended side effects, integration safety, edge cases covered
- Bridge advances: `verified` → `proven`

### Output Requirements
- `bead-output.md` must exist in clone root
- Must contain `<!-- BEAD_OUTPUT_COMPLETE -->` sentinel
- Must be >100 bytes
- Must include: commit hash, test results, files changed
