// src/runtimes/agent/runtime-queued-receipt.ts
//
// #2949 first slice (owner decision 63, 2026-09-25): a truthful receipt for a
// message that queued behind a running task. It is the queue-honesty half only;
// it steers nothing and changes no turn ordering.
//
// WHERE IT FIRES. Only after a per_chat inbound was ADMITTED to its chat's
// runtime TurnQueue and did NOT become that queue's active turn. TurnQueue.drain
// sets `activeTurn` synchronously inside `enqueue` when the queue was idle, so
// `activeTurn !== turn` right after a successful enqueue means the turn is
// waiting in the pending FIFO behind a turn that is already running.
//
// WHY PER_CHAT ONLY. single scope awaits the provider turn inside the runtime
// turn chain, so a mid-task message (and a mid-task /stop) is not even handled
// until the task finishes; "send /stop" would be false there. shared scope
// serializes every chat on one global queue, so the task ahead may belong to a
// different chat and /stop there tears down that global turn. Neither scope
// gets a receipt.
//
// WORDING. A per_chat /stop terminalizes the active turn AND every pending turn
// in that chat's queue (terminalizePerChatTurnQueueForKill finalizes
// `teardown.pending` as operator-cancelled), so the receipt never promises that
// /stop cancels less. Three facts pick one of six constants:
// - Position. "your earlier request ... This message is next" only when the
//   running turn is the same sender's own request and this message is the only
//   one waiting, so nothing else can run before it (owner decision,
//   2026-11-09). Otherwise "an earlier request ... queued behind it": the
//   running turn may be another group member's or a scheduled job, or other
//   messages wait ahead of this one.
// - Audience. Every group member reads the receipt, so the /stop sentence
//   appears only where any reader may reach and run /stop. A per_chat DM
//   always gets it. A group gets it only when its sender policy is not
//   allowlisted_only (there a member who is not allowlisted is dropped at
//   ingest before any gate) and the command gate's own rule
//   (commandGateDenies with the /stop spec's gate) accepts a reader who is not
//   an admin, which holds exactly when no admin is configured. The receipt
//   never runs the admin check, and without the sentence it names no one to
//   ask.
// - Venue. A DM says "Send /stop". A group says "Mention me with /stop": a
//   group that is not on the group allowlist dispatches only a message that
//   mentions the bot, and ingest drops a bare /stop there with no reply.
// The /stop sentence does not promise the outcome: a permitted /stop can end
// uncertain, and its reply says so. No text echoes the queued message's
// content.
//
// RATE LIMIT. At most one receipt per chat per cooldown window, so a busy group
// is not spammed while one long task runs. The cooldown is consumed when the
// send is attempted, so a failing transport is not retried in a loop.

import { createChildLogger } from '../../logger.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
// Type-only, from the runtime ring (erased at load, so no import cycle);
// the composition-ring twin in instance-loader.ts is off-limits here.
import type { SessionScope } from './runtime.ts';
import type { QueuedTurn, TurnQueue } from './turn-queue.ts';
import { commandGateDenies, getCommandSpec } from './command-registry.ts';

const log = createChildLogger('runtime-queued-receipt');

/** Own request, nothing else waiting, where the receipt offers no /stop. */
export const QUEUED_TURN_RECEIPT_NO_STOP_TEXT =
  '*Still working on your earlier request.* This message is next.';

/** Any other position, where the receipt offers no /stop. */
export const QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT =
  '*Still working on an earlier request.* This message is queued behind it.';

/** One /stop sentence: how the venue sends /stop, then the tail every venue
 *  shares, so the DM and group texts cannot drift apart. */
function stopSentence(
  send: 'Send' | 'Mention me with',
  request: 'the earlier request' | 'that request',
): string {
  return `${send} /stop to cancel ${request} and anything waiting; I'll reply with the outcome.`;
}

// The /stop texts extend the no-/stop texts, so all of them say the same status.
export const QUEUED_TURN_RECEIPT_TEXT =
  `${QUEUED_TURN_RECEIPT_NO_STOP_TEXT} ${stopSentence('Send', 'the earlier request')}`;

export const QUEUED_TURN_RECEIPT_GROUP_TEXT =
  `${QUEUED_TURN_RECEIPT_NO_STOP_TEXT} ${stopSentence('Mention me with', 'the earlier request')}`;

export const QUEUED_TURN_RECEIPT_OTHER_TEXT =
  `${QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT} ${stopSentence('Send', 'that request')}`;

export const QUEUED_TURN_RECEIPT_OTHER_GROUP_TEXT =
  `${QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT} ${stopSentence('Mention me with', 'that request')}`;

/** Pick the receipt that is true for this admission (see WORDING above). */
export function queuedTurnReceiptText(
  active: Pick<QueuedTurn, 'senderJid' | 'purpose'>,
  queued: Pick<QueuedTurn, 'senderJid' | 'isGroup'>,
  pending: number,
  stopOffered: boolean,
): string {
  const ownRequest = active.senderJid === queued.senderJid && active.purpose !== 'scheduled-agent-job';
  if (ownRequest && pending <= 1) {
    if (!stopOffered) return QUEUED_TURN_RECEIPT_NO_STOP_TEXT;
    return queued.isGroup ? QUEUED_TURN_RECEIPT_GROUP_TEXT : QUEUED_TURN_RECEIPT_TEXT;
  }
  if (!stopOffered) return QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT;
  return queued.isGroup ? QUEUED_TURN_RECEIPT_OTHER_GROUP_TEXT : QUEUED_TURN_RECEIPT_OTHER_TEXT;
}

/** The configuration the /stop offer reads; each is read only when needed. */
interface QueuedTurnReceiptAudience {
  readonly adminCount: () => number;
  readonly groupSendersAllowlistedOnly: () => boolean;
}

/** Whether the receipt offers /stop to its readers (see WORDING above). */
function receiptOffersStop(
  scope: SessionScope,
  isGroup: boolean,
  audience: QueuedTurnReceiptAudience,
): boolean {
  // A member who is not allowlisted never reaches the gate (access-policy.ts).
  if (isGroup && audience.groupSendersAllowlistedOnly()) return false;
  return !commandGateDenies(getCommandSpec('stop').gate, {
    sessionScope: scope,
    isGroup,
    // A getter, so a DM never reads the admin count, as in the command gate.
    get adminCount() { return audience.adminCount(); },
    // Every group member reads the receipt, so it offers /stop only where any
    // member may run it; in a per_chat DM the gate never asks.
    isAdmin: () => false,
  });
}

export const DEFAULT_QUEUED_TURN_RECEIPT_COOLDOWN_MS = 60_000;

/** Above this many remembered chats, expired cooldown entries are pruned. */
const COOLDOWN_PRUNE_THRESHOLD = 256;

export type QueuedTurnReceiptDecision =
  | 'sent'
  | 'disabled'
  | 'scope_not_per_chat'
  | 'not_admitted'
  | 'started_immediately'
  | 'scheduled_job'
  | 'cooldown';

export interface QueuedTurnAdmission {
  readonly scope: SessionScope;
  readonly mapKey: string;
  /** The chat's runtime TurnQueue as it stands right after the enqueue call. */
  readonly queue: Pick<TurnQueue, 'activeTurn' | 'pending'> | undefined;
  readonly turn: QueuedTurn;
  /** The boolean the enqueue returned. */
  readonly admitted: boolean;
}

export interface QueuedTurnReceiptNotifierOpts {
  readonly enabled: () => boolean;
  /** Out-of-band send. Must not route through the active turn's outbound queue. */
  readonly send: (chatJid: string, text: string) => Promise<void>;
  /** Configured admin count, the /stop gate's input (see WORDING above). */
  readonly adminCount: () => number;
  /** Whether the group sender policy is allowlisted_only (see WORDING above). */
  readonly groupSendersAllowlistedOnly: () => boolean;
  /** Time source for the cooldown; defaults to the system clock. */
  readonly clock?: Clock;
  readonly cooldownMs?: number;
}

export class QueuedTurnReceiptNotifier {
  private readonly lastSentAt = new Map<string, number>();
  private readonly enabled: () => boolean;
  private readonly send: (chatJid: string, text: string) => Promise<void>;
  private readonly audience: QueuedTurnReceiptAudience;
  private readonly clock: Clock;
  private readonly cooldownMs: number;

  constructor(opts: QueuedTurnReceiptNotifierOpts) {
    this.enabled = opts.enabled;
    this.send = opts.send;
    this.audience = {
      adminCount: opts.adminCount,
      groupSendersAllowlistedOnly: opts.groupSendersAllowlistedOnly,
    };
    this.clock = opts.clock ?? systemClock;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_QUEUED_TURN_RECEIPT_COOLDOWN_MS;
  }

  /**
   * Decide, and when warranted send, the receipt for one admission. Never
   * throws: a receipt is advisory UX and must not fail the admission path.
   */
  noteAdmission(admission: QueuedTurnAdmission): QueuedTurnReceiptDecision {
    try {
      const decision = this.decide(admission);
      if (decision !== 'sent') return decision;
      const { scope, mapKey, turn, queue } = admission;
      const stopOffered = receiptOffersStop(scope, turn.isGroup, this.audience);
      // decide() returned 'sent' only with a non-null active turn other than this one.
      const text = queuedTurnReceiptText(queue!.activeTurn!, turn, queue!.pending, stopOffered);
      this.lastSentAt.set(mapKey, this.clock.now());
      this.pruneExpired();
      void this.send(turn.chatJid, text).catch((err: unknown) => {
        log.warn({ err, mapKey, inboundSeq: turn.inboundSeq }, 'queued-turn receipt send failed');
      });
      log.info({ mapKey, inboundSeq: turn.inboundSeq, stopOffered }, 'queued-turn receipt sent');
      return 'sent';
    } catch (err) {
      log.warn({ err, mapKey: admission.mapKey }, 'queued-turn receipt decision failed');
      return 'disabled';
    }
  }

  private decide(admission: QueuedTurnAdmission): QueuedTurnReceiptDecision {
    if (!this.enabled()) return 'disabled';
    if (admission.scope !== 'per_chat') return 'scope_not_per_chat';
    if (!admission.admitted) return 'not_admitted';
    const active = admission.queue?.activeTurn ?? null;
    if (active === null || active === admission.turn) return 'started_immediately';
    // A scheduled job has no human waiting on the chat for an answer.
    if (admission.turn.purpose === 'scheduled-agent-job') return 'scheduled_job';
    const last = this.lastSentAt.get(admission.mapKey);
    if (last !== undefined && this.clock.now() - last < this.cooldownMs) return 'cooldown';
    return 'sent';
  }

  private pruneExpired(): void {
    if (this.lastSentAt.size <= COOLDOWN_PRUNE_THRESHOLD) return;
    const now = this.clock.now();
    for (const [key, at] of this.lastSentAt) {
      if (now - at >= this.cooldownMs) this.lastSentAt.delete(key);
    }
  }
}
