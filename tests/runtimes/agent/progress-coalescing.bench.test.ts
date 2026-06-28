// ─────────────────────────────────────────────────────────────────────────────
// Progress-placeholder coalescing BENCH
//
// A reusable, extensible bench that pins the invariants of the user-facing
// progress-placeholder pipeline (OutboundQueue.enqueueProgressUpdate →
// enqueueProgress dedup) against the bug class that produced "Still working… ×3":
// a per-event fan-out emitting identical user messages with no coalescing.
//
// It is organised by FAILURE DIMENSION rather than by method, so a future bug
// adds a row, not a rewrite:
//   1. Invariants        — identical fan-out collapses; distinct content never does
//   2. Window boundaries — exact suppress/allow edges of the dedupe window
//   3. Lifecycle         — per-turn reset on flush()/abortTurn(), no cross-turn leak
//   4. Mode matrix       — minimal / friendly / full all hold the same invariant
//   5. Failure modes     — pollPending gating, record-on-enqueue, abort mid-flight
//   6. Stress            — high fan-out and sustained-turn scaling
//
// Determinism: fake timers throughout; every scenario that starts the typing
// heartbeat is torn down with abortTurn()/flush() so no interval leaks.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OutboundQueue,
  MIN_SEND_GAP_MS,
  PROGRESS_TEXT_DEDUPE_WINDOW_MS,
} from '../../../src/runtimes/agent/outbound-queue.ts';
import type { ProgressEvent } from '../../../src/runtimes/agent/operation-tracker.ts';
import type { Messenger } from '../../../src/core/types.ts';

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const CHAT_JID = 'bench@s.whatsapp.net';
const INSTANCE = 'Bench';

// ─── Harness ──────────────────────────────────────────────────────────────────

interface Bench {
  queue: OutboundQueue;
  calls: string[];
  sendCount: () => number;
  /** Override sendMessage (e.g. to a never-resolving promise) for failure-mode tests. */
  setSend: (fn: (jid: string, text: string) => Promise<{ waMessageId: string | null }>) => void;
}

function bench(mode: 'full' | 'minimal' | 'friendly'): Bench {
  const calls: string[] = [];
  let sendImpl = async (_jid: string, text: string) => { calls.push(text); return { waMessageId: null }; };
  const messenger: Messenger = {
    sendMessage: vi.fn((jid: string, text: string) => sendImpl(jid, text)),
    sendMedia: vi.fn(async () => ({ waMessageId: null })),
    setTyping: vi.fn(async () => {}),
  } as unknown as Messenger;
  const queue = new OutboundQueue(messenger, CHAT_JID);
  queue.setToolUpdateMode(mode);
  // This suite benchmarks the 30s per-TEXT dedupe layer in isolation. Disable the
  // persistent per-chat rate floor (covered in progress-placeholder-rate-floor.test.ts),
  // which would otherwise dominate these sub-180s scenarios.
  queue.setProgressFloorMs(0);
  return {
    queue,
    calls,
    sendCount: () => (messenger.sendMessage as ReturnType<typeof vi.fn>).mock.calls.length,
    setSend: (fn) => { sendImpl = fn as typeof sendImpl; },
  };
}

const slow = (toolId: string, elapsedMs = 9_000): ProgressEvent =>
  ({ type: 'operation_slow', toolId, toolName: 'Read', category: 'reading', elapsedMs, expectedMs: 3_000 });
const stalled = (toolId: string, elapsedMs: number): ProgressEvent =>
  ({ type: 'operation_stalled', toolId, toolName: 'Read', category: 'reading', elapsedMs });

/** Drain queued sends without looping forever on the typing heartbeat. */
const drain = (n = 1) => vi.advanceTimersByTimeAsync(MIN_SEND_GAP_MS * n + 1);

describe('progress-coalescing BENCH', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

  // ── 1. Invariants ────────────────────────────────────────────────────────
  describe('1. invariants', () => {
    it('identical concurrent slow placeholders collapse to one (minimal)', async () => {
      const b = bench('minimal');
      for (const id of ['a', 'b', 'c', 'd']) b.queue.enqueueProgressUpdate(slow(id), INSTANCE);
      await drain();
      expect(b.calls).toEqual(['_Still working..._']);
      b.queue.abortTurn();
    });

    it('distinct text is never collapsed (full mode, different elapsed)', async () => {
      const b = bench('full');
      b.queue.enqueueProgressUpdate(slow('a', 45_000), INSTANCE);
      b.queue.enqueueProgressUpdate(slow('b', 90_000), INSTANCE);
      await drain(2);
      expect(b.calls).toHaveLength(2);
      expect(b.calls[0]).toContain('45s');
      expect(b.calls[1]).toContain('1m 30s');
      b.queue.abortTurn();
    });

    it('escalation slow→stalled emits two distinct messages', async () => {
      const b = bench('minimal');
      b.queue.enqueueProgressUpdate(slow('a'), INSTANCE);
      await drain();
      b.queue.enqueueProgressUpdate(stalled('a', 30_000), INSTANCE);
      await drain();
      expect(b.calls).toEqual(['_Still working..._', '_Still working (30s)..._']);
      b.queue.abortTurn();
    });
  });

  // ── 2. Window boundaries ─────────────────────────────────────────────────
  describe('2. window boundaries', () => {
    it('suppresses an identical placeholder just inside the window', async () => {
      const b = bench('minimal');
      b.queue.enqueueProgressUpdate(slow('a'), INSTANCE);
      await drain();
      await vi.advanceTimersByTimeAsync(PROGRESS_TEXT_DEDUPE_WINDOW_MS - MIN_SEND_GAP_MS - 2);
      b.queue.enqueueProgressUpdate(slow('b'), INSTANCE);
      await drain();
      expect(b.calls).toHaveLength(1);
      b.queue.abortTurn();
    });

    it('allows an identical placeholder once the window has elapsed', async () => {
      const b = bench('minimal');
      b.queue.enqueueProgressUpdate(slow('a'), INSTANCE);
      await drain();
      await vi.advanceTimersByTimeAsync(PROGRESS_TEXT_DEDUPE_WINDOW_MS + 1);
      b.queue.enqueueProgressUpdate(slow('b'), INSTANCE);
      await drain();
      expect(b.calls).toHaveLength(2);
      b.queue.abortTurn();
    });
  });

  // ── 3. Lifecycle reset ───────────────────────────────────────────────────
  describe('3. lifecycle reset', () => {
    it('flush() resets coalescing so the next turn re-announces', async () => {
      const b = bench('minimal');
      b.queue.enqueueProgressUpdate(slow('a'), INSTANCE);
      await drain();
      await b.queue.flush();
      b.queue.enqueueProgressUpdate(slow('b'), INSTANCE);
      await drain();
      expect(b.calls).toEqual(['_Still working..._', '_Still working..._']);
      b.queue.abortTurn();
    });

    it('abortTurn() resets coalescing (crash path)', async () => {
      const b = bench('minimal');
      b.queue.enqueueProgressUpdate(slow('a'), INSTANCE);
      await drain();
      b.queue.abortTurn();
      b.queue.enqueueProgressUpdate(slow('b'), INSTANCE);
      await drain();
      expect(b.calls).toHaveLength(2);
      b.queue.abortTurn();
    });
  });

  // ── 4. Mode matrix ───────────────────────────────────────────────────────
  describe('4. mode matrix', () => {
    for (const mode of ['minimal', 'friendly', 'full'] as const) {
      it(`${mode}: identical concurrent slow collapses to one`, async () => {
        const b = bench(mode);
        // Same elapsed → identical rendered text in every mode.
        for (const id of ['a', 'b', 'c']) b.queue.enqueueProgressUpdate(slow(id, 45_000), INSTANCE);
        await drain();
        expect(b.calls).toHaveLength(1);
        b.queue.abortTurn();
      });
    }
  });

  // ── 5. Failure modes ─────────────────────────────────────────────────────
  describe('5. failure modes', () => {
    it('pollPending gates progress to typing only — and does not pollute the dedupe map', async () => {
      const b = bench('minimal');
      b.queue.setPollPending(true);
      b.queue.enqueueProgressUpdate(slow('a'), INSTANCE);
      await drain();
      expect(b.calls).toHaveLength(0); // gated entirely while a poll is pending

      // Once the poll clears, an identical placeholder must still be deliverable —
      // the gated event must not have recorded a dedupe entry.
      b.queue.setPollPending(false);
      b.queue.enqueueProgressUpdate(slow('b'), INSTANCE);
      await drain();
      expect(b.calls).toEqual(['_Still working..._']);
      b.queue.abortTurn();
    });

    it('dedupe is recorded on enqueue, not on delivery (suppresses a duplicate even before the first is sent)', async () => {
      const b = bench('minimal');
      // First send never resolves — it is in-flight, not delivered.
      b.setSend(() => new Promise<{ waMessageId: string | null }>(() => {}));
      b.queue.enqueueProgressUpdate(slow('a'), INSTANCE);
      // Identical placeholder enqueued before the first one could ever land —
      // suppressed synchronously at enqueue (the dedupe entry is recorded there).
      b.queue.enqueueProgressUpdate(slow('b'), INSTANCE);
      // Let the drain chain reach messenger.sendMessage (it awaits the never-resolving
      // send forever, but the CALL happens on a microtask). The 1ms advance does not
      // reach the 15s SEND_TIMEOUT, so exactly one send is attempted.
      await vi.advanceTimersByTimeAsync(1);
      expect(b.sendCount()).toBe(1);
      b.queue.abortTurn();
    });

    it('abortTurn() mid-stream stops further progress output', async () => {
      const b = bench('minimal');
      b.queue.enqueueProgressUpdate(slow('a'), INSTANCE);
      b.queue.abortTurn();
      await drain();
      // The single enqueued chunk may or may not have flushed depending on timing,
      // but no NEW progress is produced after abort, and no timers leak.
      expect(b.calls.length).toBeLessThanOrEqual(1);
    });
  });

  // ── 6. Stress ────────────────────────────────────────────────────────────
  describe('6. stress', () => {
    it('a 50-tool parallel batch yields exactly one placeholder', async () => {
      const b = bench('minimal');
      for (let i = 0; i < 50; i++) b.queue.enqueueProgressUpdate(slow(`tool-${i}`), INSTANCE);
      await drain();
      expect(b.calls).toEqual(['_Still working..._']);
      b.queue.abortTurn();
    });

    it('50 distinct-elapsed placeholders are all delivered (no over-coalescing)', async () => {
      const b = bench('full');
      for (let i = 1; i <= 50; i++) b.queue.enqueueProgressUpdate(slow(`tool-${i}`, i * 1_000), INSTANCE);
      await drain(50);
      expect(b.calls).toHaveLength(50);
      b.queue.abortTurn();
    });

    it('100 sequential turns each emit exactly one placeholder (no cross-turn leak at scale)', async () => {
      const b = bench('minimal');
      for (let turn = 0; turn < 100; turn++) {
        for (const id of ['a', 'b', 'c']) b.queue.enqueueProgressUpdate(slow(`${turn}-${id}`), INSTANCE);
        await drain();
        await b.queue.flush(); // turn boundary
      }
      expect(b.calls).toHaveLength(100);
      expect(new Set(b.calls)).toEqual(new Set(['_Still working..._']));
      b.queue.abortTurn();
    });
  });
});
