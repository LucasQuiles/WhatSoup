// Proof for the persistent per-chat progress-placeholder RATE FLOOR.
//
// The pre-existing collapser (recentProgressTextAt) is a 30s per-TEXT window that
// (a) cannot cap elapsed-bearing stall text (unique each fire), (b) is cleared by
// flush()/abortTurn() every turn, and (c) lets slow→stall escalation emit two
// distinct texts. None of those bound the total placeholder rate on a long turn.
//
// The floor is keyed on the chat (the OutboundQueue is per-conversation), survives
// flush()/abortTurn(), and is checked BEFORE the text window — so it caps the rate
// regardless of text uniqueness or turn boundaries. Suppressed nudges still
// re-assert the typing indicator, preserving the alive signal.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OperationTracker } from '../../../src/runtimes/agent/operation-tracker.ts';
import type { ProgressEvent } from '../../../src/runtimes/agent/operation-tracker.ts';
import {
  OutboundQueue,
  MIN_SEND_GAP_MS,
  PROGRESS_PLACEHOLDER_RATE_FLOOR_MS,
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
const STALL_TEXT = `_${INSTANCE}: still working — this is taking a while..._`;

const CONFIG: OperationTrackerConfig = {
  enabled: true,
  progressIntervalMs: 30_000,
  thinkingLongMs: 45_000,
  thinkingStallMs: 300_000,
  progressPlaceholderRateLimitMs: PROGRESS_PLACEHOLDER_RATE_FLOOR_MS,
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

function makeMessenger(): { messenger: Messenger; calls: string[]; typingCalls: boolean[] } {
  const calls: string[] = [];
  const typingCalls: boolean[] = [];
  const messenger: Messenger = {
    sendMessage: vi.fn(async (_jid: string, text: string) => { calls.push(text); return { waMessageId: null }; }),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async (_jid: string, typing: boolean) => { typingCalls.push(typing); }),
  };
  return { messenger, calls, typingCalls };
}

function wire(floorMs: number = PROGRESS_PLACEHOLDER_RATE_FLOOR_MS) {
  const { messenger, calls, typingCalls } = makeMessenger();
  const queue = new OutboundQueue(messenger, CHAT_JID);
  queue.setToolUpdateMode('friendly');
  queue.setProgressFloorMs(floorMs);
  const tracker = new OperationTracker(INSTANCE, CONFIG, {
    onProgress: (e: ProgressEvent) => { queue.enqueueProgressUpdate(e, INSTANCE); },
    onStalled: vi.fn(),
    onThinkingStalled: vi.fn(),
  });
  return { queue, tracker, calls, typingCalls };
}

describe('progress placeholder per-chat rate floor', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('collapses slow→stall escalation (two DISTINCT texts) to one within the floor window', async () => {
    const { queue, tracker, calls } = wire();

    // read: slow at 9000ms, stalled (distinct elapsed text) at 30000ms — both well
    // inside the 180s floor. Old behavior emitted two; the floor allows only one.
    tracker.onToolStart('toolu_a', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toEqual([SLOW_TEXT]);

    await vi.advanceTimersByTimeAsync(21_000 + MIN_SEND_GAP_MS); // reach 30000ms stall
    expect(calls).toEqual([SLOW_TEXT]); // distinct stall text suppressed by floor

    tracker.shutdown();
    queue.abortTurn();
  });

  it('re-asserts the typing indicator when a nudge is floor-suppressed (liveness preserved)', async () => {
    const { queue, tracker, typingCalls } = wire();

    tracker.onToolStart('toolu_a', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    const typingTrueBefore = typingCalls.filter((t) => t === true).length;

    // Distinct stall text fires inside the floor → suppressed, but typing re-asserted.
    await vi.advanceTimersByTimeAsync(21_000 + MIN_SEND_GAP_MS);
    const typingTrueAfter = typingCalls.filter((t) => t === true).length;
    expect(typingTrueAfter).toBeGreaterThan(typingTrueBefore);

    tracker.shutdown();
    queue.abortTurn();
  });

  it('floor SURVIVES flush() — a new turn within the window does NOT re-announce', async () => {
    const { queue, tracker, calls } = wire();

    tracker.onToolStart('toolu_a', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toEqual([SLOW_TEXT]);

    // Turn ends — runtime calls flush(). The text window resets, but the floor must not.
    tracker.onToolEnd('toolu_a');
    await queue.flush();

    tracker.onToolStart('toolu_b', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toEqual([SLOW_TEXT]); // second turn suppressed by surviving floor

    tracker.shutdown();
    queue.abortTurn();
  });

  it('floor SURVIVES abortTurn() — a nudge after a crash within the window is suppressed', async () => {
    const { queue, tracker, calls } = wire();

    tracker.onToolStart('toolu_a', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toEqual([SLOW_TEXT]);

    tracker.shutdown();
    queue.abortTurn(); // session crash mid-turn

    const tracker2 = new OperationTracker(INSTANCE, CONFIG, {
      onProgress: (e: ProgressEvent) => { queue.enqueueProgressUpdate(e, INSTANCE); },
      onStalled: vi.fn(),
      onThinkingStalled: vi.fn(),
    });
    tracker2.onToolStart('toolu_b', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toEqual([SLOW_TEXT]); // still suppressed — abortTurn did not reset floor

    tracker2.shutdown();
    queue.abortTurn();
  });

  it('allows a fresh nudge once the floor window has fully elapsed', async () => {
    const { queue, tracker, calls } = wire();

    tracker.onToolStart('toolu_a', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toEqual([SLOW_TEXT]);
    tracker.onToolEnd('toolu_a');

    // Advance past the full floor window, then a genuine later nudge is allowed.
    await vi.advanceTimersByTimeAsync(PROGRESS_PLACEHOLDER_RATE_FLOOR_MS);
    tracker.onToolStart('toolu_b', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toEqual([SLOW_TEXT, SLOW_TEXT]);

    tracker.shutdown();
    queue.abortTurn();
  });

  it('caps a long multi-escalation turn to roughly turn/floor placeholders', async () => {
    const { queue, tracker, calls } = wire();

    tracker.onToolStart('toolu_a', 'Read', 'reading');
    // Drive ~13 minutes of stall escalations (tracker re-emits elapsed-bearing text).
    for (let i = 0; i < 26; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    // 13 min / 180s ≈ 4.3 windows → at most 6 placeholders (first is free).
    expect(calls.length).toBeLessThanOrEqual(6);
    expect(calls.length).toBeGreaterThanOrEqual(1);

    tracker.shutdown();
    queue.abortTurn();
  });

  it('floor disabled (0) restores pre-floor behavior — escalation emits two distinct texts', async () => {
    const { queue, tracker, calls } = wire(0);

    tracker.onToolStart('toolu_a', 'Read', 'reading');
    await vi.advanceTimersByTimeAsync(9_000 + MIN_SEND_GAP_MS);
    expect(calls).toEqual([SLOW_TEXT]);

    await vi.advanceTimersByTimeAsync(21_000 + MIN_SEND_GAP_MS);
    expect(calls).toEqual([SLOW_TEXT, PROGRESS_TEXT, STALL_TEXT]);

    tracker.shutdown();
    queue.abortTurn();
  });
});
