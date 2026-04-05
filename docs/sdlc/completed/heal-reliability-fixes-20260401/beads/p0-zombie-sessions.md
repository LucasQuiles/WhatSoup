# Bead: p0-zombie-sessions
**Status:** merged
**Type:** implement
**Runner:** runner-p0-zombie-sessions
**Dependencies:** none
**Scope:** src/runtimes/agent/runtime.ts (sendTurnToSession, ~line 878-932), tests
**Input:** See root cause analysis below
**Output:** Code fix + test proving old sessions are shut down before respawn
**Sentinel notes:**
**Cynefin domain:** clear
**Security sensitive:** false
**Complexity source:** essential
**Profile:** REPAIR
**Decision trace:** docs/sdlc/active/heal-reliability-fixes-20260401/beads/p0-zombie-sessions-decision-trace.md
**Deterministic checks:** npm run typecheck, npx vitest run --pool=forks
**Turbulence:** {L0: 0, L1: 0, L2: 0, L2.5: 0, L2.75: 0}
**Assumptions:** session.shutdown() is idempotent and safe to call on already-dead sessions
**Confidence:**

## Root Cause

Q runs `per_chat` mode WITHOUT `sandboxPerChat`. When `sendTurnToSession` detects an inactive session (`!session.getStatus().active`) and calls `session.spawnSession()`:

1. `spawnSession()` overwrites `this.child` (line 169) with the new child process
2. The old child process reference is lost
3. Old process's exit handler checks `this.child !== child` (line 253) — since `this.child` is now the NEW process, exit cleanup for the old process is SKIPPED
4. Old process keeps running as a zombie with active watchdog timers
5. Old DB session row stays marked 'active' (orphaned — `this.dbRowId` was overwritten)

Evidence: 3 concurrent Claude processes for same chat, 3 active DB rows, watchdog from session 96 firing after session 97 replaced it, 15.2G peak memory.

## Fix

In `sendTurnToSession`, when `wasInactive` is true, call `await session.shutdown()` BEFORE `await session.spawnSession()`. This:
- Kills the old process (if still running)
- Updates the old DB row to 'suspended'
- Clears watchdog timers
- Is idempotent (safe if process already dead — `shutdown` checks `this.child !== null`)

This matches the pattern already used in `handleNew()` (line 442-444):
```typescript
async handleNew(): Promise<void> {
    await this.shutdown(false);
    await this.spawnSession();
}
```
