/**
 * #3295 S3 — DeferredTurnDrain against a real SQLite store.
 *
 * The drain's own decisions, without a runtime: claim leases while a drained
 * turn waits in its chat queue, release after a lapsed claim (cancellation and
 * exhaustion are never swallowed into a replay), exhausted heads, and the
 * drain-owned terminal paths that must settle or retain the source inbound.
 * The coordinator and the chat queue are doubles that capture the dispatch the
 * drain hands over; the store, its fencing and the inbound journal are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { DEFERRED_TURN_MAX_ATTEMPTS } from '../../../src/core/deferred-turn-store.ts';
import {
  DeferredTurnDrain,
  type DeferredTurnDrainDeps,
} from '../../../src/runtimes/agent/deferred-turn-drain.ts';
import type {
  DeferredTurnDispatch,
  RuntimeTurnCoordinator,
} from '../../../src/runtimes/agent/runtime-turn-coordinator.ts';
import type { SessionManager } from '../../../src/runtimes/agent/session.ts';
import type { QueuedTurn } from '../../../src/runtimes/agent/turn-queue.ts';

const SCOPE = 'per_chat';
const CONVERSATION_KEY = '15550190977';
const DELIVERY_JID = '15550190977@s.whatsapp.net';

interface Handed {
  readonly turn: QueuedTurn;
  readonly dispatch: DeferredTurnDispatch;
}

describe('DeferredTurnDrain (#3295 S3)', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let drain: DeferredTurnDrain;
  let handed: Handed[];
  let createRuntimeTurnForDispatch: ReturnType<typeof vi.fn>;
  let enqueueTurn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    engine = new DurabilityEngine(db);
    handed = [];
    createRuntimeTurnForDispatch = vi.fn(() => ({ identity: { logicalTurnId: 'drained-turn' } }));
    enqueueTurn = vi.fn((_mapKey: string, turn: QueuedTurn, dispatch: DeferredTurnDispatch) => {
      handed.push({ turn, dispatch });
      return true;
    });
    const deps: DeferredTurnDrainDeps = {
      enabled: () => true,
      getDurability: () => engine,
      isShuttingDown: () => false,
      coordinator: { createRuntimeTurnForDispatch } as unknown as RuntimeTurnCoordinator,
      prepareTarget: () => ({ mapKey: CONVERSATION_KEY, session: {} as SessionManager }),
      requireSessionToolScopeKey: () => `${CONVERSATION_KEY}#scope`,
      enqueueTurn: enqueueTurn as unknown as DeferredTurnDrainDeps['enqueueTurn'],
      // Passes run only when a test asks (start's first pass, then kick).
      scanIntervalMs: 3_600_000,
    };
    drain = new DeferredTurnDrain(deps);
  });

  afterEach(() => {
    drain.stop();
    db.close();
    vi.restoreAllMocks();
  });

  /** A journaled inbound with a pending obligation, as a prior generation left it. */
  function seed(messageId: string, overrides: { contentType?: string; attemptCount?: number } = {}): number {
    const seq = engine.journalInbound(messageId, CONVERSATION_KEY, DELIVERY_JID, 'agent');
    engine.deferredTurns.enqueueDeferredObligation({
      scope: SCOPE,
      conversationKey: CONVERSATION_KEY,
      deliveryJid: DELIVERY_JID,
      inboundSeq: seq,
      sourceMessageId: messageId,
      receivedAtUnixSeconds: 1_760_000_000,
      replaySafe: true,
      senderJid: DELIVERY_JID,
      senderName: 'Test User',
      text: `question ${messageId}`,
      isGroup: false,
      contentType: overrides.contentType ?? 'text',
    });
    if (overrides.attemptCount !== undefined) {
      db.raw.prepare('UPDATE deferred_turn_obligations SET attempt_count = ? WHERE inbound_seq = ?')
        .run(overrides.attemptCount, seq);
    }
    return seq;
  }

  function row(seq: number) {
    return db.raw.prepare(
      `SELECT status, attempt_count, terminal_reason, claim_token,
              claim_expires_at > datetime('now') AS lease_live
       FROM deferred_turn_obligations WHERE inbound_seq = ?`,
    ).get(seq) as {
      status: string;
      attempt_count: number;
      terminal_reason: string | null;
      claim_token: string | null;
      lease_live: number | null;
    };
  }

  function inbound(seq: number) {
    return db.raw.prepare('SELECT processing_status, failure_class FROM inbound_events WHERE seq = ?').get(seq) as {
      processing_status: string;
      failure_class: string | null;
    };
  }

  /** The claim TTL elapsed while the turn waited (10 min in production). */
  function lapseClaim(seq: number): void {
    db.raw.prepare(
      "UPDATE deferred_turn_obligations SET claim_expires_at = datetime('now', '-1 seconds') WHERE inbound_seq = ?",
    ).run(seq);
  }

  /** Another drain's expiry sweep (e.g. a second process) resets the lapsed claim. */
  function foreignExpirySweep(): number {
    return new DurabilityEngine(db).deferredTurns.expireStaleClaims(SCOPE);
  }

  async function firstHandOff(): Promise<Handed> {
    drain.start();
    await vi.waitFor(() => expect(handed).toHaveLength(1));
    return handed[0]!;
  }

  // ─── Finding 3: claim lease, lapsed claims, exhaustion, FIFO ───

  it('a drained turn that waits in its chat queue longer than the claim TTL keeps its claim, and the chat still holds live input behind it', async () => {
    const seq = seed('wamid-lease', { attemptCount: DEFERRED_TURN_MAX_ATTEMPTS - 1 });
    await firstHandOff();
    expect(row(seq)).toMatchObject({ status: 'claimed', attempt_count: DEFERRED_TURN_MAX_ATTEMPTS });

    lapseClaim(seq);
    drain.kick();

    // The pass renews the live claim before its expiry sweep: never reset to
    // pending (and, on its last attempt, never turned into an exhausted head).
    await vi.waitFor(() => expect(row(seq).lease_live).toBe(1));
    expect(row(seq)).toMatchObject({ status: 'claimed', attempt_count: DEFERRED_TURN_MAX_ATTEMPTS });
    const liveSeq = engine.journalInbound('wamid-lease-live', CONVERSATION_KEY, DELIVERY_JID, 'agent');
    expect(engine.deferredTurns.hasEligibleOpenHeadBefore(SCOPE, CONVERSATION_KEY, liveSeq)).toBe(true);
    expect(handed).toHaveLength(1);
  });

  it('an operator cancellation after the claim lapsed closes the obligation operator_cancelled; the text is never replayed', async () => {
    const seq = seed('wamid-cancel');
    const { dispatch } = await firstHandOff();
    lapseClaim(seq);
    expect(foreignExpirySweep()).toBe(1);

    expect(dispatch.release('operator_cancelled')).toBe('terminal');
    expect(row(seq)).toMatchObject({ status: 'terminal_quarantined', terminal_reason: 'operator_cancelled' });

    drain.kick();
    await new Promise((resolve) => setImmediate(resolve));
    expect(handed).toHaveLength(1);
    expect(createRuntimeTurnForDispatch).toHaveBeenCalledTimes(1);
  });

  it('an operator cancellation wins over a claim another claimant took after the lapse', async () => {
    const seq = seed('wamid-cancel-reclaimed');
    const { dispatch } = await firstHandOff();
    lapseClaim(seq);
    foreignExpirySweep();
    const foreign = new DurabilityEngine(db).deferredTurns.claimNextEligible(SCOPE, {
      conversationKey: CONVERSATION_KEY, claimToken: 'foreign-claim', ttlSeconds: 600,
    });
    expect(foreign).not.toBeNull();

    expect(dispatch.release('operator_cancelled')).toBe('terminal');
    expect(row(seq)).toMatchObject({ status: 'terminal_quarantined', terminal_reason: 'operator_cancelled' });
    // The foreign claimant can no longer reach the provider boundary.
    expect(() => engine.deferredTurns.markDispatchCommit(foreign!.id, {
      claimToken: 'foreign-claim', claimEpoch: foreign!.claimEpoch,
    })).toThrow();
  });

  it('a release on the last attempt after the claim lapsed settles attempts_exhausted (terminal), never a pending exhausted head', async () => {
    const seq = seed('wamid-last', { attemptCount: DEFERRED_TURN_MAX_ATTEMPTS - 1 });
    const { dispatch } = await firstHandOff();
    lapseClaim(seq);
    foreignExpirySweep();

    expect(dispatch.release('pre_dispatch_error')).toBe('terminal');
    expect(row(seq)).toMatchObject({ status: 'terminal_quarantined', terminal_reason: 'attempts_exhausted' });
  });

  it('a release before the last attempt after the claim lapsed requeues with the attempt counted (recoverable, once)', async () => {
    const seq = seed('wamid-lapsed-requeue');
    const { dispatch } = await firstHandOff();
    lapseClaim(seq);
    foreignExpirySweep();

    expect(dispatch.release('pre_dispatch_error')).toBe('retained');
    expect(row(seq)).toMatchObject({ status: 'pending', attempt_count: 1, claim_token: null });
  });

  it('an exhausted head left by a dead claimant is closed, its open source failed, and the obligation behind it dispatches', async () => {
    const exhausted = seed('wamid-exhausted', { attemptCount: DEFERRED_TURN_MAX_ATTEMPTS });
    const next = seed('wamid-behind');

    drain.start();
    await vi.waitFor(() => expect(handed).toHaveLength(1));

    expect(row(exhausted)).toMatchObject({ status: 'terminal_quarantined', terminal_reason: 'attempts_exhausted' });
    expect(inbound(exhausted)).toEqual({ processing_status: 'failed', failure_class: 'pre_dispatch_error' });
    expect(handed[0]!.turn.inboundSeq).toBe(next);
    expect(row(next)).toMatchObject({ status: 'claimed', attempt_count: 1 });
  });

  // ─── Finding 4: drain-owned terminal paths settle or retain the source ───

  it('unsupported envelope: the obligation is quarantined and its open source failed honestly (never left processing, never completed)', async () => {
    const seq = seed('wamid-image', { contentType: 'image' });
    drain.start();
    await vi.waitFor(() => expect(row(seq).status).toBe('terminal_quarantined'));

    expect(row(seq).terminal_reason).toBe('unsupported_envelope');
    expect(inbound(seq)).toEqual({ processing_status: 'failed', failure_class: 'pre_dispatch_error' });
    expect(handed).toHaveLength(0);
  });

  it('context unavailable on the last attempt: the obligation closes attempts_exhausted and the drain fails the open source', async () => {
    const seq = seed('wamid-ctx', { attemptCount: DEFERRED_TURN_MAX_ATTEMPTS - 1 });
    createRuntimeTurnForDispatch.mockImplementation(() => {
      throw new Error('injected: no owned session');
    });
    drain.start();
    await vi.waitFor(() => expect(row(seq).status).toBe('terminal_quarantined'));

    expect(row(seq).terminal_reason).toBe('attempts_exhausted');
    expect(inbound(seq)).toEqual({ processing_status: 'failed', failure_class: 'pre_dispatch_error' });
  });

  it('enqueue failure on the last attempt: the obligation closes attempts_exhausted and the drain fails the open source', async () => {
    const seq = seed('wamid-enqueue', { attemptCount: DEFERRED_TURN_MAX_ATTEMPTS - 1 });
    enqueueTurn.mockImplementation(() => {
      throw new Error('injected: queue admission threw');
    });
    drain.start();
    await vi.waitFor(() => expect(row(seq).status).toBe('terminal_quarantined'));

    expect(row(seq).terminal_reason).toBe('attempts_exhausted');
    expect(inbound(seq)).toEqual({ processing_status: 'failed', failure_class: 'pre_dispatch_error' });
  });

  it('context unavailable before the last attempt retains the source with its obligation (requeued, source untouched)', async () => {
    const seq = seed('wamid-ctx-retry');
    createRuntimeTurnForDispatch.mockImplementationOnce(() => {
      throw new Error('injected: no owned session');
    });
    drain.start();
    await vi.waitFor(() => expect(row(seq)).toMatchObject({ status: 'pending', attempt_count: 1 }));
    expect(inbound(seq).processing_status).toBe('processing');
  });

  it('source not open: the obligation closes source_not_open and the source keeps the state its own owner wrote', async () => {
    const seq = seed('wamid-settled');
    engine.completeInbound(seq, 'response_sent');
    drain.start();
    await vi.waitFor(() => expect(row(seq).status).toBe('terminal_quarantined'));

    expect(row(seq).terminal_reason).toBe('source_not_open');
    expect(inbound(seq)).toEqual({ processing_status: 'complete', failure_class: null });
    expect(handed).toHaveLength(0);
  });
});
