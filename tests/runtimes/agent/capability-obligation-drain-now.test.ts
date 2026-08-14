/**
 * Gated cold-obligation activation (round-15 finding 2): drainObligationNow
 * activates + drains ONE named obligation, but a GROUP is refused (and its session
 * is never activated) unless a current AS-08 approval is in force. This is the
 * owner-authorized alternative to the autonomous proactive resume AE1 forbids.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CapabilityObligationStore } from '../../../src/core/capability-obligation-store.ts';
import { Database } from '../../../src/core/database.ts';
import { withTransaction } from '../../../src/core/db-tx.ts';
import { drainObligationNow, type DrainNowDeps } from '../../../src/runtimes/agent/capability-obligation-drain-now.ts';
import type { ObligationTickReport } from '../../../src/runtimes/agent/capability-obligation-supervisor.ts';

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
    runTick: async () => emptyReport(),
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
        sourceToken: 'https://youtu.be/abc', retainedMedia: null, creationReason: 'typed_deferral_signal',
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
  it('a GROUP with a live AS-08 approval activates the session and runs one tick', async () => {
    const { id } = approvedGroup();
    const { deps, activated } = makeDeps();
    const result = await drainObligationNow(deps, id);
    expect(result).toMatchObject({ activated: true });
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

  it('a DM in waiting_capability activates and drains without any approval', async () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8002, sourceMessageId: 'M-DM' });
    const { deps, activated } = makeDeps();
    const result = await drainObligationNow(deps, id);
    expect(result).toMatchObject({ activated: true });
    expect(activated).toEqual(['test-dm-target@lid']);
  });

  it('refuses an obligation that is not in waiting_capability (e.g. a parked group)', async () => {
    const id = seedObligation(); // waiting_approval — never consumed
    const { deps, activated } = makeDeps();
    expect(await drainObligationNow(deps, id)).toEqual({ activated: false, reason: 'not_drainable' });
    expect(activated).toEqual([]);
  });

  it('reports session_activation_failed without running a tick when activation fails', async () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8003, sourceMessageId: 'M-DM2' });
    let ticks = 0;
    const deps: DrainNowDeps = {
      db, store, activateSession: async () => false, runTick: async () => { ticks += 1; return emptyReport(); },
      hasAdmissibleAttestationCandidate: () => true,
    };
    expect(await drainObligationNow(deps, id)).toEqual({ activated: false, reason: 'session_activation_failed' });
    expect(ticks).toBe(0);
  });

  it('FALSIFIER (r22 pre-activation gate): no attestation candidate refuses BEFORE any session is activated', async () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 8004, sourceMessageId: 'M-DM3' });
    let ticks = 0;
    const { deps, activated } = makeDeps({
      hasAdmissibleAttestationCandidate: () => false,
      runTick: async () => { ticks += 1; return emptyReport(); },
    });
    expect(await drainObligationNow(deps, id)).toEqual({ activated: false, reason: 'no_admissible_attestation' });
    expect(activated).toEqual([]); // the session was never created/activated
    expect(ticks).toBe(0);
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

describe('hasAttestationCandidateIgnoringProvider (r22 drain-now pre-check)', () => {
  // The pre-check mirrors admission's FULL binding conjunction minus ONLY
  // provider_id/harness_type — every other field participates and is varied
  // below (r22 AE1-review Medium: the earlier form silently ignored five more
  // fields and its fixture could not detect that).
  const FACTS = {
    hostId: 'test-host', runtimeUser: 'test-user', releaseSha: 'rel-live-1',
    schemaVersion: 57, skillName: 'watch-skill', skillVersion: '1.2.3' as string | null,
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

  it('every remaining binding field participates: skill_version / dependency_versions / probe_version / canary_id', () => {
    const id = seedObligation({ isGroup: false, deliveryJid: 'test-dm@lid', sourceInboundSeq: 8105, sourceMessageId: 'M-ATT-6' });
    insertAttestation({ skillVersion: '9.9.9' });
    insertAttestation({ skillVersion: null });
    insertAttestation({ dependencyVersions: JSON.stringify({ 'yt-dlp': '1999.01.01' }) });
    insertAttestation({ probeVersion: 'probe/OTHER' });
    insertAttestation({ canaryId: 'canary-OTHER' });
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
