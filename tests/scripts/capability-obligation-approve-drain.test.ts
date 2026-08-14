/**
 * capability-obligation-approve-drain (round-15 finding 3): the operator approval
 * front-door produces a CLAIMABLE group-drain approval end-to-end — its computed
 * attestation digest matches what admission/claim expect, so the approved group
 * obligation consumes and claims. Dry-run records nothing; non-group / non-waiting
 * obligations are refused.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { approveDrain, type ApproveDrainArgs } from '../../scripts/capability-obligation-approve-drain.ts';

let db: Database;
let store: CapabilityObligationStore;

const CLI_PATH = fileURLToPath(new URL('../../scripts/capability-obligation-approve-drain.ts', import.meta.url));
const tmp = trackTmpDirs('approve-drain-cli-', { base: realpathSync(tmpdir()) });

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
      schemaVersion: 58, providerId: args.providerId, harnessType: resolveHarnessType(args.providerId),
    },
    contractVersion: 'c/1', capability: 'child_process_tools', skill: SKILL, mediaRoot: args.mediaRoot,
  });
}

beforeEach(() => { db = new Database(':memory:'); db.open(); store = new CapabilityObligationStore(db); });
afterEach(() => db.close());

describe('approveDrain (operator group-drain approval)', () => {
  it('records AND consumes in one command (round-16 blocker-2): approve → waiting_capability → claim succeeds', () => {
    const id = seedGroupObligation();
    const args = baseArgs(id, { confirm: true });
    const binding = expectedBinding(args);
    const digest = attestationBindingDigest(binding);
    // The attestation the drain runs under (admission would find it).
    const attId = recordCapabilityAttestation(db, {
      ...binding, canaryResult: 'pass', nonce: 'n-1',
      attestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    // ONE operator command records the approval AND drives the sole
    // waiting_approval → waiting_capability transition (no manual consume needed now).
    const result = approveDrain(store, db, args);
    expect(result).toMatchObject({ ok: true, mode: 'confirm', attestationDigest: digest, approvalId: expect.any(Number), consumed: true, currentState: 'waiting_capability' });
    expect((db.raw.prepare('SELECT state FROM capability_obligations WHERE id=?').get(id) as { state: string }).state).toBe('waiting_capability');

    // The claim (r14 F1 + r15 F4) accepts it because the CLI computed the digest correctly.
    const claim = store.claimObligation(id, {
      claimToken: 'tok', leaseSeconds: 300, admissionAttestationId: attId, admissionAttestationDigest: digest,
    });
    expect(claim.applied).toBe(true);
  });

  it('finding 3: recordAndConsumeGroupDrainApproval writes the approval AND flips state in ONE transaction (no orphan window)', () => {
    const id = seedGroupObligation();
    const args = baseArgs(id, { confirm: true });
    const digest = attestationBindingDigest(expectedBinding(args));
    const r = store.recordAndConsumeGroupDrainApproval({
      obligationId: id, destinationJid: GROUP_JID, releaseSha: args.releaseSha,
      manifestDigest: args.manifestDigest, drainRunId: args.drainRunId, attestationDigest: digest,
      approver: args.approver, validForSeconds: args.validForSeconds,
    });
    expect(r).toMatchObject({ ok: true, approvalId: expect.any(Number) });
    // BOTH writes landed together: exactly one approval row AND the state flip.
    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM capability_drain_approvals').get() as { c: number }).c).toBe(1);
    expect((db.raw.prepare('SELECT state, drain_approval_id AS a FROM capability_obligations WHERE id=?').get(id) as { state: string; a: number }))
      .toMatchObject({ state: 'waiting_capability', a: r.approvalId });
  });

  it('FALSIFIER (finding 3): a non-waiting obligation records NEITHER an approval NOR a state change', () => {
    const id = seedGroupObligation({ isGroup: false }); // DM, not a waiting group
    const digest = attestationBindingDigest(expectedBinding(baseArgs(id, { confirm: true })));
    const r = store.recordAndConsumeGroupDrainApproval({
      obligationId: id, destinationJid: GROUP_JID, releaseSha: 'rel-live-1',
      manifestDigest: 'md-1', drainRunId: 'drain-1', attestationDigest: digest, approver: 'owner', validForSeconds: 3600,
    });
    expect(r.ok).toBe(false);
    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM capability_drain_approvals').get() as { c: number }).c).toBe(0);
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

describe('capability-obligation-approve-drain CLI (main block reaches approveDrain end-to-end)', () => {
  /**
   * Runs the ACTUAL script main block as a subprocess. The existing tests above
   * call approveDrain() directly; this proves the runApproveDrain wiring
   * (parseApproveDrainArgs → assertSchemaCurrent → open DB → approveDrain →
   * exit code) actually executes and records — the same unexercised-main-block
   * surface that carried the attest-CLI defect.
   */
  function seedGroupObligationInFileDb(dbFile: string): number {
    const seed = new Database(dbFile);
    seed.open();
    let id = 0;
    try {
      const s = new CapabilityObligationStore(seed);
      withTransaction(seed, () => {
        id = s.applyDecisionWithinCallerTransaction({
          auditEvent: { action: 'obligation.create', actorType: 'runtime', reasonCode: 'conclusive_no_effect' },
          obligation: {
            sourceInboundSeq: 9101, sourceMessageId: 'TESTMSG-CLI-1', conversationKey: 'conv-approve-cli',
            deliveryJid: GROUP_JID, senderJid: 'test-sender@s.whatsapp.net', senderName: 'S',
            isGroup: true, groupName: 'Test Group Alpha', scope: 'per_chat', originRecoveryJobId: null,
            replayText: 'https://youtu.be/abc', contentTypeHint: 'text', contractVersion: 'c/1',
            requiredCapability: 'child_process_tools', capabilityParams: '{"skill":"watch"}',
            inputDigest: 'ab'.repeat(32), sourceDigest: 'bb'.repeat(32), sourceToken: 'https://youtu.be/abc',
            retainedMedia: null, creationReason: 'typed_deferral_signal',
          },
        }).obligationId!;
      });
    } finally {
      seed.close();
    }
    return id;
  }

  function runCli(dbFile: string, obligationId: number, extra: readonly string[]): ReturnType<typeof spawnSync> {
    const cliArgs = [
      '--db', dbFile, '--obligation-id', String(obligationId), '--release-sha', 'rel-live-1', '--provider', 'claude-cli',
      '--skill-name', 'watch', '--skill-version', '1.0.0', '--skill-digest', 'sd', '--resolver-digest', 'rd',
      '--dep', 'yt-dlp=2026.03.17', '--probe-version', 'p/1', '--canary-id', 'can-1',
      '--media-root', '/var/media', '--manifest-digest', 'md-1', '--drain-run-id', 'drain-1', '--approver', 'owner',
      '--valid-seconds', '3600', '--host', 'test-host', '--runtime-user', 'test-user', ...extra,
    ];
    return spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', CLI_PATH, ...cliArgs],
      { encoding: 'utf8' },
    );
  }

  function approvalCount(dbFile: string): number {
    const check = new Database(dbFile);
    check.open();
    try {
      return (check.raw.prepare('SELECT COUNT(*) AS c FROM capability_drain_approvals').get() as { c: number }).c;
    } finally {
      check.close();
    }
  }

  function stateOf(dbFile: string, id: number): string {
    const check = new Database(dbFile);
    check.open();
    try {
      return (check.raw.prepare('SELECT state FROM capability_obligations WHERE id=?').get(id) as { state: string }).state;
    } finally {
      check.close();
    }
  }

  it('--confirm records a group-drain approval (proves the runApproveDrain wiring executes)', () => {
    const dir = tmp.make('confirm');
    const dbFile = join(dir, 'obligations.db');
    const id = seedGroupObligationInFileDb(dbFile);
    const result = runCli(dbFile, id, ['--confirm']);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/APPROVED \+ ARMED group drain/);
    expect(approvalCount(dbFile)).toBe(1);
    // blocker-2: the CLI drove the transition — the group is now claimable-eligible.
    expect(stateOf(dbFile, id)).toBe('waiting_capability');
  }, 30_000);

  it('FALSIFIER: dry-run (no --confirm) records NO approval', () => {
    const dir = tmp.make('dryrun');
    const dbFile = join(dir, 'obligations.db');
    const id = seedGroupObligationInFileDb(dbFile);
    const result = runCli(dbFile, id, []);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/DRY-RUN approve/);
    expect(approvalCount(dbFile)).toBe(0);
  }, 30_000);
});
