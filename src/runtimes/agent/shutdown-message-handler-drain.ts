// src/runtimes/agent/shutdown-message-handler-drain.ts
//
// First slice of E20 (#3315): bound the message-handler join during
// AgentRuntime.shutdown(). The turn coordinator and the route-recycle
// lifecycle both honor one absolute shutdown deadline; the handler join sat
// between them as an unbounded `Promise.allSettled`, so a single handler that
// never settled kept shutdown pending until main.ts's hard kill.
//
// This helper races the join against the remaining budget. It does NOT abort
// the handlers (that is E20 proper) — it reports how many were still pending
// so shutdown can log one content-free receipt and move on.

import { systemClock, type Clock } from '../../lib/clock.ts';

/**
 * Typed, content-free failure the runtime records when the drain times out,
 * so the process-level shutdown policy (src/main-shutdown-policy.ts) can name
 * the cause and carry the blocker count into its exit receipt without parsing
 * message text. Never carries handler payloads, JIDs, or bodies.
 */
export class MessageHandlerDrainTimeoutError extends Error {
  readonly blockers: number;

  constructor(blockers: number) {
    super(`message handlers did not drain before the shutdown deadline (blockers=${blockers})`);
    this.name = 'MessageHandlerDrainTimeoutError';
    this.blockers = blockers;
  }
}

export interface MessageHandlerDrainResult {
  /** True when the deadline elapsed with at least one handler still pending. */
  readonly timedOut: boolean;
  /** Handlers still pending at the deadline (0 when the join completed). */
  readonly blockers: number;
  /** Every outcome when the join completed; empty when it timed out. */
  readonly settled: readonly PromiseSettledResult<void>[];
}

/**
 * Await every handler until all settle or `deadlineAt` (epoch ms, same clock
 * the shutdown deadline was computed with) passes — whichever comes first.
 *
 * Pending handlers are always given one microtask turn before a past deadline
 * is enforced, so a handler that is already resolved never counts as a
 * blocker merely because shutdown arrived late. No timer is armed for an
 * empty set.
 */
export async function drainMessageHandlersForShutdown(
  handlers: Iterable<Promise<void>>,
  deadlineAt: number,
  clock: Clock = systemClock,
): Promise<MessageHandlerDrainResult> {
  const tracked = [...handlers].map((handler) => {
    const entry = { handler, settled: false };
    void handler.then(
      () => { entry.settled = true; },
      () => { entry.settled = true; },
    );
    return entry;
  });
  if (tracked.length === 0) return { timedOut: false, blockers: 0, settled: [] };

  const DEADLINE = Symbol('message-handler-drain-deadline');
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      Promise.allSettled(tracked.map((entry) => entry.handler)),
      new Promise<typeof DEADLINE>((resolve) => {
        deadlineTimer = setTimeout(() => resolve(DEADLINE), Math.max(0, deadlineAt - clock.now()));
        deadlineTimer.unref?.();
      }),
    ]);
    if (outcome !== DEADLINE) return { timedOut: false, blockers: 0, settled: outcome };
  } finally {
    clearTimeout(deadlineTimer);
  }
  // Settlement callbacks registered above run before this continuation, so the
  // flags are current as of the deadline firing.
  const blockers = tracked.filter((entry) => !entry.settled).length;
  if (blockers === 0) {
    return { timedOut: false, blockers: 0, settled: await Promise.allSettled(tracked.map((entry) => entry.handler)) };
  }
  return { timedOut: true, blockers, settled: [] };
}
