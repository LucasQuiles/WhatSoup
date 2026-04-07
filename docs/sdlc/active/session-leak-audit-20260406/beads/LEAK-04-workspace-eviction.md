# Bead: LEAK-04 — Workspace Resource Idle Eviction

**BeadID:** LEAK-04

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`, `src/mcp/socket-server.ts`, `src/runtimes/agent/media-bridge.ts`
**Input:** Audit finding: `workspaceResources` entries never evicted
**Output:** Idle timeout eviction for workspace socket servers and media bridges
**Cynefin domain:** complicated
**Security sensitive:** false
**Profile:** REPAIR
**Deterministic checks:** `npm run typecheck`, `npx vitest run`
**Turbulence:** L0: 0, L1: 0, L2: 1 (behavioral change — idle workspaces shut down)
**Loop depth:** L0 + L1 + L2 + L2.5
**Status:** pending → running → submitted → verified → proven → hardened → reliability-proven → merged
**Current loop:** —
**Bridge sync:** false

## Root Cause

In `sandboxPerChat` mode, each chat gets its own `WhatSoupSocketServer` and `MediaBridge`, stored in:

```typescript
// runtime.ts:510
private workspaceResources: Map<string, {
  socketPath: string;
  workspacePath: string;
  socketServer: WhatSoupSocketServer | null;
  mediaBridge: MediaBridge | null;
}> = new Map();
```

Entries are created lazily at L1970 (`ensureSessionAndQueue`) and only bulk-cleared at L1828 (`shutdown()`). For a long-running instance with N distinct chats, this accumulates N socket servers (N open FDs) and N media bridge servers (N more FDs) permanently.

## Implementation Spec

### 1. Add `lastActivity` timestamp to workspace resource entries

```typescript
private workspaceResources: Map<string, {
  socketPath: string;
  workspacePath: string;
  socketServer: WhatSoupSocketServer | null;
  mediaBridge: MediaBridge | null;
  lastActivity: number;  // Date.now() — NEW
}> = new Map();
```

### 2. Touch `lastActivity` on every session interaction

Update `lastActivity` in:
- `ensureSessionAndQueue` when the entry is created (L1970): `lastActivity: Date.now()`
- `ensureSessionAndQueue` when `updateDeliveryJid` is called (L2015): `res.lastActivity = Date.now()`
- `handleEventWithContext` on every event for a per-chat session: touch the workspace resource entry

The most lightweight approach: touch on `ensureSessionAndQueue` entry (session start) and on `result` event (turn end). This avoids per-event overhead while ensuring active conversations are never evicted.

```typescript
// In handleEventWithContext, on 'result' event, after existing cleanup:
const wsRes = this.workspaceResources.get(mapKey);
if (wsRes) wsRes.lastActivity = Date.now();
```

### 3. Add periodic sweep

```typescript
private static readonly WORKSPACE_IDLE_MS = 30 * 60 * 1000; // 30 minutes
private static readonly WORKSPACE_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
private workspaceSweepTimer: ReturnType<typeof setInterval> | null = null;
```

In `start()`, after workspace setup:

```typescript
if (this.sandboxPerChat) {
  this.workspaceSweepTimer = setInterval(
    () => this.sweepIdleWorkspaces(),
    AgentRuntime.WORKSPACE_SWEEP_INTERVAL_MS
  );
  this.workspaceSweepTimer.unref(); // don't prevent process exit
}
```

The sweep method:

```typescript
private sweepIdleWorkspaces(): void {
  const now = Date.now();
  for (const [key, res] of this.workspaceResources) {
    // Don't evict if there's an active session
    if (this.chatSessions.has(key) && this.chatSessions.get(key)!.getStatus().active) {
      res.lastActivity = now; // keep alive
      continue;
    }
    if (now - res.lastActivity > AgentRuntime.WORKSPACE_IDLE_MS) {
      log.info({ workspaceKey: key, idleMs: now - res.lastActivity }, 'evicting idle workspace resources');
      if (res.socketServer) res.socketServer.stop();
      if (res.mediaBridge) res.mediaBridge();
      this.workspaceResources.delete(key);
    }
  }
}
```

### 4. Clear sweep timer in shutdown

```typescript
// In shutdown(), before workspace cleanup:
if (this.workspaceSweepTimer) {
  clearInterval(this.workspaceSweepTimer);
  this.workspaceSweepTimer = null;
}
```

### 5. Re-creation on demand

No changes needed — `ensureSessionAndQueue` already checks `!this.workspaceResources.has(workspaceKey)` before creating. If an evicted workspace receives a new message, it will be re-provisioned automatically.

## Design Decisions

- **30-minute idle timeout**: Generous enough that brief pauses between messages don't trigger eviction. Short enough to reclaim resources from abandoned conversations within an hour.
- **5-minute sweep interval**: Low overhead (just a Map iteration), frequent enough to bound the maximum stale resource time to ~35 minutes.
- **Don't evict active sessions**: Check `chatSessions` before evicting. An active Claude Code process needs its socket server.
- **`.unref()` on sweep timer**: Don't prevent clean process exit.

## Maybe I'm Wrong

### Assumption: Workspace resources are expensive enough to justify eviction
**Validation needed:** What does each workspace resource actually cost?
- `WhatSoupSocketServer`: 1 `net.Server` = 1 FD for the listening socket + 1 FD per connected client. Idle server = 1 FD.
- `MediaBridge`: 1 `net.Server` = 1 FD. Idle = 1 FD.
- Socket files on disk: 2 files per workspace (~0 bytes, inode cost only).
- Memory: each server object ~2-5KB (event emitters, maps, closures).
- Per-process FD limit: typically 1024 (soft) or 65536 (hard). At 2 FDs per workspace, 500 unique chats = 1000 FDs.
- **Verdict: FD exhaustion is the real risk, not memory.** For a bot with hundreds of distinct chats over weeks, this is a genuine operational concern. Eviction is justified.

### Assumption: 30-minute idle timeout is appropriate
**Validation needed:** What's the typical inter-message gap for active conversations?
- Human conversations: most replies within 5 minutes, with occasional 15-30 minute gaps.
- 30 minutes covers nearly all active conversation gaps. A user who returns after 31 minutes will experience a ~1-2 second workspace re-provisioning delay (mkdir, socket server start).
- **Verdict: 30 minutes is reasonable.** Could be configurable if needed, but a constant is fine for now.

### Assumption: Eviction + re-creation is transparent
**Validation needed:** What happens when a message arrives for an evicted workspace?
- `ensureSessionAndQueue` checks `!this.workspaceResources.has(workspaceKey)` (L1942). If missing, it creates a new socket server, media bridge, and workspace directory.
- The Claude Code session was already shut down (no active session for idle workspace). A new session will be spawned.
- The workspace directory still exists on disk (we don't delete it — only the server resources).
- `.mcp.json` and `sandbox-policy.json` may need re-provisioning. Check if `ensureSessionAndQueue` handles this.
- **Action:** Verify that `ensureSessionAndQueue` re-provisions MCP config and sandbox policy when workspace resources are missing but the directory exists.
- **Verdict: Likely transparent** but must verify re-provisioning path.

### Risk: Race between eviction sweep and incoming message
**Assessment:** The sweep runs on a `setInterval`. An incoming message calls `ensureSessionAndQueue` which checks `workspaceResources.has()`. JS is single-threaded, so the sweep and message handler cannot interleave mid-operation. Either the sweep deletes the entry before the message handler checks, or after. In both cases, the behavior is correct:
- Sweep first → message handler creates fresh resources.
- Message first → sweep sees active session (guard) and skips eviction.
- **Verdict: No race condition.**

## Required Tests

### Test 1: Idle workspace is evicted after timeout
```
GIVEN workspaceResources has entry for key K with lastActivity = now - 31 minutes
AND chatSessions does NOT have an active session for K
WHEN sweepIdleWorkspaces() runs
THEN workspaceResources.has(K) === false
AND socketServer.stop() was called
AND mediaBridge cleanup was called
```
**Durable:** Tests Map state and mock call counts — no timing dependency.
**Repeatable:** Control `lastActivity` via direct assignment, mock `Date.now()`.
**Observable:** `.has()` check + mock verification.
**Provable:** Boolean and call-count assertions.

### Test 2: Active session prevents eviction
```
GIVEN workspaceResources has entry for K with lastActivity = now - 60 minutes
AND chatSessions HAS an active session for K (getStatus().active === true)
WHEN sweepIdleWorkspaces() runs
THEN workspaceResources.has(K) === true (NOT evicted)
AND lastActivity is refreshed to now
```

### Test 3: Evicted workspace is re-created on next message
```
GIVEN workspaceResources does NOT have entry for K (previously evicted)
WHEN ensureSessionAndQueue(chatJid) is called
THEN workspaceResources.has(workspaceKey) === true (re-created)
AND a new socketServer was started
```

### Test 4: Sweep timer is cancelled on shutdown
```
GIVEN a running AgentRuntime with workspaceSweepTimer active
WHEN shutdown() is called
THEN workspaceSweepTimer is null
AND clearInterval was called
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass
3. 4 new unit tests as specified above

## Acceptance Criteria

- [ ] `workspaceResources` entries have `lastActivity` timestamp
- [ ] `lastActivity` is updated on session create and turn completion
- [ ] Periodic sweep evicts idle entries (>30min, no active session)
- [ ] Evicted entries have `socketServer.stop()` and `mediaBridge()` called
- [ ] Sweep timer is cleared in `shutdown()`
- [ ] Evicted workspaces are re-created on demand (existing `has()` guard)
- [ ] Pre-implementation verification of re-provisioning path
- [ ] 4 new unit tests pass
- [ ] Typecheck passes
- [ ] All existing tests pass

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
