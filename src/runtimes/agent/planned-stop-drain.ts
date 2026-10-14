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
import { deferredTurnEnvelopeRefusal } from '../../core/deferred-turn-store.ts';

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
 * Typed, content-free failure: accepted messages the stop could not hand off
 * (the deferred store refuses their envelope) were left open, so startup
 * recovery gives each an operator catch-up owner. Not a clean stop. Never
 * carries JIDs, message ids or text.
 */
export class PlannedStopIntakeRetainedError extends Error {
  readonly retained: number;

  constructor(retained: number) {
    super(`planned stop left ${retained} accepted message(s) open for recovery catch-up`);
    this.name = 'PlannedStopIntakeRetainedError';
    this.retained = retained;
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

/** How `handleMessage` treats a message that arrives while a planned stop is running. */
export type PlannedStopIntakeDecision = 'admit' | 'closed' | 'unownable';

/**
 * #3703 / #3295 S3 admission boundary during a planned stop. Ingest stores and
 * journals a message (inboundSeq assigned) BEFORE the runtime sees it, so every
 * message reaching this check is already accepted.
 * - `admit`: until the stop closes intake (just before its message-handler
 *   drain), a journaled plain-text message whose replay envelope meets the
 *   deferred store's contract (replay-safe, text within the byte bound) runs
 *   the ordinary intake pipeline; its queue admission hands it to the deferred
 *   owner (cause `planned_stop`) instead of dispatching it.
 * - `unownable`: the same eligible message before closure, but the store would
 *   refuse its envelope. The runtime leaves the inbound open; startup recovery
 *   records it as an open operator catch-up (no replay), and the stop fails
 *   with PlannedStopIntakeRetainedError instead of reporting clean.
 * - `closed`: everything else, and everything after closure, is refused with
 *   RuntimeAdmissionClosedError, which ingest records `failed / queue_closed`.
 */
export function plannedStopIntakeDecision(input: {
  readonly intakeClosed: boolean;
  /** per_chat (not sandboxed), deferredTurnAdmission on, durability present. */
  readonly deferredOwner: boolean;
  readonly msg: Pick<IncomingMessage, 'inboundSeq' | 'contentType' | 'isSyntheticJob'>;
  /** classifyInput type: only plain messages (no local or forwarded commands). */
  readonly classification: string | undefined;
  /** The replay envelope the handoff would store (its text is the message text). */
  readonly replay: { readonly replaySafe: boolean; readonly text: string | null };
}): PlannedStopIntakeDecision {
  const eligible = !input.intakeClosed
    && input.deferredOwner
    && input.msg.inboundSeq !== undefined
    && input.msg.contentType === 'text'
    && input.msg.isSyntheticJob !== true
    && input.classification === 'message';
  if (!eligible) return 'closed';
  return input.replay.text !== null
    && deferredTurnEnvelopeRefusal({ replaySafe: input.replay.replaySafe, text: input.replay.text }) === null
    ? 'admit'
    : 'unownable';
}
