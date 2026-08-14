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

import {
  findAdmissibleAttestation,
  recordCapabilityAttestation,
  type CapabilityAttestationBinding,
} from '../../../src/core/capability-attestation.ts';
import {
  CapabilityObligationStore,
  type CapabilityObligationClaimFence,
  type CapabilityObligationDueRow,
} from '../../../src/core/capability-obligation-store.ts';
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
  /** Per-call dispatch override; receives the fence so a rival's fenced write can race the outcome. */
  dispatchFn?: (
    obligationId: number,
    mintedMessageId: string,
    fence: CapabilityObligationClaimFence,
  ) => Promise<ObligationDispatchOutcome>;
  /** prepare() resolves an undispatchable target: binding still admits, dispatch is null. */
  nullDispatch?: boolean;
  /** Side effect between the due-scan and admission — a rival scanner's window. */
  onPrepare?: (obligation: CapabilityObligationDueRow) => void;
  accepted?: number[];
  settlement?: Map<number, ObligationSettlementEvidence>;
  /** Per-call settlement override; runs before the supervisor's fenced settle writes. */
  settlementFn?: (
    id: number,
    attempt: { claimEpoch: number; attemptCount: number },
  ) => ObligationSettlementEvidence | undefined;
}

function makeSupervisor(
  script: Script,
  options: { backoffSeconds?: number; mediaMaxAgeSeconds?: number; store?: CapabilityObligationStore } = {},
) {
  const dispatches: Array<{ id: number; mintedMessageId: string }> = [];
  const supervisor = new CapabilityObligationSupervisor({
    db,
    store: options.store ?? store,
    backoffSeconds: options.backoffSeconds ?? 0,
    mediaMaxAgeSeconds: options.mediaMaxAgeSeconds,
    dispatchPort: {
      // r14 F3 — merged prepare: one resolution yields the binding AND the dispatch.
      prepare: (obligation) => {
        script.onPrepare?.(obligation);
        return {
          binding: { ...BINDING, contractVersion: obligation.contractVersion },
          dispatch: script.nullDispatch
            ? null
            : async (mintedMessageId, fence) => {
                dispatches.push({ id: obligation.id, mintedMessageId });
                if (script.dispatchFn) return script.dispatchFn(obligation.id, mintedMessageId, fence);
                const outcome = script.dispatch ?? 'dispatched';
                if (outcome instanceof Error) throw outcome;
                return outcome;
              },
        };
      },
    },
    evidencePort: {
      providerAcceptedIds: () => new Set(script.accepted ?? []),
      settlementEvidence: (id, attempt) =>
        script.settlementFn ? script.settlementFn(id, attempt) : script.settlement?.get(id),
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
        sourceDigest: (over.retainedMedia as { sha256?: string } | null)?.sha256 ?? 'bb'.repeat(32),
        sourceToken: over.retainedMedia ? null : 'https://youtu.be/abc',
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

/** The live fence of a claimed obligation — what any rival replica would read from the database. */
const fenceOf = (id: number): CapabilityObligationClaimFence => {
  const row = db.raw
    .prepare('SELECT claim_token, claim_epoch FROM capability_obligations WHERE id=?')
    .get(id) as { claim_token: string; claim_epoch: number };
  return { claimToken: row.claim_token, claimEpoch: row.claim_epoch };
};

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

  it('retained media past the finite horizon blocks without claiming (A-08) even when the bytes are intact', async () => {
    // A zero-second horizon makes any retained media already expired without
    // touching created_at (which the schema keeps immutable).
    const src = join(dir, 'old.webm');
    writeFileSync(src, 'still-intact-bytes');
    const retained = await retainMediaForObligation({ root: join(dir, 'retained'), policyVersion: 'p/1' }, src);
    const id = seedObligation({
      retainedMedia: { path: retained.path, sha256: retained.sha256, bytes: retained.bytes, policyVersion: 'p/1' },
    });
    freshAttestation();
    const { supervisor, dispatches } = makeSupervisor({}, { mediaMaxAgeSeconds: 0 });
    const report = await supervisor.tick();
    expect(report.mediaBlocked).toEqual([id]);
    expect(report.claimed).toEqual([]);
    expect(dispatches).toEqual([]);
    expect(state(id)).toEqual({ state: 'blocked_media', attempt_count: 0 });
  });

  it('an expired-media obligation a rival scanner already blocked is not double-blocked or double-reported', async () => {
    // The rival blocks the row between the due-scan and this scanner's own
    // horizon block: the CAS on waiting_capability refuses, report stays empty.
    const src = join(dir, 'expired.webm');
    writeFileSync(src, 'expired-bytes');
    const retained = await retainMediaForObligation({ root: join(dir, 'retained'), policyVersion: 'p/1' }, src);
    const id = seedObligation({
      retainedMedia: { path: retained.path, sha256: retained.sha256, bytes: retained.bytes, policyVersion: 'p/1' },
    });
    freshAttestation();
    const { supervisor, dispatches } = makeSupervisor(
      { onPrepare: (obligation) => void store.blockWaitingObligation(obligation.id, 'rival_scanner') },
      { mediaMaxAgeSeconds: 0 },
    );
    const report = await supervisor.tick();
    expect(report.mediaBlocked).toEqual([]);
    expect(report.claimed).toEqual([]);
    expect(dispatches).toEqual([]);
    expect(state(id)).toEqual({ state: 'blocked_media', attempt_count: 0 });
  });

  it('a mismatched-media obligation a rival scanner already blocked is not double-blocked or double-reported', async () => {
    // Same race on the integrity-mismatch path: the rival's block lands during
    // this scanner's admission/verify window, so the second block must no-op.
    const src = join(dir, 'corrupt.webm');
    writeFileSync(src, 'original-bytes');
    const retained = await retainMediaForObligation({ root: join(dir, 'retained'), policyVersion: 'p/1' }, src);
    writeFileSync(retained.path, 'corrupted-bytes!');
    const id = seedObligation({
      retainedMedia: { path: retained.path, sha256: retained.sha256, bytes: retained.bytes, policyVersion: 'p/1' },
    });
    freshAttestation();
    const { supervisor, dispatches } = makeSupervisor({
      onPrepare: (obligation) => void store.blockWaitingObligation(obligation.id, 'rival_scanner'),
    });
    const report = await supervisor.tick();
    expect(report.mediaBlocked).toEqual([]);
    expect(report.claimed).toEqual([]);
    expect(dispatches).toEqual([]);
    expect(state(id)).toEqual({ state: 'blocked_media', attempt_count: 0 });
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

  it('a throwing dispatch is QUARANTINED fail-closed (ambiguous), never retried or crashing the tick', async () => {
    // A throw that escapes the dispatch port cannot be proven pre-boundary, so it
    // must fail closed to blocked_ambiguous — auto-retrying a possibly-effected
    // turn is the r13 Critical.
    const id = seedObligation();
    freshAttestation();
    const { supervisor } = makeSupervisor({ dispatch: new Error('boom') });
    const report = await supervisor.tick();
    expect(report.requeuedRetryable).toEqual([]);
    expect(report.quarantinedAmbiguous).toEqual([id]);
    expect(state(id).state).toBe('blocked_ambiguous');
  });

  it("a dispatch that returns 'ambiguous' (crossed the provider boundary then failed) quarantines, never auto-retries", async () => {
    const id = seedObligation();
    freshAttestation();
    const { supervisor } = makeSupervisor({ dispatch: 'ambiguous' });
    const report = await supervisor.tick();
    expect(report.quarantinedAmbiguous).toEqual([id]);
    expect(report.requeuedRetryable).toEqual([]);
    expect(state(id).state).toBe('blocked_ambiguous');
    // A later tick must NOT re-dispatch a quarantined obligation.
    const report2 = await supervisor.tick();
    expect(report2.dispatched).toEqual([]);
    expect(state(id).state).toBe('blocked_ambiguous');
  });

  it('an admitted claim whose prepared target became undispatchable requeues fail-closed under the fence', async () => {
    // prepare() resolved a target good enough to admit, but its dispatch is
    // null (undispatchable). Nothing crossed the provider boundary, so the
    // fail-closed guard requeues bounded instead of quarantining.
    const id = seedObligation();
    freshAttestation();
    const { supervisor, dispatches } = makeSupervisor({ nullDispatch: true }, { backoffSeconds: 3600 });
    const report = await supervisor.tick();
    expect(report.claimed).toEqual([id]);
    expect(report.requeuedRetryable).toEqual([id]);
    expect(report.dispatched).toEqual([]);
    expect(report.quarantinedAmbiguous).toEqual([]);
    expect(dispatches).toEqual([]);
    expect(state(id)).toEqual({ state: 'waiting_capability', attempt_count: 1 });
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
      sourceDigest: 'bb'.repeat(32),
    });
    db.raw
      .prepare(
        `INSERT INTO inbound_events (message_id, conversation_key, chat_jid, routed_to)
         VALUES (?, 'conv-sup', 'test-dm-target@lid', 'agent')`,
      )
      .run(`obl:${id}:1`);
    const seq = (db.raw.prepare('SELECT seq FROM inbound_events WHERE message_id = ?').get(`obl:${id}:1`) as { seq: number }).seq;
    db.raw
      .prepare(
        `INSERT INTO turn_terminal_records (
           scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
           logical_turn_id, manager_id, generation, attempt_kind,
           inbound_disposition, delivery_kind, delivery_op_id, reply_guarantee_disarmed
         ) VALUES ('per_chat', 'conv-sup', 'test-dm-target@lid', ?, ?, 'turn-1', 'mgr-1', 1,
                   'replied', 'completed', 'echoed', 424242, 0)`,
      )
      .run(seq, seq);
    const terminalId = Number(
      (db.raw.prepare('SELECT id FROM turn_terminal_records WHERE inbound_seq = ?').get(seq) as { id: number }).id,
    );
    const { supervisor } = makeSupervisor({
      settlement: new Map([[id, { kind: 'completed', executionReceiptId: receiptId, completionProofId: `ttr:${terminalId}` }]]),
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

  it('without an explicit backoff the runtime default keeps a requeued obligation off the same tick', async () => {
    // No backoffSeconds option: OBLIGATION_BACKOFF_SECONDS (60s) applies, so
    // the default configuration cannot hot-loop a requeue back into the same
    // tick's scan.
    const id = await claimedObligation();
    const dispatches: string[] = [];
    const supervisor = new CapabilityObligationSupervisor({
      db,
      store,
      dispatchPort: {
        prepare: (obligation) => ({
          binding: { ...BINDING, contractVersion: obligation.contractVersion },
          dispatch: async (mintedMessageId) => {
            dispatches.push(mintedMessageId);
            return 'dispatched';
          },
        }),
      },
      evidencePort: {
        providerAcceptedIds: () => new Set(),
        settlementEvidence: (obligationId) =>
          obligationId === id ? { kind: 'pre_accept_failure' } : undefined,
      },
    });
    const report = await supervisor.tick();
    expect(report.requeuedAfterPreAcceptFailure).toEqual([id]);
    expect(state(id)).toEqual({ state: 'waiting_capability', attempt_count: 1 });
    expect(dispatches).toEqual([]);
  });

  it('completed evidence that fails the receipt binding does not settle (fail-closed, stays claimed)', async () => {
    // The typed chain is validated inside settleCompleted itself: evidence
    // naming a receipt/proof that does not bind to THIS claim must be refused,
    // never reported as settled.
    const id = await claimedObligation();
    const { supervisor } = makeSupervisor({
      settlement: new Map([[id, { kind: 'completed', executionReceiptId: 999999, completionProofId: 'ttr:999999' }]]),
    });
    const report = await supervisor.tick();
    expect(report.settled).toEqual([]);
    expect(state(id)).toEqual({ state: 'claimed', attempt_count: 1 });
  });

  it('a settlement a rival replica already applied under the same fence is not double-applied or double-reported', async () => {
    // Two replicas read the same durable evidence. The rival's fenced write
    // lands first (inside our evidence read, before our fenced write); our own
    // requeue/block CAS then refuses, and the report must not count it.
    const a = seedObligation({ sourceMessageId: 'TESTMSG-SUP-RIVAL-A', sourceInboundSeq: 2020 });
    const b = seedObligation({ sourceMessageId: 'TESTMSG-SUP-RIVAL-B', sourceInboundSeq: 2021 });
    freshAttestation();
    const { supervisor: claimer } = makeSupervisor({ dispatch: 'dispatched' });
    await claimer.tick();
    expect(state(a).state).toBe('claimed');
    expect(state(b).state).toBe('claimed');
    const { supervisor } = makeSupervisor({
      settlementFn: (id) => {
        if (id === a) {
          store.requeueObligation(a, fenceOf(a), { backoffSeconds: 3600 });
          return { kind: 'pre_accept_failure' };
        }
        store.blockObligation(b, fenceOf(b), 'blocked_ambiguous', 'execution_outcome_ambiguous');
        return { kind: 'ambiguous' };
      },
    });
    const report = await supervisor.tick();
    expect(report.requeuedAfterPreAcceptFailure).toEqual([]);
    expect(report.quarantinedAmbiguous).toEqual([]);
    // The rival's single application stands.
    expect(state(a)).toEqual({ state: 'waiting_capability', attempt_count: 1 });
    expect(state(b).state).toBe('blocked_ambiguous');
  });
});

describe('single-flight claim and fence races (D7)', () => {
  it('a claim lost to a rival scanner consumes nothing and dispatches nothing', async () => {
    const id = seedObligation();
    freshAttestation();
    const { supervisor, dispatches } = makeSupervisor({
      onPrepare: (obligation) => {
        // A rival scanner claims through the same admission path between our
        // due-scan and our claim CAS.
        const admission = findAdmissibleAttestation(db, { ...BINDING, contractVersion: obligation.contractVersion });
        if (admission.outcome !== 'admissible') throw new Error('test setup: expected an admissible attestation');
        store.claimObligation(obligation.id, {
          claimToken: 'rival-token',
          leaseSeconds: 300,
          admissionAttestationId: admission.attestationId,
        });
      },
    });
    const report = await supervisor.tick();
    expect(report.claimed).toEqual([]);
    expect(report.dispatched).toEqual([]);
    expect(dispatches).toEqual([]);
    // Exactly the rival's attempt was consumed — losing the race costs nothing.
    expect(state(id)).toEqual({ state: 'claimed', attempt_count: 1 });
  });

  it("a 'retryable' outcome whose fence a rival already spent does not double-requeue or double-report", async () => {
    const id = seedObligation();
    freshAttestation();
    const { supervisor } = makeSupervisor({
      dispatchFn: async (obligationId, _minted, fence) => {
        store.requeueObligation(obligationId, fence, { backoffSeconds: 3600 });
        return 'retryable';
      },
    });
    const report = await supervisor.tick();
    expect(report.claimed).toEqual([id]);
    expect(report.requeuedRetryable).toEqual([]);
    expect(state(id)).toEqual({ state: 'waiting_capability', attempt_count: 1 });
  });

  it("an 'ambiguous' outcome whose fence a rival already spent stays quarantined once, reported once", async () => {
    const id = seedObligation();
    freshAttestation();
    const { supervisor } = makeSupervisor({
      dispatchFn: async (obligationId, _minted, fence) => {
        store.blockObligation(obligationId, fence, 'blocked_ambiguous', 'rival_replica');
        return 'ambiguous';
      },
    });
    const report = await supervisor.tick();
    expect(report.claimed).toEqual([id]);
    expect(report.quarantinedAmbiguous).toEqual([]);
    expect(state(id).state).toBe('blocked_ambiguous');
  });

  it('the fail-closed requeue for an undispatchable target is applied once under replica double-delivery', async () => {
    const id = seedObligation();
    freshAttestation();
    // Model a rival replica whose IDENTICAL fenced requeue lands in the window
    // before ours: the real store method runs twice — the second CAS refuses on
    // state — so the supervisor must not report a requeue it did not apply.
    const racing = new CapabilityObligationStore(db);
    const realRequeue = racing.requeueObligation.bind(racing);
    racing.requeueObligation = (obligationId, fence, params) => {
      realRequeue(obligationId, fence, params);
      return realRequeue(obligationId, fence, params);
    };
    const { supervisor } = makeSupervisor({ nullDispatch: true }, { backoffSeconds: 3600, store: racing });
    const report = await supervisor.tick();
    expect(report.claimed).toEqual([id]);
    expect(report.requeuedRetryable).toEqual([]);
    expect(state(id)).toEqual({ state: 'waiting_capability', attempt_count: 1 });
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
