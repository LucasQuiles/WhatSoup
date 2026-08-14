/**
 * Operator adjudication (inspect/cancel/adjudicate) over the REAL guarded state
 * machine. Cancel and requeue go through the same migration-58 transition
 * whitelist as the runtime — never raw SQL — so an illegal source state is
 * refused, and every action leaves an `operator` audit event. Real SQLite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordCapabilityAttestation } from '../../src/core/capability-attestation.ts';
import { CapabilityObligationStore } from '../../src/core/capability-obligation-store.ts';
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

afterEach(() => {
  db.close();
});

/** Record a passing, unrevoked, unexpired attestation (r15 F4: a claim now
 * transactionally re-checks the admitted attestation, so a claim that must reach
 * 'claimed' supplies one). */
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

function seed(over: { isGroup?: boolean; sourceInboundSeq?: number; sourceMessageId?: string } = {}): number {
  let id = 0;
  withTransaction(db, () => {
    id = store.applyDecisionWithinCallerTransaction({
      auditEvent: { action: 'obligation.create', actorType: 'runtime', reasonCode: 'conclusive_no_effect' },
      obligation: {
        sourceInboundSeq: over.sourceInboundSeq ?? 9001,
        sourceMessageId: over.sourceMessageId ?? 'TESTMSG-OP-1',
        conversationKey: 'conv-op',
        deliveryJid: over.isGroup ? 'test-group-op@g.us' : 'test-dm-op@lid',
        senderJid: 'test-sender@s.whatsapp.net',
        senderName: 'Test Sender',
        isGroup: over.isGroup ?? false,
        groupName: over.isGroup ? 'Op Group' : null,
        scope: 'per_chat',
        originRecoveryJobId: null,
        replayText: 'https://youtu.be/abc',
        contentTypeHint: 'text',
        contractVersion: 'test-contract/1',
        requiredCapability: 'child_process_tools',
        capabilityParams: '{"skill":"watch"}',
        inputDigest: 'aa'.repeat(32),
        sourceDigest: 'bb'.repeat(32),
        sourceToken: 'https://youtu.be/abc',
        retainedMedia: null,
        creationReason: 'harness_capability_gap',
      },
    }).obligationId!;
  });
  return id;
}

const stateOf = (id: number) =>
  (db.raw.prepare('SELECT state FROM capability_obligations WHERE id=?').get(id) as { state: string }).state;

/** Drive an obligation into blocked_ambiguous via the real claim→block path. */
function toBlockedAmbiguous(id: number): void {
  const claim = store.claimObligation(id, { claimToken: `tok-${id}`, leaseSeconds: 300, admissionAttestationId: seedFreshAttestation() });
  expect(claim.applied).toBe(true);
  if (!claim.applied) throw new Error('unreachable: claim.applied asserted true above'); // narrows the union for claimEpoch
  const blocked = store.blockObligation(
    id,
    { claimToken: `tok-${id}`, claimEpoch: claim.claimEpoch },
    'blocked_ambiguous',
    'ambiguous_settlement',
  );
  expect(blocked.applied).toBe(true);
  expect(stateOf(id)).toBe('blocked_ambiguous');
}

describe('operator cancel', () => {
  it('cancels a waiting_capability obligation and records an operator audit event', () => {
    const id = seed();
    const res = store.operatorAdjudicateObligation(id, { action: 'cancel', reasonCode: 'operator_retire', actorId: 'run-1' });
    expect(res).toMatchObject({ applied: true, currentState: 'cancelled', alreadyInTarget: false, refusedReason: null });
    expect(stateOf(id)).toBe('cancelled');
    const ev = db.raw
      .prepare("SELECT action, actor_type, actor_id FROM capability_obligation_events WHERE obligation_id=? ORDER BY id DESC LIMIT 1")
      .get(id) as { action: string; actor_type: string; actor_id: string };
    expect(ev).toEqual({ action: 'obligation.cancel', actor_type: 'operator', actor_id: 'run-1' });
  });

  it('cancels a blocked_ambiguous obligation', () => {
    const id = seed();
    toBlockedAmbiguous(id);
    expect(store.operatorAdjudicateObligation(id, { action: 'cancel', reasonCode: 'r', actorId: 'run-1' }).applied).toBe(true);
    expect(stateOf(id)).toBe('cancelled');
  });

  it('REFUSES cancelling a claimed (in-flight) obligation — never mutated mid-flight', () => {
    const id = seed();
    store.claimObligation(id, { claimToken: `tok-${id}`, leaseSeconds: 300, admissionAttestationId: seedFreshAttestation() });
    const res = store.operatorAdjudicateObligation(id, { action: 'cancel', reasonCode: 'r', actorId: 'run-1' });
    expect(res).toMatchObject({ applied: false, currentState: 'claimed', refusedReason: 'illegal_from_state' });
    expect(stateOf(id)).toBe('claimed');
  });

  it('is idempotent: cancelling an already-cancelled obligation is a no-op success', () => {
    const id = seed();
    store.operatorAdjudicateObligation(id, { action: 'cancel', reasonCode: 'r', actorId: 'run-1' });
    const again = store.operatorAdjudicateObligation(id, { action: 'cancel', reasonCode: 'r', actorId: 'run-1' });
    expect(again).toMatchObject({ applied: false, alreadyInTarget: true, currentState: 'cancelled' });
    // No second audit event was appended.
    const count = (db.raw
      .prepare("SELECT COUNT(*) AS c FROM capability_obligation_events WHERE obligation_id=? AND action='obligation.cancel'")
      .get(id) as { c: number }).c;
    expect(count).toBe(1);
  });

  it('REFUSES on a precondition (expectedState) mismatch and does not mutate', () => {
    const id = seed(); // waiting_capability
    const res = store.operatorAdjudicateObligation(id, {
      action: 'cancel',
      expectedState: 'blocked_ambiguous',
      reasonCode: 'r',
      actorId: 'run-1',
    });
    expect(res).toMatchObject({ applied: false, currentState: 'waiting_capability', refusedReason: 'precondition_mismatch' });
    expect(stateOf(id)).toBe('waiting_capability');
  });

  it('reports not_found for an unknown id', () => {
    expect(store.operatorAdjudicateObligation(999999, { action: 'cancel', reasonCode: 'r', actorId: 'run-1' })).toMatchObject({
      applied: false,
      currentState: null,
      refusedReason: 'not_found',
    });
  });
});

describe('operator requeue (adjudicate)', () => {
  it('re-arms a blocked_ambiguous obligation to waiting_capability with a re_arm event', () => {
    const id = seed();
    toBlockedAmbiguous(id);
    const res = store.operatorAdjudicateObligation(id, { action: 'requeue', reasonCode: 'operator_retry', actorId: 'run-9' });
    expect(res).toMatchObject({ applied: true, currentState: 'waiting_capability' });
    expect(stateOf(id)).toBe('waiting_capability');
    const ev = db.raw
      .prepare("SELECT action, actor_type FROM capability_obligation_events WHERE obligation_id=? ORDER BY id DESC LIMIT 1")
      .get(id) as { action: string; actor_type: string };
    expect(ev).toEqual({ action: 'obligation.re_arm', actor_type: 'operator' });
  });

  it('a waiting_capability obligation is already at the requeue target (idempotent no-op)', () => {
    const id = seed();
    const res = store.operatorAdjudicateObligation(id, { action: 'requeue', reasonCode: 'r', actorId: 'run-9' });
    expect(res).toMatchObject({ applied: false, currentState: 'waiting_capability', alreadyInTarget: true });
  });

  it('REFUSES requeueing a claimed (in-flight) obligation', () => {
    const id = seed();
    store.claimObligation(id, { claimToken: `tok-${id}`, leaseSeconds: 300, admissionAttestationId: seedFreshAttestation() });
    const res = store.operatorAdjudicateObligation(id, { action: 'requeue', reasonCode: 'r', actorId: 'run-9' });
    expect(res).toMatchObject({ applied: false, currentState: 'claimed', refusedReason: 'illegal_from_state' });
    expect(stateOf(id)).toBe('claimed');
  });
});

describe('operator inspect / list', () => {
  it('inspect returns the obligation summary, its events, and receipts', () => {
    const id = seed();
    store.operatorAdjudicateObligation(id, { action: 'cancel', reasonCode: 'r', actorId: 'run-1' });
    const view = store.operatorInspectObligation(id);
    expect(view).not.toBeNull();
    expect(view!.obligation).toMatchObject({ id, state: 'cancelled', source_token: 'https://youtu.be/abc', required_capability: 'child_process_tools' });
    expect(view!.events.some((e) => e.action === 'obligation.create')).toBe(true);
    expect(view!.events.some((e) => e.action === 'obligation.cancel')).toBe(true);
    expect(Array.isArray(view!.receipts)).toBe(true);
  });

  it('inspect returns null for an unknown id', () => {
    expect(store.operatorInspectObligation(999999)).toBeNull();
  });

  it('list filters by state and honours the limit', () => {
    const a = seed({ sourceInboundSeq: 9101, sourceMessageId: 'M-A' });
    seed({ sourceInboundSeq: 9102, sourceMessageId: 'M-B' });
    store.operatorAdjudicateObligation(a, { action: 'cancel', reasonCode: 'r', actorId: 'run-1' });
    const cancelled = store.operatorListObligations({ state: 'cancelled', limit: 10 });
    expect(cancelled.map((r) => r.id)).toEqual([a]);
    const waiting = store.operatorListObligations({ state: 'waiting_capability', limit: 10 });
    expect(waiting).toHaveLength(1);
    expect(store.operatorListObligations({ limit: 1 })).toHaveLength(1);
  });
});
