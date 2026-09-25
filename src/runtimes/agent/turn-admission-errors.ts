// Typed pre-dispatch admission errors (#3374/#3295 family).
//
// WHY TYPED: the log sanitizer (src/lib/log-sanitizer.ts) deliberately reduces
// every Error to `{errorClass: constructor.name}` — message and stack never
// reach the journal. During the 2026-08-29 q DM-scope wedge every admission
// throw was a bare `new Error`, so two hours of rejections logged an
// undiscriminating `errorClass:"Error"` and the throw site could not be
// identified after the recovering restart destroyed the in-memory state.
// Subclassing is the zero-cost fix: the sanitizer already propagates the
// subclass name, so each admission gate becomes self-identifying in the
// existing `turn processor error — finalizing before queue advance` log line.

import type { RuntimeTurnContext } from './runtime-turn-context.ts';

/** beginRuntimeTurnEvidence: durable recovery outstanding for the scope. */
export class ScopeBlockedByDurableRecoveryError extends Error {
  constructor() {
    super('Runtime turn scope is blocked by outstanding durable recovery');
    this.name = 'ScopeBlockedByDurableRecoveryError';
  }
}

/** beginRuntimeTurnEvidence: RuntimeTurnSupervisor.canAccept refused the scope. */
export class ScopeBlockedByFinalizationRecoveryError extends Error {
  constructor() {
    super('Runtime turn scope is blocked by terminal-finalization recovery state');
    this.name = 'ScopeBlockedByFinalizationRecoveryError';
  }
}

/** beginPerChatRuntimeTurn: the per-chat context FIFO already holds an owner. */
export class PerChatTurnFifoOwnerConflictError extends Error {
  constructor(mapKey: string) {
    super(`Per-chat runtime turn context FIFO already has an active owner for "${mapKey}"`);
    this.name = 'PerChatTurnFifoOwnerConflictError';
  }
}

/**
 * Structured fields for the pre-dispatch rejection log — exactly the data the
 * 2026-08-29 forensics lacked: WHICH gate rejected (rejectionClass) and what
 * the FIFO head was at rejection time ('none' distinguishes an empty FIFO
 * from a stale squatting owner — the H3 discriminator). `fifoHead` is
 * per-chat-only; omit it for shared/singleton scopes (no per-chat FIFO).
 *
 * Journal survival note: the log sanitizer redacts phone/JID-shaped values,
 * so a per-chat `scope` may reach the journal partially masked. The fields
 * that survive intact — and are the forensic joins — are `inboundSeq`
 * (joins inbound_events) and `logicalTurnId` (UUID-based).
 */
export function admissionRejectionLogFields(
  scope: string,
  context: RuntimeTurnContext,
  error: unknown,
  fifoHead?: { turnId: string | undefined },
) {
  return {
    scope,
    inboundSeq: context.identity.inboundSeq,
    logicalTurnId: context.identity.logicalTurnId,
    rejectionClass: error instanceof Error ? error.constructor.name : 'non-error',
    ...(fifoHead === undefined ? {} : { fifoHeadTurnId: fifoHead.turnId ?? 'none' }),
  };
}
