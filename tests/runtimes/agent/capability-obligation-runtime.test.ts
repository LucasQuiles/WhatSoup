/**
 * Capability-obligation runtime integration — the REAL ports over the live
 * durability schema: attestation binding from live facts + activation options,
 * dispatch journaling of the minted inbound, D6 receipt persistence from typed
 * stream events, and evidence settlement over inbound_events /
 * turn_terminal_records / capability_execution_receipts. Real SQLite; the
 * runtime pipeline entry is a scripted closure.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordCapabilityAttestation } from '../../../src/core/capability-attestation.ts';
import { directoryManifestDigest, resolverCompositeDigest } from '../../../src/core/capability-resolver-artifact.ts';
import { parseCapabilityObligationsOptions, type CapabilityObligationsOptions } from '../../../src/core/capability-contract.ts';
import { CapabilityObligationStore } from '../../../src/core/capability-obligation-store.ts';
import { Database } from '../../../src/core/database.ts';
import { withTransaction } from '../../../src/core/db-tx.ts';
import {
  buildObligationLiveFacts,
  CapabilityObligationRuntime,
  composeCapabilityObligationReplayPrompt,
  dispatchCapabilityObligationTurnViaSession,
  resolveHarnessType,
  resolveReleaseIdentity,
  servingProviderId,
  UNRESOLVED_SERVING_PROVIDER,
  type CapabilityObligationLiveFacts,
} from '../../../src/runtimes/agent/capability-obligation-runtime.ts';
import type { SessionActivationPorts } from '../../../src/runtimes/agent/capability-obligation-drain-now-service.ts';
import type { CapabilityObligationDueRow } from '../../../src/core/capability-obligation-store.ts';
import type { ObligationDispatchOutcome } from '../../../src/runtimes/agent/capability-obligation-supervisor.ts';
import { ToolRegistry } from '../../../src/mcp/registry.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import type { ToolDeclaration } from '../../../src/mcp/types.ts';

const TOOL_SESSION: SessionContext = { tier: 'chat-scoped', conversationKey: 'conv-rt', deliveryJid: 'test-dm-target@lid' };

/**
 * The attested `resolverDigest` is a COMPOSITE (round-19 findings 1+2): the artifact
 * CONTENT digest folded with the canonical execution SHAPE. The executor recomputes it
 * from the LIVE execution at drain and refuses on any mismatch, so a test's recorded
 * attestation AND its runtime options must both carry the composite for the execution the
 * executor actually runs. `compositeOf` derives it the same way the producer/executor do.
 */
const interpreterDigestCache = new Map<string, string>();
/** round-20: mirror the source — hash the interpreter (command[0]) when interpreted; memoize
 *  since every fixture reuses process.execPath (an ~80MB binary). */
function interpreterDigestOf(execution: CapabilityObligationsOptions['execution']): string | null {
  if (execution.interpreted !== true) return null;
  const real = realpathSync(execution.command[0]!);
  let d = interpreterDigestCache.get(real);
  if (d === undefined) {
    d = createHash('sha256').update(readFileSync(real)).digest('hex');
    interpreterDigestCache.set(real, d);
  }
  return d;
}
function compositeOf(execution: CapabilityObligationsOptions['execution']): string {
  const artifactPath = execution.resolverArtifactPath as string; // always declared in these fixtures
  const artifactReal = realpathSync(artifactPath);
  const contentDigest = createHash('sha256').update(readFileSync(artifactReal)).digest('hex');
  // round-20 (advisor): the composite also binds the whole-directory manifest.
  const manifestDigest = directoryManifestDigest(dirname(artifactReal));
  return resolverCompositeDigest(contentDigest, manifestDigest, execution, interpreterDigestOf(execution));
}

/**
 * Structured timing exemption (test-integrity `js-sleep-in-test`): the resolver
 * process-group reap test observes whether a REAL grandchild process writes after
 * a REAL timeout. Fake timers cannot advance an external process's wall clock, and
 * the only condition to poll (the marker file) is the very absence the test
 * asserts — so we must let real time pass the grandchild's would-be write.
 */
function TIMING(waitMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, waitMs));
}

// Round-18 finding 1: a real, explicitly-declared resolver script (the executor
// verifies the declared artifact by realpath, refusing `node -e` inline forms).
const RESOLVER_DIR = mkdtempSync(join(tmpdir(), 'co-runtime-resolver-'));
const RESOLVER_PATH = join(RESOLVER_DIR, 'resolver.cjs');
writeFileSync(RESOLVER_PATH, 'console.log("processed " + process.argv[2] + " frames+transcript ok")\n');

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
    command: [process.execPath, RESOLVER_PATH, '{source}'],
    timeoutMs: 30_000,
    minOutputBytes: 8,
    resolverArtifactPath: RESOLVER_PATH,
    interpreted: true,
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
// findings 1+2: the attested resolverDigest is the COMPOSITE (content + shape) of the
// default execution — the placeholder above is overwritten so the executor's drain-seam
// re-comparison matches. Override tests derive their own composite via compositeOf().
OPTIONS.attestation.resolverDigest = compositeOf(OPTIONS.execution);

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

function freshAttestation(
  execution: CapabilityObligationsOptions['execution'] = OPTIONS.execution,
  // round-21: an explicit digest for configs whose composite CANNOT be computed because
  // verify/stage refuses them (F1/F2). `??` short-circuits compositeOf so it is never evaluated.
  resolverDigestOverride?: string,
): number {
  return recordCapabilityAttestation(db, {
    ...LIVE_FACTS,
    contractVersion: 'test-contract/1',
    capability: 'child_process_tools',
    skillName: OPTIONS.attestation.skillName,
    skillVersion: OPTIONS.attestation.skillVersion,
    skillDigest: OPTIONS.attestation.skillDigest,
    // findings 1+2: record the COMPOSITE that admission + the executor will compare.
    resolverDigest: resolverDigestOverride ?? compositeOf(execution),
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
  over: {
    sourceInboundSeq?: number;
    sourceMessageId?: string;
    sourceDigest?: string;
    sourceToken?: string;
    replayText?: string;
    retainedMedia?: { path: string; sha256: string; bytes: number; policyVersion: string };
  } = {},
): number {
  let id = 0;
  const media = over.retainedMedia ?? null;
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
        sourceDigest: media ? media.sha256 : (over.sourceDigest ?? SOURCE_DIGEST),
        sourceToken: media ? null : (over.sourceToken ?? SOURCE_URL),
        retainedMedia: media,
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
  /** r19 F2 — pin the ATTESTED resolverDigest independent of the live execution shape, so a
   *  test can bind the attestation to shape A while the executor runs shape B (drift at the seam). */
  attestationDigestOverride?: string;
  /** r13 F4 — override the SERVING-provider facts, keyed by the chat's deliveryJid. */
  liveFacts?: (deliveryJid: string) => CapabilityObligationLiveFacts;
}

function makeRuntime(script: HarnessScript = {}) {
  const dispatched: Array<{ id: number; minted: string; seq: number }> = [];
  let registeredTool: ToolDeclaration | null = null;
  const runtime = new CapabilityObligationRuntime({
    db,
    store,
    options: script.execution === undefined && script.attestationDigestOverride === undefined
      ? OPTIONS
      : {
          ...OPTIONS,
          execution: script.execution ?? OPTIONS.execution,
          attestation: {
            ...OPTIONS.attestation,
            // r19 F2 — the attested digest is normally the COMPOSITE of the LIVE shape,
            // so the drain-time re-derivation always matches. attestationDigestOverride
            // lets a test PIN it to a DIFFERENT shape's composite (bind shape A, run shape B),
            // exercising the executor's shape-drift refusal end-to-end.
            resolverDigest: script.attestationDigestOverride ?? compositeOf(script.execution ?? OPTIONS.execution),
          },
        },
    // r14 F3 — merged: one resolution yields the SERVING-provider facts (r13 F4
    // knob preserved) AND the dispatch bound to it.
    prepareDispatch: (obligation) => ({
      facts: (script.liveFacts ?? (() => LIVE_FACTS))(obligation.deliveryJid),
      dispatch: async (minted, seq) => {
        dispatched.push({ id: obligation.id, minted, seq });
        await script.onDispatch?.(registeredTool!, runtime);
        return script.dispatchOutcome ?? 'dispatched';
      },
    }),
    getDurability: () =>
      script.journalThrows
        ? null
        : { journalInbound: (messageId: string) => journalInboundRaw(messageId) },
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

  it('FALSIFIER (r13 F4): a PRIMARY-provider attestation does NOT admit a replay served by a FALLBACK harness', async () => {
    const id = seedObligation();
    freshAttestation(); // recorded for LIVE_FACTS (primary: claude-cli / persistent_session)
    const seenJids: string[] = [];
    const { runtime, dispatched } = makeRuntime({
      // The chat is DEGRADED onto a fallback harness — the serving provider differs
      // from the configured primary the attestation was recorded for.
      liveFacts: (deliveryJid) => {
        seenJids.push(deliveryJid);
        return { ...LIVE_FACTS, providerId: 'opencode-cli', harnessType: 'spawn_per_turn' };
      },
    });
    const report = (await runtime.tickOnce()) as { attestationSkips: Array<{ id: number; reason: string }> };
    expect(report.attestationSkips.map((s) => s.id)).toEqual([id]); // not admitted on the fallback
    expect(dispatched).toEqual([]);
    expect(seenJids).toContain('test-dm-target@lid'); // liveFacts resolved PER the obligation's chat
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
    const work = mkdtempSync(join(tmpdir(), 'capx-exit3-'));
    try {
      const resolver = join(work, 'resolver.cjs');
      writeFileSync(resolver, 'console.log("plenty of output before dying"); process.exit(3)\n');
      const id = seedObligation();
      const execution: CapabilityObligationsOptions['execution'] = { command: [process.execPath,resolver, '{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
      freshAttestation(execution);
      const { runtime } = makeRuntime({
        execution,
        onDispatch: async (tool) => {
          await tool.handler({ source: SOURCE_URL }, TOOL_SESSION);
        },
      });
      await runtime.tickOnce();
      const rows = db.raw
        .prepare('SELECT result_status, source_digest FROM capability_execution_receipts WHERE obligation_id = ?')
        .all(id) as Array<{ result_status: string; source_digest: string }>;
      expect(rows).toEqual([{ result_status: 'error', source_digest: SOURCE_DIGEST }]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
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
      const id = seedObligation({ sourceDigest: SMUGGLE_DIGEST, sourceToken: SMUGGLE_SOURCE, replayText: SMUGGLE_SOURCE });
      const execution: CapabilityObligationsOptions['execution'] = { command: [process.execPath,resolver, '{source}'], timeoutMs: 30_000, minOutputBytes: 1, resolverArtifactPath: resolver, interpreted: true };
      freshAttestation(execution);
      const { runtime } = makeRuntime({
        execution,
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

  it('FALSIFIER: a resolver timeout REAPS the whole process group — a grandchild cannot escape and write after the deadline', async () => {
    // Node's spawn `timeout` option signals only the IMMEDIATE child (r13 F2). A
    // resolver that forks a grandchild and times out would leave the grandchild
    // alive to land a side effect AFTER the error receipt. The resolver here forks
    // a grandchild that writes a marker 600ms in, and itself stays alive past the
    // 200ms deadline; a correct reap (SIGKILL the process GROUP) kills both, so the
    // marker is never written.
    const work = mkdtempSync(join(tmpdir(), 'capx-reap-'));
    try {
      const resolver = join(work, 'resolver.cjs');
      writeFileSync(
        resolver,
        [
          "const cp=require('child_process');",
          'const marker=process.argv[2];',
          'const gc=cp.spawn(process.execPath,[\'-e\',\'setTimeout(function(){require("fs").writeFileSync(process.argv[1],"ESCAPED")},600)\',marker],{stdio:\'ignore\'});',
          'gc.unref();',
          "console.log('resolver-alive');",
          'setTimeout(function(){},5000);',
        ].join('\n'),
      );
      const escaped = join(work, 'escaped');
      const ESCAPED_DIGEST = createHash('sha256').update(escaped).digest('hex');
      const id = seedObligation({ sourceDigest: ESCAPED_DIGEST, sourceToken: escaped, replayText: escaped });
      const execution: CapabilityObligationsOptions['execution'] = { command: [process.execPath,resolver, '{source}'], timeoutMs: 200, minOutputBytes: 1, resolverArtifactPath: resolver, interpreted: true };
      freshAttestation(execution);
      const { runtime } = makeRuntime({
        execution,
        onDispatch: async (tool) => {
          const result = (await tool.handler({ source: escaped }, TOOL_SESSION)) as Record<string, unknown>;
          expect(result['error']).toBe('capability_execution_failed'); // timed out
          // Wait past the grandchild's would-be write (600ms from spawn); a reaped
          // group never gets there.
          await TIMING(1000);
        },
      });
      await runtime.tickOnce();
      expect(existsSync(escaped)).toBe(false); // the descendant was reaped, not left to escape
      const row = db.raw
        .prepare('SELECT result_status, output_evidence FROM capability_execution_receipts WHERE obligation_id = ?')
        .get(id) as { result_status: string; output_evidence: string };
      expect(row.result_status).toBe('error');
      expect((JSON.parse(row.output_evidence) as Record<string, unknown>)['timedOut']).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 15_000);

  it('FALSIFIER (r14 F2): a resolver that exits 0 CLEANLY still has its escaped grandchild reaped before the ok receipt', async () => {
    // r13 F2 only reaped the group on the watchdog TIMEOUT; on a clean exit the
    // watchdog was cleared and nothing swept a grandchild left in the group. Here
    // the resolver forks a same-group grandchild that writes a marker 600ms in,
    // prints enough output to satisfy minOutputBytes, and EXITS 0 immediately.
    // Pre-fix: the handler records an `ok` receipt and the grandchild escapes to
    // write AFTER it. Fixed (killGroup in `close`): the leaderless group is swept
    // when `close` fires, so the marker is never written even though the run is ok.
    const work = mkdtempSync(join(tmpdir(), 'capx-reap-clean-'));
    try {
      const resolver = join(work, 'resolver.cjs');
      writeFileSync(
        resolver,
        [
          "const cp=require('child_process');",
          'const marker=process.argv[2];',
          // same-group grandchild (NOT detached): a correct group reap reaches it
          'const gc=cp.spawn(process.execPath,[\'-e\',\'setTimeout(function(){require("fs").writeFileSync(process.argv[1],"ESCAPED")},600)\',marker],{stdio:\'ignore\'});',
          'gc.unref();',
          "console.log('resolver-alive-clean');",
          // no keep-alive: the resolver exits 0 NOW, the grandchild outlives it
        ].join('\n'),
      );
      const escaped = join(work, 'escaped');
      const ESCAPED_DIGEST = createHash('sha256').update(escaped).digest('hex');
      const id = seedObligation({ sourceDigest: ESCAPED_DIGEST, sourceToken: escaped, replayText: escaped });
      const execution: CapabilityObligationsOptions['execution'] = { command: [process.execPath,resolver, '{source}'], timeoutMs: 30_000, minOutputBytes: 1, resolverArtifactPath: resolver, interpreted: true };
      freshAttestation(execution);
      const { runtime } = makeRuntime({
        // timeout far larger than the clean exit — this is NOT the timeout path
        execution,
        onDispatch: async (tool) => {
          const result = (await tool.handler({ source: escaped }, TOOL_SESSION)) as Record<string, unknown>;
          expect(result['executed']).toBe(true); // clean exit 0 with output → ok receipt
          // Wait past the grandchild's would-be write (600ms from spawn); a group
          // swept on clean close never gets there.
          await TIMING(1000);
        },
      });
      await runtime.tickOnce();
      expect(existsSync(escaped)).toBe(false); // grandchild reaped on clean close, not left to escape
      const row = db.raw
        .prepare('SELECT result_status, output_evidence FROM capability_execution_receipts WHERE obligation_id = ?')
        .get(id) as { result_status: string; output_evidence: string };
      expect(row.result_status).toBe('ok');
      expect((JSON.parse(row.output_evidence) as Record<string, unknown>)['timedOut']).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 15_000);

  it('outside an active obligation turn the tool refuses and records nothing', async () => {
    const { tool } = makeRuntime();
    const result = (await tool().handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
    expect(result['error']).toBe('capability_execution');
    const count = (db.raw.prepare('SELECT COUNT(*) AS c FROM capability_execution_receipts').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('FALSIFIER: an EMBEDDED {source} (--out={source}) is substituted, not passed literally', async () => {
    // The config embeds the placeholder inside an argument. It must reach the
    // child as --out=<real source>, not the literal --out={source} the old
    // exact-match substitution left behind.
    const work = mkdtempSync(join(tmpdir(), 'capx-embed-'));
    try {
      const resolver = join(work, 'echo.cjs');
      writeFileSync(resolver, "const m=/^--out=(.+)$/.exec(process.argv[2]);console.log(m?m[1]:'NO-SUBSTITUTION');");
      seedObligation();
      const execution: CapabilityObligationsOptions['execution'] = { command: [process.execPath,resolver, '--out={source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
      freshAttestation(execution);
      let output = '';
      const { runtime } = makeRuntime({
        execution,
        onDispatch: async (tool) => {
          const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as { output?: string };
          output = r.output ?? '';
        },
      });
      await runtime.tickOnce();
      expect(output).toContain(SOURCE_URL);
      expect(output).not.toContain('{source}');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('FALSIFIER: a resolver that MUTATES its media input records error, not ok (snapshot re-hash)', async () => {
    // The child is handed a per-attempt SNAPSHOT, not the retained path. A
    // resolver that overwrites its input changes the snapshot; the post-execution
    // re-hash catches it and records error, never ok. WITHOUT the snapshot+rehash
    // the handler recorded ok with the ORIGINAL digest for bytes never processed.
    const work = mkdtempSync(join(tmpdir(), 'capx-media-in-'));
    try {
      const mediaPath = join(work, 'clip.webm');
      const ORIGINAL = 'ORIGINAL-MEDIA-BYTES';
      writeFileSync(mediaPath, ORIGINAL);
      const mediaSha = createHash('sha256').update(ORIGINAL).digest('hex');
      const mutator = join(work, 'mutator.cjs');
      writeFileSync(mutator, "require('fs').writeFileSync(process.argv[2],'MUTATED-DIFFERENT-BYTES');console.log('processed-and-mutated-ok');");
      const id = seedObligation({ retainedMedia: { path: mediaPath, sha256: mediaSha, bytes: ORIGINAL.length, policyVersion: 'p/1' } });
      const execution: CapabilityObligationsOptions['execution'] = { command: [process.execPath,mutator, '{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: mutator, interpreted: true };
      freshAttestation(execution);
      const { runtime } = makeRuntime({
        execution,
        onDispatch: async (tool) => {
          const r = (await tool.handler({ source: mediaPath }, TOOL_SESSION)) as Record<string, unknown>;
          expect(r['error']).toBeDefined();
        },
      });
      await runtime.tickOnce();
      const row = db.raw
        .prepare('SELECT result_status, output_evidence FROM capability_execution_receipts WHERE obligation_id = ?')
        .get(id) as { result_status: string; output_evidence: string };
      expect(row.result_status).toBe('error');
      expect((JSON.parse(row.output_evidence) as Record<string, unknown>)['reason']).toBe('media_mutated_during_execution');
      // The RETAINED original is untouched — the resolver mutated only the snapshot.
      expect(readFileSync(mediaPath, 'utf8')).toBe(ORIGINAL);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('round-20 (finding 3): the staged resolver still resolves a SIBLING module — whole-directory staging preserves resolution a single-file copy would break', async () => {
    const work = mkdtempSync(join(tmpdir(), 'capx-sibling-'));
    try {
      writeFileSync(join(work, 'helper.cjs'), 'module.exports = function () { return "HELPER-OK"; };');
      const resolver = join(work, 'resolver.cjs');
      // require('./helper.cjs') resolves relative to the EXECUTING file's dir. Round-20 stages the
      // WHOLE directory into a private root (content-addressed, immutable), so the sibling is copied
      // next to the staged resolver and resolves — a single-file copy (or the round-19 hardlink) was
      // replaced precisely so sibling modules keep working while execution is a swap-proof copy.
      writeFileSync(resolver, 'const h = require("./helper.cjs"); console.log("processed " + process.argv[2] + " " + h());');
      const execution: CapabilityObligationsOptions['execution'] = { command: [process.execPath, resolver, '{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
      seedObligation();
      freshAttestation(execution);
      let output = '';
      const { runtime } = makeRuntime({
        execution,
        onDispatch: async (tool) => {
          const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as { executed?: boolean; output?: string };
          expect(r.executed).toBe(true);
          output = r.output ?? '';
        },
      });
      await runtime.tickOnce();
      expect(output).toContain('HELPER-OK'); // the sibling module resolved from the staged copy
      // Execution stages into a PRIVATE temp root (mkdtemp), never next to the original: the source
      // dir keeps only its two real files, with no staging litter written back into it.
      expect(readdirSync(work).sort()).toEqual(['helper.cjs', 'resolver.cjs']);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('FALSIFIER (findings 1+2): a resolver whose CONTENT is swapped AFTER attestation is REFUSED at the drain seam (composite mismatch), never executed', async () => {
    const work = mkdtempSync(join(tmpdir(), 'capx-swap-'));
    try {
      const resolver = join(work, 'resolver.cjs');
      writeFileSync(resolver, 'console.log("processed " + process.argv[2] + " ORIGINAL ok");');
      const execution: CapabilityObligationsOptions['execution'] = { command: [process.execPath, resolver, '{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
      const id = seedObligation();
      freshAttestation(execution); // records the COMPOSITE of the ORIGINAL bytes + shape
      const { runtime } = makeRuntime({
        execution,
        onDispatch: async (tool) => {
          // The reviewer's real-CLI repro: replace the resolver at the SAME path after attestation.
          // The executor re-derives the live composite and must refuse — the swapped bytes never run.
          writeFileSync(resolver, 'require("node:fs").writeFileSync(process.argv[3] || "/tmp/evil-marker", "PWNED"); console.log("processed " + process.argv[2] + " SWAPPED-EVIL ok");');
          const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
          expect(r['error']).toBe('capability_execution');
        },
      });
      await runtime.tickOnce();
      const row = db.raw
        .prepare('SELECT result_status, output_evidence FROM capability_execution_receipts WHERE obligation_id = ?')
        .get(id) as { result_status: string; output_evidence: string };
      expect(row.result_status).toBe('error');
      expect((JSON.parse(row.output_evidence) as Record<string, unknown>)['reason']).toBe('resolver_digest_mismatch');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('FALSIFIER (advisor round-20): a SIBLING swapped after attestation is REFUSED at the drain seam (whole-tree manifest), and the evil sibling never executes', async () => {
    // The advisor's exact exploit reaching EXECUTION: stage+execute the whole directory but bind only
    // the artifact file, and a post-attest `helper.cjs` overwrite runs via `require('./helper.cjs')`
    // while the artifact's own bytes — and a content-only composite — are unchanged. This asserts at
    // the EXECUTOR (not the pure stage seam): the drain refuses AND the evil sibling never runs.
    const work = mkdtempSync(join(tmpdir(), 'capx-sibswap-'));
    try {
      const marker = join(work, 'evil-marker');
      const helper = join(work, 'helper.cjs');
      const resolver = join(work, 'resolver.cjs');
      writeFileSync(helper, 'module.exports = function () { return "HELPER-OK"; };');
      // require('./helper.cjs') loads the sibling from the executing (staged) dir — dir-staging copies it.
      writeFileSync(resolver, 'const h = require("./helper.cjs"); console.log("processed " + process.argv[2] + " " + h());');
      const execution: CapabilityObligationsOptions['execution'] = { command: [process.execPath, resolver, '{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
      const id = seedObligation();
      freshAttestation(execution); // records the COMPOSITE of the ORIGINAL tree (resolver + OK helper)
      const { runtime } = makeRuntime({
        execution,
        onDispatch: async (tool) => {
          // Swap ONLY the sibling; the artifact's own bytes are untouched. The evil helper writes a
          // marker at module-load — so if the resolver ever spawned, `require('./helper.cjs')` runs it.
          writeFileSync(helper, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "PWNED"); module.exports = function () { return "HELPER-EVIL"; };`);
          const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
          expect(r['error']).toBe('capability_execution');
        },
      });
      await runtime.tickOnce();
      const row = db.raw
        .prepare('SELECT result_status, output_evidence FROM capability_execution_receipts WHERE obligation_id = ?')
        .get(id) as { result_status: string; output_evidence: string };
      expect(row.result_status).toBe('error');
      expect((JSON.parse(row.output_evidence) as Record<string, unknown>)['reason']).toBe('resolver_digest_mismatch');
      expect(existsSync(marker)).toBe(false); // the evil sibling was refused BEFORE it could execute
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('R21 F2 FALSIFIER (executor seam): direct-mode [artifact,"-c","{source}"] is REFUSED at the drain (stage rejects the flag; nothing spawns)', async () => {
    // round-21: a renamed interpreter declared interpreted:false with a `-c` flag would run the
    // inbound {source} as SHELL CODE. Staging refuses the shape BEFORE any spawn. Reason discriminates:
    // with the fix → resolver_artifact_unverified (stage threw); revert it → resolver_digest_mismatch.
    const work = mkdtempSync(join(tmpdir(), 'capx-r21-f2-'));
    try {
      const artifact = join(work, 'watch-resolver'); // basename evades isInterpreterName
      writeFileSync(artifact, '#!/bin/sh\nexec "$@"\n');
      chmodSync(artifact, 0o755);
      const execution: CapabilityObligationsOptions['execution'] = { command: [artifact, '-c', '{source}'], timeoutMs: 30_000, minOutputBytes: 1, resolverArtifactPath: artifact, interpreted: false };
      const id = seedObligation();
      freshAttestation(execution, 'r21-f2-unattestable'); // admissible row; digest matches the override below
      const { runtime } = makeRuntime({
        execution,
        attestationDigestOverride: 'r21-f2-unattestable',
        onDispatch: async (tool) => {
          const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
          expect(r['error']).toBe('capability_execution');
        },
      });
      await runtime.tickOnce();
      const row = db.raw.prepare('SELECT result_status, output_evidence FROM capability_execution_receipts WHERE obligation_id = ?').get(id) as { result_status: string; output_evidence: string };
      expect(row.result_status).toBe('error');
      expect((JSON.parse(row.output_evidence) as Record<string, unknown>)['reason']).toBe('resolver_artifact_unverified');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('R21 F1 FALSIFIER (executor seam): an interpreter in a WORLD-writable dir is REFUSED at the drain (nothing spawns)', async () => {
    const work = mkdtempSync(join(tmpdir(), 'capx-r21-f1-'));
    const binDir = mkdtempSync(join(tmpdir(), 'capx-r21-f1-bin-'));
    try {
      const resolver = join(work, 'resolver.cjs');
      writeFileSync(resolver, 'process.stdout.write("processed:" + process.argv[2])');
      const interp = join(binDir, 'node');
      writeFileSync(interp, '#!/bin/sh\nexit 0\n');
      chmodSync(interp, 0o755);
      chmodSync(binDir, 0o777); // WORLD-writable ancestor → a different actor could swap the interpreter
      const execution: CapabilityObligationsOptions['execution'] = { command: [interp, resolver, '{source}'], timeoutMs: 30_000, minOutputBytes: 1, resolverArtifactPath: resolver, interpreted: true };
      const id = seedObligation();
      freshAttestation(execution, 'r21-f1-unattestable'); // admissible row; digest matches the override below
      const { runtime } = makeRuntime({
        execution,
        attestationDigestOverride: 'r21-f1-unattestable',
        onDispatch: async (tool) => {
          const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
          expect(r['error']).toBe('capability_execution');
        },
      });
      await runtime.tickOnce();
      const row = db.raw.prepare('SELECT result_status, output_evidence FROM capability_execution_receipts WHERE obligation_id = ?').get(id) as { result_status: string; output_evidence: string };
      expect(row.result_status).toBe('error');
      expect((JSON.parse(row.output_evidence) as Record<string, unknown>)['reason']).toBe('resolver_artifact_unverified');
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('R21 F3 FALSIFIER (executor seam): an EMPTY directory added after attestation is REFUSED at the drain (manifest binds dirs)', async () => {
    const work = mkdtempSync(join(tmpdir(), 'capx-r21-f3-'));
    try {
      const resolver = join(work, 'resolver.cjs');
      writeFileSync(resolver, 'console.log("processed " + process.argv[2] + " ok");');
      const execution: CapabilityObligationsOptions['execution'] = { command: [process.execPath, resolver, '{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
      const id = seedObligation();
      freshAttestation(execution); // composite of the tree WITHOUT the extra dir
      const { runtime } = makeRuntime({
        execution,
        onDispatch: async (tool) => {
          mkdirSync(join(work, 'evil-empty-dir')); // add an empty dir AFTER attestation
          const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
          expect(r['error']).toBe('capability_execution');
        },
      });
      await runtime.tickOnce();
      const row = db.raw.prepare('SELECT result_status, output_evidence FROM capability_execution_receipts WHERE obligation_id = ?').get(id) as { result_status: string; output_evidence: string };
      // revert F3 → the empty dir is invisible → composite matches → the resolver SPAWNS and succeeds → RED
      expect(row.result_status).toBe('error');
      expect((JSON.parse(row.output_evidence) as Record<string, unknown>)['reason']).toBe('resolver_digest_mismatch');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('R21 F3 HAPPY-PATH: a resolver whose directory contains an EMPTY subdir still drains OK (the dir marker does not break legit resolvers)', async () => {
    // Guards the MATCH direction of finding 3: cpSync(recursive) reproduces empty directories, so the
    // stage-time manifest (over the copy) equals the attest-time manifest (over the source). If a
    // platform/cpSync regression ever dropped empty dirs, EVERY resolver with a subdir would fail
    // closed — the availability-break class that mode-exclusion was chosen to avoid. This proves it does not.
    const work = mkdtempSync(join(tmpdir(), 'capx-r21-f3ok-'));
    try {
      const resolver = join(work, 'resolver.cjs');
      writeFileSync(resolver, 'console.log("processed " + process.argv[2] + " ok");');
      mkdirSync(join(work, 'sub'));                              // an intentional EMPTY sibling directory
      writeFileSync(join(work, 'sub', 'helper.cjs'), 'module.exports = 1;'); // and a non-empty one below it
      mkdirSync(join(work, 'emptypkg'));                         // a genuinely empty directory
      const execution: CapabilityObligationsOptions['execution'] = { command: [process.execPath, resolver, '{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
      const id = seedObligation();
      freshAttestation(execution); // composite over the tree WITH the empty dir
      const { runtime } = makeRuntime({
        execution,
        onDispatch: async (tool) => {
          const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
          expect(r['error']).toBeUndefined(); // no drift → the resolver runs
        },
      });
      await runtime.tickOnce();
      const row = db.raw.prepare('SELECT result_status FROM capability_execution_receipts WHERE obligation_id = ?').get(id) as { result_status: string };
      expect(row.result_status).toBe('ok'); // verify == execute for a resolver that legitimately has subdirs
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('FALSIFIER (finding 2): a command SHAPE drifted after attestation (same bytes, appended flag) is REFUSED at the drain seam, never executed', async () => {
    const work = mkdtempSync(join(tmpdir(), 'capx-shape-'));
    try {
      const resolver = join(work, 'resolver.cjs');
      // The artifact CONTENT is never touched here — only the argv SHAPE changes. The
      // pre-composite D5 binding excluded command/interpreter/mode, so an attacker who
      // could rewrite the instance execution config could append a behavior-changing Node
      // flag (e.g. --experimental-loader=./evil.mjs, -r ./preload.cjs) to the SAME verified
      // bytes and it would have executed. The composite digest now binds the shape, so the
      // executor re-derives composite(liveShape) and refuses when it differs from the
      // admitted composite(attestedShape).
      writeFileSync(resolver, 'console.log("processed " + process.argv[process.argv.length - 1] + " ORIGINAL ok");');
      const attestedShape: CapabilityObligationsOptions['execution'] = { command: [process.execPath, resolver, '{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
      // Same artifact, same bytes — but a flag is spliced in ahead of {source}. Only the
      // shape differs; a content-only binding would wave this straight through.
      const driftedShape: CapabilityObligationsOptions['execution'] = { command: [process.execPath, resolver, '--experimental-vm-modules', '{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
      const id = seedObligation();
      freshAttestation(attestedShape); // admission binds the COMPOSITE of the ATTESTED shape
      const { runtime } = makeRuntime({
        execution: driftedShape, // the executor runs the DRIFTED shape...
        attestationDigestOverride: compositeOf(attestedShape), // ...against the ATTESTED shape's composite
        onDispatch: async (tool) => {
          const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
          expect(r['error']).toBe('capability_execution');
        },
      });
      await runtime.tickOnce();
      const row = db.raw
        .prepare('SELECT result_status, output_evidence FROM capability_execution_receipts WHERE obligation_id = ?')
        .get(id) as { result_status: string; output_evidence: string };
      expect(row.result_status).toBe('error');
      expect((JSON.parse(row.output_evidence) as Record<string, unknown>)['reason']).toBe('resolver_digest_mismatch');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('execute_capability live-registry integration (proof-gap C)', () => {
  it('activation registers execute_capability on the REAL registry, routed and callable', async () => {
    const registry = new ToolRegistry();
    // Mirror production wiring exactly: registerTool -> registry.register.
    // Constructing the runtime performs the registration in its constructor.
    const runtime = new CapabilityObligationRuntime({
      db,
      store,
      options: OPTIONS,
      prepareDispatch: () => ({ facts: LIVE_FACTS, dispatch: async () => 'dispatched' }),
      getDurability: () => ({ journalInbound: (m: string) => journalInboundRaw(m) }),
      externalEffectFor: () => undefined,
      writeLossSince: () => false,
      registerTool: (tool) => registry.register(tool),
      turnIdFor: () => 'obl-turn',
    });
    expect(runtime).toBeDefined();
    // A chat-SCOPED session (the tier the registry uses to auto-fill injected
    // targets) — the minted obligation turn runs per_chat / chat-scoped.
    const chatSession: SessionContext = { tier: 'chat-scoped', conversationKey: 'conv-rt', deliveryJid: 'test-dm-target@lid' };
    // REGISTERED: the session sees it in the real registry's tool list.
    expect(registry.listTools(chatSession).map((t) => t.name)).toContain('execute_capability');
    // ROUTED + CALLABLE: the registry dispatches the call to the wired handler,
    // which (no active obligation turn) refuses — NOT an "Unknown tool" miss.
    const result = await registry.call('execute_capability', { source: SOURCE_URL }, chatSession);
    expect(result.isError).toBe(true);
    const text = result.content.map((c) => (c as { text?: string }).text ?? '').join(' ');
    expect(text).not.toContain('Unknown tool');
    expect(text).toContain('No active');
  });
});

describe('minted obligation turn prompt (execute_capability instruction)', () => {
  function dueRow(over: Partial<CapabilityObligationDueRow>): CapabilityObligationDueRow {
    return {
      id: 42,
      sourceInboundSeq: 5001,
      sourceMessageId: 'TESTMSG-RT-1',
      conversationKey: 'conv-rt',
      deliveryJid: 'test-dm-target@lid',
      senderJid: 'test-sender@s.whatsapp.net',
      senderName: 'Test Sender',
      isGroup: false,
      groupName: null,
      replayText: 'check this https://youtu.be/abc',
      contentTypeHint: 'text',
      contractVersion: 'test-contract/1',
      requiredCapability: 'child_process_tools',
      capabilityParams: '{"skill":"watch"}',
      inputDigest: 'aa'.repeat(32),
      sourceDigest: SOURCE_DIGEST,
      sourceToken: 'https://youtu.be/abc',
      retainedMediaPath: null,
      mediaSha256: null,
      mediaBytes: null,
      attemptCount: 0,
      mediaExpired: false,
      ...over,
    };
  }

  it('a URL obligation instructs execute_capability with the exact source token', () => {
    const prompt = composeCapabilityObligationReplayPrompt(dueRow({}));
    expect(prompt).toContain('execute_capability');
    expect(prompt).toContain('child_process_tools');
    expect(prompt).toContain('https://youtu.be/abc'); // the exact source line
    expect(prompt).toContain('check this https://youtu.be/abc'); // original message preserved
  });

  it('a media obligation names the retained media PATH as the source, not the replay text', () => {
    const prompt = composeCapabilityObligationReplayPrompt(
      dueRow({
        sourceToken: null,
        retainedMediaPath: '/var/obligation-media/ab/cd/clip.webm',
        mediaSha256: 'cc'.repeat(32),
        mediaBytes: 10,
        replayText: 'Weekly Tracker.webm',
      }),
    );
    expect(prompt).toContain('execute_capability');
    expect(prompt).toContain('/var/obligation-media/ab/cd/clip.webm'); // the source is the retained path
    expect(prompt).toContain('Weekly Tracker.webm'); // original message preserved
  });

  it('FALSIFIER: the bare replay text alone is never the whole prompt (or the agent would not call the tool)', () => {
    const row = dueRow({});
    const prompt = composeCapabilityObligationReplayPrompt(row);
    expect(prompt).not.toBe(row.replayText);
    expect(prompt.length).toBeGreaterThan(row.replayText.length);
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
    // Claim the second WITHOUT journaling (simulate crash before journal). r15 F4 —
    // a claim needs a still-admissible attestation id (freshAttestation records one).
    const claim = store.claimObligation(unaccepted, { claimToken: 'tok-u', leaseSeconds: 300, admissionAttestationId: freshAttestation() });
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

  it('servingProviderId: reads the live session provider, else a fail-closed sentinel (r13 F4)', () => {
    // The serving/fallback provider of the live session is bound — NOT the primary.
    expect(servingProviderId({ getProviderId: () => 'opencode-cli' })).toBe('opencode-cli');
    // Absent session / no provider / null provider all fail closed to the sentinel.
    expect(servingProviderId(null)).toBe(UNRESOLVED_SERVING_PROVIDER);
    expect(servingProviderId(undefined)).toBe(UNRESOLVED_SERVING_PROVIDER);
    expect(servingProviderId({})).toBe(UNRESOLVED_SERVING_PROVIDER);
    expect(servingProviderId({ getProviderId: () => null })).toBe(UNRESOLVED_SERVING_PROVIDER);
    // The sentinel routes to 'unknown_harness', which matches no recorded
    // attestation — the fail-closed claim the fix relies on.
    expect(resolveHarnessType(UNRESOLVED_SERVING_PROVIDER)).toBe('unknown_harness');
  });
});

describe('dispatch provider-boundary outcome (D7/r13 F1)', () => {
  type DispatchArgs = Parameters<typeof dispatchCapabilityObligationTurnViaSession>;
  const DUE = {
    id: 1, conversationKey: 'conv-b', deliveryJid: 'test-dm-target@lid',
    senderJid: 'test-sender@s.whatsapp.net', senderName: 'S', isGroup: false, groupName: null,
    requiredCapability: 'child_process_tools', retainedMediaPath: null,
    sourceToken: 'https://youtu.be/x', replayText: 'watch this',
  } as unknown as DispatchArgs[4];
  const target = { scope: 'per_chat', session: {}, mapKey: 'mk', managerId: 'm1', generation: 1 };

  // A fake coordinator whose processPerChatTurn drives the dispatchAllowed gate
  // (4th arg) and the onProviderBoundary callback (5th arg) exactly as the caller
  // wires them, then behaves as scripted. `isCurrent` feeds isTargetCurrent → the
  // dispatchAllowed the production coordinator consults BEFORE the boundary.
  function callWith(
    process: (onBoundary: () => void, dispatchAllowed: () => boolean) => Promise<void>,
    isCurrent = true,
  ): Promise<string> {
    const coord = {
      createRuntimeTurnForDispatch: () => ({ ctx: true }),
      processPerChatTurn: (
        _s: unknown, _t: unknown, _x: unknown, dispatchAllowed: () => boolean, onBoundary: () => void,
      ) => process(onBoundary, dispatchAllowed),
    } as unknown as DispatchArgs[0];
    return dispatchCapabilityObligationTurnViaSession(
      coord,
      target as unknown as DispatchArgs[1], // r14 F3: PRE-RESOLVED target (no resolver)
      (() => 'scope-key') as unknown as DispatchArgs[2],
      (() => isCurrent) as unknown as DispatchArgs[3],
      DUE,
      'obl:1:1',
      42,
    );
  }

  it("FALSIFIER: crossing the provider boundary then THROWING returns 'ambiguous', never retryable", async () => {
    await expect(callWith(async (onBoundary) => { onBoundary(); throw new Error('post-boundary crash'); }))
      .resolves.toBe('ambiguous');
  });

  it("a PRE-boundary throw returns 'retryable' (nothing was executed, safe to auto-retry)", async () => {
    await expect(callWith(async () => { throw new Error('pre-boundary crash'); }))
      .resolves.toBe('retryable');
  });

  it("a clean turn returns 'dispatched'", async () => {
    await expect(callWith(async (onBoundary) => { onBoundary(); }))
      .resolves.toBe('dispatched');
  });

  it("FALSIFIER (r14 F3): a turn DISCARDED pre-boundary (carried target not current) returns 'retryable', never 'dispatched'", async () => {
    // The admission-time target recycled onto a different provider/generation
    // before dispatch; production's processPerChatTurn drops the turn via the
    // dispatchAllowed gate BEFORE the provider boundary. Nothing reached the
    // provider → must requeue, not falsely report 'dispatched' (which would
    // consume the attempt and the obligation would never settle).
    await expect(callWith(
      async (onBoundary, dispatchAllowed) => {
        if (dispatchAllowed() === false) return; // discarded pre-boundary, like production
        onBoundary();
      },
      false, // isTargetCurrent → false: the carried target is stale at dispatch
    )).resolves.toBe('retryable');
  });
});

describe('operator drain-now servicing at the EXECUTOR seam (r22 AE1 adapter)', () => {
  const GROUP_JID = 'test-group-alpha@g.us';
  let requestDir: string;

  beforeEach(() => {
    requestDir = mkdtempSync(join(tmpdir(), 'co-runtime-drain-now-'));
  });
  afterEach(() => {
    rmSync(requestDir, { recursive: true, force: true });
  });

  function dropRequest(obligationId: number): void {
    writeFileSync(
      join(requestDir, `${obligationId}.json`),
      JSON.stringify({
        obligationId,
        requestedAtUnixSec: Math.floor(Date.now() / 1000),
        requestedBy: 'operator-test',
        nonce: 'nonce-0123456789',
      }),
    );
  }

  /** An attestation the r22 PRE-CHECK finds: the REAL process facts (any provider). */
  function preCheckAttestation(): number {
    const facts = buildObligationLiveFacts('provider-precheck-only');
    return recordCapabilityAttestation(db, {
      ...facts,
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
      nonce: `pre-${Math.random().toString(36).slice(2)}`,
      attestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
  }

  function makeDrainNowRuntime() {
    const dispatched: Array<{ id: number; minted: string }> = [];
    const activation: string[] = [];
    // The ports report an ALREADY-dispatchable target once "activated" — the
    // point here is the runtime→drainObligationNow→activation ORDER and gating,
    // not the SessionManager internals (unit-tested in the service suite).
    let activated = false;
    const ports: SessionActivationPorts = {
      resolveMapKey: (jid) => jid,
      resolveActiveTarget: (jid) => {
        if (activated) return { jid };
        activation.push(`resolve-cold:${jid}`);
        return null;
      },
      getSession: (mapKey) => {
        activation.push(`get:${mapKey}`);
        return {
          getStatus: () => ({ active: activated }),
          spawnSession: async () => {
            activation.push(`spawn:${mapKey}`);
            activated = true;
          },
        };
      },
      captureOwnedGeneration: (mapKey) => {
        activation.push(`capture:${mapKey}`);
        return { managerId: 'm1', generation: 1 };
      },
      activateSpawnedSession: async (mapKey) => {
        activation.push(`activate:${mapKey}`);
        return mapKey;
      },
    };
    const runtime = new CapabilityObligationRuntime({
      db,
      store,
      options: OPTIONS,
      prepareDispatch: (obligation) => ({
        facts: LIVE_FACTS,
        dispatch: async (minted) => {
          dispatched.push({ id: obligation.id, minted });
          return 'dispatched';
        },
      }),
      getDurability: () => ({ journalInbound: (messageId: string) => journalInboundRaw(messageId) }),
      externalEffectFor: () => undefined,
      writeLossSince: () => false,
      registerTool: () => {},
      turnIdFor: () => 'obl-turn',
      sessionActivation: ports,
      drainNowRequestDir: requestDir,
    });
    return { runtime, dispatched, activation };
  }

  function seedArmedGroupObligation(): { id: number; approvalId: number } {
    let id = 0;
    withTransaction(db, () => {
      id = store.applyDecisionWithinCallerTransaction({
        auditEvent: { action: 'obligation.create', actorType: 'runtime', reasonCode: 'conclusive_no_effect' },
        obligation: {
          sourceInboundSeq: 5601, sourceMessageId: 'TESTMSG-DRAINNOW-G1',
          conversationKey: 'conv-rt-group', deliveryJid: GROUP_JID,
          senderJid: 'test-sender@s.whatsapp.net', senderName: 'Test Sender',
          isGroup: true, groupName: 'Test Group Alpha',
          scope: 'per_chat', originRecoveryJobId: null, replayText: 'https://youtu.be/abc',
          contentTypeHint: 'text', contractVersion: 'test-contract/1', requiredCapability: 'child_process_tools',
          capabilityParams: '{"skill":"watch"}', inputDigest: 'aa'.repeat(32), sourceDigest: SOURCE_DIGEST,
          sourceToken: SOURCE_URL, retainedMedia: null, creationReason: 'typed_deferral_signal',
        },
      }).obligationId!;
    });
    const approvalId = Number(
      db.raw
        .prepare(
          `INSERT INTO capability_drain_approvals
             (obligation_id, destination_jid, scope, release_sha, attestation_digest, manifest_digest, drain_run_id, approver, approved_at, expires_at)
           VALUES (?, ?, 'group', 'rel-1', 'att-1', 'md-1', 'run-1', 'owner', datetime('now'), datetime('now','+1 hour'))`,
        )
        .run(id, GROUP_JID)
        .lastInsertRowid,
    );
    expect(
      store.consumeGroupDrainApproval(id, {
        destinationJid: GROUP_JID, releaseSha: 'rel-1', manifestDigest: 'md-1',
        drainRunId: 'run-1', attestationDigest: 'att-1',
      }).applied,
    ).toBe(true);
    return { id, approvalId };
  }

  it('END-TO-END: a dropped request activates the cold session and the obligation dispatches in the same tick chain', async () => {
    const id = seedObligation();
    freshAttestation(); // admission (LIVE_FACTS via prepareDispatch)
    preCheckAttestation(); // r22 pre-activation gate (real process facts)
    dropRequest(id);
    const { runtime, dispatched, activation } = makeDrainNowRuntime();
    await runtime.tickOnce();
    // The request was consumed and the activation recipe ran in order.
    expect(readdirSync(requestDir).some((n) => n === `${id}.json`)).toBe(false);
    expect(activation).toEqual([
      `resolve-cold:test-dm-target@lid`, `get:test-dm-target@lid`,
      `capture:test-dm-target@lid`, `spawn:test-dm-target@lid`, `activate:test-dm-target@lid`,
    ]);
    expect(dispatched).toEqual([{ id, minted: `obl:${id}:1` }]);
    const result = readdirSync(requestDir).find((n) => n.endsWith('.result.json'))!;
    expect(JSON.parse(readFileSync(join(requestDir, result), 'utf8'))).toMatchObject({ kind: 'drained', obligationId: id });
  });

  it('AE1 FALSIFIER at the executor: a REVOKED group approval is refused and the session ports are NEVER touched', async () => {
    const { id, approvalId } = seedArmedGroupObligation();
    db.raw.prepare("UPDATE capability_drain_approvals SET revoked_at = datetime('now') WHERE id = ?").run(approvalId);
    preCheckAttestation();
    dropRequest(id);
    const { runtime, dispatched, activation } = makeDrainNowRuntime();
    await runtime.tickOnce();
    expect(activation).toEqual([]); // the group session was never resolved, created, or activated
    expect(dispatched).toEqual([]);
    const result = readdirSync(requestDir).find((n) => n.endsWith('.result.json'))!;
    expect(JSON.parse(readFileSync(join(requestDir, result), 'utf8'))).toMatchObject({
      kind: 'refused', obligationId: id, reason: 'group_approval_required',
    });
  });

  it('PRE-CHECK FALSIFIER at the executor: no candidate attestation refuses BEFORE any session port is touched', async () => {
    const id = seedObligation();
    freshAttestation(); // admission-only row — LIVE_FACTS host, NOT this process's facts
    dropRequest(id);
    const { runtime, activation } = makeDrainNowRuntime();
    await runtime.tickOnce();
    expect(activation).toEqual([]);
    const result = readdirSync(requestDir).find((n) => n.endsWith('.result.json'))!;
    expect(JSON.parse(readFileSync(join(requestDir, result), 'utf8'))).toMatchObject({
      kind: 'refused', obligationId: id, reason: 'no_admissible_attestation',
    });
  });

  it('AE1 baseline: with NO request file the runtime never touches the session ports (no spontaneous activation)', async () => {
    seedObligation();
    freshAttestation();
    preCheckAttestation();
    const { runtime, activation } = makeDrainNowRuntime();
    await runtime.tickOnce();
    expect(activation).toEqual([]);
  });
});
