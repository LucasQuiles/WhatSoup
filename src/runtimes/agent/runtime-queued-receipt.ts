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
// /stop cancels less. Two facts pick one of four constants:
// - Position. "your earlier request ... This message is next" only when the
//   running turn is the same sender's own request and this message is the only
//   one waiting, so nothing else can run before it (owner decision,
//   2026-11-09). Otherwise "an earlier request ... queued behind it": the
//   running turn may be another group member's or a scheduled job, or other
//   messages wait ahead of this one.
// - Venue. Only a DM receipt can have the /stop sentence. Its only reader is
//   the sender, and the command gate's own rule (commandGateDenies with the
//   /stop spec's gate) never refuses a per_chat DM. It still needs ingest to
//   pass a bare /stop: in a chat listed in pausedChats, ingest dispatches only
//   text that matches a pausedChatBypassPatterns entry, and /stop is not an
//   admin command. So the DM receipt asks ingest's own paused-chat rule
//   (pausedChatAdmission, src/core/paused-chat.ts) about the text "/stop",
//   and offers it only when that rule does not hold it. A group receipt
//   never has it: every member reads it, and no group can promise every
//   reader a working /stop. The gate refuses members who are not admins once
//   admins are configured; ingest drops blocked and unresolved-LID members,
//   and members who are not allowlisted under allowlisted_only; a
//   mention-only group drops a bare /stop; and some transports carry no
//   mention data, so no one wording fits every group. Without the sentence
//   the receipt names no one to ask, and a group receipt reads no
//   configuration.
// The /stop sentence does not promise the outcome: a permitted /stop can end
// uncertain or find a stop already in progress, and its reply says so. No
// text echoes the queued message's content.
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
import { pausedChatAdmission } from '../../core/paused-chat.ts';

const log = createChildLogger('runtime-queued-receipt');

/** The exact text the /stop sentence tells the reader to send. */
const STOP_COMMAND_TEXT = '/stop';

/** Own request, nothing else waiting, where the receipt offers no /stop
 *  (every group receipt). */
export const QUEUED_TURN_RECEIPT_NO_STOP_TEXT =
  '*Still working on your earlier request.* This message is next.';

/** Any other position, where the receipt offers no /stop (every group receipt). */
export const QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT =
  '*Still working on an earlier request.* This message is queued behind it.';

/** The one /stop sentence, so the two texts that offer /stop cannot drift apart. */
function stopSentence(request: 'the earlier request' | 'that request'): string {
  return `Send ${STOP_COMMAND_TEXT} to cancel ${request} and anything waiting; I'll reply with the outcome.`;
}

// The /stop texts extend the no-/stop texts, so both say the same status.
export const QUEUED_TURN_RECEIPT_TEXT =
  `${QUEUED_TURN_RECEIPT_NO_STOP_TEXT} ${stopSentence('the earlier request')}`;

export const QUEUED_TURN_RECEIPT_OTHER_TEXT =
  `${QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT} ${stopSentence('that request')}`;

/** Pick the receipt that is true for this admission (see WORDING above). */
export function queuedTurnReceiptText(
  active: Pick<QueuedTurn, 'senderJid' | 'purpose'>,
  queued: Pick<QueuedTurn, 'senderJid'>,
  pending: number,
  stopOffered: boolean,
): string {
  const ownRequest = active.senderJid === queued.senderJid && active.purpose !== 'scheduled-agent-job';
  if (ownRequest && pending <= 1) {
    return stopOffered ? QUEUED_TURN_RECEIPT_TEXT : QUEUED_TURN_RECEIPT_NO_STOP_TEXT;
  }
  return stopOffered ? QUEUED_TURN_RECEIPT_OTHER_TEXT : QUEUED_TURN_RECEIPT_OTHER_NO_STOP_TEXT;
}

/** Whether the receipt offers /stop to its readers (see WORDING above). */
function receiptOffersStop(
  scope: SessionScope,
  turn: Pick<QueuedTurn, 'isGroup' | 'conversationKey' | 'chatJid'>,
  adminCount: () => number,
): boolean {
  // Every group member reads a group receipt, and no group can promise every
  // reader a working /stop, so a group gets no offer before any config read.
  if (turn.isGroup) return false;
  const gateDenies = commandGateDenies(getCommandSpec('stop').gate, {
    sessionScope: scope,
    isGroup: turn.isGroup,
    // A getter, so a DM never reads the admin count, as in the command gate.
    get adminCount() { return adminCount(); },
    // A DM's only reader is the sender; in a per_chat DM the gate never asks.
    isAdmin: () => false,
  });
  if (gateDenies) return false;
  // Ingest's own paused-chat rule, asked about the exact text the sentence
  // names. turn.conversationKey is the key ingest journaled this chat's
  // message under, so both see the same chat. /stop is not an admin command,
  // so ingest's admin exemption never applies to it.
  return pausedChatAdmission(turn, STOP_COMMAND_TEXT) !== 'held';
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
  /** Configured admin count, the /stop gate's input (see WORDING above). A
   *  group receipt never reads it. */
  readonly adminCount: () => number;
  /** Time source for the cooldown; defaults to the system clock. */
  readonly clock?: Clock;
  readonly cooldownMs?: number;
}

export class QueuedTurnReceiptNotifier {
  private readonly lastSentAt = new Map<string, number>();
  private readonly enabled: () => boolean;
  private readonly send: (chatJid: string, text: string) => Promise<void>;
  private readonly adminCount: () => number;
  private readonly clock: Clock;
  private readonly cooldownMs: number;

  constructor(opts: QueuedTurnReceiptNotifierOpts) {
    this.enabled = opts.enabled;
    this.send = opts.send;
    this.adminCount = opts.adminCount;
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
      const stopOffered = receiptOffersStop(scope, turn, this.adminCount);
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
