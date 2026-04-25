# Operation Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-operation progress reporting and stall detection to the WhatSoup agent runtime, replacing the coarse 10/20/30 min watchdog with intelligent per-tool tracking that emits mode-appropriate progress messages and auto-recovers stuck operations.

**Architecture:** A new `OperationTracker` module tracks every in-flight tool call with expected durations and a timer-driven escalation lifecycle (`running` -> `slow` -> `stalled`). It emits progress events consumed by the OutboundQueue (rendered per `toolUpdateMode`) and stall events consumed by the Session (recovery actions). The existing 3-tier watchdog is demoted to a hard backstop (30 min SIGKILL only).

**Tech Stack:** TypeScript, Vitest, Node.js timers (setTimeout/clearTimeout)

**Spec:** `docs/superpowers/specs/2026-04-25-operation-tracker-design.md`

---

### Task 1: Config Schema & Defaults

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test for operationTracker config loading**

In `tests/config.test.ts`, add a test block at the end of the file:

```typescript
describe('operationTracker config', () => {
  it('provides default operationTracker config when instance has none', () => {
    // config is already loaded at module level — check it has defaults
    const { config } = await import('../src/config.ts');
    expect(config.operationTracker).toBeDefined();
    expect(config.operationTracker.enabled).toBe(true);
    expect(config.operationTracker.progressIntervalMs).toBe(30_000);
    expect(config.operationTracker.thinkingLongMs).toBe(45_000);
    expect(config.operationTracker.thinkingStallMs).toBe(300_000);
    expect(config.operationTracker.recoveryGraceMs).toBe(15_000);
    expect(config.operationTracker.toolThresholds).toBeDefined();
    expect(config.operationTracker.toolThresholds.agent).toEqual({
      expectedMs: 120_000,
      slowMultiplier: 1.5,
      stallMultiplier: 3,
    });
    expect(config.operationTracker.toolThresholds.default).toEqual({
      expectedMs: 10_000,
      slowMultiplier: 2,
      stallMultiplier: 5,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/config.test.ts -t "operationTracker"`
Expected: FAIL — `config.operationTracker` is undefined

- [ ] **Step 3: Define types and default thresholds**

Add to `src/config.ts` before the `export const config = ...` block:

```typescript
export interface ToolThreshold {
  expectedMs: number;
  slowMultiplier: number;
  stallMultiplier: number;
}

export interface OperationTrackerConfig {
  enabled: boolean;
  progressIntervalMs: number;
  thinkingLongMs: number;
  thinkingStallMs: number;
  recoveryGraceMs: number;
  toolThresholds: Record<string, ToolThreshold>;
}

const DEFAULT_TOOL_THRESHOLDS: Record<string, ToolThreshold> = {
  agent:   { expectedMs: 120_000, slowMultiplier: 1.5, stallMultiplier: 3 },
  bash:    { expectedMs: 15_000,  slowMultiplier: 2,   stallMultiplier: 5 },
  read:    { expectedMs: 3_000,   slowMultiplier: 3,   stallMultiplier: 10 },
  edit:    { expectedMs: 2_000,   slowMultiplier: 3,   stallMultiplier: 10 },
  web:     { expectedMs: 10_000,  slowMultiplier: 2,   stallMultiplier: 4 },
  mcp:     { expectedMs: 15_000,  slowMultiplier: 2,   stallMultiplier: 5 },
  skill:   { expectedMs: 3_000,   slowMultiplier: 3,   stallMultiplier: 10 },
  default: { expectedMs: 10_000,  slowMultiplier: 2,   stallMultiplier: 5 },
};

function mergeToolThresholds(
  overrides?: Record<string, Partial<ToolThreshold>> | unknown,
): Record<string, ToolThreshold> {
  const result = { ...DEFAULT_TOOL_THRESHOLDS };
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    return result;
  }
  for (const [key, partial] of Object.entries(overrides as Record<string, unknown>)) {
    if (typeof partial !== 'object' || partial === null) continue;
    const base = result[key] ?? result.default;
    const p = partial as Partial<ToolThreshold>;
    result[key] = {
      expectedMs: typeof p.expectedMs === 'number' ? p.expectedMs : base.expectedMs,
      slowMultiplier: typeof p.slowMultiplier === 'number' ? p.slowMultiplier : base.slowMultiplier,
      stallMultiplier: typeof p.stallMultiplier === 'number' ? p.stallMultiplier : base.stallMultiplier,
    };
  }
  return result;
}
```

- [ ] **Step 4: Add operationTracker to the config object**

Inside the `export const config = { ... }` block, add after the `toolUpdateMode` line:

```typescript
  // Operation tracker: per-tool progress reporting & stall detection
  operationTracker: {
    enabled: (instance?.operationTracker?.enabled as boolean | undefined) ?? true,
    progressIntervalMs: (instance?.operationTracker?.progressIntervalMs as number | undefined) ?? 30_000,
    thinkingLongMs: (instance?.operationTracker?.thinkingLongMs as number | undefined) ?? 45_000,
    thinkingStallMs: (instance?.operationTracker?.thinkingStallMs as number | undefined) ?? 300_000,
    recoveryGraceMs: (instance?.operationTracker?.recoveryGraceMs as number | undefined) ?? 15_000,
    toolThresholds: mergeToolThresholds(instance?.operationTracker?.toolThresholds),
  } satisfies OperationTrackerConfig,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/config.test.ts -t "operationTracker"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add operationTracker config schema with defaults"
```

---

### Task 2: OperationTracker Core — Types & Construction

**Files:**
- Create: `src/runtimes/agent/operation-tracker.ts`
- Create: `tests/runtimes/agent/operation-tracker.test.ts`

- [ ] **Step 1: Write the failing test for tracker construction**

Create `tests/runtimes/agent/operation-tracker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OperationTracker } from '../../../src/runtimes/agent/operation-tracker.ts';
import type { OperationTrackerConfig } from '../../../src/config.ts';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const DEFAULT_CONFIG: OperationTrackerConfig = {
  enabled: true,
  progressIntervalMs: 30_000,
  thinkingLongMs: 45_000,
  thinkingStallMs: 300_000,
  recoveryGraceMs: 15_000,
  toolThresholds: {
    agent:   { expectedMs: 120_000, slowMultiplier: 1.5, stallMultiplier: 3 },
    bash:    { expectedMs: 15_000,  slowMultiplier: 2,   stallMultiplier: 5 },
    read:    { expectedMs: 3_000,   slowMultiplier: 3,   stallMultiplier: 10 },
    edit:    { expectedMs: 2_000,   slowMultiplier: 3,   stallMultiplier: 10 },
    web:     { expectedMs: 10_000,  slowMultiplier: 2,   stallMultiplier: 4 },
    mcp:     { expectedMs: 15_000,  slowMultiplier: 2,   stallMultiplier: 5 },
    skill:   { expectedMs: 3_000,   slowMultiplier: 3,   stallMultiplier: 10 },
    default: { expectedMs: 10_000,  slowMultiplier: 2,   stallMultiplier: 5 },
  },
};

function makeCallbacks() {
  return {
    onProgress: vi.fn(),
    onStalled: vi.fn(),
    onThinkingStalled: vi.fn(),
  };
}

describe('OperationTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('constructs without error', () => {
    const tracker = new OperationTracker('TestBot', DEFAULT_CONFIG, makeCallbacks());
    expect(tracker).toBeDefined();
    expect(tracker.getActive()).toEqual([]);
    tracker.shutdown();
  });

  it('tracks a tool start and end', () => {
    const tracker = new OperationTracker('TestBot', DEFAULT_CONFIG, makeCallbacks());
    tracker.onToolStart('tool-1', 'Read', 'reading');
    expect(tracker.getActive()).toHaveLength(1);
    expect(tracker.getActive()[0]).toMatchObject({
      toolId: 'tool-1',
      toolName: 'Read',
      category: 'reading',
      state: 'running',
    });
    tracker.onToolEnd('tool-1');
    expect(tracker.getActive()).toHaveLength(0);
    tracker.shutdown();
  });

  it('clears all operations on shutdown', () => {
    const tracker = new OperationTracker('TestBot', DEFAULT_CONFIG, makeCallbacks());
    tracker.onToolStart('tool-1', 'Agent', 'agent');
    tracker.onToolStart('tool-2', 'Bash', 'running');
    expect(tracker.getActive()).toHaveLength(2);
    tracker.shutdown();
    expect(tracker.getActive()).toHaveLength(0);
  });

  it('clears all operations on turn complete', () => {
    const tracker = new OperationTracker('TestBot', DEFAULT_CONFIG, makeCallbacks());
    tracker.onToolStart('tool-1', 'Agent', 'agent');
    tracker.onTurnComplete();
    expect(tracker.getActive()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/runtimes/agent/operation-tracker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the tracker module with construction and basic lifecycle**

Create `src/runtimes/agent/operation-tracker.ts`:

```typescript
import { createChildLogger } from '../../logger.ts';
import type { ToolCategory } from './providers/tool-mapping.ts';
import type { OperationTrackerConfig, ToolThreshold } from '../../config.ts';

const log = createChildLogger('operation-tracker');

// ─── Types ────────────────────────────────────────────────────────────────────

export type OperationState = 'running' | 'slow' | 'stalled' | 'recovered';

export interface TrackedOperation {
  toolId: string;
  toolName: string;
  category: ToolCategory;
  startedAt: number;
  expectedDurationMs: number;
  state: OperationState;
}

export type ProgressEvent =
  | { type: 'operation_progress'; toolId: string; toolName: string; category: ToolCategory; elapsedMs: number; state: 'running' | 'slow' }
  | { type: 'operation_slow'; toolId: string; toolName: string; category: ToolCategory; elapsedMs: number; expectedMs: number }
  | { type: 'operation_stalled'; toolId: string; toolName: string; category: ToolCategory; elapsedMs: number }
  | { type: 'thinking_long'; gapMs: number }
  | { type: 'thinking_stalled'; gapMs: number };

export interface OperationTrackerCallbacks {
  onProgress: (event: ProgressEvent) => void;
  onStalled: (toolId: string, toolName: string) => void;
  onThinkingStalled: () => void;
}

// ─── Category → threshold key mapping ─────────────────────────────────────────

function thresholdKeyForCategory(category: ToolCategory): string {
  switch (category) {
    case 'agent':     return 'agent';
    case 'running':   return 'bash';
    case 'reading':
    case 'searching': return 'read';
    case 'modifying': return 'edit';
    case 'fetching':  return 'web';
    case 'skill':     return 'skill';
    case 'other':     return 'mcp';
    default:          return 'default';
  }
}

// ─── Tracker ──────────────────────────────────────────────────────────────────

interface TrackedOperationInternal extends TrackedOperation {
  progressTimer: ReturnType<typeof setTimeout> | null;
  slowTimer: ReturnType<typeof setTimeout> | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
}

export class OperationTracker {
  private readonly instanceName: string;
  private readonly config: OperationTrackerConfig;
  private readonly callbacks: OperationTrackerCallbacks;
  private readonly operations = new Map<string, TrackedOperationInternal>();
  private lastActivityAt: number = Date.now();
  private thinkingLongTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkingStallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    instanceName: string,
    config: OperationTrackerConfig,
    callbacks: OperationTrackerCallbacks,
  ) {
    this.instanceName = instanceName;
    this.config = config;
    this.callbacks = callbacks;
  }

  onToolStart(toolId: string, toolName: string, category: ToolCategory): void {
    this.clearThinkingTimers();
    const key = thresholdKeyForCategory(category);
    const threshold: ToolThreshold = this.config.toolThresholds[key] ?? this.config.toolThresholds.default;
    const op: TrackedOperationInternal = {
      toolId,
      toolName,
      category,
      startedAt: Date.now(),
      expectedDurationMs: threshold.expectedMs,
      state: 'running',
      progressTimer: null,
      slowTimer: null,
      stallTimer: null,
    };
    this.operations.set(toolId, op);
    this.armOperationTimers(op, threshold);
    this.lastActivityAt = Date.now();
  }

  onToolEnd(toolId: string): void {
    const op = this.operations.get(toolId);
    if (op) {
      this.clearOperationTimers(op);
      this.operations.delete(toolId);
    }
    this.lastActivityAt = Date.now();
    this.armThinkingTimers();
  }

  onAnyActivity(): void {
    this.lastActivityAt = Date.now();
    this.clearThinkingTimers();
    // Only re-arm thinking timers if no tools are pending
    if (this.operations.size === 0) {
      this.armThinkingTimers();
    }
  }

  onTurnComplete(): void {
    this.clearAll();
  }

  getActive(): TrackedOperation[] {
    return Array.from(this.operations.values()).map(({ progressTimer, slowTimer, stallTimer, ...rest }) => rest);
  }

  shutdown(): void {
    this.clearAll();
  }

  // ─── Timer management ───────────────────────────────────────────────────────

  private armOperationTimers(op: TrackedOperationInternal, threshold: ToolThreshold): void {
    const slowMs = threshold.expectedMs * threshold.slowMultiplier;
    const stallMs = threshold.expectedMs * threshold.stallMultiplier;

    // Periodic progress
    op.progressTimer = setInterval(() => {
      const elapsed = Date.now() - op.startedAt;
      this.callbacks.onProgress({
        type: 'operation_progress',
        toolId: op.toolId,
        toolName: op.toolName,
        category: op.category,
        elapsedMs: elapsed,
        state: op.state as 'running' | 'slow',
      });
    }, this.config.progressIntervalMs);

    // Slow threshold
    op.slowTimer = setTimeout(() => {
      op.slowTimer = null;
      op.state = 'slow';
      const elapsed = Date.now() - op.startedAt;
      log.warn({ toolId: op.toolId, toolName: op.toolName, elapsedMs: elapsed, expectedMs: threshold.expectedMs }, 'operation slow');
      this.callbacks.onProgress({
        type: 'operation_slow',
        toolId: op.toolId,
        toolName: op.toolName,
        category: op.category,
        elapsedMs: elapsed,
        expectedMs: threshold.expectedMs,
      });
    }, slowMs);

    // Stall threshold
    op.stallTimer = setTimeout(() => {
      op.stallTimer = null;
      op.state = 'stalled';
      const elapsed = Date.now() - op.startedAt;
      log.warn({ toolId: op.toolId, toolName: op.toolName, elapsedMs: elapsed }, 'operation stalled — triggering recovery');
      this.callbacks.onProgress({
        type: 'operation_stalled',
        toolId: op.toolId,
        toolName: op.toolName,
        category: op.category,
        elapsedMs: elapsed,
      });
      this.callbacks.onStalled(op.toolId, op.toolName);
    }, stallMs);
  }

  private clearOperationTimers(op: TrackedOperationInternal): void {
    if (op.progressTimer !== null) { clearInterval(op.progressTimer); op.progressTimer = null; }
    if (op.slowTimer !== null) { clearTimeout(op.slowTimer); op.slowTimer = null; }
    if (op.stallTimer !== null) { clearTimeout(op.stallTimer); op.stallTimer = null; }
  }

  private armThinkingTimers(): void {
    this.clearThinkingTimers();
    this.thinkingLongTimer = setTimeout(() => {
      this.thinkingLongTimer = null;
      const gapMs = Date.now() - this.lastActivityAt;
      this.callbacks.onProgress({ type: 'thinking_long', gapMs });
    }, this.config.thinkingLongMs);

    this.thinkingStallTimer = setTimeout(() => {
      this.thinkingStallTimer = null;
      const gapMs = Date.now() - this.lastActivityAt;
      log.warn({ gapMs }, 'thinking stalled — triggering liveness probe');
      this.callbacks.onProgress({ type: 'thinking_stalled', gapMs });
      this.callbacks.onThinkingStalled();
    }, this.config.thinkingStallMs);
  }

  private clearThinkingTimers(): void {
    if (this.thinkingLongTimer !== null) { clearTimeout(this.thinkingLongTimer); this.thinkingLongTimer = null; }
    if (this.thinkingStallTimer !== null) { clearTimeout(this.thinkingStallTimer); this.thinkingStallTimer = null; }
  }

  private clearAll(): void {
    for (const op of this.operations.values()) {
      this.clearOperationTimers(op);
    }
    this.operations.clear();
    this.clearThinkingTimers();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/runtimes/agent/operation-tracker.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/runtimes/agent/operation-tracker.ts tests/runtimes/agent/operation-tracker.test.ts
git commit -m "feat(operation-tracker): core module with types, construction, lifecycle"
```

---

### Task 3: OperationTracker Timer Behavior Tests

**Files:**
- Modify: `tests/runtimes/agent/operation-tracker.test.ts`

- [ ] **Step 1: Write progress interval test**

Add to the `describe('OperationTracker')` block:

```typescript
  describe('progress events', () => {
    it('emits operation_progress at progressIntervalMs', () => {
      const cb = makeCallbacks();
      const tracker = new OperationTracker('TestBot', { ...DEFAULT_CONFIG, progressIntervalMs: 10_000 }, cb);
      tracker.onToolStart('t1', 'Agent', 'agent');

      vi.advanceTimersByTime(10_000);
      expect(cb.onProgress).toHaveBeenCalledTimes(1);
      expect(cb.onProgress).toHaveBeenCalledWith(expect.objectContaining({
        type: 'operation_progress',
        toolId: 't1',
        toolName: 'Agent',
        category: 'agent',
        state: 'running',
      }));

      vi.advanceTimersByTime(10_000);
      expect(cb.onProgress).toHaveBeenCalledTimes(2);

      tracker.shutdown();
    });

    it('stops progress events when tool ends', () => {
      const cb = makeCallbacks();
      const tracker = new OperationTracker('TestBot', { ...DEFAULT_CONFIG, progressIntervalMs: 10_000 }, cb);
      tracker.onToolStart('t1', 'Bash', 'running');

      vi.advanceTimersByTime(10_000);
      expect(cb.onProgress).toHaveBeenCalledTimes(1);

      tracker.onToolEnd('t1');
      vi.advanceTimersByTime(50_000);
      // No additional progress after end
      expect(cb.onProgress).toHaveBeenCalledTimes(1);

      tracker.shutdown();
    });
  });
```

- [ ] **Step 2: Write slow escalation test**

```typescript
  describe('slow escalation', () => {
    it('transitions to slow state at expectedMs * slowMultiplier', () => {
      const cb = makeCallbacks();
      // bash: 15s expected, 2x slow = 30s
      const tracker = new OperationTracker('TestBot', DEFAULT_CONFIG, cb);
      tracker.onToolStart('t1', 'Bash', 'running');

      vi.advanceTimersByTime(29_999);
      const slowCalls = cb.onProgress.mock.calls.filter(
        (c: unknown[]) => (c[0] as ProgressEvent).type === 'operation_slow'
      );
      expect(slowCalls).toHaveLength(0);

      vi.advanceTimersByTime(1);
      const slowCalls2 = cb.onProgress.mock.calls.filter(
        (c: unknown[]) => (c[0] as ProgressEvent).type === 'operation_slow'
      );
      expect(slowCalls2).toHaveLength(1);
      expect(tracker.getActive()[0].state).toBe('slow');

      tracker.shutdown();
    });
  });
```

- [ ] **Step 3: Write stall escalation and recovery trigger test**

```typescript
  describe('stall escalation', () => {
    it('transitions to stalled and triggers recovery at expectedMs * stallMultiplier', () => {
      const cb = makeCallbacks();
      // bash: 15s expected, 5x stall = 75s
      const tracker = new OperationTracker('TestBot', DEFAULT_CONFIG, cb);
      tracker.onToolStart('t1', 'Bash', 'running');

      vi.advanceTimersByTime(75_000);
      const stallCalls = cb.onProgress.mock.calls.filter(
        (c: unknown[]) => (c[0] as ProgressEvent).type === 'operation_stalled'
      );
      expect(stallCalls).toHaveLength(1);
      expect(cb.onStalled).toHaveBeenCalledWith('t1', 'Bash');
      expect(tracker.getActive()[0].state).toBe('stalled');

      tracker.shutdown();
    });
  });
```

- [ ] **Step 4: Write thinking gap tests**

```typescript
  describe('thinking gap tracking', () => {
    it('emits thinking_long after thinkingLongMs of silence', () => {
      const cb = makeCallbacks();
      const tracker = new OperationTracker('TestBot', { ...DEFAULT_CONFIG, thinkingLongMs: 5_000 }, cb);
      // Trigger activity then let it go silent
      tracker.onAnyActivity();

      vi.advanceTimersByTime(5_000);
      expect(cb.onProgress).toHaveBeenCalledWith(expect.objectContaining({
        type: 'thinking_long',
      }));
      tracker.shutdown();
    });

    it('emits thinking_stalled and triggers liveness probe after thinkingStallMs', () => {
      const cb = makeCallbacks();
      const tracker = new OperationTracker('TestBot', {
        ...DEFAULT_CONFIG,
        thinkingLongMs: 5_000,
        thinkingStallMs: 20_000,
      }, cb);
      tracker.onAnyActivity();

      vi.advanceTimersByTime(20_000);
      expect(cb.onProgress).toHaveBeenCalledWith(expect.objectContaining({
        type: 'thinking_stalled',
      }));
      expect(cb.onThinkingStalled).toHaveBeenCalledTimes(1);
      tracker.shutdown();
    });

    it('resets thinking timers on tool start', () => {
      const cb = makeCallbacks();
      const tracker = new OperationTracker('TestBot', { ...DEFAULT_CONFIG, thinkingLongMs: 5_000 }, cb);
      tracker.onAnyActivity();

      vi.advanceTimersByTime(4_000);
      tracker.onToolStart('t1', 'Read', 'reading');

      vi.advanceTimersByTime(5_000);
      // thinking_long should NOT have fired — tool start reset it
      const thinkingCalls = cb.onProgress.mock.calls.filter(
        (c: unknown[]) => (c[0] as ProgressEvent).type === 'thinking_long'
      );
      expect(thinkingCalls).toHaveLength(0);

      tracker.shutdown();
    });

    it('does not arm thinking timers while tools are pending', () => {
      const cb = makeCallbacks();
      const tracker = new OperationTracker('TestBot', { ...DEFAULT_CONFIG, thinkingLongMs: 5_000 }, cb);
      tracker.onToolStart('t1', 'Agent', 'agent');
      tracker.onAnyActivity();

      vi.advanceTimersByTime(10_000);
      const thinkingCalls = cb.onProgress.mock.calls.filter(
        (c: unknown[]) => (c[0] as ProgressEvent).type === 'thinking_long'
      );
      expect(thinkingCalls).toHaveLength(0);

      tracker.shutdown();
    });
  });
```

- [ ] **Step 5: Run all tracker tests**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/runtimes/agent/operation-tracker.test.ts`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add tests/runtimes/agent/operation-tracker.test.ts
git commit -m "test(operation-tracker): timer behavior, escalation, thinking gap tests"
```

---

### Task 4: OutboundQueue — Progress Rendering

**Files:**
- Modify: `src/runtimes/agent/outbound-queue.ts`
- Modify: `tests/runtimes/agent/outbound-queue.test.ts`

- [ ] **Step 1: Write the failing test for enqueueProgressUpdate in full mode**

Add to `tests/runtimes/agent/outbound-queue.test.ts`:

```typescript
describe('enqueueProgressUpdate', () => {
  it('renders operation_progress with elapsed time in full mode', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('full');

    queue.enqueueProgressUpdate({
      type: 'operation_progress',
      toolId: 't1',
      toolName: 'Agent',
      category: 'agent',
      elapsedMs: 60_000,
      state: 'running',
    }, 'Q');

    await queue.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Q');
    expect(calls[0]).toContain('1m');
  });

  it('renders thinking_long in full mode', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('full');

    queue.enqueueProgressUpdate({ type: 'thinking_long', gapMs: 45_000 }, 'Q');

    await queue.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Q');
    expect(calls[0]).toMatch(/thinking/i);
  });

  it('renders only first operation_progress in friendly mode', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('friendly');

    queue.enqueueProgressUpdate({
      type: 'operation_progress',
      toolId: 't1',
      toolName: 'Agent',
      category: 'agent',
      elapsedMs: 30_000,
      state: 'running',
    }, 'Q');

    queue.enqueueProgressUpdate({
      type: 'operation_progress',
      toolId: 't1',
      toolName: 'Agent',
      category: 'agent',
      elapsedMs: 60_000,
      state: 'running',
    }, 'Q');

    await queue.flush();
    // Only 1 message — second progress just refreshes typing
    expect(calls).toHaveLength(1);
  });

  it('suppresses operation_progress text in minimal mode', async () => {
    const { messenger, calls } = makeMessenger();
    const queue = new OutboundQueue(messenger, CHAT_JID);
    queue.setToolUpdateMode('minimal');

    queue.enqueueProgressUpdate({
      type: 'operation_progress',
      toolId: 't1',
      toolName: 'Agent',
      category: 'agent',
      elapsedMs: 30_000,
      state: 'running',
    }, 'Q');

    await queue.flush();
    // No text message — just typing indicator
    expect(calls).toHaveLength(0);
  });

  it('renders operation_stalled in all modes', async () => {
    for (const mode of ['full', 'friendly', 'minimal'] as const) {
      const { messenger, calls } = makeMessenger();
      const queue = new OutboundQueue(messenger, CHAT_JID);
      queue.setToolUpdateMode(mode);

      queue.enqueueProgressUpdate({
        type: 'operation_stalled',
        toolId: 't1',
        toolName: 'Bash',
        category: 'running',
        elapsedMs: 75_000,
      }, 'Q');

      await queue.flush();
      expect(calls.length).toBeGreaterThanOrEqual(1);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/runtimes/agent/outbound-queue.test.ts -t "enqueueProgressUpdate"`
Expected: FAIL — `enqueueProgressUpdate` not a function

- [ ] **Step 3: Add enqueueProgressUpdate to OutboundQueue**

Add the import at top of `src/runtimes/agent/outbound-queue.ts`:

```typescript
import type { ProgressEvent } from './operation-tracker.ts';
```

Add to the `IOutboundQueue` interface:

```typescript
  enqueueProgressUpdate(event: ProgressEvent, instanceName: string): void;
```

Add the method to the `OutboundQueue` class, after `enqueueResultText`:

```typescript
  /** Track which tool IDs have already had their first progress message sent (for friendly mode dedup). */
  private friendlyProgressSent = new Set<string>();

  /**
   * Render a progress event from the OperationTracker.
   * Rendering varies by toolUpdateMode: full shows elapsed times, friendly shows
   * plain language, minimal suppresses most but always shows stall events.
   */
  enqueueProgressUpdate(event: ProgressEvent, instanceName: string): void {
    const name = instanceName;

    switch (event.type) {
      case 'thinking_long': {
        if (this.toolUpdateMode === 'minimal') {
          this.startTyping();
          return;
        }
        this.enqueue(`_${name} is thinking..._`);
        return;
      }

      case 'thinking_stalled': {
        // All modes get a visible message for thinking stall
        if (this.toolUpdateMode === 'minimal') {
          this.enqueue(`_${name} may be stuck..._`);
        } else {
          this.enqueue(`_${name} has gone silent — checking..._`);
        }
        return;
      }

      case 'operation_progress': {
        if (this.toolUpdateMode === 'minimal') {
          this.startTyping();
          return;
        }
        if (this.toolUpdateMode === 'friendly') {
          if (this.friendlyProgressSent.has(event.toolId)) {
            this.startTyping();
            return;
          }
          this.friendlyProgressSent.add(event.toolId);
          this.enqueue(`_${name} is working on something, this might take a moment..._`);
          return;
        }
        // full mode — show elapsed time
        const elapsed = formatElapsed(event.elapsedMs);
        const desc = event.toolName === 'Agent'
          ? `running a subagent`
          : `running ${event.toolName}`;
        this.enqueue(`_${name} has been ${desc} for ${elapsed}..._`);
        return;
      }

      case 'operation_slow': {
        if (this.toolUpdateMode === 'minimal') {
          this.enqueue(`_Still working..._`);
        } else if (this.toolUpdateMode === 'friendly') {
          this.enqueue(`_${name} is still working on it..._`);
        } else {
          const elapsed = formatElapsed(event.elapsedMs);
          this.enqueue(`_\u23f3 ${name} is taking longer than expected (${elapsed})..._`);
        }
        return;
      }

      case 'operation_stalled': {
        if (this.toolUpdateMode === 'minimal') {
          this.enqueue(`_Something went wrong \u2014 retrying..._`);
        } else if (this.toolUpdateMode === 'friendly') {
          this.enqueue(`_${name} got stuck \u2014 trying again..._`);
        } else {
          this.enqueue(`_\u26a0\ufe0f ${name} appears stuck \u2014 recovering..._`);
        }
        return;
      }
    }
  }
```

Add the helper function before the class (after the constants):

```typescript
/** Format milliseconds as a human-readable elapsed string: "30s", "1m", "2m 15s". */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
```

- [ ] **Step 4: Clear friendlyProgressSent on abortTurn**

In `abortTurn()`, add:

```typescript
    this.friendlyProgressSent.clear();
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/runtimes/agent/outbound-queue.test.ts -t "enqueueProgressUpdate"`
Expected: PASS

- [ ] **Step 6: Run full outbound-queue test suite to check for regressions**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/runtimes/agent/outbound-queue.test.ts`
Expected: PASS (all existing tests still pass)

- [ ] **Step 7: Commit**

```bash
git add src/runtimes/agent/outbound-queue.ts tests/runtimes/agent/outbound-queue.test.ts
git commit -m "feat(outbound-queue): add enqueueProgressUpdate with per-mode rendering"
```

---

### Task 5: OutboundQueue — Remove Minimal Heartbeat

**Files:**
- Modify: `src/runtimes/agent/outbound-queue.ts`
- Modify: `tests/runtimes/agent/outbound-queue.test.ts`

- [ ] **Step 1: Identify all minimal heartbeat code**

In `outbound-queue.ts`, the minimal heartbeat consists of:
- Properties: `minimalSentDetails` (line ~184), `minimalLastSentAt` (line ~186), `minimalHeartbeatTimer` (line ~188)
- Methods: `scheduleMinimalHeartbeat()` (line ~514), `clearMinimalHeartbeat()` (line ~535)
- Callers: `shouldShowMinimal()` return paths that call `scheduleMinimalHeartbeat()`, `enqueueToolUpdate()`, `enqueueText()`, `enqueueStreamingText()`, `abortTurn()`, `shutdown()`
- `hasPendingWork()` references `minimalHeartbeatTimer`

- [ ] **Step 2: Remove scheduleMinimalHeartbeat and clearMinimalHeartbeat methods**

Delete the `scheduleMinimalHeartbeat()` method and the `clearMinimalHeartbeat()` method entirely.

- [ ] **Step 3: Remove the three properties**

Remove `minimalSentDetails`, `minimalLastSentAt`, and `minimalHeartbeatTimer` property declarations.

- [ ] **Step 4: Update callers**

- In `shouldShowMinimal()` return paths: remove calls to `this.scheduleMinimalHeartbeat()`
- In `enqueueToolUpdate()`: remove calls to `this.scheduleMinimalHeartbeat()`
- In `enqueueText()` / `enqueueStreamingText()`: remove `this.minimalLastSentAt = Date.now()` and `this.clearMinimalHeartbeat()`
- In `abortTurn()`: remove `this.minimalSentDetails.clear()`, `this.minimalLastSentAt = Date.now()`, `this.clearMinimalHeartbeat()`
- In `shutdown()`: remove `this.clearMinimalHeartbeat()`
- In `hasPendingWork()`: remove `this.minimalHeartbeatTimer !== null`
- In `flushToolBuffer()`: remove the `minimalSentDetails` tracking block and `minimalLastSentAt` update

- [ ] **Step 5: Update any tests that assert on minimal heartbeat behavior**

Search for tests referencing `minimalHeartbeat`, `still working on it`, `minimalSentDetails`. Update or remove them — the operation tracker now provides this functionality via `enqueueProgressUpdate`.

- [ ] **Step 6: Run full outbound-queue tests**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/runtimes/agent/outbound-queue.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/runtimes/agent/outbound-queue.ts tests/runtimes/agent/outbound-queue.test.ts
git commit -m "refactor(outbound-queue): remove minimal heartbeat, replaced by operation tracker"
```

---

### Task 6: Session Manager — Watchdog Demotion & Recovery Methods

**Files:**
- Modify: `src/runtimes/agent/session.ts`
- Modify: `tests/runtimes/agent/session.test.ts`

- [ ] **Step 1: Write failing test for recoverStalledOperation**

Add to `tests/runtimes/agent/session.test.ts`:

```typescript
describe('recoverStalledOperation', () => {
  it('sends interrupt to provider stdin', () => {
    // Setup session with mock child
    const { session, child } = createSessionWithChild();
    session.recoverStalledOperation('tool-1', 'Agent');
    // Interrupt is sent via stdin write
    expect(child.stdin.write).toHaveBeenCalled();
  });
});

describe('probeLiveness', () => {
  it('sends probe to provider stdin', () => {
    const { session, child } = createSessionWithChild();
    session.probeLiveness();
    expect(child.stdin.write).toHaveBeenCalled();
  });
});
```

Note: `createSessionWithChild` is a helper that creates a SessionManager with a mock child process — adapt to the existing test patterns in the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/runtimes/agent/session.test.ts -t "recoverStalledOperation"`
Expected: FAIL — method not found

- [ ] **Step 3: Add recoverStalledOperation and probeLiveness to SessionManager**

In `src/runtimes/agent/session.ts`, add after the `tickWatchdog()` method:

```typescript
  /**
   * Attempt to recover a stalled tool operation by interrupting the provider.
   * Called by the operation tracker when an individual tool exceeds its stall threshold.
   * This is a softer intervention than the hard watchdog — it tries stdin interrupt
   * first and lets the provider handle the tool abort gracefully.
   */
  recoverStalledOperation(toolId: string, toolName: string): void {
    if (!this.active || this.child === null) return;
    log.warn({ toolId, toolName, pid: this.child.pid, sessionId: this.sessionId }, 'recovering stalled operation — sending interrupt');
    try {
      // Send Ctrl+C via stdin to interrupt the current operation
      this.child.stdin?.write('\x03');
    } catch (err) {
      log.error({ err, toolId, toolName }, 'failed to send interrupt for stalled operation');
    }
  }

  /**
   * Probe provider liveness when no events have been received for an extended period
   * (thinking stall). Sends a newline to stdin as a keepalive check — if the provider
   * is alive, it will produce some event in response. If no response comes within
   * the recovery grace period, the hard watchdog backstop will handle termination.
   */
  probeLiveness(): void {
    if (!this.active || this.child === null) return;
    log.warn({ pid: this.child.pid, sessionId: this.sessionId }, 'probing liveness — no events received');
    try {
      this.child.stdin?.write('\n');
    } catch (err) {
      log.error({ err }, 'failed to send liveness probe');
    }
  }
```

- [ ] **Step 4: Demote watchdog — remove soft and warn tiers**

In `armWatchdog()`, replace the three-timer setup with just the hard timer:

```typescript
  private armWatchdog(): void {
    // Only the hard backstop remains — soft/warn probes are replaced by the operation tracker
    this.watchdogHard = setTimeout(() => this.handleWatchdogHard(), WATCHDOG_HARD_MS);
  }
```

In `clearTurnWatchdog()`, keep clearing all three timer variables for safety (the soft/warn variables will just be null):

```typescript
  clearTurnWatchdog(): void {
    clearTimeout(this.watchdogSoft ?? undefined);
    clearTimeout(this.watchdogWarn ?? undefined);
    clearTimeout(this.watchdogHard ?? undefined);
    this.watchdogSoft = null;
    this.watchdogWarn = null;
    this.watchdogHard = null;
    this.pendingToolIds.clear();
  }
```

Keep `handleWatchdogHard()` unchanged. Remove or deprecate `handleWatchdogSoft()` and `handleWatchdogWarn()` — they won't be called but can stay as dead code with `@deprecated` markers for one release.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/runtimes/agent/session.test.ts -t "recoverStalledOperation"`
Expected: PASS

- [ ] **Step 6: Run full session test suite**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/runtimes/agent/session.test.ts`
Expected: PASS (update any tests that asserted on soft/warn watchdog behavior)

- [ ] **Step 7: Commit**

```bash
git add src/runtimes/agent/session.ts tests/runtimes/agent/session.test.ts
git commit -m "feat(session): add recovery methods, demote watchdog to hard backstop only"
```

---

### Task 7: Runtime Wiring — Create Tracker & Route Events

**Files:**
- Modify: `src/runtimes/agent/runtime.ts`
- Modify: `tests/runtimes/agent/runtime.test.ts`

- [ ] **Step 1: Add OperationTracker import**

At the top of `src/runtimes/agent/runtime.ts`, add:

```typescript
import { OperationTracker } from './operation-tracker.ts';
import type { ProgressEvent } from './operation-tracker.ts';
```

- [ ] **Step 2: Add tracker storage**

The tracker needs to be associated with each session. Find where sessions are stored (the session map or the single session reference) and add a parallel tracker:

For `per_chat` mode, add a `Map<string, OperationTracker>` alongside the session map:

```typescript
private operationTrackers = new Map<string, OperationTracker>();
```

For `single`/`shared` mode, add a single tracker property:

```typescript
private operationTracker: OperationTracker | null = null;
```

- [ ] **Step 3: Create tracker when session is created**

In the method that creates sessions (look for `createSessionManager` calls), create an `OperationTracker` alongside each session. The tracker callbacks wire to the queue and session:

```typescript
const tracker = new OperationTracker(
  this.instanceName,
  config.operationTracker,
  {
    onProgress: (event: ProgressEvent) => {
      const queue = this.getActiveQueue?.() ?? this.getQueueForMapKey?.(mapKey);
      if (queue) queue.enqueueProgressUpdate(event, this.instanceName);
    },
    onStalled: (toolId: string, toolName: string) => {
      session.recoverStalledOperation(toolId, toolName);
    },
    onThinkingStalled: () => {
      session.probeLiveness();
    },
  },
);
```

Store the tracker in the appropriate map/property.

- [ ] **Step 4: Wire tracker into handleEvent**

In the `handleEvent()` method's switch statement, add tracker calls. Find the existing `tool_use`, `tool_result`, `assistant_text`, and `result` cases and add the tracker calls as specified in the spec:

For `tool_use`:
```typescript
tracker?.onToolStart(event.toolId, event.toolName, buildToolUpdate(event.toolName, event.toolInput ?? {}).category);
```

For `tool_result`:
```typescript
tracker?.onToolEnd(event.toolId);
```

For `assistant_text`:
```typescript
tracker?.onAnyActivity();
```

For `result`:
```typescript
tracker?.onTurnComplete();
```

Note: The category comes from `buildToolUpdate()` which is already called in the `tool_use` case — extract the category before calling `queue.enqueueToolUpdate()`.

- [ ] **Step 5: Clean up tracker on session crash/shutdown**

In the `onCrash` callback where sessions are created, add `tracker.shutdown()`.
In any session cleanup/disposal code, add `tracker.shutdown()`.
Remove the tracker from the map when the session is removed.

- [ ] **Step 6: Run runtime tests**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/runtimes/agent/runtime.test.ts`
Expected: PASS (existing tests should not break — the tracker is additive)

- [ ] **Step 7: Commit**

```bash
git add src/runtimes/agent/runtime.ts tests/runtimes/agent/runtime.test.ts
git commit -m "feat(runtime): wire OperationTracker into event pipeline"
```

---

### Task 8: Integration Test & Full Suite Verification

**Files:**
- Modify: `tests/runtimes/agent/operation-tracker.test.ts`

- [ ] **Step 1: Add integration-style test for full escalation lifecycle**

```typescript
describe('full escalation lifecycle', () => {
  it('progresses through running → slow → stalled for a bash tool', () => {
    const cb = makeCallbacks();
    const tracker = new OperationTracker('TestBot', DEFAULT_CONFIG, cb);

    // bash: expected=15s, slow=30s, stall=75s, progress every 30s
    tracker.onToolStart('t1', 'Bash', 'running');

    // At 30s: progress fires AND slow fires
    vi.advanceTimersByTime(30_000);
    const progressCalls = cb.onProgress.mock.calls.filter(
      (c: unknown[]) => (c[0] as ProgressEvent).type === 'operation_progress'
    );
    expect(progressCalls.length).toBeGreaterThanOrEqual(1);

    const slowCalls = cb.onProgress.mock.calls.filter(
      (c: unknown[]) => (c[0] as ProgressEvent).type === 'operation_slow'
    );
    expect(slowCalls).toHaveLength(1);
    expect(tracker.getActive()[0].state).toBe('slow');

    // At 75s: stall fires and recovery is triggered
    vi.advanceTimersByTime(45_000);
    const stallCalls = cb.onProgress.mock.calls.filter(
      (c: unknown[]) => (c[0] as ProgressEvent).type === 'operation_stalled'
    );
    expect(stallCalls).toHaveLength(1);
    expect(cb.onStalled).toHaveBeenCalledWith('t1', 'Bash');

    tracker.shutdown();
  });

  it('does not fire stall if tool ends in time', () => {
    const cb = makeCallbacks();
    const tracker = new OperationTracker('TestBot', DEFAULT_CONFIG, cb);

    tracker.onToolStart('t1', 'Read', 'reading');
    vi.advanceTimersByTime(5_000);
    tracker.onToolEnd('t1');
    vi.advanceTimersByTime(100_000);

    // No stall event
    expect(cb.onStalled).not.toHaveBeenCalled();
    tracker.shutdown();
  });

  it('handles multiple concurrent operations independently', () => {
    const cb = makeCallbacks();
    const tracker = new OperationTracker('TestBot', DEFAULT_CONFIG, cb);

    tracker.onToolStart('t1', 'Agent', 'agent');
    tracker.onToolStart('t2', 'Read', 'reading');

    // End the read (fast) — agent still running
    vi.advanceTimersByTime(5_000);
    tracker.onToolEnd('t2');

    expect(tracker.getActive()).toHaveLength(1);
    expect(tracker.getActive()[0].toolId).toBe('t1');

    tracker.shutdown();
  });
});
```

- [ ] **Step 2: Run all operation tracker tests**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run tests/runtimes/agent/operation-tracker.test.ts`
Expected: PASS

- [ ] **Step 3: Run the full test suite**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run 2>&1 | tail -20`
Expected: All tests pass (or only pre-existing failures unrelated to this change)

- [ ] **Step 4: Commit**

```bash
git add tests/runtimes/agent/operation-tracker.test.ts
git commit -m "test(operation-tracker): integration tests for full escalation lifecycle"
```

---

### Task 9: TypeScript Compile Check & Build

**Files:**
- No new files — verification only

- [ ] **Step 1: TypeScript compile check**

Run: `cd /home/q/LAB/WhatSoup && npx tsc --noEmit 2>&1 | head -30`
Expected: No errors

- [ ] **Step 2: Build the project**

Run: `cd /home/q/LAB/WhatSoup && npm run build 2>&1 | tail -10`
Expected: Clean build

- [ ] **Step 3: Run full test suite one final time**

Run: `cd /home/q/LAB/WhatSoup && npx vitest run 2>&1 | tail -10`
Expected: All tests pass

- [ ] **Step 4: Final commit if any fixups were needed**

```bash
git add -A
git commit -m "fix: address compile/test issues from operation tracker integration"
```
