# Bead: ERR-03 — Exception Safety in Workspace Provisioning

**BeadID:** ERR-03

**Status:** merged
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/core/workspace.ts`, `src/runtimes/agent/runtime.ts`
**Input:** Audit findings: symlinkSync not in try/catch (workspace.ts:236), writeFileSync not in try/catch (workspace.ts:88,95,223), fresh spawn fallback not caught (runtime.ts:2001-2008), partial workspace resource cleanup
**Output:** All provisioning wrapped in try/catch with partial-state cleanup
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

Multiple related issues in the workspace provisioning path:

1. **workspace.ts:236** — `symlinkSync(target, path)` not in try/catch. Can throw EEXIST if a non-symlink file exists at path, EPERM, ENOENT.
2. **workspace.ts:88,95,223** — `writeFileSync` calls not in try/catch. ENOSPC, EACCES throw uncaught.
3. **runtime.ts:2001-2008** — After resume failure in `ensureSessionAndQueue`, the fallback `await session.spawnSession()` has no try/catch. If it throws, workspace resources (socket server, media bridge) are committed to `workspaceResources` map but the session is never created in `chatSessions` — leaving the workspace permanently broken.
4. **runtime.ts:1941-1970** — `workspaceResources.set()` happens before `chatSessions.set()`. If anything between them throws, socket servers are leaked.

## Implementation Spec

### 1. Wrap `provisionWorkspace` internals in try/catch

```typescript
export function provisionWorkspace(workspacePath: string, ...): void {
  try {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'sandbox-policy.json'), ...);
    writeFileSync(join(claudeDir, 'settings.json'), ...);
    writeFileSync(join(workspacePath, '.mcp.json'), ...);
    try { unlinkSync(symlinkPath); } catch { /* ok if not exists */ }
    symlinkSync(symlinkTarget, symlinkPath);
  } catch (err) {
    // Log and re-throw — caller handles cleanup
    log.error({ err, workspacePath }, 'workspace provisioning failed');
    throw err;
  }
}
```

### 2. Wrap `ensureSessionAndQueue` spawn fallback

```typescript
try {
  await session.spawnSession(resumable.session_id, resumable.id);
} catch (err) {
  log.warn({ err, workspaceKey }, 'resume threw');
  try {
    await session.spawnSession();
  } catch (spawnErr) {
    log.error({ err: spawnErr, workspaceKey }, 'fresh spawn also failed — cleaning up workspace');
    // Clean up workspace resources
    const res = this.workspaceResources.get(workspaceKey);
    if (res) {
      if (res.socketServer) try { res.socketServer.stop(); } catch { /* */ }
      if (res.mediaBridge) try { res.mediaBridge(); } catch { /* */ }
      this.workspaceResources.delete(workspaceKey);
    }
    this.chatSessions.delete(workspaceKey);
    this.chatQueues.delete(workspaceKey);
    throw spawnErr; // propagate to turnChain catch
  }
}
```

### 3. Ensure workspace resource cleanup on any failure in ensureSessionAndQueue

Add a top-level try/catch around the provisioning + session creation block that cleans up partial workspace resources if anything throws after `workspaceResources.set()`.

## Maybe I'm Wrong

### Assumption: symlinkSync can fail with EEXIST
**Validation:** The preceding `unlinkSync` removes the old symlink. But between `unlinkSync` and `symlinkSync`, another process could create a file at that path. More realistically, if `unlinkSync` fails because the path is a directory (not a symlink), the catch swallows it, and `symlinkSync` then throws EEXIST.
**Verdict: Confirmed possible** in the directory case.

### Assumption: The fresh spawn fallback failure leaves workspace permanently broken
**Validation:** After the fallback throws, `workspaceResources.has(workspaceKey)` is true but `chatSessions.has(workspaceKey)` is false. The next message calls `ensureSessionAndQueue`, which checks `chatSessions.has()` — false, so it enters the provisioning block. But `workspaceResources.has()` is true, so it skips socket server creation. A new session is created and added to `chatSessions`. The workspace recovers on the next message.
**Verdict: The workspace self-heals on next message.** The issue is less severe than initially assessed — but the leaked socket server from the failed attempt still needs cleanup. Severity downgraded from HIGH to MEDIUM.

## Required Tests

### Test 1: Provisioning failure cleans up partial workspace resources
```
GIVEN ensureSessionAndQueue is called
AND provisionWorkspace throws ENOSPC
WHEN the error propagates
THEN workspaceResources does NOT have an entry for the workspace key
AND no socket server is left running
```

### Test 2: Spawn fallback failure cleans up workspace resources
```
GIVEN ensureSessionAndQueue with a failed resume
AND the fresh spawn fallback also throws
WHEN the error propagates
THEN workspace resources for that key are stopped and removed
```

## Verification

1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] `provisionWorkspace` has top-level try/catch with logging
- [ ] Spawn fallback failure cleans up workspace resources
- [ ] Partial workspace resources never leaked to `workspaceResources` map
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
