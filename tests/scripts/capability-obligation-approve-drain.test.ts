/**
 * capability-obligation-approve-drain (round-15 finding 3): the operator approval
 * front-door produces a CLAIMABLE group-drain approval end-to-end — its computed
 * attestation digest matches what admission/claim expect, so the approved group
 * obligation consumes and claims. Dry-run records nothing; non-group / non-waiting
 * obligations are refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attestationBindingDigest,
  buildCapabilityAttestationBinding,
  recordCapabilityAttestation,
  type AttestationSkillIdentity,
} from '../../src/core/capability-attestation.ts';
import { CapabilityObligationStore } from '../../src/core/capability-obligation-store.ts';
import { Database } from '../../src/core/database.ts';
import { withTransaction } from '../../src/core/db-tx.ts';
import { resolveHarnessType } from '../../src/runtimes/agent/capability-obligation-runtime.ts';
import { approveDrain, type ApproveDrainArgs } from '../../scripts/capability-obligation-approve-drain.ts';

let db: Database;
let store: CapabilityObligationStore;

const GROUP_JID = 'test-group-alpha@g.us';
const SKILL: AttestationSkillIdentity = {
  skillName: 'watch', skillVersion: '1.0.0', skillDigest: 'sd', resolverDigest: 'rd',
  dependencyVersions: { 'yt-dlp': '2026.03.17' }, probeVersion: 'p/1', canaryId: 'can-1',
};

function baseArgs(obligationId: number, over: Partial<ApproveDrainArgs> = {}): ApproveDrainArgs {
  return {
    dbPath: ':memory:', obligationId,
    releaseSha: 'rel-live-1', providerId: 'claude-cli',
    skill: SKILL, mediaRoot: '/var/media',
    manifestDigest: 'md-1', drainRunId: 'drain-1', approver: 'owner', validForSeconds: 3600,
    hostId: 'test-host', runtimeUser: 'test-user',
    json: false, confirm: false,
    ...over,
  };
}

function seedGroupObligation(over: Partial<Record<string, unknown>> = {}): number {
  let id = 0;
  withTransaction(db, () => {
    id = store.applyDecisionWithinCallerTransaction({
      auditEvent: { action: 'obligation.create', actorType: 'runtime', reasonCode: 'conclusive_no_effect' },
      obligation: {
        sourceInboundSeq: (over.sourceInboundSeq as number) ?? 9001,
        sourceMessageId: (over.sourceMessageId as string) ?? 'TESTMSG-APPROVE-1',
        conversationKey: 'conv-approve', deliveryJid: (over.deliveryJid as string) ?? GROUP_JID,
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

/** The binding the operator + supervisor both build for this obligation. */
function expectedBinding(args: ApproveDrainArgs) {
  return buildCapabilityAttestationBinding({
    liveFacts: {
      hostId: args.hostId, runtimeUser: args.runtimeUser, releaseSha: args.releaseSha,
      schemaVersion: 57, providerId: args.providerId, harnessType: resolveHarnessType(args.providerId),
    },
    contractVersion: 'c/1', capability: 'child_process_tools', skill: SKILL, mediaRoot: args.mediaRoot,
  });
}

beforeEach(() => { db = new Database(':memory:'); db.open(); store = new CapabilityObligationStore(db); });
afterEach(() => db.close());

describe('approveDrain (operator group-drain approval)', () => {
  it('produces a CLAIMABLE approval end-to-end: approve → consume → claim succeeds', () => {
    const id = seedGroupObligation();
    const args = baseArgs(id, { confirm: true });
    const binding = expectedBinding(args);
    const digest = attestationBindingDigest(binding);
    // The attestation the drain runs under (admission would find it).
    const attId = recordCapabilityAttestation(db, {
      ...binding, canaryResult: 'pass', nonce: 'n-1',
      attestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const result = approveDrain(store, db, args);
    expect(result).toMatchObject({ ok: true, mode: 'confirm', attestationDigest: digest, approvalId: expect.any(Number) });

    // Consume with the SAME live drain facts the approval was cut for.
    const consumed = store.consumeGroupDrainApproval(id, {
      destinationJid: GROUP_JID, releaseSha: 'rel-live-1', manifestDigest: 'md-1',
      drainRunId: 'drain-1', attestationDigest: digest,
    });
    expect(consumed.applied).toBe(true);

    // The claim (r14 F1 + r15 F4) accepts it because the CLI computed the digest correctly.
    const claim = store.claimObligation(id, {
      claimToken: 'tok', leaseSeconds: 300, admissionAttestationId: attId, admissionAttestationDigest: digest,
    });
    expect(claim.applied).toBe(true);
  });

  it('dry-run reports the digest but records NO approval', () => {
    const id = seedGroupObligation();
    const result = approveDrain(store, db, baseArgs(id, { confirm: false }));
    expect(result).toMatchObject({ ok: true, mode: 'dry-run', attestationDigest: expect.any(String) });
    expect(result.approvalId).toBeUndefined();
    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM capability_drain_approvals').get() as { c: number }).c).toBe(0);
  });

  it('refuses a non-group obligation', () => {
    const id = seedGroupObligation({ isGroup: false, deliveryJid: 'test-dm-target@lid', sourceInboundSeq: 9002, sourceMessageId: 'M2' });
    expect(approveDrain(store, db, baseArgs(id, { confirm: true })).reason).toBe('not_a_waiting_group');
  });

  it('refuses an unknown obligation id', () => {
    expect(approveDrain(store, db, baseArgs(4242, { confirm: true })).reason).toBe('not_found');
  });
});
