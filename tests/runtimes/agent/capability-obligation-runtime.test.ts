/**
 * Capability-obligation runtime integration — the REAL ports over the live
 * durability schema: attestation binding from live facts + activation options,
 * dispatch journaling of the minted inbound, D6 receipt persistence from typed
 * stream events, and evidence settlement over inbound_events /
 * turn_terminal_records / capability_execution_receipts. Real SQLite; the
 * runtime pipeline entry is a scripted closure.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordCapabilityAttestation } from '../../../src/core/capability-attestation.ts';
import { parseCapabilityObligationsOptions, type CapabilityObligationsOptions } from '../../../src/core/capability-contract.ts';
import { CapabilityObligationStore } from '../../../src/core/capability-obligation-store.ts';
import { Database } from '../../../src/core/database.ts';
import { withTransaction } from '../../../src/core/db-tx.ts';
import {
  CapabilityObligationRuntime,
  resolveReleaseIdentity,
  type CapabilityObligationLiveFacts,
} from '../../../src/runtimes/agent/capability-obligation-runtime.ts';
import type { ObligationDispatchOutcome } from '../../../src/runtimes/agent/capability-obligation-supervisor.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { ToolDeclaration } from '../../../src/mcp/types.ts';

const TOOL_SESSION: SessionContext = { tier: 'chat', conversationKey: 'conv-rt', deliveryJid: 'test-dm-target@lid' };

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
  execution: {
    command: ['node', '-e', 'console.log("processed " + process.argv[1] + " frames+transcript ok")', '{source}'],
    timeoutMs: 30_000,
    minOutputBytes: 8,
  },
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

const SOURCE_URL = 'https://youtu.be/abc';
const SOURCE_DIGEST = createHash('sha256').update(SOURCE_URL).digest('hex');

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

function seedObligation(
  over: { sourceInboundSeq?: number; sourceMessageId?: string; sourceDigest?: string; replayText?: string } = {},
): number {
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
        replayText: over.replayText ?? 'https://youtu.be/abc',
        contentTypeHint: 'text',
        contractVersion: 'test-contract/1',
        requiredCapability: 'child_process_tools',
        capabilityParams: '{"skill":"watch"}',
        inputDigest: 'aa'.repeat(32),
        sourceDigest: over.sourceDigest ?? SOURCE_DIGEST,
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
  /** Runs DURING the dispatched turn — the window where execute_capability works. */
  onDispatch?: (tool: ToolDeclaration, runtime: CapabilityObligationRuntime) => Promise<void> | void;
  journalThrows?: boolean;
  execution?: CapabilityObligationsOptions['execution'];
}

function makeRuntime(script: HarnessScript = {}) {
  const dispatched: Array<{ id: number; minted: string; seq: number }> = [];
  let registeredTool: ToolDeclaration | null = null;
  const runtime = new CapabilityObligationRuntime({
    db,
    store,
    options: script.execution === undefined ? OPTIONS : { ...OPTIONS, execution: script.execution },
    liveFacts: () => LIVE_FACTS,
    getDurability: () =>
      script.journalThrows
        ? null
        : { journalInbound: (messageId: string) => journalInboundRaw(messageId) },
    dispatchTurn: async (obligation, minted, seq) => {
      dispatched.push({ id: obligation.id, minted, seq });
      await script.onDispatch?.(registeredTool!, runtime);
      return script.dispatchOutcome ?? 'dispatched';
    },
    externalEffectFor: () => undefined,
    writeLossSince: () => false,
    registerTool: (tool) => {
      registeredTool = tool;
    },
    turnIdFor: () => 'obl-turn',
  });
  return { runtime, dispatched, tool: () => registeredTool! };
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

describe('trusted execution tool (D6)', () => {
  it('a REAL resolver run against the exact source records an ok receipt with the derived digest', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime({
      onDispatch: async (tool) => {
        const result = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as { executed?: boolean };
        expect(result.executed).toBe(true);
      },
    });
    await runtime.tickOnce();
    const receipt = db.raw
      .prepare(
        `SELECT obligation_id, result_status, claim_epoch, attempt_number, source_digest, logical_turn_id
         FROM capability_execution_receipts WHERE obligation_id = ?`,
      )
      .get(id) as Record<string, unknown>;
    expect(receipt).toEqual({
      obligation_id: id,
      result_status: 'ok',
      claim_epoch: 1,
      attempt_number: 1,
      source_digest: SOURCE_DIGEST,
      logical_turn_id: 'obl-turn',
    });
  });

  it('FALSIFIER: a forged-evidence Bash turn records NOTHING — only the handler writes receipts', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime({
      onDispatch: () => {
        // The model prints whatever it wants in its own tools; no receipt path
        // exists outside the trusted handler, so nothing to call here.
      },
    });
    await runtime.tickOnce();
    const count = (db.raw
      .prepare('SELECT COUNT(*) AS c FROM capability_execution_receipts WHERE obligation_id = ?')
      .get(id) as { c: number }).c;
    expect(count).toBe(0);
  });

  it('FALSIFIER: the wrong source records an error receipt and never runs the resolver', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime({
      onDispatch: async (tool) => {
        const result = (await tool.handler({ source: 'https://youtu.be/WRONG' }, TOOL_SESSION)) as Record<string, unknown>;
        expect(result['error']).toBe('capability_execution');
      },
    });
    await runtime.tickOnce();
    const rows = db.raw
      .prepare('SELECT result_status, source_digest FROM capability_execution_receipts WHERE obligation_id = ?')
      .all(id) as Array<{ result_status: string; source_digest: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('error');
    expect(rows[0]!.source_digest).not.toBe(SOURCE_DIGEST);
  });

  it('FALSIFIER: a failing resolver (nonzero exit) records an error receipt even with the right source', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime({
      execution: { command: ['node', '-e', 'console.log("plenty of output before dying"); process.exit(3)', '{source}'], timeoutMs: 30_000, minOutputBytes: 8 },
      onDispatch: async (tool) => {
        await tool.handler({ source: SOURCE_URL }, TOOL_SESSION);
      },
    });
    await runtime.tickOnce();
    const rows = db.raw
      .prepare('SELECT result_status, source_digest FROM capability_execution_receipts WHERE obligation_id = ?')
      .all(id) as Array<{ result_status: string; source_digest: string }>;
    expect(rows).toEqual([{ result_status: 'error', source_digest: SOURCE_DIGEST }]);
  });

  it('FALSIFIER: a source that would smuggle an argv flag is refused BEFORE the resolver spawns', async () => {
    // A leading_token remainder is arbitrary user text and can begin with '-';
    // if it lands as a standalone argv element the resolver child parses it as
    // an OPTION FLAG (argument injection). spawn() is shell-less, so this is the
    // only argv-level vector, and it must be refused before the child starts.
    //
    // Non-vacuous by construction: the resolver here HONORS a `--output=PATH`
    // flag by writing that file, so WITHOUT the guard this call would write an
    // attacker-chosen path and record an 'ok' receipt. The guard must make the
    // write never happen.
    const work = mkdtempSync(join(tmpdir(), 'capx-smuggle-'));
    try {
      const resolver = join(work, 'resolver.cjs');
      writeFileSync(
        resolver,
        `const fs=require('fs');for(const a of process.argv.slice(2)){const m=/^--output=(.+)$/.exec(a);if(m)fs.writeFileSync(m[1],'SMUGGLED');}console.log('resolver ran');`,
      );
      const smuggleTarget = join(work, 'pwned');
      const SMUGGLE_SOURCE = `--output=${smuggleTarget}`;
      const SMUGGLE_DIGEST = createHash('sha256').update(SMUGGLE_SOURCE).digest('hex');
      const id = seedObligation({ sourceDigest: SMUGGLE_DIGEST, replayText: SMUGGLE_SOURCE });
      freshAttestation();
      const { runtime } = makeRuntime({
        execution: { command: ['node', resolver, '{source}'], timeoutMs: 30_000, minOutputBytes: 1 },
        onDispatch: async (tool) => {
          const result = (await tool.handler({ source: SMUGGLE_SOURCE }, TOOL_SESSION)) as Record<string, unknown>;
          expect(result['error']).toBe('capability_execution');
        },
      });
      await runtime.tickOnce();
      // The resolver never ran: the attacker-chosen path it would have written is absent.
      expect(existsSync(smuggleTarget)).toBe(false);
      // The receipt discriminates "refused before spawn" (a `reason`, no
      // `exitCode`) from "ran and failed" (which records an exitCode).
      const row = db.raw
        .prepare('SELECT result_status, source_digest, output_evidence FROM capability_execution_receipts WHERE obligation_id = ?')
        .get(id) as { result_status: string; source_digest: string; output_evidence: string };
      expect(row.result_status).toBe('error');
      expect(row.source_digest).toBe(SMUGGLE_DIGEST);
      const evidence = JSON.parse(row.output_evidence) as Record<string, unknown>;
      expect(evidence['reason']).toBe('source_would_smuggle_option_flag');
      expect('exitCode' in evidence).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('outside an active obligation turn the tool refuses and records nothing', async () => {
    const { tool } = makeRuntime();
    const result = (await tool().handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
    expect(result['error']).toBe('capability_execution');
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
      onDispatch: async (tool) => {
        await tool.handler({ source: SOURCE_URL }, TOOL_SESSION);
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
      onDispatch: async (tool) => {
        await tool.handler({ source: SOURCE_URL }, TOOL_SESSION);
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
  it('resolveReleaseIdentity: env wins, release-dir basename next, sentinel otherwise', () => {
    expect(resolveReleaseIdentity('/opt/WhatSoup-release-abc1234', { WHATSOUP_RELEASE_SHA: 'envsha' })).toBe('envsha');
    expect(resolveReleaseIdentity('/opt/WhatSoup-release-abc1234', {})).toBe('abc1234');
    expect(resolveReleaseIdentity('/opt/whatsoup-dev-checkout', {})).toBe('unreleased-dev-tree');
  });
});
