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
 * - exhausted head-of-line blocks its conversation in per_chat mode, otherwise
 *   its scope, until an operator terminal closes it;
 * - bounded envelope (oversize refused, never truncated); error CLASSES only;
 * - content-free diagnostics projection;
 * - retention guard hook: non-terminal obligations are visible to retention.
 *
 * No runtime wiring in S1: the coordinator/supervisor slices (S2/S3) consume
 * this store behind the feature flag.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
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
  let databaseDirectory: string | null;

  beforeEach(() => {
    databaseDirectory = null;
    db = new Database(':memory:');
    db.open();
    store = new DeferredTurnStore(db);
  });

  afterEach(() => {
    db.close();
    if (databaseDirectory !== null) rmSync(databaseDirectory, { recursive: true });
  });

  function claim(token = 'claim-token-1', ttlSeconds = 300) {
    return store.claimNextEligible(SCOPE, { conversationKey: CONVERSATION_KEY, claimToken: token, ttlSeconds });
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
      const claimed = store.claimNextEligible(SCOPE, { conversationKey: CONVERSATION_KEY, claimToken: 'claim-short', ttlSeconds: -1 });
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

  describe('conversation-scoped claims', () => {
    const otherConversation = '15550100002';

    function claimOther(token = 'claim-other') {
      return store.claimNextEligible(SCOPE, {
        conversationKey: otherConversation,
        claimToken: token,
        ttlSeconds: 300,
      });
    }

    function useFileDatabase(): string {
      db.close();
      databaseDirectory = mkdtempSync(join(tmpdir(), 'deferred-reopen-'));
      const path = join(databaseDirectory, 'state.sqlite');
      db = new Database(path);
      db.open();
      store = new DeferredTurnStore(db);
      return path;
    }

    function reopen(path: string): void {
      db.close();
      db = new Database(path);
      db.open();
      store = new DeferredTurnStore(db);
    }

    it.each(['claimed', 'dispatched_commit', 'exhausted'] as const)(
      'a %s head holds its conversation while another conversation progresses FIFO',
      (headState) => {
        const first = store.enqueueDeferredObligation(enqueueInput(5));
        store.enqueueDeferredObligation(enqueueInput(7, { conversationKey: otherConversation, text: 'other first' }));
        store.enqueueDeferredObligation(enqueueInput(9));
        store.enqueueDeferredObligation(enqueueInput(11, { conversationKey: otherConversation, text: 'other second' }));

        const head = claim('head');
        expect(head?.inboundSeq).toBe(5);
        const fence = { claimToken: 'head', claimEpoch: head!.claimEpoch };
        if (headState === 'dispatched_commit') store.markDispatchCommit(first.id, fence);
        if (headState === 'exhausted') {
          store.requeueClaim(first.id, fence, 'provider_unavailable');
          for (let attempt = 1; attempt < DEFERRED_TURN_MAX_ATTEMPTS; attempt += 1) {
            const token = `exhaust-${attempt}`;
            const current = claim(token);
            expect(current?.id).toBe(first.id);
            store.requeueClaim(first.id, { claimToken: token, claimEpoch: current!.claimEpoch }, 'provider_unavailable');
          }
        }

        expect(claim('must-hold')).toBeNull();
        const other = claimOther();
        expect(other).toMatchObject({
          inboundSeq: 7,
          conversationKey: otherConversation,
          sourceMessageId: 'wamid-deferred-7',
          text: 'other first',
        });
        expect(claimOther('must-hold-other')).toBeNull();
        const otherFence = { claimToken: 'claim-other', claimEpoch: other!.claimEpoch };
        store.markDispatchCommit(other!.id, otherFence);
        store.terminalizeCompleted(other!.id, otherFence);
        expect(claimOther('other-second')).toMatchObject({ inboundSeq: 11, text: 'other second' });
        expect(claim('still-held')).toBeNull();
        store.terminalizeByOperator(first.id, 'operator_resolved_manually');
        expect(claim('after-operator')?.inboundSeq).toBe(9);
      },
    );

    it.each([
      { name: 'missing', key: undefined },
      { name: 'empty', key: '' },
      { name: 'whitespace', key: '   ' },
      { name: 'oversized ASCII', key: 'a'.repeat(2049) },
      { name: 'oversized UTF-8', key: 'é'.repeat(1025) },
    ])('refuses a $name per-chat key without spending an attempt', ({ key }) => {
      const created = store.enqueueDeferredObligation(enqueueInput(51));
      expect(() => store.claimNextEligible(SCOPE, {
        conversationKey: key,
        claimToken: 'invalid-key',
        ttlSeconds: 300,
      })).toThrow(/conversation key/i);
      expect(store.listOpenObligations(SCOPE)).toEqual([
        { id: created.id, inboundSeq: 51, status: 'pending', attemptCount: 0 },
      ]);
    });

    it('cannot claim a source using a different conversation key', () => {
      store.enqueueDeferredObligation(enqueueInput(61));
      expect(claimOther()).toBeNull();
      expect(claim()?.attemptCount).toBe(1);
    });

    it('keeps non-per-chat FIFO scope-wide without requiring a conversation key', () => {
      const first = store.enqueueDeferredObligation(enqueueInput(71, { scope: 'global' }));
      store.enqueueDeferredObligation(enqueueInput(72, { scope: 'global', conversationKey: otherConversation }));
      const head = store.claimNextEligible('global', { claimToken: 'global-first', ttlSeconds: 300 });
      expect(head?.inboundSeq).toBe(71);
      expect(store.claimNextEligible('global', { conversationKey: otherConversation, claimToken: 'global-held', ttlSeconds: 300 })).toBeNull();
      store.terminalizeByOperator(first.id, 'operator_resolved_manually');
      expect(store.claimNextEligible('global', { claimToken: 'global-second', ttlSeconds: 300 })?.inboundSeq).toBe(72);
    });

    it('reclaims a pre-commit claim after SQLite reopen and rejects its previous fence', () => {
      const path = useFileDatabase();
      store.enqueueDeferredObligation(enqueueInput(81));
      const original = claim('before-reopen', -1)!;
      const oldFence = { claimToken: 'before-reopen', claimEpoch: original.claimEpoch };

      reopen(path);

      expect(store.expireStaleClaims(SCOPE)).toBe(1);
      const reclaimed = claim('after-reopen')!;
      expect(reclaimed).toMatchObject({ id: original.id, inboundSeq: 81, attemptCount: 2 });
      expect(reclaimed.claimEpoch).toBeGreaterThan(original.claimEpoch);
      expect(() => store.markDispatchCommit(original.id, oldFence)).toThrow(DeferredTurnClaimFenceError);
      expect(() => store.requeueClaim(original.id, oldFence, 'stale_owner')).toThrow(DeferredTurnClaimFenceError);
      expect(() => store.terminalizeCompleted(original.id, oldFence)).toThrow(DeferredTurnClaimFenceError);
      const newFence = { claimToken: 'after-reopen', claimEpoch: reclaimed.claimEpoch };
      store.markDispatchCommit(reclaimed.id, newFence);
      expect(() => store.markDispatchCommit(reclaimed.id, newFence)).toThrow(DeferredTurnClaimFenceError);
      expect(() => store.terminalizeCompleted(reclaimed.id, oldFence)).toThrow(DeferredTurnClaimFenceError);
      store.terminalizeCompleted(reclaimed.id, newFence);
      expect(store.listOpenObligations(SCOPE)).toEqual([]);
    });

    it('retains the post-commit replay veto and conversation hold after SQLite reopen', () => {
      const path = useFileDatabase();
      store.enqueueDeferredObligation(enqueueInput(91, { text: 'persisted envelope' }));
      store.enqueueDeferredObligation(enqueueInput(92, { conversationKey: otherConversation }));
      store.enqueueDeferredObligation(enqueueInput(93));
      const committed = claim('commit-before-reopen', -1)!;
      const fence = { claimToken: 'commit-before-reopen', claimEpoch: committed.claimEpoch };
      store.markDispatchCommit(committed.id, fence);

      reopen(path);

      expect(store.expireStaleClaims(SCOPE)).toBe(0);
      expect(() => store.requeueClaim(committed.id, fence, 'restart_retry')).toThrow(/dispatch.*commit|committed/i);
      expect(claim('must-not-replay')).toBeNull();
      expect(claimOther()).toMatchObject({ inboundSeq: 92, conversationKey: otherConversation });
      expect(db.raw.prepare('SELECT status, replay_text, source_message_id FROM deferred_turn_obligations WHERE id = ?').get(committed.id)).toMatchObject({
        status: 'dispatched_commit',
        replay_text: 'persisted envelope',
        source_message_id: 'wamid-deferred-91',
      });
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

  // #3295 S3: the drain's store surface and the restart ownership of an
  // obligation's source inbound, against real journaled inbound rows.
  describe('drain support (#3295 S3)', () => {
    let engine: DurabilityEngine;

    beforeEach(() => {
      engine = new DurabilityEngine(db);
    });

    function journal(id: string, conversationKey = CONVERSATION_KEY): number {
      return engine.journalInbound(id, conversationKey, DELIVERY_JID, 'agent');
    }

    function inboundStatus(seq: number): string {
      return (db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq) as {
        processing_status: string;
      }).processing_status;
    }

    function commitHead(token: string, conversationKey = CONVERSATION_KEY) {
      const claimed = store.claimNextEligible(SCOPE, { conversationKey, claimToken: token, ttlSeconds: 300 })!;
      const fence = { claimToken: token, claimEpoch: claimed.claimEpoch };
      store.markDispatchCommit(claimed.id, fence);
      return { claimed, fence };
    }

    it('lists exactly one head per conversation, the lowest open sequence', () => {
      const a1 = journal('wamid-h-a1');
      const b1 = journal('wamid-h-b1', '15550100002');
      const a2 = journal('wamid-h-a2');
      store.enqueueDeferredObligation(enqueueInput(a1));
      store.enqueueDeferredObligation(enqueueInput(b1, { conversationKey: '15550100002' }));
      store.enqueueDeferredObligation(enqueueInput(a2));

      expect(store.listOpenHeads(SCOPE).map((head) => [head.conversationKey, head.inboundSeq, head.status]))
        .toEqual([[CONVERSATION_KEY, a1, 'pending'], ['15550100002', b1, 'pending']]);

      // A committed head stays the head: it holds its queue, never skipped.
      commitHead('claim-h');
      expect(store.listOpenHeads(SCOPE).find((head) => head.conversationKey === CONVERSATION_KEY))
        .toMatchObject({ inboundSeq: a1, status: 'dispatched_commit' });
    });

    it('reports a source open only while it is open and has no terminal record', () => {
      const open = journal('wamid-src-open');
      const failed = journal('wamid-src-failed');
      engine.markInboundFailed(failed);
      expect(store.isSourceOpen(open)).toBe(true);
      expect(store.isSourceOpen(failed)).toBe(false);
      expect(store.isSourceOpen(999_999)).toBe(false);
    });

    it('settles a committed obligation only once its source is terminal, and never a pre-commit one', () => {
      const seq = journal('wamid-settle');
      store.enqueueDeferredObligation(enqueueInput(seq));
      const { claimed } = commitHead('claim-s');

      // Source still open: held, replay vetoed, nothing changes.
      expect(store.settleDispatchedObligation(claimed.id)).toBeNull();
      expect(store.listOpenObligations(SCOPE)).toEqual([
        expect.objectContaining({ id: claimed.id, status: 'dispatched_commit' }),
      ]);

      engine.completeInbound(seq, 'response_sent');
      expect(store.settleDispatchedObligation(claimed.id)).toBe('completed');
      expect(store.hasNonTerminalObligation(SCOPE, seq)).toBe(false);
      expect(store.settleDispatchedObligation(claimed.id)).toBeNull();

      // A failed source closes as source_failed; pending/claimed rows never settle.
      const failedSeq = journal('wamid-settle-failed');
      store.enqueueDeferredObligation(enqueueInput(failedSeq));
      const pendingSeq = journal('wamid-settle-pending');
      store.enqueueDeferredObligation(enqueueInput(pendingSeq));
      const committed = commitHead('claim-f');
      engine.markInboundFailed(failedSeq);
      engine.markInboundFailed(pendingSeq);
      expect(store.settleDispatchedObligation(committed.claimed.id)).toBe('source_failed');
      // A failed turn never closes as completed: it is quarantined with the honest reason.
      expect(db.raw.prepare('SELECT status, terminal_reason FROM deferred_turn_obligations WHERE id = ?')
        .get(committed.claimed.id)).toEqual({ status: 'terminal_quarantined', terminal_reason: 'source_failed' });
      const pendingId = store.listOpenObligations(SCOPE)[0]!.id;
      expect(store.settleDispatchedObligation(pendingId)).toBeNull();
      expect(store.listOpenObligations(SCOPE)).toEqual([
        expect.objectContaining({ id: pendingId, status: 'pending' }),
      ]);
    });

    it('crash recovery leaves a pre-commit owned inbound open and fails committed, exhausted and unowned ones', () => {
      const pending = journal('wamid-rc-pending');
      const claimedSeq = journal('wamid-rc-claimed', '15550100002');
      const committed = journal('wamid-rc-committed', '15550100003');
      const exhausted = journal('wamid-rc-exhausted', '15550100004');
      const unowned = journal('wamid-rc-unowned');
      store.enqueueDeferredObligation(enqueueInput(pending));
      store.enqueueDeferredObligation(enqueueInput(claimedSeq, { conversationKey: '15550100002' }));
      store.claimNextEligible(SCOPE, { conversationKey: '15550100002', claimToken: 'claim-rc', ttlSeconds: 300 });
      store.enqueueDeferredObligation(enqueueInput(committed, { conversationKey: '15550100003' }));
      commitHead('claim-rc-commit', '15550100003');
      store.enqueueDeferredObligation(enqueueInput(exhausted, { conversationKey: '15550100004' }));
      for (let attempt = 0; attempt < DEFERRED_TURN_MAX_ATTEMPTS; attempt += 1) {
        const token = `claim-rc-x${attempt}`;
        const row = store.claimNextEligible(SCOPE, { conversationKey: '15550100004', claimToken: token, ttlSeconds: 300 })!;
        store.requeueClaim(row.id, { claimToken: token, claimEpoch: row.claimEpoch }, 'dispatch_failed');
      }

      new DurabilityEngine(db).preConnectRecovery({ deferredTurnOwnerEnabled: true });

      expect(inboundStatus(pending)).toBe('processing');
      expect(inboundStatus(claimedSeq)).toBe('processing');
      expect(inboundStatus(committed)).toBe('failed');
      expect(inboundStatus(exhausted)).toBe('failed');
      expect(inboundStatus(unowned)).toBe('failed');
    });

    it('with the deferred owner disabled (flag off), crash recovery fails owned inbounds and closes every open obligation, committed ones included', () => {
      const pending = journal('wamid-off-pending');
      const claimedSeq = journal('wamid-off-claimed', '15550100002');
      const committed = journal('wamid-off-committed', '15550100003');
      store.enqueueDeferredObligation(enqueueInput(pending));
      store.enqueueDeferredObligation(enqueueInput(claimedSeq, { conversationKey: '15550100002' }));
      store.claimNextEligible(SCOPE, { conversationKey: '15550100002', claimToken: 'claim-off', ttlSeconds: 300 });
      store.enqueueDeferredObligation(enqueueInput(committed, { conversationKey: '15550100003' }));
      const { claimed: committedRow, fence: committedFence } = commitHead('claim-off-commit', '15550100003');

      // No argument: the owner is disabled, matching a runtime without the flag.
      new DurabilityEngine(db).preConnectRecovery();

      for (const seq of [pending, claimedSeq, committed]) expect(inboundStatus(seq)).toBe('failed');
      const rows = db.raw.prepare(
        'SELECT inbound_seq, status, terminal_reason FROM deferred_turn_obligations ORDER BY inbound_seq',
      ).all();
      expect(rows).toEqual([
        { inbound_seq: pending, status: 'terminal_quarantined', terminal_reason: 'owner_disabled' },
        { inbound_seq: claimedSeq, status: 'terminal_quarantined', terminal_reason: 'owner_disabled' },
        // Post-commit with no owner to settle it: closed quarantined (never left
        // dispatched_commit, never completed); being terminal, never replayed.
        { inbound_seq: committed, status: 'terminal_quarantined', terminal_reason: 'owner_disabled_after_commit' },
      ]);
      expect(store.hasNonTerminalObligation(SCOPE, committed)).toBe(false);
      expect(() => store.requeueClaim(committedRow.id, committedFence, 'replay_attempt')).toThrow();
      expect(store.settleDispatchedObligation(committedRow.id)).toBeNull();
    });

    it('with the deferred owner disabled, a committed obligation whose source already completed or failed before the restart closes quarantined, never completed', () => {
      const delivered = journal('wamid-off-delivered');
      const failedEarlier = journal('wamid-off-failed', '15550100002');
      store.enqueueDeferredObligation(enqueueInput(delivered));
      store.enqueueDeferredObligation(enqueueInput(failedEarlier, { conversationKey: '15550100002' }));
      commitHead('claim-off-delivered');
      commitHead('claim-off-failed', '15550100002');
      // The turns ran their course, but no owner settled the obligations before the stop.
      engine.completeInbound(delivered, 'response_sent');
      engine.markInboundFailed(failedEarlier);

      new DurabilityEngine(db).preConnectRecovery({ deferredTurnOwnerEnabled: false });

      expect(inboundStatus(delivered)).toBe('complete');
      expect(inboundStatus(failedEarlier)).toBe('failed');
      expect(db.raw.prepare(
        'SELECT inbound_seq, status, terminal_reason FROM deferred_turn_obligations ORDER BY inbound_seq',
      ).all()).toEqual([
        { inbound_seq: delivered, status: 'terminal_quarantined', terminal_reason: 'owner_disabled_after_commit' },
        { inbound_seq: failedEarlier, status: 'terminal_quarantined', terminal_reason: 'owner_disabled_after_commit' },
      ]);
    });

    it('with the deferred owner enabled, crash recovery closes no obligation (the drain owns them)', () => {
      const pending = journal('wamid-on-pending');
      const committed = journal('wamid-on-committed', '15550100003');
      store.enqueueDeferredObligation(enqueueInput(pending));
      store.enqueueDeferredObligation(enqueueInput(committed, { conversationKey: '15550100003' }));
      commitHead('claim-on-commit', '15550100003');

      new DurabilityEngine(db).preConnectRecovery({ deferredTurnOwnerEnabled: true });

      expect(inboundStatus(pending)).toBe('processing');
      expect(db.raw.prepare(
        'SELECT inbound_seq, status FROM deferred_turn_obligations ORDER BY inbound_seq',
      ).all()).toEqual([
        { inbound_seq: pending, status: 'pending' },
        { inbound_seq: committed, status: 'dispatched_commit' },
      ]);
    });

    it('reports an eligible older head only for the same conversation', () => {
      const head = journal('wamid-fifo-head');
      const later = journal('wamid-fifo-later');
      store.enqueueDeferredObligation(enqueueInput(head));
      expect(store.hasEligibleOpenHeadBefore(SCOPE, CONVERSATION_KEY, later)).toBe(true);
      expect(store.hasEligibleOpenHeadBefore(SCOPE, CONVERSATION_KEY, head)).toBe(false);
      expect(store.hasEligibleOpenHeadBefore(SCOPE, '15550100002', later)).toBe(false);
      // An exhausted head is not eligible: it cannot run, so it never holds live input.
      for (let attempt = 0; attempt < DEFERRED_TURN_MAX_ATTEMPTS; attempt += 1) {
        const token = `claim-fifo-x${attempt}`;
        const row = store.claimNextEligible(SCOPE, { conversationKey: CONVERSATION_KEY, claimToken: token, ttlSeconds: 300 })!;
        store.requeueClaim(row.id, { claimToken: token, claimEpoch: row.claimEpoch }, 'dispatch_failed');
      }
      expect(store.hasEligibleOpenHeadBefore(SCOPE, CONVERSATION_KEY, later)).toBe(false);
    });

    it('holds live input behind runnable work queued behind an exhausted head (no FIFO bypass)', () => {
      const head = journal('wamid-fifo-x-head');
      const behind = journal('wamid-fifo-x-behind');
      const live = journal('wamid-fifo-x-live');
      store.enqueueDeferredObligation(enqueueInput(head));
      store.enqueueDeferredObligation(enqueueInput(behind));
      for (let attempt = 0; attempt < DEFERRED_TURN_MAX_ATTEMPTS; attempt += 1) {
        const token = `claim-fifo-xh${attempt}`;
        const row = store.claimNextEligible(SCOPE, { conversationKey: CONVERSATION_KEY, claimToken: token, ttlSeconds: 300 })!;
        expect(row.inboundSeq).toBe(head);
        store.requeueClaim(row.id, { claimToken: token, claimEpoch: row.claimEpoch }, 'dispatch_failed');
      }
      // The exhausted head cannot run, but `behind` is older than the live input and can.
      expect(store.hasEligibleOpenHeadBefore(SCOPE, CONVERSATION_KEY, live)).toBe(true);
      expect(store.hasEligibleOpenHeadBefore(SCOPE, CONVERSATION_KEY, behind)).toBe(false);
    });

    it('closes an exhausted pending head without a fence and never a runnable or claimed row', () => {
      const exhausted = journal('wamid-exh-close');
      const runnable = journal('wamid-exh-runnable', '15550100002');
      store.enqueueDeferredObligation(enqueueInput(exhausted));
      store.enqueueDeferredObligation(enqueueInput(runnable, { conversationKey: '15550100002' }));
      for (let attempt = 0; attempt < DEFERRED_TURN_MAX_ATTEMPTS; attempt += 1) {
        const token = `claim-exh${attempt}`;
        const row = store.claimNextEligible(SCOPE, { conversationKey: CONVERSATION_KEY, claimToken: token, ttlSeconds: 300 })!;
        store.requeueClaim(row.id, { claimToken: token, claimEpoch: row.claimEpoch }, 'dispatch_failed');
      }
      const [exhaustedRow, runnableRow] = store.listOpenObligations(SCOPE);
      expect(store.terminalizeExhaustedHead(runnableRow!.id)).toBeNull();
      expect(store.terminalizeExhaustedHead(exhaustedRow!.id)).toEqual({
        inboundSeq: exhausted, sourceMessageId: `wamid-deferred-${exhausted}`, deliveryJid: DELIVERY_JID,
      });
      expect(store.listOpenObligations(SCOPE).map((o) => o.inboundSeq)).toEqual([runnable]);
    });

    it('renews only a live claim and restores a lapsed claim only to its original claimant', () => {
      const seq = journal('wamid-lease-store');
      store.enqueueDeferredObligation(enqueueInput(seq));
      const claimed = store.claimNextEligible(SCOPE, { conversationKey: CONVERSATION_KEY, claimToken: 'claim-lease', ttlSeconds: -1 })!;
      const fence = { claimToken: 'claim-lease', claimEpoch: claimed.claimEpoch };
      expect(store.renewClaim(claimed.id, { ...fence, claimToken: 'claim-other' }, 600)).toBe(false);
      expect(store.renewClaim(claimed.id, fence, 600)).toBe(true);
      expect(store.expireStaleClaims(SCOPE)).toBe(0);

      db.raw.prepare("UPDATE deferred_turn_obligations SET claim_expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(claimed.id);
      expect(store.expireStaleClaims(SCOPE)).toBe(1);
      // A swept claim is not renewed (renewal never revives it) ...
      expect(store.renewClaim(claimed.id, fence, 600)).toBe(false);
      // ... but its claimant may restore it while nobody re-claimed it.
      expect(store.restoreLapsedClaim(claimed.id, { ...fence, claimEpoch: fence.claimEpoch + 1 }, 600)).toBe(false);
      expect(store.restoreLapsedClaim(claimed.id, fence, 600)).toBe(true);
      expect(store.listOpenObligations(SCOPE)[0]).toMatchObject({ status: 'claimed', attemptCount: 1 });
      store.requeueClaim(claimed.id, fence, 'dispatch_failed');

      // Once another claimant took it, the old claimant cannot restore it.
      store.claimNextEligible(SCOPE, { conversationKey: CONVERSATION_KEY, claimToken: 'claim-next', ttlSeconds: 600 });
      expect(store.restoreLapsedClaim(claimed.id, fence, 600)).toBe(false);
    });
  });
});
