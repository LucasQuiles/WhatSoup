/**
 * #3295 slice S1 — durable `deferred_by_recovery_scope` obligation store.
 *
 * A journaled follower blocked solely by active same-scope turn recovery must
 * gain a durable non-terminal owner instead of a terminal admission rejection.
 * S1 pins the store's contract against real SQLite:
 *
 * - one obligation per (scope, inbound_seq), idempotent enqueue;
 * - strict head-of-line FIFO claiming — never skip an earlier seq;
 * - fenced claim/requeue/terminalize mirroring turn-recovery-store semantics
 *   (claim token + epoch; stale fence refused);
 * - the requirement-4 veto boundary: once `dispatched_commit` is durably
 *   marked, requeue (automatic input replay) is permanently refused;
 * - exhausted head-of-line BLOCKS the scope (order preservation) until an
 *   operator terminal closes it;
 * - bounded envelope (oversize refused, never truncated); error CLASSES only;
 * - content-free diagnostics projection;
 * - retention guard hook: non-terminal obligations are visible to retention.
 *
 * No runtime wiring in S1: the coordinator/supervisor slices (S2/S3) consume
 * this store behind the feature flag.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../../src/core/database.ts';
import {
  DEFERRED_TURN_MAX_ATTEMPTS,
  DeferredTurnClaimFenceError,
  DeferredTurnStore,
  type DeferredTurnEnqueueInput,
} from '../../src/core/deferred-turn-store.ts';

const SCOPE = 'per_chat';
const CONVERSATION_KEY = '15550100001';
const DELIVERY_JID = '15550100001:7@s.whatsapp.net';

function enqueueInput(inboundSeq: number, overrides: Partial<DeferredTurnEnqueueInput> = {}): DeferredTurnEnqueueInput {
  return {
    scope: SCOPE,
    conversationKey: CONVERSATION_KEY,
    deliveryJid: DELIVERY_JID,
    inboundSeq,
    sourceMessageId: `wamid-deferred-${inboundSeq}`,
    receivedAtUnixSeconds: 1_750_000_000 + inboundSeq,
    replaySafe: true,
    senderJid: 'probe@s.whatsapp.net',
    senderName: 'Probe',
    text: `follower ${inboundSeq}`,
    isGroup: false,
    contentType: 'text',
    toolScopeKey: `${CONVERSATION_KEY}#scope`,
    ...overrides,
  };
}

describe('deferred turn obligations (#3295 S1)', () => {
  let db: Database;
  let store: DeferredTurnStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    store = new DeferredTurnStore(db);
  });

  afterEach(() => {
    db.close();
  });

  function claim(token = 'claim-token-1', ttlSeconds = 300) {
    return store.claimNextEligible(SCOPE, { claimToken: token, ttlSeconds });
  }

  describe('enqueue', () => {
    it('creates a pending obligation and dedupes per (scope, inbound_seq)', () => {
      const first = store.enqueueDeferredObligation(enqueueInput(11));
      expect(first.status).toBe('pending');
      expect(first.deduplicated).toBe(false);

      const again = store.enqueueDeferredObligation(enqueueInput(11));
      expect(again.id).toBe(first.id);
      expect(again.deduplicated).toBe(true);

      expect(store.countByStatus(SCOPE)).toEqual({ pending: 1 });
    });

    it('keeps distinct scopes independent', () => {
      store.enqueueDeferredObligation(enqueueInput(11));
      const other = store.enqueueDeferredObligation({
        ...enqueueInput(11),
        scope: 'global',
        conversationKey: 'global-key',
      });
      expect(other.deduplicated).toBe(false);
      expect(store.countByStatus(SCOPE)).toEqual({ pending: 1 });
      expect(store.countByStatus('global')).toEqual({ pending: 1 });
    });

    it('refuses an oversize replay text instead of truncating it', () => {
      const oversize = 'x'.repeat(256 * 1024 + 1);
      expect(() => store.enqueueDeferredObligation(enqueueInput(12, { text: oversize })))
        .toThrow(/replay text exceeds/i);
      expect(store.countByStatus(SCOPE)).toEqual({});
    });

    it('refuses a replay-unsafe envelope — the terminal path owns those turns', () => {
      expect(() => store.enqueueDeferredObligation(enqueueInput(13, { replaySafe: false })))
        .toThrow(/replay-unsafe/i);
    });
  });

  describe('strict FIFO claim', () => {
    it('claims the lowest pending sequence and refuses to skip the held head', () => {
      store.enqueueDeferredObligation(enqueueInput(5));
      store.enqueueDeferredObligation(enqueueInput(7));
      store.enqueueDeferredObligation(enqueueInput(9));

      const head = claim('claim-a');
      expect(head?.inboundSeq).toBe(5);

      // Head is claimed: a second claimer gets NOTHING — never seq 7.
      expect(claim('claim-b')).toBeNull();
    });

    it('an exhausted head blocks the scope until an operator closes it', () => {
      store.enqueueDeferredObligation(enqueueInput(5));
      store.enqueueDeferredObligation(enqueueInput(7));

      for (let attempt = 0; attempt < DEFERRED_TURN_MAX_ATTEMPTS; attempt += 1) {
        const claimed = claim(`claim-${attempt}`);
        expect(claimed?.inboundSeq).toBe(5);
        store.requeueClaim(claimed!.id, { claimToken: `claim-${attempt}`, claimEpoch: claimed!.claimEpoch }, 'provider_unavailable');
      }
      // Attempts exhausted: head not claimable, and FIFO refuses to skip it.
      expect(claim('claim-final')).toBeNull();
      expect(store.listOpenObligations(SCOPE).map((o) => o.status)).toEqual(['exhausted', 'pending']);

      store.terminalizeByOperator(
        store.listOpenObligations(SCOPE)[0]!.id,
        'operator_resolved_manually',
      );
      expect(claim('claim-after-operator')?.inboundSeq).toBe(7);
    });
  });

  describe('fencing', () => {
    it('refuses a requeue with a stale claim fence', () => {
      store.enqueueDeferredObligation(enqueueInput(21));
      const claimed = claim('claim-real');
      expect(claimed).not.toBeNull();

      expect(() => store.requeueClaim(claimed!.id, { claimToken: 'claim-wrong', claimEpoch: claimed!.claimEpoch }, 'boom_class'))
        .toThrow(DeferredTurnClaimFenceError);
      expect(() => store.requeueClaim(claimed!.id, { claimToken: 'claim-real', claimEpoch: claimed!.claimEpoch + 1 }, 'boom_class'))
        .toThrow(DeferredTurnClaimFenceError);

      store.requeueClaim(claimed!.id, { claimToken: 'claim-real', claimEpoch: claimed!.claimEpoch }, 'boom_class');
      expect(store.listOpenObligations(SCOPE)[0]!.status).toBe('pending');
    });

    it('a stale expired claim returns to pending via reclaim, preserving attempts', () => {
      store.enqueueDeferredObligation(enqueueInput(22));
      const claimed = store.claimNextEligible(SCOPE, { claimToken: 'claim-short', ttlSeconds: -1 });
      expect(claimed).not.toBeNull();

      const reclaimed = store.expireStaleClaims(SCOPE);
      expect(reclaimed).toBe(1);
      const row = store.listOpenObligations(SCOPE)[0]!;
      expect(row.status).toBe('pending');
      expect(row.attemptCount).toBe(1);

      // A live (unexpired) claim is never reclaimed.
      const again = claim('claim-live');
      expect(again).not.toBeNull();
      expect(store.expireStaleClaims(SCOPE)).toBe(0);
    });
  });

  describe('requirement-4 veto boundary', () => {
    it('permits requeue before dispatch commit and permanently refuses it after', () => {
      store.enqueueDeferredObligation(enqueueInput(31));
      const claimed = claim('claim-commit');
      const fence = { claimToken: 'claim-commit', claimEpoch: claimed!.claimEpoch };

      store.markDispatchCommit(claimed!.id, fence);
      expect(() => store.requeueClaim(claimed!.id, fence, 'late_regret'))
        .toThrow(/dispatch.*commit|committed/i);

      store.terminalizeCompleted(claimed!.id, fence);
      expect(store.countByStatus(SCOPE)).toEqual({ terminal_completed: 1 });
    });

    it('quarantines a claimed obligation whose envelope proves undispatchable', () => {
      store.enqueueDeferredObligation(enqueueInput(32));
      const claimed = claim('claim-q');
      const fence = { claimToken: 'claim-q', claimEpoch: claimed!.claimEpoch };
      store.terminalizeQuarantined(claimed!.id, fence, 'envelope_unsupported');
      expect(store.countByStatus(SCOPE)).toEqual({ terminal_quarantined: 1 });
      // Terminal rows never come back.
      expect(claim('claim-later')).toBeNull();
    });

    it('refuses terminal completion straight from pending', () => {
      const created = store.enqueueDeferredObligation(enqueueInput(33));
      expect(() => store.terminalizeCompleted(created.id, { claimToken: 'claim-x', claimEpoch: 1 }))
        .toThrow(DeferredTurnClaimFenceError);
    });
  });

  describe('privacy and diagnostics', () => {
    it('accepts only bounded error classes, never raw error text', () => {
      store.enqueueDeferredObligation(enqueueInput(41));
      const claimed = claim('claim-e');
      const fence = { claimToken: 'claim-e', claimEpoch: claimed!.claimEpoch };
      expect(() => store.requeueClaim(claimed!.id, fence, 'Error: connection reset by peer (raw stack trace)'))
        .toThrow(/error class/i);
      store.requeueClaim(claimed!.id, fence, 'provider_unavailable');
    });

    it('diagnostics projection is content-free', () => {
      store.enqueueDeferredObligation(enqueueInput(42, { text: 'SECRET message body', senderName: 'Secret Sender' }));
      const summary = JSON.stringify(store.summarizeForDiagnostics(SCOPE));
      expect(summary).not.toContain('SECRET');
      expect(summary).not.toContain('Secret Sender');
      expect(summary).not.toContain('probe@s.whatsapp.net');
      expect(summary).not.toContain(DELIVERY_JID);
      expect(summary).toContain('pending');
    });
  });

  describe('retention guard hook', () => {
    it('reports a non-terminal obligation for its inbound and clears on terminal', () => {
      store.enqueueDeferredObligation(enqueueInput(51));
      expect(store.hasNonTerminalObligation(SCOPE, 51)).toBe(true);

      const claimed = claim('claim-r');
      const fence = { claimToken: 'claim-r', claimEpoch: claimed!.claimEpoch };
      store.markDispatchCommit(claimed!.id, fence);
      expect(store.hasNonTerminalObligation(SCOPE, 51)).toBe(true);

      store.terminalizeCompleted(claimed!.id, fence);
      expect(store.hasNonTerminalObligation(SCOPE, 51)).toBe(false);
    });
  });
});
