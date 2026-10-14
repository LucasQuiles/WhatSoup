// src/runtimes/agent/planned-stop-drain.ts
//
// #3703: a planned stop (SIGTERM from a deploy or release activation) used to
// finalize a dispatched turn `failed / session_crash` at once and still report
// `shutdown complete`. The runtime now (1) gives dispatched turns a short,
// bounded drain so a reply that is about to land is delivered, and (2) reports
// every journaled turn the stop still had to fail, so the stop is not logged
// as clean. The drain is short on purpose: it must fit, together with the
// finalization deadline, inside main.ts's 10 s forced exit and the service
// manager's stop timeout. It does not replace a stop gate before the stop.

import { systemClock, type Clock } from '../../lib/clock.ts';
import type { IncomingMessage } from '../../core/types.ts';

/** Default bound on the planned-stop drain of dispatched turns. */
export const PLANNED_STOP_DRAIN_MS = 5_000;

const PLANNED_STOP_DRAIN_POLL_MS = 10;

/**
 * Typed, content-free failure: the stop finalized `lost` journaled turns
 * failed. Never carries JIDs, message ids or text.
 */
export class PlannedStopTurnLossError extends Error {
  readonly lost: number;

  constructor(lost: number) {
    super(`planned stop finalized ${lost} journaled turn(s) failed`);
    this.name = 'PlannedStopTurnLossError';
    this.lost = lost;
  }
}

/**
 * Content-free failure: the stop could not close runtime TurnQueues that no
 * reset/kill teardown owns, so their undispatched turns were not taken.
 */
export class PlannedStopQueueCloseError extends AggregateError {
  constructor(failures: ReadonlyArray<unknown>) {
    super(failures, `planned stop could not close ${failures.length} runtime turn queue(s)`);
    this.name = 'PlannedStopQueueCloseError';
  }
}

/** Wait until `busy()` is false or `deadlineAt` passes. Resolves `true` when drained. */
export async function waitForPlannedStopDrain(
  busy: () => boolean,
  deadlineAt: number,
  clock: Clock = systemClock,
): Promise<boolean> {
  while (busy()) {
    const remaining = deadlineAt - clock.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(PLANNED_STOP_DRAIN_POLL_MS, remaining));
      timer.unref?.();
    });
  }
  return true;
}

/**
 * #3703 / #3295 S3 admission boundary during a planned stop. Until the stop
 * closes intake (just before its message-handler drain), a journaled plain
 * text message that can become a durable deferred obligation runs through the
 * ordinary intake pipeline; its queue admission then hands it to the deferred
 * owner (cause `planned_stop`) instead of dispatching it. Everything else, and
 * everything after closure, is refused with RuntimeAdmissionClosedError, which
 * ingest records `failed / queue_closed`: an honest, distinct rejection.
 */
export function admitsPlannedStopIntake(input: {
  readonly intakeClosed: boolean;
  /** per_chat (not sandboxed), deferredTurnAdmission on, durability present. */
  readonly deferredOwner: boolean;
  readonly msg: Pick<IncomingMessage, 'inboundSeq' | 'contentType' | 'isSyntheticJob'>;
  /** classifyInput type: only plain messages (no local or forwarded commands). */
  readonly classification: string | undefined;
}): boolean {
  return !input.intakeClosed
    && input.deferredOwner
    && input.msg.inboundSeq !== undefined
    && input.msg.contentType === 'text'
    && input.msg.isSyntheticJob !== true
    && input.classification === 'message';
}
