# Bead: LOG-02 — Periodic Health Stats Emission

**BeadID:** LOG-02

**Status:** pending
**Type:** implement
**Runner:** —
**Dependencies:** none
**Scope:** `src/runtimes/agent/runtime.ts`
**Input:** Audit finding: no periodic logging of Map sizes, session counts, crash rates
**Output:** Interval-based stats log dump
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

There is no way to observe the runtime's internal state without a debugger or the health HTTP endpoint. For long-running instances, there is no automatic evidence of growing map sizes, accumulating sessions, or crash rates in the log stream.

## Implementation Spec

Add a periodic stats logger:

```typescript
private static readonly STATS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
private statsTimer: ReturnType<typeof setInterval> | null = null;

// In start():
this.statsTimer = setInterval(() => this.logStats(), AgentRuntime.STATS_INTERVAL_MS);
this.statsTimer.unref();

private logStats(): void {
  log.info({
    activeSessions: this.chatSessions.size,
    activeQueues: this.chatQueues.size,
    outboundQueues: this.outboundQueues.size,
    workspaceResources: this.workspaceResources.size,
    perChatMaps: {
      inboundSeqQueue: this.perChatInboundSeqQueue.size,
      turnContentType: this.perChatTurnContentType.size,
      turnText: this.perChatTurnText.size,
      assistantItemText: this.perChatAssistantItemText.size,
      pendingTurnText: this.pendingTurnText.size,
    },
    pendingRespawnTimers: this.pendingRespawnTimers.size,
    sessionScope: this.sessionScope,
  }, 'agent runtime stats');
}

// In shutdown():
if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
```

## Maybe I'm Wrong

### Assumption: 5-minute interval is appropriate
**Assessment:** Too frequent = log noise. Too infrequent = miss transient spikes. 5 minutes provides 288 data points per day — enough to spot trends without overwhelming log storage.
**Verdict: Reasonable default.** Could be configurable later.

## Required Tests

No new behavioral tests — logging only. Verify:
1. `npm run typecheck` — zero errors
2. `npx vitest run` — all tests pass

## Acceptance Criteria

- [ ] Periodic stats emitted every 5 minutes at info level
- [ ] Includes all Map/Set sizes relevant to leak tracking
- [ ] Timer is `.unref()`'d and cleared in shutdown
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
