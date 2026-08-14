/**
 * D4/D7 — capability-obligation store branch probes (capability-obligation
 * replay). Covers the store arms the claims/C3 suites leave dark: every
 * validateCapabilityDecisionParams guard, nullable audit/due-row projections,
 * the group-drain approval refusal matrix, and the four lost-CAS fences
 * (operator re-arm, settle, atomic record+consume, consume). The schema
 * triggers are all RAISE(ABORT) — a trigger firing throws, it never silently
 * skips a row — so the CAS fences are exercised by injecting a WHITELISTED
 * concurrent state flip between a method's same-transaction read and its
 * fenced UPDATE, proving each fence refuses (or rolls back) instead of
 * settling on stale facts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordCapabilityAttestation } from '../../src/core/capability-attestation.ts';
import {
  CapabilityObligationStore,
  validateCapabilityDecisionParams,
  type CapabilityDecisionParams,
  type CapabilityObligationEventAction,
  type CapabilityObligationInsertParams,
} from '../../src/core/capability-obligation-store.ts';
import { Database } from '../../src/core/database.ts';
import { withTransaction } from '../../src/core/db-tx.ts';

let db: Database;
let store: CapabilityObligationStore;
let attSeq = 0;
let oblSeq = 0;

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
  store = new CapabilityObligationStore(db);
});

afterEach(() => {
  db.close();
});

function obligationParams(
  over: Partial<CapabilityObligationInsertParams> = {},
): CapabilityObligationInsertParams {
  oblSeq += 1;
  return {
    sourceInboundSeq: 2000 + oblSeq,
    sourceMessageId: `TESTMSG-STORE-${oblSeq}`,
    conversationKey: 'conv-store',
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
    creationReason: 'typed_deferral_signal',
    ...over,
  };
}

function createDecision(
  over: Partial<CapabilityObligationInsertParams> = {},
): CapabilityDecisionParams {
  return {
    auditEvent: {
      action: 'obligation.create',
      actorType: 'runtime',
      reasonCode: 'conclusive_no_effect',
    },
    obligation: obligationParams(over),
  };
}

function seedObligation(over: Partial<CapabilityObligationInsertParams> = {}): number {
  let id = 0;
  withTransaction(db, () => {
    const outcome = store.applyDecisionWithinCallerTransaction(createDecision(over));
    id = outcome.obligationId!;
  });
  return id;
}

function seedGroupObligation(): number {
  return seedObligation({
    isGroup: true,
    groupName: 'Test Group',
    deliveryJid: 'test-group-gamma@g.us',
  });
}

/** See capability-obligation-claims.test.ts — every claim that must succeed
 * supplies a passing, unrevoked, unexpired attestation (r15 F4). */
function seedFreshAttestation(): number {
  return recordCapabilityAttestation(db, {
    hostId: 'h', runtimeUser: 'u', releaseSha: 'r', schemaVersion: 58,
    providerId: 'claude-cli', harnessType: 'persistent_session', contractVersion: 'c/1',
    capability: 'child_process_tools', skillName: 'watch', skillVersion: '1.0.0',
    skillDigest: 'sd', resolverDigest: 'rd', dependencyVersions: {}, probeVersion: 'p/1',
    canaryId: 'can', mediaRoot: '/var/media',
    canaryResult: 'pass', nonce: `att-store-${++attSeq}`,
    attestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
}

// D6: settlement additionally requires the minted turn's terminal record to
// name the receipt's logical turn — seed both halves of that chain.
function seedMintedTurnTerminal(obligationId: number, attempt: number, logicalTurnId: string): number {
  const seq = Number(
    db.raw
      .prepare(
        `INSERT INTO inbound_events (message_id, conversation_key, chat_jid, routed_to)
         VALUES (?, 'conv-store', 'test-dm-target@lid', 'agent')`,
      )
      .run(`obl:${obligationId}:${attempt}`).lastInsertRowid,
  );
  db.raw
    .prepare(
      `INSERT INTO turn_terminal_records (
         scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
         logical_turn_id, manager_id, generation, attempt_kind,
         inbound_disposition, delivery_kind, delivery_op_id, reply_guarantee_disarmed
       ) VALUES ('per_chat', 'conv-store', 'test-dm-target@lid', ?, ?, ?, 'mgr-1', 1,
                 'replied', 'completed', 'echoed', 424242, 0)`,
    )
    .run(seq, seq, logicalTurnId);
  return Number(
    (db.raw.prepare('SELECT id FROM turn_terminal_records WHERE inbound_seq = ?').get(seq) as { id: number }).id,
  );
}

/**
 * Simulate a lost CAS: run `inject` immediately before the first statement
 * matching `pattern` executes inside `body`. The store's fenced UPDATEs
 * re-check state in their WHERE clause precisely because another writer can
 * win between the method's read and its write; injecting a whitelisted flip
 * at that point is the only way to reach those arms (all schema triggers
 * RAISE(ABORT) — they throw, they never silently skip the row). Transaction
 * control (BEGIN/COMMIT) is prepared once per Database and cached, so
 * patching `prepare` here cannot disturb it.
 */
function withRaceInjection<T>(pattern: RegExp, inject: () => void, body: () => T): T {
  const raw = db.raw;
  const realPrepare = raw.prepare.bind(raw);
  const patched = (sql: string): ReturnType<typeof realPrepare> => {
    const stmt = realPrepare(sql);
    if (!pattern.test(sql)) return stmt;
    return {
      get: (...args: unknown[]) => { inject(); return stmt.get(...(args as never[])); },
      run: (...args: unknown[]) => { inject(); return stmt.run(...(args as never[])); },
      all: (...args: unknown[]) => { inject(); return stmt.all(...(args as never[])); },
    } as unknown as ReturnType<typeof realPrepare>;
  };
  Object.defineProperty(raw, 'prepare', { value: patched, configurable: true, writable: true });
  try {
    return body();
  } finally {
    Reflect.deleteProperty(raw, 'prepare');
  }
}

const obligationState = (id: number): string =>
  (db.raw.prepare('SELECT state FROM capability_obligations WHERE id = ?').get(id) as { state: string }).state;

const approvalCount = (id: number): number =>
  (db.raw.prepare('SELECT COUNT(*) c FROM capability_drain_approvals WHERE obligation_id = ?').get(id) as { c: number }).c;

const eventCount = (id: number, action: string): number =>
  (db.raw
    .prepare('SELECT COUNT(*) c FROM capability_obligation_events WHERE obligation_id = ? AND action = ?')
    .get(id, action) as { c: number }).c;

const CANCEL_SQL = "UPDATE capability_obligations SET state = 'cancelled', updated_at = datetime('now') WHERE id = ?";

const DRAIN = {
  destinationJid: 'test-group-gamma@g.us',
  releaseSha: 'release-sha-1',
  manifestDigest: 'manifest-digest-1',
  drainRunId: 'drain-run-1',
  attestationDigest: 'attestation-digest-1',
} as const;

describe('validateCapabilityDecisionParams guards', () => {
  it('accepts a well-formed create decision (guards are attributable, not blanket)', () => {
    expect(() => validateCapabilityDecisionParams(createDecision())).not.toThrow();
  });

  it('rejects an action outside the typed action list', () => {
    const decision = createDecision();
    decision.auditEvent = {
      ...decision.auditEvent,
      action: 'obligation.destroy' as CapabilityObligationEventAction,
    };
    expect(() => validateCapabilityDecisionParams(decision)).toThrow(/unknown audit action/);
  });

  it('rejects a listed action that is neither create nor not_created', () => {
    expect(() =>
      validateCapabilityDecisionParams({
        auditEvent: { action: 'obligation.claim', actorType: 'supervisor' },
      }),
    ).toThrow(/must be create or not_created/);
  });

  it('rejects empty replay text', () => {
    expect(() => validateCapabilityDecisionParams(createDecision({ replayText: '' }))).toThrow(
      /non-empty replay text/,
    );
  });

  it('rejects a non-positive source inbound sequence', () => {
    expect(() => validateCapabilityDecisionParams(createDecision({ sourceInboundSeq: 0 }))).toThrow(
      /journaled source inbound sequence/,
    );
  });

  it('rejects a group obligation without a group name', () => {
    expect(() =>
      validateCapabilityDecisionParams(createDecision({ isGroup: true, groupName: null })),
    ).toThrow(/group requires a group name/);
  });

  it('rejects a malformed input digest', () => {
    expect(() => validateCapabilityDecisionParams(createDecision({ inputDigest: 'nope' }))).toThrow(
      /64-hex input digest/,
    );
  });

  it('rejects a malformed source digest', () => {
    expect(() => validateCapabilityDecisionParams(createDecision({ sourceDigest: 'nope' }))).toThrow(
      /64-hex source digest/,
    );
  });

  it('rejects retained media whose sha diverges from the source digest', () => {
    expect(() =>
      validateCapabilityDecisionParams(
        createDecision({
          sourceToken: null,
          retainedMedia: { path: '/var/media/x.jpg', sha256: 'cc'.repeat(32), bytes: 100, policyVersion: 'v1' },
        }),
      ),
    ).toThrow(/must equal the retained media digest/);
  });

  it('rejects carrying both retained media and a source token', () => {
    expect(() =>
      validateCapabilityDecisionParams(
        createDecision({
          retainedMedia: { path: '/var/media/x.jpg', sha256: 'bb'.repeat(32), bytes: 100, policyVersion: 'v1' },
        }),
      ),
    ).toThrow(/must not carry both/);
  });

  it('rejects the neither-source case (no media, no token)', () => {
    expect(() =>
      validateCapabilityDecisionParams(createDecision({ sourceToken: null, retainedMedia: null })),
    ).toThrow(/requires a source token/);
  });

  it('rejects non-JSON capability params', () => {
    expect(() =>
      validateCapabilityDecisionParams(createDecision({ capabilityParams: '{nope' })),
    ).toThrow(/canonical JSON/);
  });
});

describe('appendEventWithinCallerTransaction optional-field defaults', () => {
  it('persists NULLs for every omitted optional field', () => {
    const id = seedObligation();
    let eventId = 0;
    withTransaction(db, () => {
      eventId = store.appendEventWithinCallerTransaction(
        { action: 'obligation.dispatch', actorType: 'supervisor' },
        id,
      );
    });
    const row = db.raw
      .prepare(
        `SELECT obligation_id, action, actor_id, reason_code, source_hash, claim_epoch, detail
         FROM capability_obligation_events WHERE id = ?`,
      )
      .get(eventId) as Record<string, unknown>;
    expect(row).toEqual({
      obligation_id: id,
      action: 'obligation.dispatch',
      actor_id: null,
      reason_code: null,
      source_hash: null,
      claim_epoch: null,
      detail: null,
    });
  });
});

describe('listDueObligations nullable projections', () => {
  it('maps NULL sender name and content-type hint through to the due row', () => {
    const id = seedObligation({ senderName: null, contentTypeHint: null });
    const row = store.listDueObligations(10).find((d) => d.id === id);
    expect(row).toMatchObject({ id, senderName: null, contentTypeHint: null });
  });
});

describe('blockWaitingObligation CAS', () => {
  it('refuses to block a claimed obligation and appends no event', () => {
    const id = seedObligation();
    const claim = store.claimObligation(id, {
      claimToken: 'tok-1',
      leaseSeconds: 300,
      admissionAttestationId: seedFreshAttestation(),
    });
    expect(claim.applied).toBe(true);
    expect(store.blockWaitingObligation(id, 'media_hash_mismatch')).toEqual({ applied: false });
    expect(obligationState(id)).toBe('claimed');
    expect(eventCount(id, 'obligation.block')).toBe(0);
  });
});

describe('recordGroupDrainApproval refusal matrix', () => {
  it('refuses a nonexistent obligation', () => {
    expect(
      store.recordGroupDrainApproval({ obligationId: 999999, ...DRAIN, approver: 'op-test', validForSeconds: 3600 }),
    ).toEqual({ recorded: false, reason: 'not_a_waiting_group' });
  });

  it('refuses a non-group obligation even with the matching destination', () => {
    const id = seedObligation();
    expect(
      store.recordGroupDrainApproval({
        obligationId: id,
        ...DRAIN,
        destinationJid: 'test-dm-target@lid',
        approver: 'op-test',
        validForSeconds: 3600,
      }),
    ).toEqual({ recorded: false, reason: 'not_a_waiting_group' });
    expect(approvalCount(id)).toBe(0);
  });

  it('refuses a group obligation that already left waiting_approval', () => {
    const id = seedGroupObligation();
    const cancelled = store.operatorAdjudicateObligation(id, {
      action: 'cancel',
      reasonCode: 'ops_retire',
      actorId: 'op-test',
    });
    expect(cancelled.applied).toBe(true);
    expect(
      store.recordGroupDrainApproval({ obligationId: id, ...DRAIN, approver: 'op-test', validForSeconds: 3600 }),
    ).toEqual({ recorded: false, reason: 'not_a_waiting_group' });
  });

  it('refuses a destination that differs from the obligation delivery JID', () => {
    const id = seedGroupObligation();
    expect(
      store.recordGroupDrainApproval({
        obligationId: id,
        ...DRAIN,
        destinationJid: 'other-group@g.us',
        approver: 'op-test',
        validForSeconds: 3600,
      }),
    ).toEqual({ recorded: false, reason: 'destination_mismatch' });
    expect(approvalCount(id)).toBe(0);
  });

  it('records an approval for a waiting group without consuming it', () => {
    const id = seedGroupObligation();
    const result = store.recordGroupDrainApproval({
      obligationId: id,
      ...DRAIN,
      approver: 'op-test',
      validForSeconds: 3600,
    });
    expect(result.recorded).toBe(true);
    expect(result.approvalId).toBeTypeOf('number');
    const approval = db.raw
      .prepare('SELECT obligation_id, destination_jid, scope, attestation_digest FROM capability_drain_approvals WHERE id = ?')
      .get(result.approvalId!) as Record<string, unknown>;
    expect(approval).toEqual({
      obligation_id: id,
      destination_jid: DRAIN.destinationJid,
      scope: 'group',
      attestation_digest: DRAIN.attestationDigest,
    });
    expect(eventCount(id, 'approval.record')).toBe(1);
    // Recording alone must not arm the drain (the cold path consumes later).
    expect(obligationState(id)).toBe('waiting_approval');
  });
});

describe('recordAndConsumeGroupDrainApproval refusals', () => {
  it('refuses a destination mismatch before inserting anything', () => {
    const id = seedGroupObligation();
    expect(
      store.recordAndConsumeGroupDrainApproval({
        obligationId: id,
        ...DRAIN,
        destinationJid: 'other-group@g.us',
        approver: 'op-test',
        validForSeconds: 3600,
      }),
    ).toEqual({ ok: false, reason: 'destination_mismatch' });
    expect(approvalCount(id)).toBe(0);
    expect(obligationState(id)).toBe('waiting_approval');
  });
});

describe('lost-CAS fences (a concurrent winner between read and fenced write)', () => {
  it('operator requeue refuses when the obligation is cancelled under it', () => {
    const id = seedObligation();
    expect(store.blockWaitingObligation(id, 'media_hash_mismatch').applied).toBe(true);
    const cancelStmt = db.raw.prepare(CANCEL_SQL);
    const result = withRaceInjection(
      /next_attempt_at = datetime\('now'\), updated_at/,
      () => { cancelStmt.run(id); },
      () =>
        store.operatorAdjudicateObligation(id, {
          action: 'requeue',
          reasonCode: 'operator_requeue',
          actorId: 'op-test',
        }),
    );
    expect(result).toEqual({
      applied: false,
      wouldApply: false,
      currentState: 'blocked_media',
      alreadyInTarget: false,
      refusedReason: 'illegal_from_state',
    });
    // The concurrent cancel won; the operator wrote nothing on top of it.
    expect(obligationState(id)).toBe('cancelled');
    expect(eventCount(id, 'obligation.re_arm')).toBe(0);
  });

  it('settleCompleted refuses (without a binding-mismatch verdict) when the claim is quarantined under it', () => {
    const id = seedObligation();
    const claim = store.claimObligation(id, {
      claimToken: 'tok-1',
      leaseSeconds: 300,
      admissionAttestationId: seedFreshAttestation(),
    });
    expect(claim.applied).toBe(true);
    if (!claim.applied) return;
    const receiptId = store.recordExecutionReceipt({
      obligationId: id,
      logicalTurnId: 'turn-race',
      toolUseId: 'tu-race',
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
    const terminalId = seedMintedTurnTerminal(id, claim.attemptCount, 'turn-race');
    const quarantineStmt = db.raw.prepare(
      `UPDATE capability_obligations
       SET state = 'blocked_ambiguous', claim_token = NULL, claim_expires_at = NULL,
           updated_at = datetime('now')
       WHERE id = ?`,
    );
    const settled = withRaceInjection(
      /SET state = 'completed'/,
      () => { quarantineStmt.run(id); },
      () =>
        store.settleCompleted(
          id,
          { claimToken: 'tok-1', claimEpoch: claim.claimEpoch },
          { executionReceiptId: receiptId, completionProofId: `ttr:${terminalId}` },
        ),
    );
    // The receipt DID bind (no receipt_binding_mismatch); only the fenced
    // UPDATE lost — the distinct refusal shape distinguishes the two arms.
    expect(settled.applied).toBe(false);
    expect(settled.reason).toBeUndefined();
    expect(obligationState(id)).toBe('blocked_ambiguous');
    const row = db.raw
      .prepare('SELECT capability_execution_receipt_id, completion_proof_id FROM capability_obligations WHERE id = ?')
      .get(id) as Record<string, unknown>;
    expect(row).toEqual({ capability_execution_receipt_id: null, completion_proof_id: null });
    expect(eventCount(id, 'obligation.settle')).toBe(0);
  });

  it('recordAndConsumeGroupDrainApproval rolls back the approval when the consume loses the race', () => {
    const id = seedGroupObligation();
    const cancelStmt = db.raw.prepare(CANCEL_SQL);
    expect(() =>
      withRaceInjection(
        /SET state = 'waiting_capability', drain_approval_id = \?/,
        () => { cancelStmt.run(id); },
        () =>
          store.recordAndConsumeGroupDrainApproval({
            obligationId: id,
            ...DRAIN,
            approver: 'op-test',
            validForSeconds: 3600,
          }),
      ),
    ).toThrow(/consume did not apply within the atomic transaction/);
    // Fail-closed atomicity: the INSERTed approval, its audit event, AND the
    // injected concurrent flip all rolled back with the shared transaction —
    // no orphan authorization survives.
    expect(approvalCount(id)).toBe(0);
    expect(eventCount(id, 'approval.record')).toBe(0);
    expect(obligationState(id)).toBe('waiting_approval');
  });

  it('consumeGroupDrainApproval refuses when the obligation is cancelled under it', () => {
    const id = seedGroupObligation();
    const recorded = store.recordGroupDrainApproval({
      obligationId: id,
      ...DRAIN,
      approver: 'op-test',
      validForSeconds: 3600,
    });
    expect(recorded.recorded).toBe(true);
    const cancelStmt = db.raw.prepare(CANCEL_SQL);
    const result = withRaceInjection(
      /SET state = 'waiting_capability', drain_approval_id = \?/,
      () => { cancelStmt.run(id); },
      () => store.consumeGroupDrainApproval(id, { ...DRAIN }),
    );
    expect(result).toEqual({ applied: false, reason: 'no_matching_approval' });
    // The concurrent cancel committed; the approval was NOT consumed onto it.
    expect(obligationState(id)).toBe('cancelled');
    const drainRef = db.raw
      .prepare('SELECT drain_approval_id FROM capability_obligations WHERE id = ?')
      .get(id) as { drain_approval_id: number | null };
    expect(drainRef).toEqual({ drain_approval_id: null });
  });
});
