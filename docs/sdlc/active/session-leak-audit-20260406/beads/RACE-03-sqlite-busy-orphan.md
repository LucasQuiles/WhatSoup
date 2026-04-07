# Bead: RACE-03 — SQLITE_BUSY During createSession Orphans Child Process

**BeadID:** RACE-03

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/session.ts`
**Input:** Audit finding: child spawned at L512 before createSession at L536 — SQLITE_BUSY orphans child
**Output:** Reorder spawn-after-DB-write, or add cleanup on DB failure
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

In `spawnSession()` at session.ts:

```typescript
// L512: spawn the child process
const child = spawn(binary, args, { cwd, stdio: ['pipe','pipe','pipe'], env });
// L522-523:
this.child = child;
this.active = true;
// ... attach event handlers ...
// L536:
this.dbRowId = createSession(this.db, child.pid!, cwd, this.chatJid);
```

The child process is spawned BEFORE the DB row is created. If `createSession` throws `SQLITE_BUSY` (or any other DB error), the child is already running. `this.child` is set, `this.active` is true, but `this.dbRowId` is null. The error propagates up through `spawnSession()`.

With no `dbRowId`, the session cannot be properly tracked in the DB. The exit handler at L750 checks `if (this.dbRowId != null)` before calling `updateSessionStatus` — it's null, so the DB row is never updated. The child runs untethered until the watchdog kills it or the process exits.

## Implementation Spec

### Option A: Create DB row before spawn (recommended)

```typescript
// Create DB row first with pid=0 (placeholder)
this.dbRowId = createSession(this.db, 0, cwd, this.chatJid, workspaceKey);

// Then spawn
const child = spawn(binary, args, { cwd, stdio: ['pipe','pipe','pipe'], env });
this.child = child;
this.active = true;

// Update DB with actual PID
updateSessionPid(this.db, this.dbRowId, child.pid!);
```

This requires a new `updateSessionPid` helper in `session-db.ts`.

### Option B: Kill child on DB failure (simpler)

```typescript
const child = spawn(binary, args, { ... });
this.child = child;
this.active = true;
// ... attach handlers ...
try {
  this.dbRowId = createSession(this.db, child.pid!, cwd, this.chatJid);
} catch (err) {
  log.error({ err, pid: child.pid }, 'createSession failed — killing orphaned child');
  this.active = false;
  child.kill('SIGKILL');
  this.child = null;
  throw err;
}
```

## Maybe I'm Wrong

### Assumption: SQLITE_BUSY can happen in production
**Validation:** better-sqlite3's default busy timeout is 0ms — it throws immediately on contention. If another connection (e.g., fleet health poller reading the DB) holds a read lock during a WAL checkpoint, writes can fail. The `agent_sessions` table is also read by the fleet's `/api/lines` routes.
**Verdict: Confirmed possible** in fleet-managed deployments where the same SQLite DB is accessed by multiple processes.

### Risk: Option A — DB row with pid=0 is a valid row
**Assessment:** If the spawn fails (ENOENT, EMFILE) after the DB row is created, the row has pid=0 and status='active'. The stale-session reaper would try `process.kill(0, 0)` which sends signal 0 to the calling process group — not what we want. Need to handle this: if spawn fails, immediately mark the row as 'ended'.
**Verdict: Option B is simpler and safer.** Kill the child on DB failure rather than reordering.

## Required Tests

### Test 1: DB failure during spawn kills child process
```
GIVEN spawnSession is called
AND createSession will throw SQLITE_BUSY
WHEN spawnSession executes
THEN the spawned child process is killed (SIGKILL)
AND this.child === null
AND this.active === false
AND the error is re-thrown
```

### Test 2: DB failure doesn't leave session in inconsistent state
```
GIVEN spawnSession fails due to DB error
WHEN a subsequent message triggers sendTurnToSession
THEN sendTurnToSession sees active=false and spawns a fresh session successfully
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] DB failure after spawn kills the child process
- [ ] Session state (active, child, dbRowId) is cleaned up
- [ ] Error is re-thrown for caller handling
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
