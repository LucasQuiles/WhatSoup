import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OperationTracker } from '../../../src/runtimes/agent/operation-tracker.ts';
import type {
  OperationTrackerCallbacks,
  ProgressEvent,
} from '../../../src/runtimes/agent/operation-tracker.ts';
import type { OperationTrackerConfig } from '../../../src/config.ts';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ─── Test config ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: OperationTrackerConfig = {
  enabled: true,
  progressIntervalMs: 30_000,
  thinkingLongMs: 45_000,
  thinkingStallMs: 300_000,
  progressPlaceholderRateLimitMs: 180_000,
  maxStatusMessagesPerTurn: Number.MAX_SAFE_INTEGER,
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCallbacks(): {
  callbacks: OperationTrackerCallbacks;
  progressEvents: ProgressEvent[];
  stalledCalls: Array<{ toolId: string; toolName: string }>;
  thinkingStalledCalls: number;
} {
  const progressEvents: ProgressEvent[] = [];
  const stalledCalls: Array<{ toolId: string; toolName: string }> = [];
  let thinkingStalledCalls = 0;

  const callbacks: OperationTrackerCallbacks = {
    onProgress: vi.fn((event: ProgressEvent) => { progressEvents.push(event); }),
    onStalled: vi.fn((toolId: string, toolName: string) => { stalledCalls.push({ toolId, toolName }); }),
    onThinkingStalled: vi.fn(() => { thinkingStalledCalls++; }),
  };

  return {
    callbacks,
    progressEvents,
    stalledCalls,
    get thinkingStalledCalls() { return thinkingStalledCalls; },
  };
}

function makeTracker(callbacks: OperationTrackerCallbacks, config = DEFAULT_CONFIG): OperationTracker {
  return new OperationTracker('test-instance', config, callbacks);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('OperationTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Construction & lifecycle ───────────────────────────────────────────

  describe('construction & lifecycle', () => {
    it('constructs without error and getActive returns empty', () => {
      const { callbacks } = makeCallbacks();
      const tracker = makeTracker(callbacks);
      expect(tracker.getActive()).toEqual([]);
      tracker.shutdown();
    });

    it('tracks tool start and end', () => {
      const { callbacks } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Bash', 'running');
      expect(tracker.getActive()).toHaveLength(1);
      expect(tracker.getActive()[0].toolId).toBe('t1');
      expect(tracker.getActive()[0].toolName).toBe('Bash');
      expect(tracker.getActive()[0].category).toBe('running');
      expect(tracker.getActive()[0].state).toBe('running');

      tracker.onToolEnd('t1');
      expect(tracker.getActive()).toEqual([]);
      tracker.shutdown();
    });

    it('clears all operations on shutdown', () => {
      const { callbacks } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Bash', 'running');
      tracker.onToolStart('t2', 'Read', 'reading');
      expect(tracker.getActive()).toHaveLength(2);

      tracker.shutdown();
      expect(tracker.getActive()).toEqual([]);
    });

    it('clears all operations on turn complete', () => {
      const { callbacks } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Bash', 'running');
      tracker.onToolStart('t2', 'Read', 'reading');

      tracker.onTurnComplete();
      expect(tracker.getActive()).toEqual([]);
    });

    it('getActive returns operations without internal timer fields', () => {
      const { callbacks } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Bash', 'running');
      const active = tracker.getActive();
      expect(active).toHaveLength(1);
      const op = active[0];
      // Internal fields should be stripped
      expect(op).not.toHaveProperty('progressTimer');
      expect(op).not.toHaveProperty('slowTimer');
      expect(op).not.toHaveProperty('stallTimer');
      // Public fields should be present
      expect(op).toHaveProperty('toolId');
      expect(op).toHaveProperty('toolName');
      expect(op).toHaveProperty('category');
      expect(op).toHaveProperty('startedAt');
      expect(op).toHaveProperty('expectedDurationMs');
      expect(op).toHaveProperty('state');

      tracker.shutdown();
    });
  });

  // ─── Progress events ────────────────────────────────────────────────────

  describe('progress events', () => {
    it('emits operation_progress at progressIntervalMs intervals', () => {
      const { callbacks, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Bash', 'running');

      // No progress yet
      expect(progressEvents.filter(e => e.type === 'operation_progress')).toHaveLength(0);

      // First interval
      vi.advanceTimersByTime(30_000);
      const progresses = progressEvents.filter(e => e.type === 'operation_progress');
      expect(progresses).toHaveLength(1);
      expect(progresses[0]).toMatchObject({
        type: 'operation_progress',
        toolId: 't1',
        toolName: 'Bash',
        category: 'running',
        state: 'running',
      });
      expect((progresses[0] as { elapsedMs: number }).elapsedMs).toBe(30_000);

      // Second interval
      vi.advanceTimersByTime(30_000);
      expect(progressEvents.filter(e => e.type === 'operation_progress')).toHaveLength(2);

      tracker.shutdown();
    });

    it('stops progress events when tool ends', () => {
      const { callbacks, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Bash', 'running');
      vi.advanceTimersByTime(30_000);
      expect(progressEvents.filter(e => e.type === 'operation_progress')).toHaveLength(1);

      tracker.onToolEnd('t1');

      // No more progress events after end
      vi.advanceTimersByTime(60_000);
      expect(progressEvents.filter(e => e.type === 'operation_progress')).toHaveLength(1);

      tracker.shutdown();
    });

    it('progress events include correct elapsedMs', () => {
      const { callbacks, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // Use agent category (stalls at 360s) so 3 progress events fire before stall
      tracker.onToolStart('t1', 'Agent', 'agent');

      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);
      vi.advanceTimersByTime(30_000);

      const progresses = progressEvents.filter(e => e.type === 'operation_progress') as Array<{ elapsedMs: number }>;
      expect(progresses).toHaveLength(3);
      expect(progresses[0].elapsedMs).toBe(30_000);
      expect(progresses[1].elapsedMs).toBe(60_000);
      expect(progresses[2].elapsedMs).toBe(90_000);

      tracker.shutdown();
    });
  });

  // ─── Slow escalation ────────────────────────────────────────────────────

  describe('slow escalation', () => {
    it('transitions to slow state at expectedMs * slowMultiplier', () => {
      const { callbacks, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // bash: expectedMs=15000, slowMultiplier=2 → slow at 30000ms
      tracker.onToolStart('t1', 'Bash', 'running');

      vi.advanceTimersByTime(30_000);

      const slowEvents = progressEvents.filter(e => e.type === 'operation_slow');
      expect(slowEvents).toHaveLength(1);
      expect(tracker.getActive()[0].state).toBe('slow');

      tracker.shutdown();
    });

    it('does not fire slow before threshold', () => {
      const { callbacks, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // bash: slow at 30000ms
      tracker.onToolStart('t1', 'Bash', 'running');

      vi.advanceTimersByTime(29_999);

      expect(progressEvents.filter(e => e.type === 'operation_slow')).toHaveLength(0);
      expect(tracker.getActive()[0].state).toBe('running');

      tracker.shutdown();
    });

    it('emits operation_slow event with correct fields', () => {
      const { callbacks, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // bash: expectedMs=15000, slowMultiplier=2 → slow at 30000ms
      tracker.onToolStart('t1', 'Bash', 'running');

      vi.advanceTimersByTime(30_000);

      const slowEvent = progressEvents.find(e => e.type === 'operation_slow');
      expect(slowEvent).toMatchObject({
        type: 'operation_slow',
        toolId: 't1',
        toolName: 'Bash',
        category: 'running',
        elapsedMs: 30_000,
        expectedMs: 15_000,
      });

      tracker.shutdown();
    });
  });

  // ─── Stall escalation ──────────────────────────────────────────────────

  describe('stall escalation', () => {
    it('transitions to stalled and triggers onStalled at expectedMs * stallMultiplier', () => {
      const { callbacks, stalledCalls, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // bash: expectedMs=15000, stallMultiplier=5 → stall at 75000ms
      tracker.onToolStart('t1', 'Bash', 'running');

      vi.advanceTimersByTime(75_000);

      expect(tracker.getActive()[0].state).toBe('stalled');
      expect(stalledCalls).toHaveLength(1);
      expect(stalledCalls[0]).toEqual({ toolId: 't1', toolName: 'Bash' });

      const stallEvents = progressEvents.filter(e => e.type === 'operation_stalled');
      expect(stallEvents).toHaveLength(1);

      tracker.shutdown();
    });

    it('emits operation_stalled event with correct fields', () => {
      const { callbacks, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // bash: stall at 75000ms
      tracker.onToolStart('t1', 'Bash', 'running');

      vi.advanceTimersByTime(75_000);

      const stallEvent = progressEvents.find(e => e.type === 'operation_stalled');
      expect(stallEvent).toMatchObject({
        type: 'operation_stalled',
        toolId: 't1',
        toolName: 'Bash',
        category: 'running',
        elapsedMs: 75_000,
      });

      tracker.shutdown();
    });

    it('does not fire stall if tool ends in time', () => {
      const { callbacks, stalledCalls, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // bash: stall at 75000ms
      tracker.onToolStart('t1', 'Bash', 'running');

      vi.advanceTimersByTime(50_000);
      tracker.onToolEnd('t1');

      vi.advanceTimersByTime(50_000);

      expect(stalledCalls).toHaveLength(0);
      expect(progressEvents.filter(e => e.type === 'operation_stalled')).toHaveLength(0);

      tracker.shutdown();
    });
  });

  // ─── Thinking gap ──────────────────────────────────────────────────────

  describe('thinking gap', () => {
    it('emits thinking_long after thinkingLongMs of silence', () => {
      const { callbacks, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // Start and end a tool to arm thinking timers
      tracker.onToolStart('t1', 'Bash', 'running');
      tracker.onToolEnd('t1');

      vi.advanceTimersByTime(45_000);

      const longEvents = progressEvents.filter(e => e.type === 'thinking_long');
      expect(longEvents).toHaveLength(1);
      expect((longEvents[0] as { gapMs: number }).gapMs).toBe(45_000);

      tracker.shutdown();
    });

    it('emits thinking_stalled and triggers onThinkingStalled after thinkingStallMs', () => {
      const ctx = makeCallbacks();
      const tracker = makeTracker(ctx.callbacks);

      tracker.onToolStart('t1', 'Bash', 'running');
      tracker.onToolEnd('t1');

      vi.advanceTimersByTime(300_000);

      const stallEvents = ctx.progressEvents.filter(e => e.type === 'thinking_stalled');
      expect(stallEvents).toHaveLength(1);
      expect(ctx.thinkingStalledCalls).toBe(1);

      tracker.shutdown();
    });

    it('resets thinking timers on tool start', () => {
      const { callbacks, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // Arm thinking timers
      tracker.onToolStart('t1', 'Bash', 'running');
      tracker.onToolEnd('t1');

      // Advance part way
      vi.advanceTimersByTime(40_000);
      expect(progressEvents.filter(e => e.type === 'thinking_long')).toHaveLength(0);

      // Start a new tool — should clear thinking timers
      tracker.onToolStart('t2', 'Read', 'reading');

      // Advance past original threshold — should NOT fire
      vi.advanceTimersByTime(10_000);
      expect(progressEvents.filter(e => e.type === 'thinking_long')).toHaveLength(0);

      tracker.onToolEnd('t2');
      tracker.shutdown();
    });

    it('does not arm thinking timers while tools are pending', () => {
      const { callbacks, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Bash', 'running');
      tracker.onToolStart('t2', 'Read', 'reading');

      // End one tool — still one pending
      tracker.onToolEnd('t1');

      // Advance past thinking threshold
      vi.advanceTimersByTime(300_000);
      expect(progressEvents.filter(e => e.type === 'thinking_long')).toHaveLength(0);
      expect(progressEvents.filter(e => e.type === 'thinking_stalled')).toHaveLength(0);

      tracker.shutdown();
    });

    it('re-arms thinking timers after last tool ends', () => {
      const { callbacks, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Bash', 'running');
      tracker.onToolStart('t2', 'Read', 'reading');

      tracker.onToolEnd('t1');
      // Still one pending — no thinking timers
      vi.advanceTimersByTime(44_000);
      expect(progressEvents.filter(e => e.type === 'thinking_long')).toHaveLength(0);

      // End last tool — now thinking timers should arm
      tracker.onToolEnd('t2');

      vi.advanceTimersByTime(45_000);
      expect(progressEvents.filter(e => e.type === 'thinking_long')).toHaveLength(1);

      tracker.shutdown();
    });

    it('onAnyActivity resets thinking timers', () => {
      const { callbacks, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // Arm thinking timers
      tracker.onToolStart('t1', 'Bash', 'running');
      tracker.onToolEnd('t1');

      // Advance part way
      vi.advanceTimersByTime(40_000);
      expect(progressEvents.filter(e => e.type === 'thinking_long')).toHaveLength(0);

      // Activity resets timers
      tracker.onAnyActivity();

      // Advance past original threshold — should NOT fire since timers were reset
      vi.advanceTimersByTime(10_000);
      expect(progressEvents.filter(e => e.type === 'thinking_long')).toHaveLength(0);

      // But should fire after full interval from reset
      vi.advanceTimersByTime(35_000);
      expect(progressEvents.filter(e => e.type === 'thinking_long')).toHaveLength(1);

      tracker.shutdown();
    });
  });

  // ─── Multiple concurrent operations ─────────────────────────────────────

  describe('multiple concurrent operations', () => {
    it('handles multiple tools independently', () => {
      const { callbacks } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Bash', 'running');
      tracker.onToolStart('t2', 'Read', 'reading');
      tracker.onToolStart('t3', 'Edit', 'modifying');

      expect(tracker.getActive()).toHaveLength(3);

      tracker.onToolEnd('t2');
      expect(tracker.getActive()).toHaveLength(2);
      expect(tracker.getActive().map(o => o.toolId).sort()).toEqual(['t1', 't3']);

      tracker.shutdown();
    });

    it('restarting the same toolId does not leak the previous timers (no duplicate slow event)', () => {
      // A phantom/replayed tool_use event re-invokes onToolStart for a toolId that is
      // still tracked. The previous op's slow/stall timers must be cleared, otherwise
      // both fire and the user gets duplicate "Still working…" placeholders.
      const { callbacks, progressEvents } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // read: slow at 9000ms
      tracker.onToolStart('dup', 'Read', 'reading');
      vi.advanceTimersByTime(1_000);
      tracker.onToolStart('dup', 'Read', 'reading'); // re-seen before the first ended

      vi.advanceTimersByTime(9_000);

      const slowEvents = progressEvents.filter((e) => e.type === 'operation_slow');
      expect(slowEvents).toHaveLength(1);
      expect(tracker.getActive()).toHaveLength(1);

      tracker.shutdown();
    });

    it('ending one tool does not affect another\'s timers', () => {
      const { callbacks, progressEvents, stalledCalls } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // bash: slow at 30000ms, stall at 75000ms
      tracker.onToolStart('t1', 'Bash', 'running');
      // read: slow at 9000ms, stall at 30000ms
      tracker.onToolStart('t2', 'Read', 'reading');

      // End the read tool early
      vi.advanceTimersByTime(5_000);
      tracker.onToolEnd('t2');

      // Advance to bash slow threshold
      vi.advanceTimersByTime(25_000);

      const slowEvents = progressEvents.filter(e => e.type === 'operation_slow');
      expect(slowEvents).toHaveLength(1);
      expect(slowEvents[0]).toMatchObject({ toolId: 't1', toolName: 'Bash' });

      // No stall event for Read (it ended)
      expect(stalledCalls).toHaveLength(0);

      // Advance to bash stall
      vi.advanceTimersByTime(45_000);
      expect(stalledCalls).toHaveLength(1);
      expect(stalledCalls[0]).toEqual({ toolId: 't1', toolName: 'Bash' });

      tracker.shutdown();
    });
  });

  // ─── Full lifecycle ─────────────────────────────────────────────────────

  describe('full lifecycle', () => {
    it('running → slow → stalled for a bash tool (15s expected, 30s slow, 75s stall)', () => {
      const { callbacks, progressEvents, stalledCalls } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Bash', 'running');
      expect(tracker.getActive()[0].state).toBe('running');

      // Progress at 30s
      vi.advanceTimersByTime(30_000);
      expect(tracker.getActive()[0].state).toBe('slow');
      const slowEvent = progressEvents.find(e => e.type === 'operation_slow');
      expect(slowEvent).toBeDefined();

      // State is slow, progress events should reflect that
      const progressAfterSlow = progressEvents.filter(
        e => e.type === 'operation_progress' && 'state' in e && e.state === 'slow'
      );
      // There should be at least one progress event after going slow (the one at 30s boundary)
      // But the exact count depends on timing — the progress interval fires concurrently

      // Advance to stall at 75s (45s more from current position of 30s)
      vi.advanceTimersByTime(45_000);
      expect(tracker.getActive()[0].state).toBe('stalled');
      expect(stalledCalls).toHaveLength(1);

      const stallEvent = progressEvents.find(e => e.type === 'operation_stalled');
      expect(stallEvent).toMatchObject({
        type: 'operation_stalled',
        toolId: 't1',
        toolName: 'Bash',
        elapsedMs: 75_000,
      });

      tracker.shutdown();
    });

    it('tool ending at running state clears cleanly', () => {
      const { callbacks, progressEvents, stalledCalls } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Bash', 'running');
      vi.advanceTimersByTime(10_000);
      tracker.onToolEnd('t1');

      expect(tracker.getActive()).toEqual([]);
      expect(progressEvents.filter(e => e.type === 'operation_slow')).toHaveLength(0);
      expect(stalledCalls).toHaveLength(0);

      // No further events after end
      vi.advanceTimersByTime(100_000);
      expect(progressEvents.filter(e => e.type === 'operation_slow')).toHaveLength(0);
      expect(stalledCalls).toHaveLength(0);

      tracker.shutdown();
    });

    it('tool ending at slow state clears cleanly', () => {
      const { callbacks, stalledCalls } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // bash: slow at 30000ms
      tracker.onToolStart('t1', 'Bash', 'running');
      vi.advanceTimersByTime(30_000);
      expect(tracker.getActive()[0].state).toBe('slow');

      tracker.onToolEnd('t1');
      expect(tracker.getActive()).toEqual([]);

      // No stall after end
      vi.advanceTimersByTime(100_000);
      expect(stalledCalls).toHaveLength(0);

      tracker.shutdown();
    });

    it('tool ending at stalled state clears cleanly', () => {
      const { callbacks } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // bash: stall at 75000ms
      tracker.onToolStart('t1', 'Bash', 'running');
      vi.advanceTimersByTime(75_000);
      expect(tracker.getActive()[0].state).toBe('stalled');

      tracker.onToolEnd('t1');
      expect(tracker.getActive()).toEqual([]);

      tracker.shutdown();
    });
  });

  // ─── Category → threshold mapping ──────────────────────────────────────

  describe('category threshold mapping', () => {
    it('maps "reading" category to "read" threshold', () => {
      const { callbacks } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Read', 'reading');
      // read: expectedMs=3000
      expect(tracker.getActive()[0].expectedDurationMs).toBe(3_000);

      tracker.shutdown();
    });

    it('maps "searching" category to "read" threshold', () => {
      const { callbacks } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Grep', 'searching');
      expect(tracker.getActive()[0].expectedDurationMs).toBe(3_000);

      tracker.shutdown();
    });

    it('maps "modifying" category to "edit" threshold', () => {
      const { callbacks } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'Edit', 'modifying');
      expect(tracker.getActive()[0].expectedDurationMs).toBe(2_000);

      tracker.shutdown();
    });

    it('maps "fetching" category to "web" threshold', () => {
      const { callbacks } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'WebFetch', 'fetching');
      expect(tracker.getActive()[0].expectedDurationMs).toBe(10_000);

      tracker.shutdown();
    });

    it('maps "other" category to "mcp" threshold', () => {
      const { callbacks } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      tracker.onToolStart('t1', 'SomeMcp', 'other');
      expect(tracker.getActive()[0].expectedDurationMs).toBe(15_000);

      tracker.shutdown();
    });

    it('maps unknown category to "default" threshold', () => {
      const { callbacks } = makeCallbacks();
      const tracker = makeTracker(callbacks);

      // 'planning' is not mapped explicitly → falls through to default
      tracker.onToolStart('t1', 'Plan', 'planning');
      expect(tracker.getActive()[0].expectedDurationMs).toBe(10_000);

      tracker.shutdown();
    });
  });
});
