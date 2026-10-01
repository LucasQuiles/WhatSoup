// src/runtimes/agent/runtime-queued-receipt.ts
//
// #2949 first slice (owner decision 63, 2026-09-25): a truthful "queued behind
// the current task" receipt. It is the queue-honesty half only; it steers
// nothing and changes no turn ordering.
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
// `teardown.pending` as operator-cancelled), so the receipt says exactly that.
// The text is a constant: it never echoes the queued message's content.
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

const log = createChildLogger('runtime-queued-receipt');

export const QUEUED_TURN_RECEIPT_TEXT =
  '*Queued behind the current task.* Send /stop to cancel the running task and everything queued behind it.';

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
  readonly queue: Pick<TurnQueue, 'activeTurn'> | undefined;
  readonly turn: QueuedTurn;
  /** The boolean the enqueue returned. */
  readonly admitted: boolean;
}

export interface QueuedTurnReceiptNotifierOpts {
  readonly enabled: () => boolean;
  /** Out-of-band send. Must not route through the active turn's outbound queue. */
  readonly send: (chatJid: string, text: string) => Promise<void>;
  /** Time source for the cooldown; defaults to the system clock. */
  readonly clock?: Clock;
  readonly cooldownMs?: number;
}

export class QueuedTurnReceiptNotifier {
  private readonly lastSentAt = new Map<string, number>();
  private readonly enabled: () => boolean;
  private readonly send: (chatJid: string, text: string) => Promise<void>;
  private readonly clock: Clock;
  private readonly cooldownMs: number;

  constructor(opts: QueuedTurnReceiptNotifierOpts) {
    this.enabled = opts.enabled;
    this.send = opts.send;
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
      const { mapKey, turn } = admission;
      this.lastSentAt.set(mapKey, this.clock.now());
      this.pruneExpired();
      void this.send(turn.chatJid, QUEUED_TURN_RECEIPT_TEXT).catch((err: unknown) => {
        log.warn({ err, mapKey, inboundSeq: turn.inboundSeq }, 'queued-turn receipt send failed');
      });
      log.info({ mapKey, inboundSeq: turn.inboundSeq }, 'queued-turn receipt sent');
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
