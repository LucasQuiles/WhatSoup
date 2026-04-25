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
  progressTimer: ReturnType<typeof setInterval> | null;
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
    // Only arm thinking timers if no tools are still pending
    if (this.operations.size === 0) {
      this.armThinkingTimers();
    }
  }

  onAnyActivity(): void {
    this.lastActivityAt = Date.now();
    this.clearThinkingTimers();
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
      // Stop periodic progress — stall recovery has been triggered
      if (op.progressTimer !== null) { clearInterval(op.progressTimer); op.progressTimer = null; }
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
