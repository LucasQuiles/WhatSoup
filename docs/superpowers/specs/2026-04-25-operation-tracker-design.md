# Operation Tracker — Progress Reporting & Stall Detection

**Status:** completed — design realized in `src/runtimes/agent/operation-tracker.ts` and consumers.

## Problem

When the agent provider (Claude, Codex, Gemini, etc.) spends extended time thinking (30-60s between tool calls) or running long operations like subagents (2-5 min), the user receives no visible feedback beyond a typing indicator. The existing 3-tier watchdog (10/20/30 min) is too coarse to detect stuck operations and too slow to inform the user.

This affects all three output modes (`full`, `friendly`, `minimal`) and all provider types.

## Solution

A new `OperationTracker` module that tracks every in-flight tool call with expected durations, emits progress events rendered per output mode, and triggers auto-recovery when operations stall. The existing watchdog is demoted to a hard backstop.

## Architecture

### Module: `operation-tracker.ts`

Tracks per-operation state with a timer-driven escalation lifecycle.

#### Data Model

```typescript
interface TrackedOperation {
  toolId: string
  toolName: string
  category: ToolCategory
  startedAt: number
  expectedDurationMs: number
  state: 'running' | 'slow' | 'stalled' | 'recovered'
}

interface ToolThreshold {
  expectedMs: number
  slowMultiplier: number
  stallMultiplier: number
}

interface OperationTrackerConfig {
  enabled: boolean
  progressIntervalMs: number    // How often to emit progress events (default 30s)
  thinkingLongMs: number        // Gap threshold for "thinking" message (default 45s)
  thinkingStallMs: number       // Gap threshold for liveness probe (default 5 min)
  recoveryGraceMs: number       // Time to wait after interrupt before escalating (default 15s)
  toolThresholds: Record<string, ToolThreshold>
}
```

#### Tool Threshold Defaults

| Threshold key | Expected | Slow (multiplier) | Stall (multiplier) | Maps from ToolCategory |
|---------------|----------|--------------------|--------------------|------------------------|
| `agent` | 120s | 1.5x (180s) | 3x (360s) | `agent` |
| `bash` | 15s | 2x (30s) | 5x (75s) | `running` |
| `read` | 3s | 3x (9s) | 10x (30s) | `reading`, `searching` |
| `edit` | 2s | 3x (6s) | 10x (20s) | `modifying` |
| `web` | 10s | 2x (20s) | 4x (40s) | `fetching` |
| `mcp` | 15s | 2x (30s) | 5x (75s) | `other` |
| `skill` | 3s | 3x (9s) | 10x (30s) | `skill` |
| `default` | 10s | 2x (20s) | 5x (50s) | anything else |

#### Category-to-Threshold Mapping

```typescript
function thresholdKeyForCategory(category: ToolCategory): string {
  switch (category) {
    case 'agent':     return 'agent'
    case 'running':   return 'bash'
    case 'reading':
    case 'searching': return 'read'
    case 'modifying': return 'edit'
    case 'fetching':  return 'web'
    case 'skill':     return 'skill'
    case 'other':     return 'mcp'
    default:          return 'default'
  }
}
```

#### Escalation Lifecycle

```
running → (exceeds expectedMs * slowMultiplier) → slow → (exceeds expectedMs * stallMultiplier) → stalled → (recovery action) → recovered
```

Each state transition emits an event. The `running` state emits periodic `operation_progress` events at `progressIntervalMs` intervals.

#### Thinking Gap Tracking

Between tool calls the provider is thinking. The tracker monitors the gap since the last event of any type:

- Gap exceeds `thinkingLongMs` (45s default) → emit `thinking_long` event
- Gap exceeds `thinkingStallMs` (5 min default) → emit `thinking_stalled`, trigger liveness probe

This is separate from tool operation tracking — it catches the case where no tools are pending but the provider has gone silent.

#### Events Emitted

| Event | When | Contains |
|-------|------|----------|
| `operation_progress` | Every `progressIntervalMs` while operation is `running` or `slow` | toolId, toolName, category, elapsedMs, state |
| `operation_slow` | Operation crosses slow threshold | toolId, toolName, category, elapsedMs, expectedMs |
| `operation_stalled` | Operation crosses stall threshold | toolId, toolName, category, elapsedMs |
| `thinking_long` | Event gap exceeds `thinkingLongMs` | gapMs |
| `thinking_stalled` | Event gap exceeds `thinkingStallMs` | gapMs |

```typescript
type ProgressEvent =
  | { type: 'operation_progress'; toolId: string; toolName: string; category: ToolCategory; elapsedMs: number; state: 'running' | 'slow' }
  | { type: 'operation_slow'; toolId: string; toolName: string; category: ToolCategory; elapsedMs: number; expectedMs: number }
  | { type: 'operation_stalled'; toolId: string; toolName: string; category: ToolCategory; elapsedMs: number }
  | { type: 'thinking_long'; gapMs: number }
  | { type: 'thinking_stalled'; gapMs: number }
```

#### Interface

```typescript
interface OperationTrackerCallbacks {
  onProgress: (event: ProgressEvent) => void
  onStalled: (toolId: string, toolName: string) => void
  onThinkingStalled: () => void
}

class OperationTracker {
  constructor(
    instanceName: string,
    config: OperationTrackerConfig,
    callbacks: OperationTrackerCallbacks,
  )

  onToolStart(toolId: string, toolName: string, category: ToolCategory): void
  onToolEnd(toolId: string): void
  onAnyActivity(): void
  onTurnComplete(): void
  getActive(): TrackedOperation[]
  shutdown(): void
}
```

Constructed with instance name (for message formatting), config, and callbacks. No dependency on OutboundQueue or Session — communicates purely through callbacks.

---

### OutboundQueue Changes

#### New Method

```typescript
enqueueProgressUpdate(event: ProgressEvent, instanceName: string): void
```

Receives tracker events and renders per output mode.

#### Rendering Per Output Mode

##### `full` mode

Shows everything with elapsed time and operation context using existing `TOOL_CATEGORY_META` emojis.

| Event | Example message |
|-------|-----------------|
| `thinking_long` | _Q is thinking..._ |
| `operation_progress` (Agent, 60s) | _Q has been running code review for 1m..._ |
| `operation_progress` (Agent, 120s) | _Q has been running code review for 2m..._ |
| `operation_progress` (Bash, 30s) | _Q is running a command (30s)..._ |
| `operation_slow` | _Q is taking longer than expected..._ |
| `operation_stalled` | _Q appears stuck — recovering..._ |

Progress messages sent at the tracker's cadence (every 30s).

##### `friendly` mode

Plain language, less frequent, no elapsed timestamps.

| Event | Example message |
|-------|-----------------|
| `thinking_long` | _Q is thinking..._ |
| `operation_progress` (first only) | _Q is working on something, this might take a moment..._ |
| `operation_slow` | _Q is still working on it..._ |
| `operation_stalled` | _Q got stuck — trying again..._ |

Only the first `operation_progress` per operation produces a message. Subsequent ones refresh the typing indicator only.

##### `minimal` mode

Near-silent. Only surfaces stall events.

| Event | Example message |
|-------|-----------------|
| `thinking_long` | Typing indicator only |
| `operation_progress` | Typing indicator only |
| `operation_slow` | _Still working..._ |
| `operation_stalled` | _Something went wrong — retrying..._ |

#### Removed

`scheduleMinimalHeartbeat()` and related state (`minimalHeartbeatTimer`, `minimalLastSentAt`, `minimalSentDetails`) are removed. The operation tracker's events replace this mechanism with operation-aware timing instead of time-since-last-message.

---

### Session Manager Changes

#### Watchdog Demotion

- **Removed:** `WATCHDOG_SOFT_MS` (10 min) and `WATCHDOG_WARN_MS` (20 min) probe tiers. Superseded by per-operation tracking.
- **Kept:** `WATCHDOG_HARD_MS` (30 min) as last-resort process kill. Should rarely fire.
- **Kept:** `tickWatchdog()` — still resets the hard backstop timer on any activity.
- **Removed:** `armWatchdog()` soft/warn tier setup. Only the hard timer is armed.

#### New Methods

```typescript
// Called by runtime when tracker emits operation_stalled
recoverStalledOperation(toolId: string, toolName: string): void

// Called by runtime when tracker emits thinking_stalled
probeLiveness(): void
```

**`recoverStalledOperation`:** Sends interrupt to the provider process via stdin. If no `tool_result` arrives within `recoveryGraceMs` (15s default), escalates to process restart.

**`probeLiveness`:** Sends a synthetic probe to the provider's stdin to check responsiveness. If no event arrives within 30s, restarts the process.

---

### Runtime Wiring

#### Tracker Creation

One tracker per session, created alongside the session manager. Uses the same lifecycle — shutdown on session crash/shutdown, turn-complete on result events.

```typescript
const tracker = new OperationTracker(
  this.instanceName,
  config.operationTracker,
  {
    onProgress: (event) => queue.enqueueProgressUpdate(event, this.instanceName),
    onStalled: (toolId, toolName) => session.recoverStalledOperation(toolId, toolName),
    onThinkingStalled: () => session.probeLiveness(),
  },
)
```

#### Event Handler Integration

Additions to the existing `handleEvent()` switch:

```
case 'tool_use':
  session.trackToolStart(toolId)                          // existing
  session.tickWatchdog()                                  // existing (backstop only)
  tracker.onToolStart(toolId, toolName, category)         // NEW
  queue.enqueueToolUpdate(...)                            // existing
  break

case 'tool_result':
  session.trackToolEnd(toolId)                            // existing
  session.tickWatchdog()                                  // existing
  tracker.onToolEnd(toolId)                               // NEW
  break

case 'assistant_text':
  session.tickWatchdog()                                  // existing
  tracker.onAnyActivity()                                 // NEW
  queue.enqueueStreamingText(...)                         // existing
  break

case 'result':
  session.clearTurnWatchdog()                             // existing
  tracker.onTurnComplete()                                // NEW
  queue.enqueueResultText(...)                            // existing
  break
```

#### Session Scope Handling

- `per_chat`: Each chat gets its own session + tracker + queue. Straightforward.
- `shared`: One session serves multiple chats. Tracker is per-session (tracks provider process). Progress events route to the correct chat's queue via existing `mapKey` resolution.
- `single`: Same as shared — one tracker, events routed by active chat.

#### Cleanup

- Session crash → `tracker.shutdown()` in existing `onCrash` handler
- Session shutdown → `tracker.shutdown()` in existing cleanup path
- Turn complete → `tracker.onTurnComplete()` clears lingering tracked operations

---

### Configuration

#### Instance `config.json` Schema

All fields optional. Unset fields use platform defaults.

```json
{
  "toolUpdateMode": "full",
  "operationTracker": {
    "enabled": true,
    "progressIntervalMs": 30000,
    "thinkingLongMs": 45000,
    "thinkingStallMs": 300000,
    "recoveryGraceMs": 15000,
    "toolThresholds": {
      "agent":   { "expectedMs": 120000, "slowMultiplier": 1.5, "stallMultiplier": 3 },
      "bash":    { "expectedMs": 15000,  "slowMultiplier": 2,   "stallMultiplier": 5 },
      "read":    { "expectedMs": 3000,   "slowMultiplier": 3,   "stallMultiplier": 10 },
      "edit":    { "expectedMs": 2000,   "slowMultiplier": 3,   "stallMultiplier": 10 },
      "web":     { "expectedMs": 10000,  "slowMultiplier": 2,   "stallMultiplier": 4 },
      "mcp":     { "expectedMs": 15000,  "slowMultiplier": 2,   "stallMultiplier": 5 },
      "skill":   { "expectedMs": 3000,   "slowMultiplier": 3,   "stallMultiplier": 10 },
      "default": { "expectedMs": 10000,  "slowMultiplier": 2,   "stallMultiplier": 5 }
    }
  }
}
```

#### Config Loading (`config.ts`)

```typescript
operationTracker: {
  enabled: (instance?.operationTracker?.enabled as boolean | undefined) ?? true,
  progressIntervalMs: (instance?.operationTracker?.progressIntervalMs as number | undefined) ?? 30_000,
  thinkingLongMs: (instance?.operationTracker?.thinkingLongMs as number | undefined) ?? 45_000,
  thinkingStallMs: (instance?.operationTracker?.thinkingStallMs as number | undefined) ?? 300_000,
  recoveryGraceMs: (instance?.operationTracker?.recoveryGraceMs as number | undefined) ?? 15_000,
  toolThresholds: mergeToolThresholds(instance?.operationTracker?.toolThresholds),
}
```

`mergeToolThresholds` deep-merges instance overrides onto platform defaults. Only specified keys are overridden.

#### Interaction with `toolUpdateMode`

These are orthogonal concerns:
- `toolUpdateMode` controls what the user sees (rendering)
- `operationTracker` controls what gets tracked and when recovery fires (detection + recovery)

A `minimal` mode instance with default tracker config gets full stall detection — it just renders progress messages minimally.

---

### File Changes

#### New Files

| File | Purpose |
|------|---------|
| `src/runtimes/agent/operation-tracker.ts` | Core tracker: timers, state machine, escalation, events |
| `src/runtimes/agent/operation-tracker.test.ts` | Unit tests: timer behavior, escalation, config merge, cleanup |

#### Modified Files

| File | Changes |
|------|---------|
| `src/config.ts` | Add `operationTracker` config block with defaults and `mergeToolThresholds` |
| `src/runtimes/agent/runtime.ts` | Create tracker per session, wire into `handleEvent()`, route tracker callbacks |
| `src/runtimes/agent/session.ts` | Add `recoverStalledOperation()`, `probeLiveness()`. Remove soft/warn watchdog tiers, keep hard backstop |
| `src/runtimes/agent/outbound-queue.ts` | Add `enqueueProgressUpdate()`. Remove `scheduleMinimalHeartbeat()` and related state |
| Tests | Update outbound-queue tests, add operation-tracker tests |

#### Unchanged Files

| File | Why |
|------|-----|
| `stream-parser.ts` | Event parsing is correct as-is |
| `tool-mapping.ts` | Category mapping already provides what the tracker needs |
| `session-db.ts` | Durability layer doesn't need operation tracking awareness |
| `turn-queue.ts` | Turn serialization is orthogonal |

### Dependency Graph

```
config.ts
  ↓
operation-tracker.ts  (imports: config types, ToolCategory type from tool-mapping)
  ↓ emits events via callbacks only
runtime.ts  (imports: operation-tracker, routes events to queue and session)
  ↓                    ↓
outbound-queue.ts    session.ts
(progress render)    (stall recovery)
```

The tracker has no dependency on OutboundQueue or Session. It communicates purely through callbacks provided at construction. Testable with mock callbacks, decoupled from message delivery and process management.
