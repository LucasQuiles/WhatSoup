/**
 * Exact-binding falsifiers for the capability-obligation safety boundaries.
 *
 * Each test reproduces a probe that previously defeated a boundary and pins
 * the fail-closed behavior:
 *  - D6: a settlement receipt recorded for a DIFFERENT obligation, a stale
 *    claim epoch, a prior attempt, an error result, or a foreign contract
 *    version must never complete an obligation — at the store API AND at the
 *    raw-SQL trigger layer.
 *  - D7: a group obligation must not leave `waiting_approval` on the strength
 *    of an approval whose binding facts (release SHA, manifest digest,
 *    drain-run ID, attestation digest) do not match the live drain; raw SQL
 *    without an explicit consumed-approval reference must RAISE.
 *  - D5: an attestation whose skill version, resolver digest, dependency
 *    versions, probe version, or canary identity differ from the running
 *    consumer's binding must skip admission, never admit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findAdmissibleAttestation,
  recordCapabilityAttestation,
  type CapabilityAttestationBinding,
} from '../../src/core/capability-attestation.ts';
import { CapabilityObligationStore } from '../../src/core/capability-obligation-store.ts';
import { Database } from '../../src/core/database.ts';
import { withTransaction } from '../../src/core/db-tx.ts';

let db: Database;
let store: CapabilityObligationStore;

const INPUT_DIGEST = 'ab'.repeat(32);

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
  store = new CapabilityObligationStore(db);
});

afterEach(() => {
  db.close();
});

function seedObligation(over: Partial<Record<string, unknown>> = {}): number {
  let id = 0;
  withTransaction(db, () => {
    id = store.applyDecisionWithinCallerTransaction({
      auditEvent: { action: 'obligation.create', actorType: 'runtime', reasonCode: 'conclusive_no_effect' },
      obligation: {
        sourceInboundSeq: (over.sourceInboundSeq as number) ?? 3001,
        sourceMessageId: (over.sourceMessageId as string) ?? 'TESTMSG-BIND-1',
        conversationKey: 'conv-bind',
        deliveryJid: (over.deliveryJid as string) ?? 'test-dm-target@lid',
        senderJid: 'test-sender@s.whatsapp.net',
        senderName: 'Test Sender',
        isGroup: (over.isGroup as boolean) ?? false,
        groupName: (over.groupName as string | null) ?? null,
        scope: 'per_chat',
        originRecoveryJobId: null,
        replayText: 'https://youtu.be/abc',
        contentTypeHint: 'text',
        contractVersion: 'test-contract/1',
        requiredCapability: 'child_process_tools',
        capabilityParams: '{"skill":"watch"}',
        inputDigest: INPUT_DIGEST,
        sourceDigest: 'bb'.repeat(32),
        sourceToken: 'https://youtu.be/abc',
        retainedMedia: null,
        creationReason: 'typed_deferral_signal',
      },
    }).obligationId!;
  });
  return id;
}

function claimIt(id: number): { claimToken: string; claimEpoch: number; attemptCount: number } {
  const claim = store.claimObligation(id, { claimToken: `tok-${id}`, leaseSeconds: 300 });
  expect(claim.applied).toBe(true);
  if (!claim.applied) throw new Error('unreachable');
  return { claimToken: `tok-${id}`, claimEpoch: claim.claimEpoch, attemptCount: claim.attemptCount };
}

const stateOf = (id: number) =>
  (db.raw.prepare('SELECT state FROM capability_obligations WHERE id=?').get(id) as { state: string }).state;

describe('D6 falsifier — settlement receipts are obligation- and attempt-bound', () => {
  it('a receipt recorded for a DIFFERENT obligation cannot complete this one (store API)', () => {
    const victim = seedObligation();
    const other = seedObligation({ sourceInboundSeq: 3002, sourceMessageId: 'TESTMSG-BIND-2' });
    const victimFence = claimIt(victim);
    const otherFence = claimIt(other);
    const foreignReceipt = store.recordExecutionReceipt({
      obligationId: other,
      logicalTurnId: 'turn-other',
      toolUseId: 'tu-other',
      skillName: 'watch',
      contractVersion: 'test-contract/1',
      inputDigest: INPUT_DIGEST,
      mediaDigest: null,
      resultStatus: 'ok',
      outputEvidence: { ok: true },
      claimEpoch: otherFence.claimEpoch,
      attemptNumber: otherFence.attemptCount,
      sourceDigest: 'bb'.repeat(32),
    });

    const settled = store.settleCompleted(victim, victimFence, {
      executionReceiptId: foreignReceipt,
      completionProofId: 'wt-x',
    });
    expect(settled.applied).toBe(false);
    expect(stateOf(victim)).toBe('claimed');
  });

  it('a nonexistent receipt id cannot complete an obligation', () => {
    const id = seedObligation();
    const fence = claimIt(id);
    const settled = store.settleCompleted(id, fence, {
      executionReceiptId: 999_999,
      completionProofId: 'wt-x',
    });
    expect(settled.applied).toBe(false);
    expect(stateOf(id)).toBe('claimed');
  });

  it('a receipt from a PRIOR attempt/claim epoch cannot settle the current one', () => {
    const id = seedObligation();
    const first = claimIt(id);
    const staleReceipt = store.recordExecutionReceipt({
      obligationId: id,
      logicalTurnId: 'turn-1',
      toolUseId: 'tu-1',
      skillName: 'watch',
      contractVersion: 'test-contract/1',
      inputDigest: INPUT_DIGEST,
      mediaDigest: null,
      resultStatus: 'ok',
      outputEvidence: null,
      claimEpoch: first.claimEpoch,
      attemptNumber: first.attemptCount,
      sourceDigest: 'bb'.repeat(32),
    });
    const requeued = store.requeueObligation(id, first, { backoffSeconds: 0 });
    expect(requeued.applied).toBe(true);
    const second = claimIt(id);

    const settled = store.settleCompleted(id, second, {
      executionReceiptId: staleReceipt,
      completionProofId: 'wt-x',
    });
    expect(settled.applied).toBe(false);
    expect(stateOf(id)).toBe('claimed');
  });

  it('an error-status receipt cannot complete an obligation', () => {
    const id = seedObligation();
    const fence = claimIt(id);
    const errorReceipt = store.recordExecutionReceipt({
      obligationId: id,
      logicalTurnId: 'turn-1',
      toolUseId: 'tu-1',
      skillName: 'watch',
      contractVersion: 'test-contract/1',
      inputDigest: INPUT_DIGEST,
      mediaDigest: null,
      resultStatus: 'error',
      outputEvidence: null,
      claimEpoch: fence.claimEpoch,
      attemptNumber: fence.attemptCount,
      sourceDigest: 'bb'.repeat(32),
    });
    const settled = store.settleCompleted(id, fence, {
      executionReceiptId: errorReceipt,
      completionProofId: 'wt-x',
    });
    expect(settled.applied).toBe(false);
  });

  it('a receipt whose input digest does not match the obligation cannot complete it', () => {
    const id = seedObligation();
    const fence = claimIt(id);
    const mismatched = store.recordExecutionReceipt({
      obligationId: id,
      logicalTurnId: 'turn-1',
      toolUseId: 'tu-1',
      skillName: 'watch',
      contractVersion: 'test-contract/1',
      inputDigest: 'cd'.repeat(32),
      mediaDigest: null,
      resultStatus: 'ok',
      outputEvidence: null,
      claimEpoch: fence.claimEpoch,
      attemptNumber: fence.attemptCount,
      sourceDigest: 'bb'.repeat(32),
    });
    const settled = store.settleCompleted(id, fence, {
      executionReceiptId: mismatched,
      completionProofId: 'wt-x',
    });
    expect(settled.applied).toBe(false);
  });

  it('FALSIFIER: an unproven-delivery terminal (kind!=echoed / null op / arbitrary proof) cannot settle', () => {
    const id = seedObligation({ sourceInboundSeq: 3004, sourceMessageId: 'TESTMSG-BIND-4' });
    const fence = claimIt(id);
    const receiptId = store.recordExecutionReceipt({
      obligationId: id,
      logicalTurnId: 'turn-d',
      toolUseId: 'tu-d',
      skillName: 'watch',
      contractVersion: 'test-contract/1',
      inputDigest: INPUT_DIGEST,
      mediaDigest: null,
      resultStatus: 'ok',
      outputEvidence: null,
      claimEpoch: fence.claimEpoch,
      attemptNumber: fence.attemptCount,
      sourceDigest: 'bb'.repeat(32),
    });
    // The minted turn terminalized WITHOUT proven delivery.
    const seq = Number(
      db.raw
        .prepare(
          `INSERT INTO inbound_events (message_id, conversation_key, chat_jid, routed_to)
           VALUES (?, 'conv-bind', 'test-dm-target@lid', 'agent')`,
        )
        .run(`obl:${id}:${fence.attemptCount}`).lastInsertRowid,
    );
    db.raw
      .prepare(
        `INSERT INTO turn_terminal_records (
           scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
           logical_turn_id, manager_id, generation, attempt_kind,
           inbound_disposition, delivery_kind, delivery_op_id, reply_guarantee_disarmed
         ) VALUES ('per_chat', 'conv-bind', 'test-dm-target@lid', ?, ?, 'turn-d', 'mgr-1', 1,
                   'replied', 'failed_terminal', 'none', NULL, 0)`,
      )
      .run(seq, seq);
    const settled = store.settleCompleted(id, fence, {
      executionReceiptId: receiptId,
      completionProofId: 'arbitrary-non-null',
    });
    expect(settled.applied).toBe(false);
    expect(stateOf(id)).toBe('claimed');
  });

  it('raw SQL cannot complete with a cross-obligation receipt: the schema itself refuses', () => {
    const victim = seedObligation();
    const other = seedObligation({ sourceInboundSeq: 3003, sourceMessageId: 'TESTMSG-BIND-3' });
    claimIt(victim);
    const otherFence = claimIt(other);
    const foreignReceipt = store.recordExecutionReceipt({
      obligationId: other,
      logicalTurnId: 'turn-other',
      toolUseId: 'tu-other',
      skillName: 'watch',
      contractVersion: 'test-contract/1',
      inputDigest: INPUT_DIGEST,
      mediaDigest: null,
      resultStatus: 'ok',
      outputEvidence: null,
      claimEpoch: otherFence.claimEpoch,
      attemptNumber: otherFence.attemptCount,
      sourceDigest: 'bb'.repeat(32),
    });
    expect(() =>
      db.raw
        .prepare(
          `UPDATE capability_obligations
           SET state='completed', capability_execution_receipt_id=?, completion_proof_id=?
           WHERE id=?`,
        )
        .run(foreignReceipt, 'wt-x', victim),
    ).toThrow(/bound|receipt/i);
    expect(stateOf(victim)).toBe('claimed');
  });
});

describe('D7 falsifier — group drains need an exactly bound, live-matching approval', () => {
  const GROUP = { isGroup: true, groupName: 'Test Group Alpha', deliveryJid: 'test-group-alpha@g.us' };
  const LIVE = {
    destinationJid: 'test-group-alpha@g.us',
    releaseSha: 'rel-live-1',
    manifestDigest: 'md-live-1',
    drainRunId: 'drain-run-live-1',
    attestationDigest: 'att-digest-live-1',
  };

  function insertApproval(id: number, over: Partial<Record<string, string | null>> = {}): number {
    const result = db.raw
      .prepare(
        `INSERT INTO capability_drain_approvals
           (obligation_id, destination_jid, scope, release_sha, attestation_digest,
            manifest_digest, drain_run_id, approver, approved_at, expires_at)
         VALUES (?, ?, 'group', ?, ?, ?, ?, 'test-owner', datetime('now'), datetime('now', '+1 hour'))`,
      )
      .run(
        id,
        (over.destinationJid as string) ?? LIVE.destinationJid,
        (over.releaseSha as string) ?? LIVE.releaseSha,
        over.attestationDigest === undefined ? LIVE.attestationDigest : over.attestationDigest,
        (over.manifestDigest as string) ?? LIVE.manifestDigest,
        (over.drainRunId as string) ?? LIVE.drainRunId,
      );
    return Number(result.lastInsertRowid);
  }

  it('an approval with the right destination but WRONG binding facts does not unlock', () => {
    const id = seedObligation(GROUP);
    insertApproval(id, { releaseSha: 'rel-unrelated', manifestDigest: 'md-unrelated', drainRunId: 'drain-unrelated' });
    const consumed = store.consumeGroupDrainApproval(id, LIVE);
    expect(consumed.applied).toBe(false);
    expect(stateOf(id)).toBe('waiting_approval');
  });

  it('each mismatched live fact individually blocks consumption', () => {
    const id = seedObligation(GROUP);
    insertApproval(id);
    for (const wrong of [
      { ...LIVE, releaseSha: 'rel-other' },
      { ...LIVE, manifestDigest: 'md-other' },
      { ...LIVE, drainRunId: 'drain-other' },
      { ...LIVE, attestationDigest: 'att-other' },
      { ...LIVE, destinationJid: 'test-group-beta@g.us' },
    ]) {
      const consumed = store.consumeGroupDrainApproval(id, wrong);
      expect(consumed.applied).toBe(false);
    }
    expect(stateOf(id)).toBe('waiting_approval');
  });

  it('an exactly matching approval unlocks and records the consumed approval id', () => {
    const id = seedObligation(GROUP);
    const approvalId = insertApproval(id);
    const consumed = store.consumeGroupDrainApproval(id, LIVE);
    expect(consumed).toMatchObject({ applied: true, approvalId });
    expect(stateOf(id)).toBe('waiting_capability');
    const row = db.raw
      .prepare('SELECT drain_approval_id FROM capability_obligations WHERE id=?')
      .get(id) as { drain_approval_id: number };
    expect(row.drain_approval_id).toBe(approvalId);
  });

  it('raw SQL cannot leave waiting_approval without referencing a consumed approval', () => {
    const id = seedObligation(GROUP);
    insertApproval(id);
    expect(() =>
      db.raw.prepare("UPDATE capability_obligations SET state='waiting_capability' WHERE id=?").run(id),
    ).toThrow(/approval/i);
    expect(stateOf(id)).toBe('waiting_approval');
  });

  it('FALSIFIER (r13 F3): a group approval REVOKED after consumption can no longer be CLAIMED', () => {
    // The group_approval_gate trigger fires only on waiting_approval →
    // waiting_capability; the claim out of waiting_capability must re-validate the
    // approval, or a revoked approval still dispatches (the r13 High).
    const id = seedObligation(GROUP);
    const approvalId = insertApproval(id);
    expect(store.consumeGroupDrainApproval(id, LIVE).applied).toBe(true);
    expect(stateOf(id)).toBe('waiting_capability');
    // Revoke AFTER consumption — the obligation row is untouched (still parked).
    db.raw.prepare("UPDATE capability_drain_approvals SET revoked_at = datetime('now') WHERE id = ?").run(approvalId);
    const claim = store.claimObligation(id, { claimToken: 'tok-revoked', leaseSeconds: 300 });
    expect(claim.applied).toBe(false); // revoked approval is re-checked at claim time
    expect(stateOf(id)).toBe('waiting_capability'); // nothing dispatched
  });

  it('a group approval still valid at claim time claims normally (r13 F3 positive control)', () => {
    const id = seedObligation(GROUP);
    insertApproval(id);
    expect(store.consumeGroupDrainApproval(id, LIVE).applied).toBe(true);
    const claim = store.claimObligation(id, { claimToken: 'tok-ok', leaseSeconds: 300 });
    expect(claim.applied).toBe(true);
    expect(stateOf(id)).toBe('claimed');
  });

  it('a group approval row without an attestation digest is unrepresentable', () => {
    const id = seedObligation(GROUP);
    expect(() => insertApproval(id, { attestationDigest: null })).toThrow();
  });
});

describe('D5 falsifier — attestation admission matches EVERY recorded binding field', () => {
  const BINDING: CapabilityAttestationBinding = {
    hostId: 'test-host',
    runtimeUser: 'test-user',
    releaseSha: 'relsha-1',
    schemaVersion: 57,
    providerId: 'claude-cli',
    harnessType: 'persistent_session',
    contractVersion: 'test-contract/1',
    capability: 'child_process_tools',
    skillName: 'watch',
    skillVersion: '1.0.0',
    skillDigest: 'skill-digest-1',
    resolverDigest: 'resolver-digest-1',
    dependencyVersions: { 'dep-a': '1.2.3', 'dep-b': '4.5.6' },
    probeVersion: 'probe/1',
    canaryId: 'canary-1',
    mediaRoot: '/var/media-root',
  };

  function record(over: Partial<CapabilityAttestationBinding> = {}): void {
    recordCapabilityAttestation(db, {
      ...BINDING,
      ...over,
      canaryResult: 'pass',
      nonce: `n-${Math.random().toString(36).slice(2)}`,
      attestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
  }

  it('wrong resolver digest / dependency versions / probe version / canary id / skill version are binding mismatches', () => {
    for (const over of [
      { resolverDigest: 'resolver-digest-WRONG' },
      { dependencyVersions: { 'dep-a': '9.9.9', 'dep-b': '4.5.6' } },
      { probeVersion: 'probe/999' },
      { canaryId: 'canary-WRONG' },
      { skillVersion: '9.9.9' },
    ] satisfies Array<Partial<CapabilityAttestationBinding>>) {
      // The table is append-only; each record differs from BINDING in exactly
      // one field, so none may ever admit against the exact binding.
      record(over);
      const admission = findAdmissibleAttestation(db, BINDING);
      expect(admission).toEqual({ outcome: 'skip', reason: 'binding_mismatch' });
    }
  });

  it('dependency-version key ORDER does not defeat matching (canonical serialization)', () => {
    record({ dependencyVersions: { 'dep-b': '4.5.6', 'dep-a': '1.2.3' } });
    const admission = findAdmissibleAttestation(db, BINDING);
    expect(admission.outcome).toBe('admissible');
  });

  it('an exact match on all fields still admits', () => {
    record();
    const admission = findAdmissibleAttestation(db, BINDING);
    expect(admission.outcome).toBe('admissible');
  });
});
