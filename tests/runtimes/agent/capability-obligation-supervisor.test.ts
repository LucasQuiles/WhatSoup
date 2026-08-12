/**
 * Capability-obligation supervisor — D5 attestation-gated admission, D3
 * pre-claim media integrity, D7 single-flight claim/requeue/reclaim, D6
 * evidence-gated settlement. Real SQLite; dispatch/attestation/evidence are
 * scripted ports.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordCapabilityAttestation, type CapabilityAttestationBinding } from '../../../src/core/capability-attestation.ts';
import { CapabilityObligationStore } from '../../../src/core/capability-obligation-store.ts';
import { Database } from '../../../src/core/database.ts';
import { withTransaction } from '../../../src/core/db-tx.ts';
import { retainMediaForObligation } from '../../../src/core/obligation-media-retention.ts';
import {
  CapabilityObligationSupervisor,
  type ObligationDispatchOutcome,
  type ObligationSettlementEvidence,
} from '../../../src/runtimes/agent/capability-obligation-supervisor.ts';

let db: Database;
let store: CapabilityObligationStore;
let dir: string;

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
  resolverDigest: 'r1',
  dependencyVersions: {},
  probeVersion: 'p/1',
  canaryId: 'c1',
  mediaRoot: '/var/media-root',
};

function freshAttestation(): void {
  recordCapabilityAttestation(db, {
    ...BINDING,
    canaryResult: 'pass',
    nonce: `n-${Math.random().toString(36).slice(2)}`,
    attestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
}

interface Script {
  dispatch?: ObligationDispatchOutcome | Error;
  accepted?: number[];
  settlement?: Map<number, ObligationSettlementEvidence>;
}

function makeSupervisor(script: Script, options: { backoffSeconds?: number } = {}) {
  const dispatches: Array<{ id: number; mintedMessageId: string }> = [];
  const supervisor = new CapabilityObligationSupervisor({
    db,
    store,
    backoffSeconds: options.backoffSeconds ?? 0,
    dispatchPort: {
      async dispatch(obligation, mintedMessageId) {
        dispatches.push({ id: obligation.id, mintedMessageId });
        const outcome = script.dispatch ?? 'dispatched';
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
    attestationPort: {
      binding: (obligation) => ({ ...BINDING, contractVersion: obligation.contractVersion }),
    },
    evidencePort: {
      providerAcceptedIds: () => new Set(script.accepted ?? []),
      settlementEvidence: (id, _attempt) => script.settlement?.get(id),
    },
  });
  return { supervisor, dispatches };
}

function seedObligation(over: Partial<Record<string, unknown>> = {}): number {
  let id = 0;
  withTransaction(db, () => {
    id = store.applyDecisionWithinCallerTransaction({
      auditEvent: { action: 'obligation.create', actorType: 'runtime', reasonCode: 'conclusive_no_effect' },
      obligation: {
        sourceInboundSeq: (over.sourceInboundSeq as number) ?? 2001,
        sourceMessageId: (over.sourceMessageId as string) ?? 'TESTMSG-SUP-1',
        conversationKey: 'conv-sup',
        deliveryJid: 'test-dm-target@lid',
        senderJid: 'test-sender@s.whatsapp.net',
        senderName: 'Test Sender',
        isGroup: false,
        groupName: null,
        scope: 'per_chat',
        originRecoveryJobId: null,
        replayText: 'https://youtu.be/abc',
        contentTypeHint: 'text',
        contractVersion: 'test-contract/1',
        requiredCapability: 'child_process_tools',
        capabilityParams: '{"skill":"watch"}',
        inputDigest: 'aa'.repeat(32),
        retainedMedia: (over.retainedMedia as never) ?? null,
        creationReason: 'typed_deferral_signal',
      },
    }).obligationId!;
  });
  return id;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
  store = new CapabilityObligationStore(db);
  dir = mkdtempSync(join(tmpdir(), 'obl-supervisor-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const state = (id: number) =>
  (db.raw.prepare('SELECT state, attempt_count FROM capability_obligations WHERE id=?').get(id) as {
    state: string;
    attempt_count: number;
  });

describe('attestation admission (D5)', () => {
  it('skips without claiming or consuming attempts when no attestation exists', async () => {
    const id = seedObligation();
    const { supervisor, dispatches } = makeSupervisor({});
    const report = await supervisor.tick();
    expect(report.attestationSkips).toEqual([{ id, reason: 'none_recorded' }]);
    expect(report.claimed).toEqual([]);
    expect(dispatches).toEqual([]);
    expect(state(id)).toEqual({ state: 'waiting_capability', attempt_count: 0 });
  });

  it('claims and dispatches with a minted obl:<id>:<attempt> message id when attested', async () => {
    const id = seedObligation();
    freshAttestation();
    const { supervisor, dispatches } = makeSupervisor({ dispatch: 'dispatched' });
    const report = await supervisor.tick();
    expect(report.claimed).toEqual([id]);
    expect(report.dispatched).toEqual([id]);
    expect(dispatches).toEqual([{ id, mintedMessageId: `obl:${id}:1` }]);
    expect(state(id)).toEqual({ state: 'claimed', attempt_count: 1 });
  });
});

describe('media admission (D3)', () => {
  it('blocks mismatched retained media before claiming — zero attempts consumed', async () => {
    const src = join(dir, 'clip.webm');
    writeFileSync(src, 'original-bytes');
    const retained = await retainMediaForObligation({ root: join(dir, 'retained'), policyVersion: 'p/1' }, src);
    writeFileSync(retained.path, 'corrupted-bytes!');
    const id = seedObligation({
      retainedMedia: { path: retained.path, sha256: retained.sha256, bytes: retained.bytes, policyVersion: 'p/1' },
    });
    freshAttestation();
    const { supervisor, dispatches } = makeSupervisor({});
    const report = await supervisor.tick();
    expect(report.mediaBlocked).toEqual([id]);
    expect(dispatches).toEqual([]);
    expect(state(id)).toEqual({ state: 'blocked_media', attempt_count: 0 });
  });

  it('verified retained media dispatches normally', async () => {
    const src = join(dir, 'clip.ogg');
    writeFileSync(src, 'audio-bytes');
    const retained = await retainMediaForObligation({ root: join(dir, 'retained'), policyVersion: 'p/1' }, src);
    const id = seedObligation({
      retainedMedia: { path: retained.path, sha256: retained.sha256, bytes: retained.bytes, policyVersion: 'p/1' },
    });
    freshAttestation();
    const { supervisor } = makeSupervisor({ dispatch: 'dispatched' });
    const report = await supervisor.tick();
    expect(report.dispatched).toEqual([id]);
  });
});

describe('dispatch outcomes (D7)', () => {
  it('a retryable dispatch requeues under the fence with backoff', async () => {
    const id = seedObligation();
    freshAttestation();
    const { supervisor } = makeSupervisor({ dispatch: 'retryable' });
    const report = await supervisor.tick();
    expect(report.requeuedRetryable).toEqual([id]);
    expect(state(id)).toEqual({ state: 'waiting_capability', attempt_count: 1 });
  });

  it('a throwing dispatch is treated as retryable, never crashes the tick', async () => {
    const id = seedObligation();
    freshAttestation();
    const { supervisor } = makeSupervisor({ dispatch: new Error('boom') });
    const report = await supervisor.tick();
    expect(report.requeuedRetryable).toEqual([id]);
    expect(state(id).state).toBe('waiting_capability');
  });
});

describe('settlement (D6)', () => {
  async function claimedObligation(): Promise<number> {
    const id = seedObligation();
    freshAttestation();
    const { supervisor } = makeSupervisor({ dispatch: 'dispatched' });
    await supervisor.tick();
    expect(state(id).state).toBe('claimed');
    return id;
  }

  it('completes only on the full evidence chain', async () => {
    const id = await claimedObligation();
    const receiptId = store.recordExecutionReceipt({
      obligationId: id,
      logicalTurnId: 'turn-1',
      toolUseId: 'tu-1',
      skillName: 'watch',
      contractVersion: 'test-contract/1',
      inputDigest: 'aa'.repeat(32),
      mediaDigest: null,
      resultStatus: 'ok',
      outputEvidence: { ok: true },
      claimEpoch: 1,
      attemptNumber: 1,
    });
    const { supervisor } = makeSupervisor({
      settlement: new Map([[id, { kind: 'completed', executionReceiptId: receiptId, completionProofId: 'wt-1' }]]),
    });
    const report = await supervisor.tick();
    expect(report.settled).toEqual([id]);
    expect(state(id).state).toBe('completed');
  });

  it('conclusive pre-accept failure requeues bounded (backoff keeps it undue this tick)', async () => {
    const id = await claimedObligation();
    const { supervisor, dispatches } = makeSupervisor(
      { settlement: new Map([[id, { kind: 'pre_accept_failure' }]]) },
      { backoffSeconds: 3600 },
    );
    const report = await supervisor.tick();
    expect(report.requeuedAfterPreAcceptFailure).toEqual([id]);
    expect(state(id).state).toBe('waiting_capability');
    // The backoff makes it not-due, so the same tick's scan did not re-claim it.
    expect(dispatches).toEqual([]);
  });

  it('with zero backoff a requeued obligation is immediately reclaimed by the same tick (bounded by attempts)', async () => {
    const id = await claimedObligation();
    const { supervisor } = makeSupervisor({
      settlement: new Map([[id, { kind: 'pre_accept_failure' }]]),
    });
    const report = await supervisor.tick();
    expect(report.requeuedAfterPreAcceptFailure).toEqual([id]);
    expect(state(id)).toEqual({ state: 'claimed', attempt_count: 2 });
  });

  it('ambiguous execution quarantines and is not auto-retried', async () => {
    const id = await claimedObligation();
    const { supervisor } = makeSupervisor({
      settlement: new Map([[id, { kind: 'ambiguous' }]]),
    });
    const report = await supervisor.tick();
    expect(report.quarantinedAmbiguous).toEqual([id]);
    expect(state(id).state).toBe('blocked_ambiguous');
    // A later tick does nothing further to it.
    const again = await supervisor.tick();
    expect(again.settled).toEqual([]);
    expect(state(id).state).toBe('blocked_ambiguous');
  });

  it('no evidence yet = still running; nothing changes', async () => {
    const id = await claimedObligation();
    const { supervisor } = makeSupervisor({});
    const report = await supervisor.tick();
    expect(report.settled).toEqual([]);
    expect(state(id).state).toBe('claimed');
  });
});

describe('lease reclaim wiring (D7)', () => {
  it('expired unaccepted leases requeue; accepted ones quarantine', async () => {
    const a = seedObligation({ sourceMessageId: 'TESTMSG-SUP-A', sourceInboundSeq: 2002 });
    const b = seedObligation({ sourceMessageId: 'TESTMSG-SUP-B', sourceInboundSeq: 2003 });
    freshAttestation();
    const { supervisor } = makeSupervisor({ dispatch: 'dispatched' });
    await supervisor.tick();
    db.raw
      .prepare("UPDATE capability_obligations SET claim_expires_at = datetime('now','-5 seconds') WHERE id IN (?, ?)")
      .run(a, b);
    const { supervisor: reclaimer } = makeSupervisor({ accepted: [b] });
    const report = await reclaimer.tick();
    expect(report.reclaimed.requeued).toContain(a);
    expect(report.reclaimed.quarantined).toContain(b);
    expect(state(b).state).toBe('blocked_ambiguous');
  });
});
