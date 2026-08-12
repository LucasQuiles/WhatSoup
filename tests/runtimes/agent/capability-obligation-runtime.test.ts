/**
 * Capability-obligation runtime integration — the REAL ports over the live
 * durability schema: attestation binding from live facts + activation options,
 * dispatch journaling of the minted inbound, D6 receipt persistence from typed
 * stream events, and evidence settlement over inbound_events /
 * turn_terminal_records / capability_execution_receipts. Real SQLite; the
 * runtime pipeline entry is a scripted closure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordCapabilityAttestation } from '../../../src/core/capability-attestation.ts';
import { parseCapabilityObligationsOptions, type CapabilityObligationsOptions } from '../../../src/core/capability-contract.ts';
import { CapabilityObligationStore } from '../../../src/core/capability-obligation-store.ts';
import { Database } from '../../../src/core/database.ts';
import { withTransaction } from '../../../src/core/db-tx.ts';
import {
  CapabilityObligationRuntime,
  matchesCapabilityExecution,
  resolveReleaseIdentity,
  type CapabilityObligationLiveFacts,
} from '../../../src/runtimes/agent/capability-obligation-runtime.ts';
import type { ObligationDispatchOutcome } from '../../../src/runtimes/agent/capability-obligation-supervisor.ts';

const OPTIONS = parseCapabilityObligationsOptions({
  enabled: true,
  contract: {
    version: 'test-contract/1',
    rules: [
      { id: 'watch-url', kind: 'url_host', hosts: ['youtu.be'], capability: 'child_process_tools' },
    ],
  },
  mediaRoot: '/var/obligation-media',
  retentionPolicyVersion: 'policy/1',
  retentionHorizonDays: 30,
  receipt: { toolName: 'Bash', commandMarker: 'watch.py', minOutputBytes: 8 },
  attestation: {
    skillName: 'watch',
    skillVersion: '1.0.0',
    skillDigest: 'skill-digest-1',
    resolverDigest: 'resolver-digest-1',
    dependencyVersions: { 'yt-dlp': '2026.03.17' },
    probeVersion: 'probe/1',
    canaryId: 'canary-1',
  },
}) as CapabilityObligationsOptions;

const LIVE_FACTS: CapabilityObligationLiveFacts = {
  hostId: 'test-host',
  runtimeUser: 'test-user',
  releaseSha: 'relsha-live',
  schemaVersion: 57,
  providerId: 'claude-cli',
  harnessType: 'persistent_session',
};

let db: Database;
let store: CapabilityObligationStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.open();
  store = new CapabilityObligationStore(db);
});

afterEach(() => {
  db.close();
});

function freshAttestation(): void {
  recordCapabilityAttestation(db, {
    ...LIVE_FACTS,
    contractVersion: 'test-contract/1',
    capability: 'child_process_tools',
    skillName: OPTIONS.attestation.skillName,
    skillVersion: OPTIONS.attestation.skillVersion,
    skillDigest: OPTIONS.attestation.skillDigest,
    resolverDigest: OPTIONS.attestation.resolverDigest,
    dependencyVersions: OPTIONS.attestation.dependencyVersions,
    probeVersion: OPTIONS.attestation.probeVersion,
    canaryId: OPTIONS.attestation.canaryId,
    mediaRoot: OPTIONS.mediaRoot,
    canaryResult: 'pass',
    nonce: `n-${Math.random().toString(36).slice(2)}`,
    attestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
}

function seedObligation(over: { sourceInboundSeq?: number; sourceMessageId?: string } = {}): number {
  let id = 0;
  withTransaction(db, () => {
    id = store.applyDecisionWithinCallerTransaction({
      auditEvent: { action: 'obligation.create', actorType: 'runtime', reasonCode: 'conclusive_no_effect' },
      obligation: {
        sourceInboundSeq: over.sourceInboundSeq ?? 5001,
        sourceMessageId: over.sourceMessageId ?? 'TESTMSG-RT-1',
        conversationKey: 'conv-rt',
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
        retainedMedia: null,
        creationReason: 'typed_deferral_signal',
      },
    }).obligationId!;
  });
  return id;
}

function journalInboundRaw(messageId: string): number {
  const res = db.raw
    .prepare(
      `INSERT INTO inbound_events (message_id, conversation_key, chat_jid, routed_to)
       VALUES (?, 'conv-rt', 'test-dm-target@lid', 'agent')`,
    )
    .run(messageId);
  return Number(res.lastInsertRowid);
}

function insertTerminal(inboundSeq: number, deliveryKind: string, deliveryOpId: number | null): number {
  const res = db.raw
    .prepare(
      `INSERT INTO turn_terminal_records (
         scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
         logical_turn_id, manager_id, generation, attempt_kind,
         inbound_disposition, delivery_kind, delivery_op_id, reply_guarantee_disarmed
       ) VALUES ('per_chat', 'conv-rt', 'test-dm-target@lid', ?, ?,
                 'obl-turn', 'mgr-1', 1, 'replied', 'completed', ?, ?, 0)`,
    )
    .run(inboundSeq, inboundSeq, deliveryKind, deliveryOpId);
  return Number(res.lastInsertRowid);
}

interface HarnessScript {
  dispatchOutcome?: ObligationDispatchOutcome;
  onDispatch?: (mapKey: string, runtime: CapabilityObligationRuntime) => void;
  journalThrows?: boolean;
}

function makeRuntime(script: HarnessScript = {}) {
  const dispatched: Array<{ id: number; minted: string; seq: number }> = [];
  const runtime = new CapabilityObligationRuntime({
    db,
    store,
    options: OPTIONS,
    liveFacts: () => LIVE_FACTS,
    getDurability: () =>
      script.journalThrows
        ? null
        : { journalInbound: (messageId: string) => journalInboundRaw(messageId) },
    dispatchTurn: async (obligation, minted, seq) => {
      dispatched.push({ id: obligation.id, minted, seq });
      script.onDispatch?.(runtime.resolveRecorderKey(obligation.deliveryJid), runtime);
      return script.dispatchOutcome ?? 'dispatched';
    },
  });
  return { runtime, dispatched };
}

const state = (id: number) =>
  (db.raw.prepare('SELECT state, attempt_count FROM capability_obligations WHERE id=?').get(id) as {
    state: string;
    attempt_count: number;
  });

describe('attestation port (D5)', () => {
  it('admits and dispatches only when live facts + options match a recorded attestation', async () => {
    const id = seedObligation();
    const { runtime, dispatched } = makeRuntime();
    let report = (await runtime.tickOnce()) as { attestationSkips: Array<{ id: number; reason: string }> };
    expect(report.attestationSkips).toEqual([{ id, reason: 'none_recorded' }]);
    expect(dispatched).toEqual([]);

    freshAttestation();
    report = (await runtime.tickOnce()) as never;
    expect(dispatched).toEqual([{ id, minted: `obl:${id}:1`, seq: expect.any(Number) }]);
    expect(state(id)).toEqual({ state: 'claimed', attempt_count: 1 });
  });
});

describe('dispatch port (D7)', () => {
  it('journals the minted inbound before entering the pipeline', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime();
    await runtime.tickOnce();
    const row = db.raw
      .prepare('SELECT conversation_key, chat_jid FROM inbound_events WHERE message_id = ?')
      .get(`obl:${id}:1`) as { conversation_key: string; chat_jid: string };
    expect(row).toEqual({ conversation_key: 'conv-rt', chat_jid: 'test-dm-target@lid' });
  });

  it('a journaling failure requeues bounded without a minted inbound', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime, dispatched } = makeRuntime({ journalThrows: true });
    const report = (await runtime.tickOnce()) as { requeuedRetryable: number[] };
    expect(report.requeuedRetryable).toEqual([id]);
    expect(dispatched).toEqual([]);
    expect(state(id).state).toBe('waiting_capability');
  });
});

describe('receipt recorder (D6)', () => {
  it('persists an ok receipt ONLY for the declared execution invocation with real output', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime({
      onDispatch: (mapKey, rt) => {
        rt.onStreamEvent(mapKey, {
          type: 'tool_use',
          toolName: 'Bash',
          toolId: 'tu-1',
          toolInput: { command: 'python3 /skills/watch/watch.py --url https://youtu.be/abc' },
        });
        rt.onStreamEvent(mapKey, {
          type: 'tool_result',
          isError: false,
          toolId: 'tu-1',
          content: 'frames extracted; transcript ready',
        });
      },
    });
    await runtime.tickOnce();
    const receipt = db.raw
      .prepare(
        `SELECT obligation_id, tool_use_id, result_status, claim_epoch, attempt_number, input_digest
         FROM capability_execution_receipts WHERE obligation_id = ?`,
      )
      .get(id) as Record<string, unknown>;
    expect(receipt).toEqual({
      obligation_id: id,
      tool_use_id: 'tu-1',
      result_status: 'ok',
      claim_epoch: 1,
      attempt_number: 1,
      input_digest: 'aa'.repeat(32),
    });
  });

  it('a Skill LOAD is not execution — no receipt at all', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime({
      onDispatch: (mapKey, rt) => {
        rt.onStreamEvent(mapKey, { type: 'tool_use', toolName: 'Skill', toolId: 'tu-s', toolInput: { skill: 'watch' } });
        rt.onStreamEvent(mapKey, { type: 'tool_result', isError: false, toolId: 'tu-s', content: 'skill loaded successfully' });
      },
    });
    await runtime.tickOnce();
    const count = (db.raw
      .prepare('SELECT COUNT(*) AS c FROM capability_execution_receipts WHERE obligation_id = ?')
      .get(id) as { c: number }).c;
    expect(count).toBe(0);
  });

  it('unmarked Bash is ignored; errored or evidence-thin execution records an error receipt', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime({
      onDispatch: (mapKey, rt) => {
        rt.onStreamEvent(mapKey, { type: 'tool_use', toolName: 'Bash', toolId: 'tu-x', toolInput: { command: 'ls -la' } });
        rt.onStreamEvent(mapKey, { type: 'tool_result', isError: false, toolId: 'tu-x', content: 'ls output here' });
        rt.onStreamEvent(mapKey, { type: 'tool_use', toolName: 'Bash', toolId: 'tu-y', toolInput: { command: 'python3 watch.py x' } });
        rt.onStreamEvent(mapKey, { type: 'tool_result', isError: true, toolId: 'tu-y', content: 'traceback: boom' });
        rt.onStreamEvent(mapKey, { type: 'tool_use', toolName: 'Bash', toolId: 'tu-z', toolInput: { command: 'python3 watch.py y' } });
        rt.onStreamEvent(mapKey, { type: 'tool_result', isError: false, toolId: 'tu-z', content: 'ok' }); // 2 bytes < min 8
      },
    });
    await runtime.tickOnce();
    const rows = db.raw
      .prepare('SELECT tool_use_id, result_status FROM capability_execution_receipts WHERE obligation_id = ? ORDER BY id')
      .all(id) as Array<{ tool_use_id: string; result_status: string }>;
    expect(rows).toEqual([
      { tool_use_id: 'tu-y', result_status: 'error' },
      { tool_use_id: 'tu-z', result_status: 'error' },
    ]);
  });

  it('events outside an active obligation turn are no-ops', () => {
    const { runtime } = makeRuntime();
    expect(() =>
      runtime.onStreamEvent('some-chat@lid', {
        type: 'tool_use',
        toolName: 'Bash',
        toolId: 'tu-z',
        toolInput: { command: 'python3 watch.py x' },
      }),
    ).not.toThrow();
    const count = (db.raw.prepare('SELECT COUNT(*) AS c FROM capability_execution_receipts').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});

describe('evidence port (D6/D7)', () => {
  async function dispatchedObligation(script: HarnessScript = {}): Promise<number> {
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime(script);
    await runtime.tickOnce();
    expect(state(id).state).toBe('claimed');
    return id;
  }

  it('completes on receipt + echoed terminal with a delivery op', async () => {
    const id = await dispatchedObligation({
      onDispatch: (mapKey, rt) => {
        rt.onStreamEvent(mapKey, { type: 'tool_use', toolName: 'Bash', toolId: 'tu-1', toolInput: { command: 'python3 watch.py go' } });
        rt.onStreamEvent(mapKey, { type: 'tool_result', isError: false, toolId: 'tu-1', content: 'frames + transcript done' });
      },
    });
    const seq = (db.raw.prepare('SELECT seq FROM inbound_events WHERE message_id = ?').get(`obl:${id}:1`) as { seq: number }).seq;
    const terminalId = insertTerminal(seq, 'echoed', 424242);
    const { runtime: settler } = makeRuntime();
    const report = (await settler.tickOnce()) as { settled: number[] };
    expect(report.settled).toEqual([id]);
    const row = db.raw
      .prepare('SELECT state, completion_proof_id FROM capability_obligations WHERE id=?')
      .get(id) as { state: string; completion_proof_id: string };
    expect(row.state).toBe('completed');
    expect(row.completion_proof_id).toBe(`ttr:${terminalId}`);
  });

  it('a terminal record WITHOUT a receipt quarantines (never completes, never retries)', async () => {
    const id = await dispatchedObligation();
    const seq = (db.raw.prepare('SELECT seq FROM inbound_events WHERE message_id = ?').get(`obl:${id}:1`) as { seq: number }).seq;
    insertTerminal(seq, 'echoed', 424242);
    const { runtime: settler } = makeRuntime();
    const report = (await settler.tickOnce()) as { quarantinedAmbiguous: number[] };
    expect(report.quarantinedAmbiguous).toEqual([id]);
    expect(state(id).state).toBe('blocked_ambiguous');
  });

  it('a receipt WITHOUT echoed delivery proof quarantines', async () => {
    const id = await dispatchedObligation({
      onDispatch: (mapKey, rt) => {
        rt.onStreamEvent(mapKey, { type: 'tool_use', toolName: 'Bash', toolId: 'tu-1', toolInput: { command: 'python3 watch.py go' } });
        rt.onStreamEvent(mapKey, { type: 'tool_result', isError: false, toolId: 'tu-1', content: 'frames + transcript done' });
      },
    });
    const seq = (db.raw.prepare('SELECT seq FROM inbound_events WHERE message_id = ?').get(`obl:${id}:1`) as { seq: number }).seq;
    insertTerminal(seq, 'flushed', 424242);
    const { runtime: settler } = makeRuntime();
    const report = (await settler.tickOnce()) as { quarantinedAmbiguous: number[] };
    expect(report.quarantinedAmbiguous).toEqual([id]);
  });

  it('no terminal record yet = still running; nothing changes', async () => {
    const id = await dispatchedObligation();
    const { runtime: settler } = makeRuntime();
    const report = (await settler.tickOnce()) as { settled: number[]; quarantinedAmbiguous: number[] };
    expect(report.settled).toEqual([]);
    expect(report.quarantinedAmbiguous).toEqual([]);
    expect(state(id).state).toBe('claimed');
  });

  it('lease reclaim: journaled minted inbound counts as provider acceptance (quarantine); unjournaled requeues', async () => {
    const accepted = await dispatchedObligation();
    const unaccepted = seedObligation({ sourceInboundSeq: 5002, sourceMessageId: 'TESTMSG-RT-2' });
    db.raw
      .prepare("UPDATE capability_obligations SET claim_expires_at = datetime('now','-5 seconds') WHERE id = ?")
      .run(accepted);
    // Claim the second WITHOUT journaling (simulate crash before journal).
    const claim = store.claimObligation(unaccepted, { claimToken: 'tok-u', leaseSeconds: 300 });
    expect(claim.applied).toBe(true);
    db.raw
      .prepare("UPDATE capability_obligations SET claim_expires_at = datetime('now','-5 seconds') WHERE id = ?")
      .run(unaccepted);
    const { runtime } = makeRuntime();
    const report = (await runtime.tickOnce()) as { reclaimed: { requeued: number[]; quarantined: number[] } };
    expect(report.reclaimed.quarantined).toContain(accepted);
    expect(report.reclaimed.requeued).toContain(unaccepted);
  });
});

describe('helpers', () => {
  it('matchesCapabilityExecution requires the declared tool AND the command marker', () => {
    const rule = OPTIONS.receipt;
    expect(matchesCapabilityExecution(rule, 'Bash', { command: 'python3 watch.py --x' })).toBe(true);
    expect(matchesCapabilityExecution(rule, 'Bash', { command: 'ls -la' })).toBe(false);
    expect(matchesCapabilityExecution(rule, 'Skill', { skill: 'watch' })).toBe(false);
    expect(matchesCapabilityExecution(rule, 'Skill', { skill: 'watch.py' })).toBe(false);
    expect(matchesCapabilityExecution(rule, 'Bash', {})).toBe(false);
  });

  it('resolveReleaseIdentity: env wins, release-dir basename next, sentinel otherwise', () => {
    expect(resolveReleaseIdentity('/opt/WhatSoup-release-abc1234', { WHATSOUP_RELEASE_SHA: 'envsha' })).toBe('envsha');
    expect(resolveReleaseIdentity('/opt/WhatSoup-release-abc1234', {})).toBe('abc1234');
    expect(resolveReleaseIdentity('/opt/whatsoup-dev-checkout', {})).toBe('unreleased-dev-tree');
  });
});
