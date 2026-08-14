/**
 * Gated cold-obligation activation (round-15 finding 2): drainObligationNow
 * activates + drains ONE named obligation, but a GROUP is refused (and its session
 * is never activated) unless a current AS-08 approval is in force. This is the
 * owner-authorized alternative to the autonomous proactive resume AE1 forbids.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  recordCapabilityAttestation,
  type CapabilityAttestationBinding,
} from '../../../src/core/capability-attestation.ts';
import { CapabilityObligationStore } from '../../../src/core/capability-obligation-store.ts';
import { Database } from '../../../src/core/database.ts';
import { withTransaction } from '../../../src/core/db-tx.ts';
import {
  deriveNamedDrainOutcome,
  drainObligationNow,
  type DrainNowDeps,
} from '../../../src/runtimes/agent/capability-obligation-drain-now.ts';
import {
  CapabilityObligationSupervisor,
  type ObligationTickReport,
} from '../../../src/runtimes/agent/capability-obligation-supervisor.ts';

let db: Database;
let store: CapabilityObligationStore;

const GROUP_JID = 'test-group-alpha@g.us';
const LIVE = {
  destinationJid: GROUP_JID, releaseSha: 'rel-live-1', manifestDigest: 'md-live-1',
  drainRunId: 'drain-run-live-1', attestationDigest: 'att-digest-live-1',
};

function emptyReport(): ObligationTickReport {
  return {
    reclaimed: { requeued: [], quarantined: [] }, settled: [], requeuedAfterPreAcceptFailure: [],
    quarantinedAmbiguous: [], attestationSkips: [], mediaBlocked: [], claimed: [], dispatched: [], requeuedRetryable: [],
  };
}

function makeDeps(over: Partial<DrainNowDeps> = {}): { deps: DrainNowDeps; activated: string[] } {
  const activated: string[] = [];
  const deps: DrainNowDeps = {
    db, store,
    activateSession: async (jid) => { activated.push(jid); return true; },
    // A no-op targeted drain: nothing is claimed or dispatched, so the truthful
    // post-state outcome for a still-due named row is named_parked/still_due.
    drainNamed: async () => ({ processed: true as const, report: emptyReport() }),
    hasAdmissibleAttestationCandidate: () => true,
    ...over,
  };
  return { deps, activated };
}

function seedObligation(over: Partial<Record<string, unknown>> = {}): number {
  let id = 0;
  withTransaction(db, () => {
    id = store.applyDecisionWithinCallerTransaction({
      auditEvent: { action: 'obligation.create', actorType: 'runtime', reasonCode: 'conclusive_no_effect' },
      obligation: {
        sourceInboundSeq: (over.sourceInboundSeq as number) ?? 8001,
        sourceMessageId: (over.sourceMessageId as string) ?? 'TESTMSG-DRAIN-1',
        conversationKey: 'conv-drain', deliveryJid: (over.deliveryJid as string) ?? GROUP_JID,
        senderJid: 'test-sender@s.whatsapp.net', senderName: 'S',
        isGroup: (over.isGroup as boolean) ?? true, groupName: 'Test Group Alpha',
        scope: 'per_chat', originRecoveryJobId: null, replayText: 'https://youtu.be/abc',
        contentTypeHint: 'text', contractVersion: 'c/1', requiredCapability: 'child_process_tools',
        capabilityParams: '{"skill":"watch"}', inputDigest: 'ab'.repeat(32), sourceDigest: 'bb'.repeat(32),
        sourceToken: 'https://youtu.be/abc', retainedMedia: null, creationReason: 'harness_capability_gap',
      },
    }).obligationId!;
  });
  return id;
}

function insertApproval(id: number): number {
  return Number(
    db.raw
      .prepare(
        `INSERT INTO capability_drain_approvals
           (obligation_id, destination_jid, scope, release_sha, attestation_digest, manifest_digest, drain_run_id, approver, approved_at, expires_at)
         VALUES (?, ?, 'group', ?, ?, ?, ?, 'owner', datetime('now'), datetime('now','+1 hour'))`,
      )
      .run(id, LIVE.destinationJid, LIVE.releaseSha, LIVE.attestationDigest, LIVE.manifestDigest, LIVE.drainRunId)
      .lastInsertRowid,
  );
}

/** Move a seeded GROUP obligation to waiting_capability by consuming an approval. */
function approvedGroup(): { id: number; approvalId: number } {
  const id = seedObligation();
  const approvalId = insertApproval(id);
  expect(store.consumeGroupDrainApproval(id, LIVE).applied).toBe(true);
  return { id, approvalId };
}

beforeEach(() => { db = new Database(':memory:'); db.open(); store = new CapabilityObligationStore(db); });
afterEach(() => db.close());

describe('drainObligationNow (gated cold activation)', () => {
  it('a GROUP with a live AS-08 approval activates the session and runs the targeted drain', async () => {
    const { id } = approvedGroup();
    const { deps, activated } = makeDeps();
    const result = await drainObligationNow(deps, id);
    // The stub drain touches nothing, so the truthful outcome is parked/still_due.
    expect(result).toMatchObject({ activated: true, named: { kind: 'named_parked', reason: 'still_due' } });
    expect(activated).toEqual([GROUP_JID]);
  });

  it("FALSIFIER: a GROUP whose approval was REVOKED after consumption is refused and NEVER activates", async () => {
    const { id, approvalId } = approvedGroup();
    db.raw.prepare("UPDATE capability_drain_approvals SET revoked_at = datetime('now') WHERE id = ?").run(approvalId);
    const { deps, activated } = makeDeps();
    const result = await drainObligationNow(deps, id);
    expect(result).toEqual({ activated: false, reason: 'group_approval_required' });
    expect(activated).toEqual([]); // the session is NOT activated for an unauthorised group
  });

  it('a DM in waiting_capability activates and runs the targeted drain without any approval', async () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8002, sourceMessageId: 'M-DM' });
    const { deps, activated } = makeDeps();
    const result = await drainObligationNow(deps, id);
    expect(result).toMatchObject({ activated: true, named: { kind: 'named_parked', reason: 'still_due' } });
    expect(activated).toEqual(['test-dm-target@lid']);
  });

  it('refuses an obligation that is not in waiting_capability (e.g. a parked group)', async () => {
    const id = seedObligation(); // waiting_approval — never consumed
    const { deps, activated } = makeDeps();
    expect(await drainObligationNow(deps, id)).toEqual({ activated: false, reason: 'not_drainable' });
    expect(activated).toEqual([]);
  });

  it('reports session_activation_failed without running the targeted drain when activation fails', async () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8003, sourceMessageId: 'M-DM2' });
    let drains = 0;
    const deps: DrainNowDeps = {
      db, store, activateSession: async () => false,
      drainNamed: async () => { drains += 1; return { processed: true as const, report: emptyReport() }; },
      hasAdmissibleAttestationCandidate: () => true,
    };
    expect(await drainObligationNow(deps, id)).toEqual({ activated: false, reason: 'session_activation_failed' });
    expect(drains).toBe(0);
  });

  it('FALSIFIER (r22 pre-activation gate): no attestation candidate refuses BEFORE any session is activated', async () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8004, sourceMessageId: 'M-DM3' });
    let drains = 0;
    const { deps, activated } = makeDeps({
      hasAdmissibleAttestationCandidate: () => false,
      drainNamed: async () => { drains += 1; return { processed: true as const, report: emptyReport() }; },
    });
    expect(await drainObligationNow(deps, id)).toEqual({ activated: false, reason: 'no_admissible_attestation' });
    expect(activated).toEqual([]); // the session was never created/activated
    expect(drains).toBe(0);
  });

  it('a THROWING attestation pre-check refuses fail-closed (never activates)', async () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8005, sourceMessageId: 'M-DM4' });
    const { deps, activated } = makeDeps({
      hasAdmissibleAttestationCandidate: () => { throw new Error('store unavailable'); },
    });
    expect(await drainObligationNow(deps, id)).toEqual({ activated: false, reason: 'no_admissible_attestation' });
    expect(activated).toEqual([]);
  });

  it('the group-approval gate runs BEFORE the attestation pre-check (revoked group never reaches it)', async () => {
    const { id, approvalId } = approvedGroup();
    db.raw.prepare("UPDATE capability_drain_approvals SET revoked_at = datetime('now') WHERE id = ?").run(approvalId);
    let preChecked = 0;
    const { deps, activated } = makeDeps({
      hasAdmissibleAttestationCandidate: () => { preChecked += 1; return true; },
    });
    expect(await drainObligationNow(deps, id)).toEqual({ activated: false, reason: 'group_approval_required' });
    expect(preChecked).toBe(0);
    expect(activated).toEqual([]);
  });

  it('refuses an unknown obligation id', async () => {
    const { deps } = makeDeps();
    expect(await drainObligationNow(deps, 9999)).toEqual({ activated: false, reason: 'not_found' });
  });
});

describe('truthful named-drain outcomes (audit F2)', () => {
  const ATTESTED_BINDING: CapabilityAttestationBinding = {
    hostId: 'test-host', runtimeUser: 'test-user', releaseSha: 'rel-live-1', schemaVersion: 60,
    providerId: 'claude-cli', harnessType: 'persistent_session', contractVersion: 'c/1',
    capability: 'child_process_tools', skillName: 'watch-skill', skillVersion: '1.2.3',
    skillDigest: 'skill-digest-1', resolverDigest: 'resolver-composite-1',
    dependencyVersions: { 'yt-dlp': '2026.03.17' }, probeVersion: 'probe/1', canaryId: 'canary-1',
    mediaRoot: '/tmp/media-root',
  };

  function freshAttestation(): void {
    recordCapabilityAttestation(db, {
      ...ATTESTED_BINDING,
      canaryResult: 'pass',
      nonce: `n-${Math.random().toString(36).slice(2)}`,
      attestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
  }

  function realSupervisor(): { supervisor: CapabilityObligationSupervisor; dispatches: number[] } {
    const dispatches: number[] = [];
    const supervisor = new CapabilityObligationSupervisor({
      db,
      store,
      dispatchPort: {
        prepare: (obligation) => ({
          binding: { ...ATTESTED_BINDING, contractVersion: obligation.contractVersion },
          dispatch: async () => {
            dispatches.push(obligation.id);
            return 'dispatched';
          },
        }),
      },
      evidencePort: {
        providerAcceptedIds: () => new Set(),
        settlementEvidence: () => undefined,
      },
    });
    return { supervisor, dispatches };
  }

  const rowState = (id: number) =>
    db.raw.prepare('SELECT state, attempt_count AS attemptCount FROM capability_obligations WHERE id = ?').get(id) as {
      state: string;
      attemptCount: number;
    };

  it('FALSIFIER (audit F2 red): a NAMED obligation behind >10 older due obligations is ACTUALLY processed, and the result says so', async () => {
    // Global tick is oldest-first, cap 10 — the named 12th row would never be
    // scanned (the pre-fix code reported success from exactly that tick). A
    // truthful drain processes the NAMED obligation via the supervisor's
    // targeted scan and reports an outcome derived from ITS post-state.
    const older: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      older.push(seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8200 + i, sourceMessageId: `M-OLD-${i}` }));
    }
    const named = seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8300, sourceMessageId: 'M-NAMED' });
    freshAttestation();
    const { supervisor, dispatches } = realSupervisor();
    const { deps } = makeDeps({ drainNamed: (id) => supervisor.drainNamed(id) });
    const result = await drainObligationNow(deps, named);
    // The named obligation itself must have been claimed and dispatched…
    expect(rowState(named)).toEqual({ state: 'claimed', attemptCount: 1 });
    expect(dispatches).toEqual([named]);
    // …and the reported outcome must be derived from the NAMED row's post-state.
    expect(result).toEqual({
      activated: true,
      named: { kind: 'named_dispatched', state: 'claimed', attemptCount: 1, claimEpoch: 1 },
    });
    // The targeted path never touches the older backlog.
    for (const id of older) expect(rowState(id)).toEqual({ state: 'waiting_capability', attemptCount: 0 });
  });

  it('FALSIFIER (audit F2 red): a drain whose named obligation was NOT touched must not read as success', async () => {
    // The committed r22 test encoded the lie: an EMPTY tick report was accepted
    // as a successful drain. The truthful outcome for an untouched, still-due
    // named row is a typed parked classification — never an unqualified success.
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8301, sourceMessageId: 'M-EMPTY' });
    const { deps } = makeDeps(); // the no-op drain: nothing scans the named row
    const result = await drainObligationNow(deps, id);
    expect(rowState(id)).toEqual({ state: 'waiting_capability', attemptCount: 0 }); // untouched
    expect(result).toEqual({
      activated: true,
      named: { kind: 'named_parked', state: 'waiting_capability', reason: 'still_due', detail: null },
    });
  });

  it('an attestation skip during the targeted drain reports named_parked/attestation_skip with the skip reason', async () => {
    // No attestation recorded: the targeted scan skips (zero attempts) and the
    // outcome must say so, not claim success.
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8302, sourceMessageId: 'M-SKIP' });
    const { supervisor, dispatches } = realSupervisor();
    const { deps } = makeDeps({ drainNamed: (obligationId) => supervisor.drainNamed(obligationId) });
    const result = await drainObligationNow(deps, id);
    expect(dispatches).toEqual([]);
    expect(rowState(id)).toEqual({ state: 'waiting_capability', attemptCount: 0 });
    expect(result).toEqual({
      activated: true,
      named: { kind: 'named_parked', state: 'waiting_capability', reason: 'attestation_skip', detail: 'none_recorded' },
    });
  });

  it('a rival claim between gating and the targeted drain reports named_claimed, never this drain\'s success', async () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8303, sourceMessageId: 'M-RIVAL' });
    freshAttestation();
    const { supervisor } = realSupervisor();
    const { deps } = makeDeps({
      drainNamed: async (obligationId) => {
        // The rival's claim lands first; our targeted pass then finds it not due.
        db.raw
          .prepare(
            `UPDATE capability_obligations
             SET state = 'claimed', attempt_count = attempt_count + 1, claim_epoch = claim_epoch + 1,
                 claim_token = 'rival-token', claim_expires_at = datetime('now', '+300 seconds')
             WHERE id = ?`,
          )
          .run(obligationId);
        return supervisor.drainNamed(obligationId);
      },
    });
    const result = await drainObligationNow(deps, id);
    expect(result).toEqual({
      activated: true,
      named: { kind: 'named_claimed', state: 'claimed', attemptCount: 1 },
    });
  });

  it('deriveNamedDrainOutcome reports named_settled ONLY from the queried row + verified receipt chain', async () => {
    // Drive a REAL completion through the store (claim → receipt → minted-turn
    // terminal record → fenced settle) and require the derivation to surface
    // exactly the durable proofs, not a blanket success.
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8304, sourceMessageId: 'M-CHAIN' });
    freshAttestation();
    const { supervisor } = realSupervisor();
    const tick = await supervisor.drainNamed(id);
    expect(rowState(id).state).toBe('claimed');
    const receiptId = store.recordExecutionReceipt({
      obligationId: id, logicalTurnId: 'turn-drain-1', toolUseId: 'tu-drain-1', skillName: 'watch',
      contractVersion: 'c/1', inputDigest: 'ab'.repeat(32), mediaDigest: null, resultStatus: 'ok',
      outputEvidence: { ok: true }, claimEpoch: 1, attemptNumber: 1, sourceDigest: 'bb'.repeat(32),
    });
    db.raw
      .prepare(
        `INSERT INTO inbound_events (message_id, conversation_key, chat_jid, routed_to)
         VALUES (?, 'conv-drain', 'test-dm-target@lid', 'agent')`,
      )
      .run(`obl:${id}:1`);
    const seq = (db.raw.prepare('SELECT seq FROM inbound_events WHERE message_id = ?').get(`obl:${id}:1`) as { seq: number }).seq;
    db.raw
      .prepare(
        `INSERT INTO turn_terminal_records (
           scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
           logical_turn_id, manager_id, generation, attempt_kind,
           inbound_disposition, delivery_kind, delivery_op_id, reply_guarantee_disarmed
         ) VALUES ('per_chat', 'conv-drain', 'test-dm-target@lid', ?, ?, 'turn-drain-1', 'mgr-1', 1,
                   'replied', 'completed', 'echoed', 434343, 0)`,
      )
      .run(seq, seq);
    const terminalId = Number(
      (db.raw.prepare('SELECT id FROM turn_terminal_records WHERE inbound_seq = ?').get(seq) as { id: number }).id,
    );
    const fence = db.raw
      .prepare('SELECT claim_token AS claimToken, claim_epoch AS claimEpoch FROM capability_obligations WHERE id = ?')
      .get(id) as { claimToken: string; claimEpoch: number };
    expect(
      store.settleCompleted(id, fence, { executionReceiptId: receiptId, completionProofId: `ttr:${terminalId}` }).applied,
    ).toBe(true);
    const outcome = deriveNamedDrainOutcome(store, id, tick);
    expect(outcome).toEqual({
      kind: 'named_settled', state: 'completed', completionProofId: `ttr:${terminalId}`, executionReceiptId: receiptId,
    });
  });

  it('deriveNamedDrainOutcome fails closed to settlement_evidence_incomplete when the receipt chain cannot be verified', () => {
    // The schema makes a proof-less completed row unreachable; the derivation
    // is the last line and must still refuse to call it settled on its own.
    // A structural store stub models the impossible post-state directly.
    const stub = {
      operatorInspectObligation: () => ({
        obligation: { state: 'completed', attempt_count: 1, claim_epoch: 1, completion_proof_id: null },
        events: [],
        receipts: [],
      }),
      dueObligationById: () => ({ due: null, state: 'completed', notDueReason: 'not_waiting' }),
    } as unknown as CapabilityObligationStore;
    const outcome = deriveNamedDrainOutcome(stub, 7, { processed: true, report: emptyReport() });
    expect(outcome).toEqual({
      kind: 'named_parked', state: 'completed', reason: 'settlement_evidence_incomplete', detail: null,
    });
  });

  it('deriveNamedDrainOutcome classifies a requeued-under-backoff row as named_parked/backoff_pending', () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8305, sourceMessageId: 'M-BACKOFF' });
    db.raw
      .prepare(
        `UPDATE capability_obligations
         SET next_attempt_at = datetime('now', '+3600 seconds') WHERE id = ?`,
      )
      .run(id);
    const outcome = deriveNamedDrainOutcome(store, id, { processed: true, report: emptyReport() });
    expect(outcome).toEqual({
      kind: 'named_parked', state: 'waiting_capability', reason: 'backoff_pending', detail: null,
    });
  });

  it('deriveNamedDrainOutcome reports named_not_found for a vanished row', () => {
    const outcome = deriveNamedDrainOutcome(store, 424242, { processed: true, report: emptyReport() });
    expect(outcome).toEqual({ kind: 'named_not_found' });
  });
});

describe('hasAttestationCandidateIgnoringProvider (r22 drain-now pre-check)', () => {
  // The pre-check mirrors admission's FULL binding conjunction minus ONLY
  // provider_id/harness_type. Every other field participates and is
  // discriminating — proven exhaustively in the "EVERY participating binding
  // field" case below (r22 AE1-review Medium: the earlier form silently ignored
  // five fields and its fixture could not detect that; the fixture now varies
  // all of them).
  const FACTS = {
    hostId: 'test-host', runtimeUser: 'test-user', releaseSha: 'rel-live-1',
    schemaVersion: 60, skillName: 'watch-skill', skillVersion: '1.2.3' as string | null,
    skillDigest: 'skill-digest-1', resolverDigest: 'resolver-composite-1' as string | null,
    dependencyVersions: { 'yt-dlp': '2026.03.17' } as Record<string, string>,
    probeVersion: 'probe/1', canaryId: 'canary-1', mediaRoot: '/tmp/media-root',
  };

  function insertAttestation(over: Partial<Record<string, unknown>> = {}): void {
    db.raw
      .prepare(
        `INSERT INTO capability_attestations
           (host_id, runtime_user, release_sha, schema_version, provider_id, harness_type,
            contract_version, capability, skill_name, skill_version, skill_digest, resolver_digest,
            dependency_versions, media_root, canary_id, canary_result, probe_version, nonce,
            attested_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 datetime('now'), ?, ?)`,
      )
      .run(
        (over.hostId as string) ?? FACTS.hostId,
        (over.runtimeUser as string) ?? FACTS.runtimeUser,
        (over.releaseSha as string) ?? FACTS.releaseSha,
        (over.schemaVersion as number) ?? FACTS.schemaVersion,
        (over.providerId as string) ?? 'some-provider-the-runtime-never-uses',
        (over.harnessType as string) ?? 'some-harness',
        (over.contractVersion as string) ?? 'c/1',
        (over.capability as string) ?? 'child_process_tools',
        (over.skillName as string) ?? FACTS.skillName,
        'skillVersion' in over ? (over.skillVersion as string | null) : FACTS.skillVersion,
        (over.skillDigest as string) ?? FACTS.skillDigest,
        'resolverDigest' in over ? (over.resolverDigest as string | null) : FACTS.resolverDigest,
        (over.dependencyVersions as string) ?? JSON.stringify(FACTS.dependencyVersions),
        (over.mediaRoot as string) ?? FACTS.mediaRoot,
        (over.canaryId as string) ?? FACTS.canaryId,
        (over.canaryResult as string) ?? 'pass',
        (over.probeVersion as string) ?? FACTS.probeVersion,
        (over.nonce as string) ?? `nonce-${Math.random().toString(36).slice(2)}`,
        (over.expiresAt as string) ?? new Date(Date.now() + 3_600_000).toISOString().replace('T', ' ').slice(0, 19),
        (over.revokedAt as string | null) ?? null,
      );
  }

  it('matches a live attestation REGARDLESS of provider/harness — and of nothing else', () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm@lid', sourceInboundSeq: 8100, sourceMessageId: 'M-ATT-1' });
    insertAttestation({ providerId: 'provider-never-seen', harnessType: 'harness-never-seen' });
    expect(store.hasAttestationCandidateIgnoringProvider({ obligationId: id, ...FACTS })).toBe(true);
  });

  it('false when no attestation exists at all', () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm@lid', sourceInboundSeq: 8101, sourceMessageId: 'M-ATT-2' });
    expect(store.hasAttestationCandidateIgnoringProvider({ obligationId: id, ...FACTS })).toBe(false);
  });

  it('false for revoked, failed-canary, wrong-release, wrong-skill-digest, or wrong-capability rows', () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm@lid', sourceInboundSeq: 8102, sourceMessageId: 'M-ATT-3' });
    insertAttestation({ revokedAt: '2020-01-01 00:00:00' });
    insertAttestation({ canaryResult: 'fail' });
    insertAttestation({ releaseSha: 'rel-OTHER' });
    insertAttestation({ skillDigest: 'skill-digest-OTHER' });
    insertAttestation({ capability: 'network_tools' });
    expect(store.hasAttestationCandidateIgnoringProvider({ obligationId: id, ...FACTS })).toBe(false);
  });

  it('FALSIFIER (r22 review Medium — resolver DRIFT): an attestation bound to an OLD composite is NOT a candidate', () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm@lid', sourceInboundSeq: 8104, sourceMessageId: 'M-ATT-5' });
    insertAttestation({ resolverDigest: 'resolver-composite-STALE' });
    expect(store.hasAttestationCandidateIgnoringProvider({ obligationId: id, ...FACTS })).toBe(false);
  });

  it('EVERY participating binding field is discriminating (r22 review L2 — all 11, not just the easy 6)', () => {
    // Each wrong-field attestation must NOT match; only an exact one does. This
    // varies the five the prior fixture silently skipped (host_id, runtime_user,
    // schema_version, contract_version via the JOINed obligation, media_root) in
    // addition to skill_version / resolver_digest / dependency_versions /
    // probe_version / canary_id / release_sha — closing the coverage gap a
    // second reviewer flagged (the SQL was already correct; the suite couldn't
    // prove it).
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm@lid', sourceInboundSeq: 8105, sourceMessageId: 'M-ATT-6' });
    insertAttestation({ hostId: 'host-OTHER' });
    insertAttestation({ runtimeUser: 'user-OTHER' });
    insertAttestation({ schemaVersion: 999 });
    insertAttestation({ contractVersion: 'contract-OTHER' }); // JOINed from the obligation
    insertAttestation({ mediaRoot: '/media-OTHER' });
    insertAttestation({ skillVersion: '9.9.9' });
    insertAttestation({ resolverDigest: 'resolver-OTHER' });
    insertAttestation({ dependencyVersions: JSON.stringify({ 'yt-dlp': '1999.01.01' }) });
    insertAttestation({ probeVersion: 'probe/OTHER' });
    insertAttestation({ canaryId: 'canary-OTHER' });
    insertAttestation({ releaseSha: 'rel-OTHER-2' });
    expect(store.hasAttestationCandidateIgnoringProvider({ obligationId: id, ...FACTS })).toBe(false);
    insertAttestation(); // exact match (any provider) — now a candidate
    expect(store.hasAttestationCandidateIgnoringProvider({ obligationId: id, ...FACTS })).toBe(true);
  });

  it('NULL skill_version/resolver_digest match with IS semantics (same as admission)', () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm@lid', sourceInboundSeq: 8106, sourceMessageId: 'M-ATT-7' });
    insertAttestation({ skillVersion: null, resolverDigest: null });
    const nullFacts = { ...FACTS, skillVersion: null, resolverDigest: null };
    expect(store.hasAttestationCandidateIgnoringProvider({ obligationId: id, ...nullFacts })).toBe(true);
    expect(store.hasAttestationCandidateIgnoringProvider({ obligationId: id, ...FACTS })).toBe(false);
  });

  it('false for an expired attestation', () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm@lid', sourceInboundSeq: 8103, sourceMessageId: 'M-ATT-4' });
    insertAttestation({ expiresAt: '2020-01-01 00:00:00' });
    expect(store.hasAttestationCandidateIgnoringProvider({ obligationId: id, ...FACTS })).toBe(false);
  });
});
