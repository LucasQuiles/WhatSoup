# Bead: SILENT-01 — Spawn-Per-Turn `createSession` Passes Wrong Arguments

**BeadID:** SILENT-01

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/session.ts`
**Input:** Audit finding: createSession(db, 0, this.instanceName) passes instanceName as cwd, omits chatJid
**Output:** Correct argument order matching createSession signature
**Cynefin domain:** clear
**Security sensitive:** false
**Profile:** REPAIR
**Deterministic checks:** `npm run typecheck`, `npx vitest run`
**Turbulence:** L0: 0, L1: 0, L2: 0
**Loop depth:** L0 + L1
**Status:** pending → running → submitted → verified → proven → hardened → reliability-proven → merged
**Current loop:** —
**Bridge sync:** false

## Root Cause

At session.ts:~502 (spawn-per-turn path):

```typescript
this.dbRowId = createSession(this.db, 0, this.instanceName);
```

The `createSession` signature is: `createSession(db, pid, cwd, chatJid?, workspaceKey?)`.

The third argument should be `cwd` (directory path), but `this.instanceName` (e.g., `"personal"`) is passed instead. The fourth argument `chatJid` is omitted entirely.

**Consequence:** Every OpenCode-cli session row has `started_in_directory = "personal"` and `chat_jid = NULL`. These rows are:
- Not resumable (no chatJid to match against)
- Not queryable by chat
- Not matched by `backfillWorkspaceKeys` (which looks for chatJid)
- A silent data corruption affecting all spawn-per-turn providers

The correct call (used for persistent providers at L536) is:
```typescript
createSession(this.db, child.pid!, cwd, this.chatJid);
```

## Implementation Spec

Fix the argument order:

```typescript
// At ~L502, BEFORE:
this.dbRowId = createSession(this.db, 0, this.instanceName);

// AFTER:
this.dbRowId = createSession(this.db, 0, this.cwd, this.chatJid, this.workspaceKey);
```

Where `this.cwd` is the working directory (same as used in the persistent provider path). Verify that `this.cwd` and `this.chatJid` are available in the spawn-per-turn branch context.

## Maybe I'm Wrong

### Assumption: `this.instanceName` is not the intended value for cwd
**Validation:** `createSession`'s third parameter is `cwd: string` which maps to `started_in_directory` in the DB schema. The persistent provider path at L536 passes `cwd` (the actual directory). `this.instanceName` is a human-readable name like `"personal"` or `"q"` — clearly not a directory path.
**Verdict: Confirmed bug.** This is a straightforward argument order mistake.

### Assumption: This affects production
**Validation:** Check if any WhatSoup instances use `opencode-cli` as the agent provider.
**Action:** Grep for `opencode` or `isSpawnPerTurn` usage in configs.
**Verdict: Only affects spawn-per-turn providers.** If no instances use them, this is latent. But it should still be fixed for correctness.

## Required Tests

### Test 1: Spawn-per-turn session row has correct cwd and chatJid
```
GIVEN a spawn-per-turn provider (opencode-cli)
WHEN spawnSession is called
THEN the DB row has started_in_directory = actual cwd (not instanceName)
AND chat_jid = the session's chatJid
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] `createSession` called with correct (cwd, chatJid, workspaceKey) in spawn-per-turn path
- [ ] Arguments match the persistent provider path
- [ ] 1 new test passes
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
