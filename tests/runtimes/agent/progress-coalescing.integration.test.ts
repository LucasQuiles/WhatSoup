// Integration proof for the "Still working… x3" duplicate-placeholder fix.
// Wires a real OperationTracker to a real OutboundQueue (the exact production path:
// tracker.onProgress → queue.enqueueProgressUpdate) and proves, with deterministic
// fake timers, that a parallel tool batch yields ONE user-facing placeholder even
// though the tracker genuinely emits one slow event per concurrent operation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OperationTracker } from '../../../src/runtimes/agent/operation-tracker.ts';
import type { ProgressEvent } from '../../../src/runtimes/agent/operation-tracker.ts';
import {
  OutboundQueue,
  MIN_SEND_GAP_MS,
  PROGRESS_TEXT_DEDUPE_WINDOW_MS,
} from '../../../src/runtimes/agent/outbound-queue.ts';
import type { OperationTrackerConfig } from '../../../src/config.ts';
import type { Messenger } from '../../../src/core/types.ts';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const CHAT_JID = 'ana-invoicing@s.whatsapp.net';
const INSTANCE = 'Ana';
const SLOW_TEXT = `_${INSTANCE} is still working on it..._`;
const PROGRESS_TEXT = `_${INSTANCE} is working on something, this might take a moment..._`;
const STALL_TEXT = `_${INSTANCE}: Still working (30s)..._`;

const CONFIG: OperationTrackerConfig = {
  enabled: true,
  progressIntervalMs: 30_000,
  thinkingLongMs: 45_000,
  thinkingStallMs: 300_000,
  progressPlaceholderRateLimitMs: 180_000,
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

function makeMessenger(): { messenger: Messenger; calls: string[] } {
  const calls: string[] = [];
  const messenger: Messenger = {
    sendMessage: vi.fn(async (_jid: string, text: string) => { calls.push(text); return { waMessageId: null }; }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async () => {}),
  };
  return { messenger, calls };
}

/** Wire a real tracker to a real queue exactly as runtime.createOperationTracker does. */
function wire(mode: 'full' | 'minimal' | 'friendly') {
  const { messenger, calls } = makeMessenger();
  const queue = new OutboundQueue(messenger, CHAT_JID);
  queue.setToolUpdateMode(mode);
  // Isolate the 30s per-TEXT dedupe layer under test from the persistent per-chat
  // rate floor (covered separately in progress-placeholder-rate-floor.test.ts).
  // These cases drive sub-180s timings where the floor would otherwise dominate.
  queue.setProgressFloorMs(0);
  const slowEvents: ProgressEvent[] = [];
  const stalledCalls: string[] = [];
  const tracker = new OperationTracker(INSTANCE, CONFIG, {
    onProgress: (e: ProgressEvent) => {
      if (e.type === 'operation_slow') slowEvents.push(e);
      queue.enqueueProgressUpdate(e, INSTANCE);
    },
    onStalled: (toolId: string) => { stalledCalls.push(toolId); },
    onThinkingStalled: vi.fn(),
  });
  return { queue, tracker, calls, slowEvents, stalledCalls };
}

describe('progress placeholder coalescing (tracker → queue integration)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a parallel batch of 3 slow Read tools emits 3 tracker events but ONE chat message', async () => {
    const { queue, tracker, calls, slowEvents } = wire('friendly');

    // The model issues three Read tools in one turn (read: slow at 3000*3 = 9000ms).
    tracker.onToolStart('toolu_a', 'Read', 'reading');
    tracker.onToolStart('toolu_b', 'Read', 'reading');
    tracker.onToolStart('toolu_c', 'Read', 'reading');

    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);

    // SOURCE proof: the tracker genuinely fires one slow event per concurrent op.
    expect(slowEvents).toHaveLength(3);
    // FIX proof: the user-facing chat receives exactly one identical placeholder.
    expect(calls).toEqual([SLOW_TEXT]);

    tracker.shutdown();
    queue.abortTurn();
  });

  it('escalation: one op going slow then stalled sends two DISTINCT messages', async () => {
    const { queue, tracker, calls } = wire('friendly');

    // read: slow at 9000ms, stalled at 3000*10 = 30000ms.
    tracker.onToolStart('toolu_a', 'Read', 'reading');

    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toEqual([SLOW_TEXT]);

    await vi.advanceTimersByTimeAsync(21_000 + MIN_SEND_GAP_MS); // reach 30000ms stall
    expect(calls).toEqual([SLOW_TEXT, PROGRESS_TEXT, STALL_TEXT]);

    tracker.shutdown();
    queue.abortTurn();
  });

  it('a brand-new turn re-announces after flush() resets coalescing', async () => {
    const { queue, tracker, calls } = wire('friendly');

    tracker.onToolStart('toolu_a', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toHaveLength(1);

    // Turn ends — runtime calls queue.flush(), which clears the coalescing window.
    tracker.onToolEnd('toolu_a');
    await queue.flush();

    // Next turn, same placeholder text, well within 30s of the previous one — must re-announce.
    tracker.onToolStart('toolu_b', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toEqual([SLOW_TEXT, SLOW_TEXT]);

    tracker.shutdown();
    queue.abortTurn();
  });

  it('coalesces across a JID-alias retarget within the window (text-only key)', async () => {
    const { queue, tracker, calls } = wire('friendly');

    tracker.onToolStart('toolu_a', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toHaveLength(1);

    // The conversation's send JID flips (@s.whatsapp.net ↔ @lid) — still one conversation.
    queue.updateDeliveryJid('ana-invoicing@lid');

    tracker.onToolStart('toolu_b', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toHaveLength(1); // duplicate suppressed across the alias flip

    tracker.shutdown();
    queue.abortTurn();
  });

  it('window expiry inside one long turn allows a genuine later nudge', async () => {
    const { queue, tracker, calls } = wire('friendly');

    tracker.onToolStart('toolu_a', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toEqual([SLOW_TEXT]);
    // End it so it does not escalate to a (distinct) stall message — we are isolating
    // window expiry of the identical plain placeholder, with no flush in between.
    tracker.onToolEnd('toolu_a');

    await vi.advanceTimersByTimeAsync(PROGRESS_TEXT_DEDUPE_WINDOW_MS);
    tracker.onToolStart('toolu_b', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toEqual([SLOW_TEXT, SLOW_TEXT]);

    tracker.shutdown();
    queue.abortTurn();
  });
});
