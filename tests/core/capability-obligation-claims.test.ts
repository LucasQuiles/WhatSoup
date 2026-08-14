/**
 * D7 — single-flight claim/lease/fence primitives (capability-obligation replay).
 * At-most-one concurrent claim per obligation; claim token/epoch fence every
 * terminal write; lease expiry before provider acceptance requeues under bounded
 * policy; expiry/crash after acceptance quarantines (blocked_ambiguous). A
 * stale fence can never settle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordCapabilityAttestation } from '../../src/core/capability-attestation.ts';
import {
  CAPABILITY_OBLIGATION_MAX_ATTEMPTS,
  CapabilityObligationStore,
} from '../../src/core/capability-obligation-store.ts';
import { Database } from '../../src/core/database.ts';
import { withTransaction } from '../../src/core/db-tx.ts';

let db: Database;
let store: CapabilityObligationStore;
let attSeq = 0;

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
  store = new CapabilityObligationStore(db);
});

/**
 * Record a passing, unrevoked, unexpired attestation and return its id. r15 F4:
 * the claim now transactionally re-checks that the ADMITTED attestation is still
 * admissible, so every claim that must succeed supplies one. A claim that must be
 * refused for another reason (already-claimed, exhausted) still supplies a valid
 * attestation so the refusal is proven to come from THAT reason, not a missing one.
 */
function seedFreshAttestation(): number {
  return recordCapabilityAttestation(db, {
    hostId: 'h', runtimeUser: 'u', releaseSha: 'r', schemaVersion: 59,
    providerId: 'claude-cli', harnessType: 'persistent_session', contractVersion: 'c/1',
    capability: 'child_process_tools', skillName: 'watch', skillVersion: '1.0.0',
    skillDigest: 'sd', resolverDigest: 'rd', dependencyVersions: {}, probeVersion: 'p/1',
    canaryId: 'can', mediaRoot: '/var/media',
    canaryResult: 'pass', nonce: `att-${++attSeq}`,
    attestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
}

afterEach(() => {
  db.close();
});

// D6: settlement additionally requires the minted turn's terminal record to
// name the receipt's logical turn — seed both halves of that chain.
function seedMintedTurnTerminal(obligationId: number, attempt: number, logicalTurnId: string): number {
  const seq = Number(
    db.raw
      .prepare(
        `INSERT INTO inbound_events (message_id, conversation_key, chat_jid, routed_to)
         VALUES (?, 'conv-claims', 'test-dm-target@lid', 'agent')`,
      )
      .run(`obl:${obligationId}:${attempt}`).lastInsertRowid,
  );
  db.raw
    .prepare(
      `INSERT INTO turn_terminal_records (
         scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
         logical_turn_id, manager_id, generation, attempt_kind,
         inbound_disposition, delivery_kind, delivery_op_id, reply_guarantee_disarmed
       ) VALUES ('per_chat', 'conv-claims', 'test-dm-target@lid', ?, ?, ?, 'mgr-1', 1,
                 'replied', 'completed', 'echoed', 424242, 0)`,
    )
    .run(seq, seq, logicalTurnId);
  return Number(
    (db.raw.prepare('SELECT id FROM turn_terminal_records WHERE inbound_seq = ?').get(seq) as { id: number }).id,
  );
}

function seedObligation(over: Partial<Record<string, unknown>> = {}): number {
  let id = 0;
  withTransaction(db, () => {
    const outcome = store.applyDecisionWithinCallerTransaction({
      auditEvent: {
        action: 'obligation.create',
        actorType: 'runtime',
        reasonCode: 'conclusive_no_effect',
      },
      obligation: {
        sourceInboundSeq: (over.sourceInboundSeq as number) ?? 1001,
        sourceMessageId: (over.sourceMessageId as string) ?? 'TESTMSG-CLAIM-1',
        conversationKey: 'conv-claims',
        deliveryJid: 'test-dm-target@lid',
        senderJid: 'test-sender@s.whatsapp.net',
        senderName: 'Test Sender',
        isGroup: false,
        groupName: null,
        scope: 'per_chat',
        originRecoveryJobId: null,
        replayText: 'https://youtu.be/abc',
        contentTypeHint: 'text',
        contractVersion: 'test-instance/1',
        requiredCapability: 'child_process_tools',
        capabilityParams: '{"skill":"watch"}',
        inputDigest: 'aa'.repeat(32),
        sourceDigest: 'bb'.repeat(32),
        sourceToken: 'https://youtu.be/abc',
        retainedMedia: null,
        creationReason: 'harness_capability_gap',
      },
    });
    id = outcome.obligationId!;
  });
  return id;
}

describe('listDueObligations + claimObligation', () => {
  it('lists a waiting obligation and claims it single-flight', () => {
    const id = seedObligation();
    const due = store.listDueObligations(10);
    expect(due.map((d) => d.id)).toEqual([id]);

    const claim = store.claimObligation(id, { claimToken: 'tok-1', leaseSeconds: 300, admissionAttestationId: seedFreshAttestation() });
    expect(claim.applied).toBe(true);
    if (!claim.applied) return;
    expect(claim.claimEpoch).toBe(1);
    expect(claim.attemptCount).toBe(1);

    // Second concurrent claimant loses without side effects.
    const loser = store.claimObligation(id, { claimToken: 'tok-2', leaseSeconds: 300, admissionAttestationId: seedFreshAttestation() });
    expect(loser.applied).toBe(false);
    expect(store.listDueObligations(10)).toEqual([]);
  });

  it('does not list obligations whose next_attempt_at is in the future', () => {
    const id = seedObligation();
    const claim = store.claimObligation(id, { claimToken: 'tok-1', leaseSeconds: 300, admissionAttestationId: seedFreshAttestation() });
    expect(claim.applied).toBe(true);
    if (!claim.applied) return;
    store.requeueObligation(id, { claimToken: 'tok-1', claimEpoch: claim.claimEpoch }, { backoffSeconds: 3600 });
    expect(store.listDueObligations(10)).toEqual([]);
  });
});

describe('fenced settlement', () => {
  it('a stale fence cannot settle, requeue, or block', () => {
    const id = seedObligation();
    const claim = store.claimObligation(id, { claimToken: 'tok-1', leaseSeconds: 300, admissionAttestationId: seedFreshAttestation() });
    expect(claim.applied).toBe(true);
    if (!claim.applied) return;
    const stale = { claimToken: 'tok-STALE', claimEpoch: claim.claimEpoch };
    expect(store.requeueObligation(id, stale, { backoffSeconds: 1 }).applied).toBe(false);
    expect(store.blockObligation(id, stale, 'blocked_ambiguous', 'x').applied).toBe(false);
    expect(
      store.settleCompleted(id, stale, { executionReceiptId: 1, completionProofId: 'p' }).applied,
    ).toBe(false);
    // The live fence still works after stale attempts.
    const ok = store.blockObligation(
      id,
      { claimToken: 'tok-1', claimEpoch: claim.claimEpoch },
      'blocked_media',
      'hash-mismatch',
    );
    expect(ok.applied).toBe(true);
  });

  it('settleCompleted requires a real execution receipt row (schema proof gate)', () => {
    const id = seedObligation();
    const claim = store.claimObligation(id, { claimToken: 'tok-1', leaseSeconds: 300, admissionAttestationId: seedFreshAttestation() });
    expect(claim.applied).toBe(true);
    if (!claim.applied) return;
    const fence = { claimToken: 'tok-1', claimEpoch: claim.claimEpoch };
    const receiptId = store.recordExecutionReceipt({
      obligationId: id,
      logicalTurnId: 'turn-1',
      toolUseId: 'tu-1',
      skillName: 'watch',
      contractVersion: 'test-instance/1',
      inputDigest: 'aa'.repeat(32),
      mediaDigest: null,
      resultStatus: 'ok',
      outputEvidence: { resolver: 'qvideo', ok: true },
      claimEpoch: claim.claimEpoch,
      attemptNumber: claim.attemptCount,
      sourceDigest: 'bb'.repeat(32),
    });
    const terminalId = seedMintedTurnTerminal(id, claim.attemptCount, 'turn-1');
    const settled = store.settleCompleted(id, fence, {
      executionReceiptId: receiptId,
      completionProofId: `ttr:${terminalId}`,
    });
    expect(settled.applied).toBe(true);
    const row = db.raw
      .prepare('SELECT state, capability_execution_receipt_id, completion_proof_id FROM capability_obligations WHERE id=?')
      .get(id) as Record<string, unknown>;
    expect(row.state).toBe('completed');
    expect(row.capability_execution_receipt_id).toBe(receiptId);
    expect(row.completion_proof_id).toBe(`ttr:${terminalId}`);
  });
});

describe('bounded retry and exhaustion', () => {
  it('requeue increments nothing extra; re-claim increments attempts; exhaustion is terminal', () => {
    const id = seedObligation();
    for (let attempt = 1; attempt <= CAPABILITY_OBLIGATION_MAX_ATTEMPTS; attempt++) {
      const claim = store.claimObligation(id, { claimToken: `tok-${attempt}`, leaseSeconds: 300, admissionAttestationId: seedFreshAttestation() });
      expect(claim.applied, `claim ${attempt}`).toBe(true);
      if (!claim.applied) return;
      expect(claim.attemptCount).toBe(attempt);
      const requeue = store.requeueObligation(
        id,
        { claimToken: `tok-${attempt}`, claimEpoch: claim.claimEpoch },
        { backoffSeconds: 0 },
      );
      expect(requeue.applied).toBe(true);
      if (attempt === CAPABILITY_OBLIGATION_MAX_ATTEMPTS) {
        expect(requeue.exhausted).toBe(true);
      }
    }
    const state = (db.raw.prepare('SELECT state FROM capability_obligations WHERE id=?').get(id) as { state: string }).state;
    expect(state).toBe('exhausted');
    expect(store.claimObligation(id, { claimToken: 'tok-x', leaseSeconds: 1, admissionAttestationId: seedFreshAttestation() }).applied).toBe(false);
  });
});

describe('expired-lease reclaim (D7 crash windows)', () => {
  function expireLease(id: number): void {
    db.raw
      .prepare("UPDATE capability_obligations SET claim_expires_at = datetime('now', '-10 seconds') WHERE id=?")
      .run(id);
  }

  it('pre-acceptance expiry requeues; the stale worker cannot settle afterwards', () => {
    const id = seedObligation();
    const claim = store.claimObligation(id, { claimToken: 'tok-1', leaseSeconds: 300, admissionAttestationId: seedFreshAttestation() });
    expect(claim.applied).toBe(true);
    if (!claim.applied) return;
    expireLease(id);
    const reclaimed = store.reclaimExpiredClaims({ providerAcceptedIds: new Set() });
    expect(reclaimed.requeued).toEqual([id]);
    expect(reclaimed.quarantined).toEqual([]);
    // Stale worker's fence is dead.
    expect(
      store.settleCompleted(id, { claimToken: 'tok-1', claimEpoch: claim.claimEpoch }, {
        executionReceiptId: 1,
        completionProofId: 'p',
      }).applied,
    ).toBe(false);
  });

  it('post-acceptance expiry quarantines (blocked_ambiguous), never auto-requeues', () => {
    const id = seedObligation();
    const claim = store.claimObligation(id, { claimToken: 'tok-1', leaseSeconds: 300, admissionAttestationId: seedFreshAttestation() });
    expect(claim.applied).toBe(true);
    expireLease(id);
    const reclaimed = store.reclaimExpiredClaims({ providerAcceptedIds: new Set([id]) });
    expect(reclaimed.requeued).toEqual([]);
    expect(reclaimed.quarantined).toEqual([id]);
    const state = (db.raw.prepare('SELECT state FROM capability_obligations WHERE id=?').get(id) as { state: string }).state;
    expect(state).toBe('blocked_ambiguous');
  });

  it('live leases are never reclaimed', () => {
    const id = seedObligation();
    store.claimObligation(id, { claimToken: 'tok-1', leaseSeconds: 300, admissionAttestationId: seedFreshAttestation() });
    const reclaimed = store.reclaimExpiredClaims({ providerAcceptedIds: new Set() });
    expect(reclaimed).toEqual({ requeued: [], quarantined: [] });
  });
});
