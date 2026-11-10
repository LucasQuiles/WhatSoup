/**
 * Targeted branch coverage for src/runtimes/agent/capability-obligation-execution-tool.ts —
 * the arms the runtime integration suite leaves dark: spawn-seam failure normalization
 * (synchronous throws, NUL-argv refusal, pid-less children, settle-once guards), the
 * output-cap truncation bounds, media-obligation source/identity refusals and the media
 * happy path, direct-mode (non-interpreted) argv substitution, and the terminal-record
 * fallback when no live logical turn owns the conversation.
 *
 * The harness mirrors tests/runtimes/agent/capability-obligation-runtime.test.ts: real
 * SQLite, real attestation rows, the REAL CapabilityObligationRuntime with a scripted
 * dispatch closure, and a REAL resolver child process everywhere the covered arm is
 * reachable by one. Only the spawn-seam arms that no real child can produce (a
 * synchronous spawn throw past the NUL guard; a child object with no pid; error/close
 * re-entry after settlement) use a per-test spawn override that otherwise delegates to
 * the real spawn.
 */
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordCapabilityAttestation } from '../../../src/core/capability-attestation.ts';
import { directoryManifestDigest, resolverCompositeDigest } from '../../../src/core/capability-resolver-artifact.ts';
import { parseCapabilityObligationsOptions, type CapabilityObligationsOptions } from '../../../src/core/capability-contract.ts';
import { CapabilityObligationStore } from '../../../src/core/capability-obligation-store.ts';
import { Database } from '../../../src/core/database.ts';
import { withTransaction } from '../../../src/core/db-tx.ts';
import { CapabilityObligationRuntime, type CapabilityObligationLiveFacts } from '../../../src/runtimes/agent/capability-obligation-runtime.ts';
import type { ObligationDispatchOutcome } from '../../../src/runtimes/agent/capability-obligation-supervisor.ts';
import type { SessionContext, ToolDeclaration } from '../../../src/mcp/types.ts';
import {
  deliverThenThrow,
  grandchildResolverSource,
  groupKillError,
  killLeaderOnceThenEperm,
  readFixturePid,
  reapFixtureGroups,
  settleWithin,
  throwOnly,
  waitForPidGone,
  type GroupSignalSeam,
} from '../../helpers/group-kill-seams.ts';
import { trackTmpDirs } from '../../helpers/tmp-dir.ts';
import { trustedNodePath } from '../../helpers/trusted-node.ts';

// ── Spawn seam override ──────────────────────────────────────────────────────
// The executor's runResolver wraps spawn defensively: a synchronous throw is
// normalized to a labeled rejection, a pid-less child makes the group-kill a
// no-op, and error/close settle exactly once. None of those states can be
// produced by a real child that passed staging (the interpreter and artifact
// verifiably exist), so those tests substitute the returned child; every other
// test runs the real spawn.
let spawnOverride: (() => unknown) | null = null;
// Issue 3568 seams. The pid of every real DETACHED spawn (the resolver is its own group leader),
// so the process.kill spy can intercept that group and nothing else.
const detachedSpawnPids: number[] = [];
// The child object of every real detached spawn, so a test can read its stdio state after the run.
const detachedSpawns: ChildProcess[] = [];
// When set, answers ONLY the membership probe's `ps -A -o pid=,pgid=,stat=` read.
let psOverride: (() => { status: number; stdout: string }) | null = null;
// The pgid argument of every membership probe, recorded by a pass-through mock (issue 3568).
const probedPgids: number[] = [];
// The arguments of every warn call on the execution tool's own logger, recorded by a pass-through
// mock that still logs (issue 3568).
const executionToolWarns: unknown[][] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    if (spawnOverride !== null) return spawnOverride() as ReturnType<typeof actual.spawn>;
    const child = actual.spawn(...args);
    const options = (args as unknown[])[2] as { detached?: boolean } | undefined;
    if (options?.detached === true && child.pid !== undefined) {
      detachedSpawnPids.push(child.pid);
      detachedSpawns.push(child);
    }
    return child;
  }) as typeof actual.spawn;
  const spawnSync = ((...args: unknown[]) => {
    const [command, commandArgs] = args;
    // Match the probe's exact call before reading psOverride, so a spawnSync at import time
    // never touches the module-level binding.
    if (command === 'ps' && Array.isArray(commandArgs) && commandArgs.join(' ') === '-A -o pid=,pgid=,stat=' && psOverride !== null) {
      const answer = psOverride();
      return { pid: 0, output: [null, answer.stdout, ''], stdout: answer.stdout, stderr: '', status: answer.status, signal: null };
    }
    return (actual.spawnSync as unknown as (...a: unknown[]) => unknown)(...args);
  }) as unknown as typeof actual.spawnSync;
  return { ...actual, spawn, spawnSync };
});

vi.mock('../../../src/lib/process-group-membership.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/process-group-membership.ts')>();
  return {
    ...actual,
    probeGroupMembership: (pgid: number) => {
      probedPgids.push(pgid);
      return actual.probeGroupMembership(pgid);
    },
  };
});

vi.mock('../../../src/logger.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/logger.ts')>();
  return {
    ...actual,
    createChildLogger: (name: string) => {
      const child = actual.createChildLogger(name);
      if (name !== 'agent:capability-execution-tool') return child;
      const warn = child.warn.bind(child) as (...args: unknown[]) => void;
      child.warn = ((...args: unknown[]) => {
        executionToolWarns.push(args);
        warn(...args);
      }) as typeof child.warn;
      return child;
    },
  };
});

/** A child stream: 'data' events, and the no-op `destroy()` the reap grace calls. */
class FakeStream extends EventEmitter {
  destroy(): this {
    return this;
  }
}

/**
 * The shape runResolver consumes: pid, stdout/stderr 'data', 'error'/'close', and the no-op
 * `unref()` the reap grace calls, so a close that arrives after the grace cannot throw in its timer.
 */
class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  constructor(readonly pid: number | undefined) {
    super();
  }
  unref(): void { /* no handle holds the event loop */ }
}

/**
 * Structured timing exemption (test-integrity `js-sleep-in-test`): the pid-less
 * watchdog test must let REAL wall time pass the executor's 100ms watchdog
 * before the fake child reports its signal death — the watchdog deadline IS the
 * behavior under test, it lives inside the awaited handler call, and fake
 * timers cannot advance it without also freezing the handler's own async I/O
 * (staging, hashing). The deferred action is an event emission, not a test-body
 * sleep; the test resolves as soon as the handler settles.
 */
function TIMING(afterMs: number, fn: () => void): void {
  setTimeout(fn, afterMs);
}

const TOOL_SESSION: SessionContext = { tier: 'chat-scoped', conversationKey: 'conv-xt', deliveryJid: 'test-dm-target@lid' };

// process.execPath can live under a group/world-writable prefix (Homebrew, CI
// hostedtoolcache) that the r21 F1 interpreter-writability guard refuses; the
// helper stages a byte-identical node at a trusted path.
const NODE = trustedNodePath();

const interpreterDigestCache = new Map<string, string>();
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
/** The attested resolverDigest is the COMPOSITE (content + manifest + interpreter + shape). */
function compositeOf(execution: CapabilityObligationsOptions['execution']): string {
  const artifactReal = realpathSync(execution.resolverArtifactPath as string);
  const contentDigest = createHash('sha256').update(readFileSync(artifactReal)).digest('hex');
  const manifestDigest = directoryManifestDigest(dirname(artifactReal));
  return resolverCompositeDigest(contentDigest, manifestDigest, execution, interpreterDigestOf(execution));
}

const RESOLVER_DIR = mkdtempSync(join(tmpdir(), 'co-exectool-resolver-'));
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
    interpreter: NODE,
    resolverArtifactPath: RESOLVER_PATH,
    args: ['{source}'],
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
OPTIONS.attestation.resolverDigest = compositeOf(OPTIONS.execution);

const LIVE_FACTS: CapabilityObligationLiveFacts = {
  hostId: 'test-host',
  runtimeUser: 'test-user',
  releaseSha: 'relsha-live',
  schemaVersion: 60,
  providerId: 'claude-cli',
  harnessType: 'persistent_session',
};

const SOURCE_URL = 'https://youtu.be/abc';
const SOURCE_DIGEST = createHash('sha256').update(SOURCE_URL).digest('hex');

let db: Database;
let store: CapabilityObligationStore;
const dispatchErrors: unknown[] = [];

beforeEach(() => {
  dispatchErrors.length = 0;
  db = new Database(':memory:');
  db.open();
  store = new CapabilityObligationStore(db);
});

afterEach(() => {
  spawnOverride = null;
  psOverride = null;
  detachedSpawnPids.length = 0;
  detachedSpawns.length = 0;
  probedPgids.length = 0;
  executionToolWarns.length = 0;
  db.close();
  if (dispatchErrors.length > 0) {
    throw new AggregateError(dispatchErrors, 'Dispatch callback failed');
  }
});

function freshAttestation(execution: CapabilityObligationsOptions['execution'] = OPTIONS.execution): number {
  return recordCapabilityAttestation(db, {
    ...LIVE_FACTS,
    contractVersion: 'test-contract/1',
    capability: 'child_process_tools',
    skillName: OPTIONS.attestation.skillName,
    skillVersion: OPTIONS.attestation.skillVersion,
    skillDigest: OPTIONS.attestation.skillDigest,
    resolverDigest: compositeOf(execution),
    dependencyVersions: OPTIONS.attestation.dependencyVersions,
    probeVersion: OPTIONS.attestation.probeVersion,
    canaryId: OPTIONS.attestation.canaryId,
    mediaRoot: OPTIONS.mediaRoot,
    canaryResult: 'pass',
    nonce: `n-${Math.random().toString(36).slice(2)}`,
    attestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    evidence: { probeStdoutRef: null, probeStderrRef: null, probeExit: null, canaryInputRef: null, mediaRootReadable: null },
  });
}

function seedObligation(
  over: {
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
        sourceInboundSeq: 6001,
        sourceMessageId: 'TESTMSG-XT-1',
        conversationKey: 'conv-xt',
        deliveryJid: 'test-dm-target@lid',
        senderJid: 'test-sender@s.whatsapp.net',
        senderName: 'Test Sender',
        isGroup: false,
        groupName: null,
        scope: 'per_chat',
        originRecoveryJobId: null,
        replayText: over.replayText ?? SOURCE_URL,
        contentTypeHint: 'text',
        contractVersion: 'test-contract/1',
        requiredCapability: 'child_process_tools',
        capabilityParams: '{"skill":"watch"}',
        inputDigest: 'aa'.repeat(32),
        sourceDigest: media ? media.sha256 : (over.sourceDigest ?? SOURCE_DIGEST),
        sourceToken: media ? null : (over.sourceToken ?? SOURCE_URL),
        retainedMedia: media,
        creationReason: 'harness_capability_gap',
      },
    }).obligationId!;
  });
  return id;
}

function journalInboundRaw(messageId: string): number {
  const res = db.raw
    .prepare(
      `INSERT INTO inbound_events (message_id, conversation_key, chat_jid, routed_to)
       VALUES (?, 'conv-xt', 'test-dm-target@lid', 'agent')`,
    )
    .run(messageId);
  return Number(res.lastInsertRowid);
}

function makeRuntime(
  script: {
    onDispatch?: (tool: ToolDeclaration) => Promise<void> | void;
    execution?: CapabilityObligationsOptions['execution'];
    turnIdFor?: (conversationKey: string) => string | null;
  } = {},
) {
  const dispatched: Array<{ id: number; minted: string; seq: number }> = [];
  let registeredTool: ToolDeclaration | null = null;
  const runtime = new CapabilityObligationRuntime({
    db,
    store,
    options: script.execution === undefined
      ? OPTIONS
      : {
          ...OPTIONS,
          execution: script.execution,
          attestation: { ...OPTIONS.attestation, resolverDigest: compositeOf(script.execution) },
        },
    prepareDispatch: (obligation) => ({
      facts: LIVE_FACTS,
      dispatch: async (minted, seq) => {
        dispatched.push({ id: obligation.id, minted, seq });
        try {
          await script.onDispatch?.(registeredTool!);
        } catch (error) {
          // Production quarantines dispatch errors; also surface them to Vitest.
          dispatchErrors.push(error);
          throw error;
        }
        return 'dispatched' as ObligationDispatchOutcome;
      },
    }),
    getDurability: () => ({ journalInbound: (messageId: string) => journalInboundRaw(messageId) }),
    externalEffectFor: () => undefined,
    writeLossSince: () => false,
    registerTool: (tool) => {
      registeredTool = tool;
    },
    turnIdFor: script.turnIdFor ?? (() => 'obl-turn'),
  });
  return { runtime, dispatched, tool: () => registeredTool! };
}

const receiptRows = (id: number) =>
  db.raw
    .prepare(
      `SELECT result_status, source_digest, media_digest, logical_turn_id, output_evidence
       FROM capability_execution_receipts WHERE obligation_id = ?`,
    )
    .all(id) as Array<{
    result_status: string;
    source_digest: string | null;
    media_digest: string | null;
    logical_turn_id: string;
    output_evidence: string;
  }>;

const evidenceOf = (row: { output_evidence: string }) => JSON.parse(row.output_evidence) as Record<string, unknown>;

describe('session and parameter refusals', () => {
  it('a session without a conversationKey is refused, and a conversation with no active turn is refused — neither records a receipt', async () => {
    const { tool } = makeRuntime();
    const unbound = (await tool().handler({ source: SOURCE_URL }, { tier: 'global' })) as Record<string, unknown>;
    expect(unbound['error']).toBe('capability_execution');
    expect(String(unbound['message'])).toContain('conversation-bound');

    const noTurn = (await tool().handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
    expect(noTurn['error']).toBe('capability_execution');
    expect(String(noTurn['message'])).toContain('No active capability obligation turn');

    const count = (db.raw.prepare('SELECT COUNT(*) AS c FROM capability_execution_receipts').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('a missing source parameter coerces to the empty string and records a source_mismatch error receipt with the empty-string digest', async () => {
    const EMPTY_DIGEST = createHash('sha256').update('').digest('hex');
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime({
      onDispatch: async (tool) => {
        // Direct handler call with no `source` key — the schema gate lives in the
        // registry; the handler itself must fail closed on the coerced ''.
        const r = (await tool.handler({}, TOOL_SESSION)) as Record<string, unknown>;
        expect(r['error']).toBe('capability_execution');
        expect(String(r['message'])).toContain('Source does not match this obligation');
      },
    });
    await runtime.tickOnce();
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('error');
    expect(rows[0]!.source_digest).toBe(EMPTY_DIGEST);
    expect(evidenceOf(rows[0]!)['reason']).toBe('source_mismatch');
  });

  it('a source beginning with "-" that matches the obligation digest is still refused before spawn (option-flag smuggling)', async () => {
    const SMUGGLE = '--evil-flag';
    const id = seedObligation({
      sourceDigest: createHash('sha256').update(SMUGGLE).digest('hex'),
      sourceToken: SMUGGLE,
      replayText: SMUGGLE,
    });
    freshAttestation();
    const { runtime } = makeRuntime({
      onDispatch: async (tool) => {
        const r = (await tool.handler({ source: SMUGGLE }, TOOL_SESSION)) as Record<string, unknown>;
        expect(r['error']).toBe('capability_execution');
        expect(String(r['message'])).toContain('option-flag smuggling refused');
      },
    });
    await runtime.tickOnce();
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('error');
    const evidence = evidenceOf(rows[0]!);
    expect(evidence['reason']).toBe('source_would_smuggle_option_flag');
    expect('exitCode' in evidence).toBe(false); // refused BEFORE the resolver ran
  });
});

describe('media obligations', () => {
  it('naming anything but the retained media path is refused with a null observed digest, and the resolver never runs', async () => {
    const work = mkdtempSync(join(tmpdir(), 'capx-media-wrongsrc-'));
    const mediaPath = join(work, 'clip.webm');
    writeFileSync(mediaPath, 'RETAINED-MEDIA-BYTES');
    const mediaSha = createHash('sha256').update('RETAINED-MEDIA-BYTES').digest('hex');
    const resolverDir = mkdtempSync(join(tmpdir(), 'capx-media-wrongsrc-resolver-'));
    const marker = join(work, 'ran-marker');
    const resolver = join(resolverDir, 'resolver.cjs');
    writeFileSync(resolver, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'RAN'); console.log('resolver ran anyway');`);
    const execution: CapabilityObligationsOptions['execution'] = { command: [NODE, resolver, '{source}'], interpreter: NODE, args: ['{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
    const id = seedObligation({ retainedMedia: { path: mediaPath, sha256: mediaSha, bytes: 20, policyVersion: 'p/1' } });
    freshAttestation(execution);
    const { runtime } = makeRuntime({
      execution,
      onDispatch: async (tool) => {
        const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        expect(r['error']).toBe('capability_execution');
        expect(String(r['message'])).toContain('Source must be the retained media path');
      },
    });
    await runtime.tickOnce();
    expect(existsSync(marker)).toBe(false);
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('error');
    expect(rows[0]!.source_digest).toBeNull(); // no digest was ever derived for the wrong source
    expect(evidenceOf(rows[0]!)['reason']).toBe('source_is_not_the_retained_media_path');
  });

  it('a media resolver that leaves its snapshot untouched records an ok receipt binding the media digest, and the child read the snapshot bytes', async () => {
    const work = mkdtempSync(join(tmpdir(), 'capx-media-ok-'));
    const mediaPath = join(work, 'clip.webm');
    const CONTENT = 'HAPPY-MEDIA-BYTES';
    writeFileSync(mediaPath, CONTENT);
    const mediaSha = createHash('sha256').update(CONTENT).digest('hex');
    const resolverDir = mkdtempSync(join(tmpdir(), 'capx-media-ok-resolver-'));
    const resolver = join(resolverDir, 'resolver.cjs');
    // Echo the input's CONTENT so the assertion proves the child was handed a
    // readable snapshot of the retained bytes, not just any path.
    writeFileSync(resolver, "const fs=require('fs');console.log('processed-media ' + fs.readFileSync(process.argv[2],'utf8'));");
    const execution: CapabilityObligationsOptions['execution'] = { command: [NODE, resolver, '{source}'], interpreter: NODE, args: ['{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
    const id = seedObligation({ retainedMedia: { path: mediaPath, sha256: mediaSha, bytes: CONTENT.length, policyVersion: 'p/1' } });
    freshAttestation(execution);
    const { runtime } = makeRuntime({
      execution,
      onDispatch: async (tool) => {
        const r = (await tool.handler({ source: mediaPath }, TOOL_SESSION)) as { executed?: boolean; output?: string };
        expect(r.executed).toBe(true);
        expect(r.output).toContain(CONTENT);
      },
    });
    await runtime.tickOnce();
    expect(readFileSync(mediaPath, 'utf8')).toBe(CONTENT); // retained original untouched
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('ok');
    expect(rows[0]!.source_digest).toBe(mediaSha);
    expect(rows[0]!.media_digest).toBe(mediaSha);
  });

  it('a media resolver that MUTATES its snapshot records error, never ok', async () => {
    const work = mkdtempSync(join(tmpdir(), 'capx-media-mut-'));
    const mediaPath = join(work, 'clip.webm');
    const ORIGINAL = 'ORIGINAL-MEDIA-BYTES';
    writeFileSync(mediaPath, ORIGINAL);
    const mediaSha = createHash('sha256').update(ORIGINAL).digest('hex');
    const resolverDir = mkdtempSync(join(tmpdir(), 'capx-media-mut-resolver-'));
    const mutator = join(resolverDir, 'mutator.cjs');
    writeFileSync(mutator, "require('fs').writeFileSync(process.argv[2],'MUTATED-DIFFERENT-BYTES');console.log('processed-and-mutated-ok');");
    const execution: CapabilityObligationsOptions['execution'] = { command: [NODE, mutator, '{source}'], interpreter: NODE, args: ['{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: mutator, interpreted: true };
    const id = seedObligation({ retainedMedia: { path: mediaPath, sha256: mediaSha, bytes: ORIGINAL.length, policyVersion: 'p/1' } });
    freshAttestation(execution);
    const { runtime } = makeRuntime({
      execution,
      onDispatch: async (tool) => {
        const r = (await tool.handler({ source: mediaPath }, TOOL_SESSION)) as Record<string, unknown>;
        expect(r['error']).toBe('capability_execution_failed');
      },
    });
    await runtime.tickOnce();
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('error');
    expect(evidenceOf(rows[0]!)['reason']).toBe('media_mutated_during_execution');
    expect(readFileSync(mediaPath, 'utf8')).toBe(ORIGINAL); // only the snapshot was mutated
  });
});

describe('spawn seam', () => {
  it('a NUL byte in a resolver argv token is refused before any spawn — labeled spawn-failure receipt, resolver never runs', async () => {
    const resolverDir = mkdtempSync(join(tmpdir(), 'capx-nul-resolver-'));
    const markerDir = mkdtempSync(join(tmpdir(), 'capx-nul-marker-'));
    const marker = join(markerDir, 'ran-marker');
    const resolver = join(resolverDir, 'resolver.cjs');
    writeFileSync(resolver, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'RAN'); console.log('resolver ran anyway');`);
    // The NUL rides a config token, which staging does not inspect in interpreted
    // mode past command[0]/command[1] — spawn() would throw an opaque synchronous
    // ERR_INVALID_ARG_VALUE; the guard must reject cleanly first.
    const execution: CapabilityObligationsOptions['execution'] = { command: [NODE, resolver, '{source}', 'nul\0token'], interpreter: NODE, args: ['{source}', 'nul\0token'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
    const id = seedObligation();
    freshAttestation(execution);
    const { runtime } = makeRuntime({
      execution,
      onDispatch: async (tool) => {
        const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        expect(r['error']).toBe('capability_execution');
        expect(String(r['message'])).toContain('Capability resolver could not be started');
      },
    });
    await runtime.tickOnce();
    expect(existsSync(marker)).toBe(false);
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('error');
    expect(evidenceOf(rows[0]!)['reason']).toBe('resolver_spawn_failed');
  });

  it('a synchronous Error thrown by spawn is normalized to the labeled spawn-failure receipt', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime({
      onDispatch: async (tool) => {
        spawnOverride = () => {
          throw new Error('synthetic synchronous spawn failure');
        };
        const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        spawnOverride = null;
        expect(r['error']).toBe('capability_execution');
        expect(String(r['message'])).toContain('Capability resolver could not be started');
      },
    });
    await runtime.tickOnce();
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('error');
    const evidence = evidenceOf(rows[0]!);
    expect(evidence['reason']).toBe('resolver_spawn_failed');
    expect('exitCode' in evidence).toBe(false);
  });

  it('a synchronous NON-Error throw from spawn is wrapped and still yields the labeled spawn-failure receipt', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime({
      onDispatch: async (tool) => {
        spawnOverride = () => {
          // eslint-disable-next-line no-throw-literal -- the non-Error wrap arm is the test subject; expires 2099-12-31
          throw 'synthetic-nonerror-throw';
        };
        const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        spawnOverride = null;
        expect(r['error']).toBe('capability_execution');
        expect(String(r['message'])).toContain('Capability resolver could not be started');
      },
    });
    await runtime.tickOnce();
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('error');
    expect(evidenceOf(rows[0]!)['reason']).toBe('resolver_spawn_failed');
  });

  it('a pid-less child that outlives the watchdog is recorded as a timed-out signal exit — the group-kill is a safe no-op', async () => {
    const execution: CapabilityObligationsOptions['execution'] = { command: [NODE, RESOLVER_PATH, '{source}'], interpreter: NODE, args: ['{source}'], timeoutMs: 100, minOutputBytes: 8, resolverArtifactPath: RESOLVER_PATH, interpreted: true };
    const id = seedObligation();
    freshAttestation(execution);
    const { runtime } = makeRuntime({
      execution,
      onDispatch: async (tool) => {
        spawnOverride = () => {
          const child = new FakeChild(undefined);
          // Real wall time must pass the 100ms watchdog so the pid-less kill
          // path runs before the child reports its signal death.
          TIMING(600, () => child.emit('close', null, 'SIGKILL'));
          return child;
        };
        const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        spawnOverride = null;
        expect(r['error']).toBe('capability_execution_failed');
        expect(String(r['message'])).toContain('exit=none');
        expect(String(r['message'])).toContain('signal=SIGKILL');
        expect(String(r['message'])).toContain('timedOut=true');
      },
    });
    await runtime.tickOnce();
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('error');
    const evidence = evidenceOf(rows[0]!);
    expect(evidence['exitCode']).toBeNull();
    expect(evidence['timedOut']).toBe(true);
  });

  it('an error event AFTER a clean close does not disturb the settled ok outcome', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime({
      onDispatch: async (tool) => {
        spawnOverride = () => {
          // A pid far outside any live pgid range: the close-time group sweep hits
          // ESRCH and is swallowed, never a real process group.
          const child = new FakeChild(2 ** 30);
          setImmediate(() => {
            child.stdout.emit('data', Buffer.from('fake-clean-exit-output'));
            child.emit('close', 0, null);
            child.emit('error', new Error('late error after settlement'));
          });
          return child;
        };
        const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as { executed?: boolean; output?: string };
        spawnOverride = null;
        expect(r.executed).toBe(true);
        expect(r.output).toBe('fake-clean-exit-output');
      },
    });
    await runtime.tickOnce();
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1); // settled exactly once — no second receipt from the late error
    expect(rows[0]!.result_status).toBe('ok');
  });

  it('a close event AFTER a spawn error does not double-settle — exactly one labeled spawn-failure receipt', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime } = makeRuntime({
      onDispatch: async (tool) => {
        spawnOverride = () => {
          const child = new FakeChild(undefined);
          setImmediate(() => {
            child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
            child.emit('close', null, null);
          });
          return child;
        };
        const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        spawnOverride = null;
        expect(r['error']).toBe('capability_execution');
        expect(String(r['message'])).toContain('Capability resolver could not be started');
      },
    });
    await runtime.tickOnce();
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('error');
    expect(evidenceOf(rows[0]!)['reason']).toBe('resolver_spawn_failed');
  });
});

describe('output capture caps', () => {
  it('stdout and stderr capture stop growing at their caps while the run still completes ok', async () => {
    const resolverDir = mkdtempSync(join(tmpdir(), 'capx-caps-resolver-'));
    const resolver = join(resolverDir, 'flood.cjs');
    // 400_000 > STDOUT_CAP_BYTES (262_144); 200_000 > STDERR_CAP_BYTES (65_536).
    // Pipes deliver in bounded chunks, so appending stops within one chunk of
    // each cap — well under the totals written.
    writeFileSync(resolver, "process.stdout.write('a'.repeat(400000)); process.stderr.write('b'.repeat(200000));");
    const execution: CapabilityObligationsOptions['execution'] = { command: [NODE, resolver, '{source}'], interpreter: NODE, args: ['{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
    const id = seedObligation();
    freshAttestation(execution);
    const { runtime } = makeRuntime({
      execution,
      onDispatch: async (tool) => {
        const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as { executed?: boolean; output?: string };
        expect(r.executed).toBe(true);
        const len = r.output?.length ?? 0;
        expect(len).toBeGreaterThanOrEqual(262_144); // the cap was reached…
        expect(len).toBeLessThan(400_000); // …and later chunks were dropped, not appended
      },
    });
    await runtime.tickOnce();
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('ok');
    const evidence = evidenceOf(rows[0]!);
    expect(evidence['stderrBytes']).toBeGreaterThanOrEqual(65_536);
    expect(evidence['stderrBytes']).toBeLessThan(200_000);
  });
});

describe('direct (non-interpreted) execution mode', () => {
  it('a direct-mode resolver executes its STAGED copy as argv[0] with {source} substituted', async () => {
    const resolverDir = mkdtempSync(join(tmpdir(), 'capx-direct-resolver-'));
    const script = join(resolverDir, 'watch-direct-resolver');
    writeFileSync(script, '#!/bin/sh\nprintf "processed direct %s ok\\n" "$1"\n');
    chmodSync(script, 0o755);
    const execution: CapabilityObligationsOptions['execution'] = { command: [script, '{source}'], interpreter: null, args: ['{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: script, interpreted: false };
    const id = seedObligation();
    freshAttestation(execution);
    const { runtime } = makeRuntime({
      execution,
      onDispatch: async (tool) => {
        const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as { executed?: boolean; output?: string };
        expect(r.executed).toBe(true);
        expect(r.output).toContain(`processed direct ${SOURCE_URL} ok`);
      },
    });
    await runtime.tickOnce();
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('ok');
    expect(rows[0]!.source_digest).toBe(SOURCE_DIGEST);
  });
});

describe('resolver identity refusal', () => {
  it('a resolver whose content is swapped after attestation is refused at the drain seam and never executed', async () => {
    const resolverDir = mkdtempSync(join(tmpdir(), 'capx-swap-resolver-'));
    const markerDir = mkdtempSync(join(tmpdir(), 'capx-swap-marker-'));
    const marker = join(markerDir, 'evil-marker');
    const resolver = join(resolverDir, 'resolver.cjs');
    writeFileSync(resolver, 'console.log("processed " + process.argv[2] + " ORIGINAL ok");');
    const execution: CapabilityObligationsOptions['execution'] = { command: [NODE, resolver, '{source}'], interpreter: NODE, args: ['{source}'], timeoutMs: 30_000, minOutputBytes: 8, resolverArtifactPath: resolver, interpreted: true };
    const id = seedObligation();
    freshAttestation(execution); // binds the ORIGINAL bytes
    const { runtime } = makeRuntime({
      execution,
      onDispatch: async (tool) => {
        writeFileSync(resolver, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'PWNED'); console.log('processed SWAPPED ok');`);
        const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        expect(r['error']).toBe('capability_execution');
      },
    });
    await runtime.tickOnce();
    expect(existsSync(marker)).toBe(false); // the swapped bytes never ran
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('error');
    expect(evidenceOf(rows[0]!)['reason']).toBe('resolver_digest_mismatch');
  });
});

describe('receipt turn identity', () => {
  it('when no live logical turn owns the conversation, the receipt falls back to the minted message id', async () => {
    const id = seedObligation();
    freshAttestation();
    const { runtime, dispatched } = makeRuntime({
      turnIdFor: () => null, // terminal-record identity resolver finds no live turn
      onDispatch: async (tool) => {
        const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as { executed?: boolean };
        expect(r.executed).toBe(true);
      },
    });
    await runtime.tickOnce();
    expect(dispatched).toEqual([{ id, minted: `obl:${id}:1`, seq: expect.any(Number) }]);
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result_status).toBe('ok');
    expect(rows[0]!.logical_turn_id).toBe(dispatched[0]!.minted);
  });
});

// ── post-merge audit hotfix (2026-08-14): F1 duplicate execution, F3 durability loss, F8 caps/signals ──

/** A resolver in its own isolated dir that APPENDS one line to a count file per run. */
function countingResolver(): { execution: CapabilityObligationsOptions['execution']; countFile: string; runs: () => number } {
  const dir = mkdtempSync(join(tmpdir(), 'co-exectool-count-'));
  const counterDir = mkdtempSync(join(tmpdir(), 'co-exectool-countfile-')); // OUTSIDE the resolver dir: the whole-dir manifest binds every sibling
  const countFile = join(counterDir, 'runs.log');
  const script = join(dir, 'counting-resolver.cjs');
  writeFileSync(
    script,
    `require('node:fs').appendFileSync(${JSON.stringify(countFile)}, 'ran\\n');\nconsole.log('processed ' + process.argv[2] + ' externally ok');\n`,
  );
  return {
    execution: {
      command: [NODE, script, '{source}'],
      interpreter: NODE,
      args: ['{source}'],
      timeoutMs: 30_000,
      minOutputBytes: 8,
      resolverArtifactPath: script,
      interpreted: true,
    },
    countFile,
    runs: () => (existsSync(countFile) ? readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length : 0),
  };
}

describe('durable execution reservation (audit F1 — Critical)', () => {
  it('a second call for the SAME claim epoch and attempt is refused and the external resolver runs exactly ONCE', async () => {
    const counting = countingResolver();
    const id = seedObligation();
    freshAttestation(counting.execution);
    const { runtime } = makeRuntime({
      execution: counting.execution,
      onDispatch: async (tool) => {
        const first = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        expect(first['executed']).toBe(true);
        const second = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        expect(second['error']).toBe('capability_execution');
        expect(String(second['message'])).toContain('already reserved an execution');
      },
    });
    await runtime.tickOnce();
    expect(counting.runs()).toBe(1); // the external side effect happened exactly once
    const rows = receiptRows(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.result_status).sort()).toEqual(['error', 'ok']);
    const errorRow = rows.find((r) => r.result_status === 'error')!;
    expect(evidenceOf(errorRow)['reason']).toBe('execution_already_reserved');
    const reservations = db.raw
      .prepare('SELECT COUNT(*) AS n FROM capability_execution_reservations WHERE obligation_id = ?')
      .get(id) as { n: number };
    expect(reservations).toEqual({ n: 1 });
  });

  it('a refused call (source mismatch) consumes NO reservation — the corrected retry still executes', async () => {
    const counting = countingResolver();
    const id = seedObligation();
    freshAttestation(counting.execution);
    const { runtime } = makeRuntime({
      execution: counting.execution,
      onDispatch: async (tool) => {
        const wrong = (await tool.handler({ source: 'https://youtu.be/WRONG' }, TOOL_SESSION)) as Record<string, unknown>;
        expect(wrong['error']).toBe('capability_execution');
        const right = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        expect(right['executed']).toBe(true);
      },
    });
    await runtime.tickOnce();
    expect(counting.runs()).toBe(1);
    const rows = receiptRows(id);
    expect(rows.map((r) => r.result_status).sort()).toEqual(['error', 'ok']);
  });
});

describe('receipt durability loss is caller-visible (audit F3)', () => {
  it('a successful execution whose receipt cannot persist returns a durability-loss ERROR, never clean success', async () => {
    const counting = countingResolver();
    seedObligation();
    freshAttestation(counting.execution);
    const originalRecord = store.recordExecutionReceipt.bind(store);
    let failNext = false;
    (store as { recordExecutionReceipt: typeof store.recordExecutionReceipt }).recordExecutionReceipt = (params) => {
      if (failNext) {
        failNext = false;
        throw new Error('synthetic receipt write loss');
      }
      return originalRecord(params);
    };
    // The runtime QUARANTINES a throwing dispatch, so an expect() inside
    // onDispatch is swallowed — capture the handler result and assert OUTSIDE
    // the dispatch closure (this is what actually kills the return-true mutant).
    let observed: Record<string, unknown> | null = null;
    const { runtime } = makeRuntime({
      execution: counting.execution,
      onDispatch: async (tool) => {
        failNext = true; // the NEXT receipt write (this call's) is lost
        observed = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
      },
    });
    await runtime.tickOnce();
    expect(counting.runs()).toBe(1); // the external work DID happen — which is exactly why the loss must be visible
    expect(observed).not.toBeNull();
    const r = observed! as Record<string, unknown>;
    expect(String(r['message'])).toContain('could NOT be persisted');
    expect(String(r['message'])).toContain('Do not send');
    expect(r['executed']).toBeUndefined();
    expect(r['output']).toBeUndefined();
    expect(r).toMatchObject({ error: 'capability_execution_durability_loss' });
  });
});

describe('byte-exact caps and honest signal labeling (audit F8)', () => {
  it('multi-byte UTF-8 flood is capped at EXACTLY the advertised stdout byte limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'co-exectool-flood-'));
    const script = join(dir, 'flood-resolver.cjs');
    // 100k × '€' = 300,000 UTF-8 bytes > the 262,144 cap
    writeFileSync(script, "process.stdout.write('\\u20ac'.repeat(100000));\n");
    const execution: CapabilityObligationsOptions['execution'] = {
      command: [NODE, script, '{source}'],
      interpreter: NODE,
      args: ['{source}'],
      timeoutMs: 30_000,
      minOutputBytes: 8,
      resolverArtifactPath: script,
      interpreted: true,
    };
    const id = seedObligation();
    freshAttestation(execution);
    const { runtime } = makeRuntime({
      execution,
      onDispatch: async (tool) => {
        const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        expect(r['executed']).toBe(true);
        expect(Buffer.byteLength(String(r['output']), 'utf8')).toBeLessThanOrEqual(262_144);
      },
    });
    await runtime.tickOnce();
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    expect(evidenceOf(rows[0]!)['stdoutBytes']).toBe(262_144); // byte-exact at the cap, never beyond
  });

  it('a child killed by a signal reports signal=SIGKILL with timedOut=false — no watchdog, no timeout claim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'co-exectool-sig-'));
    const script = join(dir, 'selfkill-resolver.cjs');
    writeFileSync(script, "process.kill(process.pid, 'SIGKILL');\n");
    const execution: CapabilityObligationsOptions['execution'] = {
      command: [NODE, script, '{source}'],
      interpreter: NODE,
      args: ['{source}'],
      timeoutMs: 30_000,
      minOutputBytes: 8,
      resolverArtifactPath: script,
      interpreted: true,
    };
    const id = seedObligation();
    freshAttestation(execution);
    const { runtime } = makeRuntime({
      execution,
      onDispatch: async (tool) => {
        const r = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        expect(r['error']).toBe('capability_execution_failed');
        expect(String(r['message'])).toContain('signal=SIGKILL');
        expect(String(r['message'])).toContain('timedOut=false');
      },
    });
    await runtime.tickOnce();
    const rows = receiptRows(id);
    expect(rows).toHaveLength(1);
    const evidence = evidenceOf(rows[0]!);
    expect(evidence['signal']).toBe('SIGKILL');
    expect(evidence['timedOut']).toBe(false);
  });
});

// ── issue 3568: the resolver's group reap must never mask a live member ──

/**
 * Spies on process.kill and hands ONLY a group kill aimed at the resolver's own group (a real
 * detached spawn recorded by the child_process mock) to `answer`; every other call goes to the
 * real kill. While `answer` runs, its own process.kill calls also go to the real kill.
 */
function interceptResolverGroupKill(answer: GroupSignalSeam): { targets: number[]; restore: () => void } {
  const realKill = process.kill.bind(process);
  const targets: number[] = [];
  let answering = false;
  const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (!answering && pid < -1 && detachedSpawnPids.includes(-pid)) {
      targets.push(pid);
      answering = true;
      try {
        answer(pid, (signal ?? 'SIGTERM') as NodeJS.Signals);
      } finally {
        answering = false;
      }
      return true;
    }
    return realKill(pid, signal);
  }) as typeof process.kill);
  return { targets, restore: () => spy.mockRestore() };
}

/**
 * A `ps` listing in which the group the probe asked about holds only a zombie. It answers for the
 * pgid the probe was given, so a probe of anything but a positive pid reads as malformed
 * (`unknown`) and fails closed.
 */
function zombieOnlyListing(): { status: number; stdout: string } {
  const pgid = probedPgids[probedPgids.length - 1] ?? 0;
  return { status: 0, stdout: ` ${pgid} ${pgid} Z\n` };
}

/** The operator warning the call site must log once when the group is not proven reaped. */
function expectOneReapWarning(obligationId: number, reapError: RegExp): void {
  const reapWarnings = executionToolWarns.filter(([fields]) => typeof fields === 'object' && fields !== null && 'reapError' in fields);
  expect(reapWarnings).toEqual([[{ obligationId, reapError: expect.stringMatching(reapError) }, 'capability resolver process group not proven reaped']]);
}

/** The operator warning the call site must log once when the run settled without a `close`. */
function expectOneCloseNotObservedWarning(obligationId: number): void {
  const closeWarnings = executionToolWarns.filter(([fields]) => typeof fields === 'object' && fields !== null && 'closeNotObserved' in fields);
  expect(closeWarnings).toEqual([[{ obligationId, closeNotObserved: true }, 'capability resolver output still open after the reap grace; a descendant may still be running']]);
}

const reapResolverDirs = trackTmpDirs('co-exectool-3568-');

/** A resolver in its own dir (removed after each test): the whole-dir manifest binds every sibling. */
function isolatedResolver(name: string, source: string, timeoutMs = 30_000): CapabilityObligationsOptions['execution'] {
  const dir = reapResolverDirs.make(name);
  const script = join(dir, 'resolver.cjs');
  writeFileSync(script, source);
  return {
    command: [NODE, script, '{source}'],
    interpreter: NODE,
    args: ['{source}'],
    timeoutMs,
    minOutputBytes: 8,
    resolverArtifactPath: script,
    interpreted: true,
  };
}

async function runToolOnce(
  execution?: CapabilityObligationsOptions['execution'],
): Promise<{ id: number; result: Record<string, unknown> }> {
  const id = seedObligation();
  freshAttestation(execution ?? OPTIONS.execution);
  let result: Record<string, unknown> = {};
  const { runtime } = makeRuntime({
    ...(execution === undefined ? {} : { execution }),
    onDispatch: async (tool) => {
      result = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
    },
  });
  await runtime.tickOnce();
  return { id, result };
}

/** Resolver source that changes the snapshot it was handed (argv[2]) before anything else. */
const SNAPSHOT_MUTATION = "require('fs').writeFileSync(process.argv[2],'MUTATED-DIFFERENT-BYTES');";

/** runToolOnce for a media obligation: the source is the retained media path, which the run snapshots. */
async function runMediaToolOnce(
  execution: CapabilityObligationsOptions['execution'],
  media: { path: string; content: string },
): Promise<{ id: number; result: Record<string, unknown> }> {
  writeFileSync(media.path, media.content);
  const sha256 = createHash('sha256').update(media.content).digest('hex');
  const id = seedObligation({ retainedMedia: { path: media.path, sha256, bytes: Buffer.byteLength(media.content), policyVersion: 'p/1' } });
  freshAttestation(execution);
  let result: Record<string, unknown> = {};
  const { runtime } = makeRuntime({
    execution,
    onDispatch: async (tool) => {
      result = (await tool.handler({ source: media.path }, TOOL_SESSION)) as Record<string, unknown>;
    },
  });
  await runtime.tickOnce();
  return { id, result };
}

const listResolverStages =(): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith('ws-resolver-stage-'));

describe('resolver process-group reap (issue 3568)', () => {
  it('an EPERM close-time sweep of a group with no live member records ok, the same as an ESRCH sweep', async () => {
    let probeCalls = 0;
    psOverride = () => { probeCalls += 1; return zombieOnlyListing(); };
    const kill = interceptResolverGroupKill(deliverThenThrow('EPERM', []));
    try {
      const { id, result } = await runToolOnce();
      // One probe, of the resolver's own positive pid: the close-time sweep is the only kill.
      expect(probeCalls).toBe(1);
      expect(detachedSpawnPids).toHaveLength(1);
      expect(probedPgids).toEqual([detachedSpawnPids[0]]);
      expect(kill.targets).toEqual([-detachedSpawnPids[0]!]);
      const rows = receiptRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result_status).toBe('ok');
      expect(evidenceOf(rows[0]!)['reapError']).toBeUndefined();
      expect(result['executed']).toBe(true);
    } finally {
      kill.restore();
    }
  }, 20_000);

  it('an EPERM close-time sweep while a same-group grandchild is live records error with reapError (default ps probe)', async () => {
    // The resolver leaves a same-group grandchild that lives until this test's teardown kills it,
    // then ends with output. It writes the grandchild's pid before it prints, so the pid is known
    // before the close-time sweep and its probe run. The pid goes to a tracked dir OUTSIDE the
    // resolver dir.
    const pidFile = join(reapResolverDirs.make('eperm-live-pid'), 'grandchild.pid');
    const execution = isolatedResolver(
      'eperm-live',
      grandchildResolverSource(pidFile, { holdStdio: false, setsid: false, block: false }),
    );
    const pidKnownAtKill: boolean[] = [];
    // No signal reaches the group, so the grandchild is still live when the real ps probe reads it.
    const kill = interceptResolverGroupKill(() => {
      pidKnownAtKill.push(existsSync(pidFile));
      throw groupKillError('EPERM');
    });
    try {
      const { id, result } = await runToolOnce(execution);
      expect(pidKnownAtKill).toEqual([true]);
      const rows = receiptRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result_status).toBe('error');
      expect(String(evidenceOf(rows[0]!)['reapError'])).toMatch(/EPERM; group membership probe: live/);
      expect(result['error']).toBe('capability_execution_failed');
      expect(String(result['message'])).toMatch(/reapError=group kill failed: EPERM; group membership probe: live/);
      expectOneReapWarning(id, /EPERM; group membership probe: live/);
    } finally {
      kill.restore();
      reapFixtureGroups(kill.targets); // the grandchild is still alive, so its group id is still allocated
      const gcPid = readFixturePid(pidFile);
      if (gcPid !== undefined) expect(await waitForPidGone(gcPid)).toBe(true);
    }
  }, 20_000);

  it('an EPERM close-time sweep that the membership probe cannot read records error — fail closed', async () => {
    let probeCalls = 0;
    psOverride = () => { probeCalls += 1; return { status: 1, stdout: '' }; };
    const kill = interceptResolverGroupKill(throwOnly('EPERM', []));
    try {
      const { id } = await runToolOnce();
      const rows = receiptRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result_status).toBe('error');
      expect(String(evidenceOf(rows[0]!)['reapError'])).toMatch(/EPERM; group membership probe: unknown/);
      expect(probeCalls).toBeGreaterThan(0);
    } finally {
      kill.restore(); // no fixture reap: the leader exited and was reaped, so its group id may be reused
    }
  }, 20_000);

  it('a group-sweep error other than EPERM records error without consulting the membership probe', async () => {
    let probeCalls = 0;
    psOverride = () => { probeCalls += 1; return zombieOnlyListing(); };
    const kill = interceptResolverGroupKill(throwOnly('EINVAL', []));
    try {
      const { id } = await runToolOnce();
      const rows = receiptRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result_status).toBe('error');
      expect(String(evidenceOf(rows[0]!)['reapError'])).toMatch(/EINVAL/);
      expect(probeCalls).toBe(0);
    } finally {
      kill.restore();
    }
  }, 20_000);

  it('a watchdog EPERM that leaves a live grandchild holding stdout settles an error receipt within the reap grace', async () => {
    // The grandchild inherits the resolver's stdout and stderr and holds them until this test's
    // teardown, so `close` cannot fire before the 5 s grace that follows the 3 s watchdog. 3 s
    // leaves room for two node start-ups under load, as in attest. The pid goes to a tracked dir
    // OUTSIDE the resolver dir.
    const pidFile = join(reapResolverDirs.make('eperm-no-close-pid'), 'grandchild.pid');
    const execution = isolatedResolver(
      'eperm-no-close',
      grandchildResolverSource(pidFile, { holdStdio: true, setsid: false, block: true }),
      3_000,
    );
    const kill = interceptResolverGroupKill(killLeaderOnceThenEperm([]));
    const before = new Set(listResolverStages());
    const start = Date.now();
    const run = runToolOnce(execution);
    try {
      // A run that never settles fails here, below the test timeout, so the teardown below still runs.
      const { id, result } = await settleWithin(run, 19_000, 'the run did not settle within 19 s: the reap grace never settled it');
      const elapsed = Date.now() - start;
      expect(existsSync(pidFile)).toBe(true); // the grandchild existed before the watchdog fired
      const rows = receiptRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result_status).toBe('error');
      const evidence = evidenceOf(rows[0]!);
      expect(String(evidence['reapError'])).toMatch(/EPERM; group membership probe: live/);
      expect(evidence['reason']).toBe('resolver_close_not_observed');
      expect(evidence['timedOut']).toBe(true);
      expect(result['error']).toBe('capability_execution_failed');
      expect(elapsed).toBeLessThan(18_000); // the grace settled it; the grandchild never released stdout
      expect(listResolverStages().filter((n) => !before.has(n))).toEqual([]); // the stage dir was removed
      // Grace expiry destroys the child's pipes and does not signal the group again: the failed
      // first kill is the only one.
      expect(kill.targets).toHaveLength(1);
      expect(detachedSpawns).toHaveLength(1);
      expect(detachedSpawns[0]!.stdout?.destroyed).toBe(true);
      expect(detachedSpawns[0]!.stderr?.destroyed).toBe(true);
      expect(String(result['message'])).toMatch(/reapError=group kill failed: EPERM; group membership probe: live/);
      expectOneReapWarning(id, /EPERM; group membership probe: live/);
    } finally {
      // Runs whether or not the run settled. Restore the spy first: while it is active, a kill of
      // the resolver group goes to the seam, which no longer signals anything.
      kill.restore();
      reapFixtureGroups(kill.targets); // the grandchild is still alive, so its group id is still allocated
      const gcPid = readFixturePid(pidFile);
      const gone = gcPid === undefined ? true : await waitForPidGone(gcPid);
      // A run still pending here settles once the grandchild is gone; let it finish before the DB closes.
      await settleWithin(run, 2_000, 'the run did not settle after teardown').catch(() => undefined);
      expect(gone).toBe(true);
    }
    // 30 s: a hung run costs the start-up, the 19 s bound, up to 2 s of waitForPidGone and the 2 s
    // settle, and all of it must finish before the test timeout.
  }, 30_000);

  it('a watchdog group kill that succeeds while a setsid descendant holds stdout settles after the reap grace as close-not-observed', async () => {
    // The descendant leaves the resolver's group, so the watchdog's group kill succeeds yet never
    // reaches it, and it holds stdout and stderr until this test's teardown.
    const pidFile = join(reapResolverDirs.make('setsid-pid'), 'grandchild.pid');
    const execution = isolatedResolver(
      'setsid-holder',
      grandchildResolverSource(pidFile, { holdStdio: true, setsid: true, block: true }),
      3_000,
    );
    // Records each group kill and still delivers it, so the real kill succeeds.
    const kill = interceptResolverGroupKill((target, signal) => { process.kill(target, signal); });
    const before = new Set(listResolverStages());
    const run = runToolOnce(execution);
    try {
      // 3 s watchdog + 5 s grace: a run that never arms the grace hangs, and this bound fails it.
      const { id, result } = await settleWithin(run, 18_000, 'the run did not settle within 18 s: no reap grace after a successful watchdog kill');
      expect(existsSync(pidFile)).toBe(true); // the descendant existed before the watchdog fired
      const rows = receiptRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result_status).toBe('error');
      const evidence = evidenceOf(rows[0]!);
      expect(evidence['reason']).toBe('resolver_close_not_observed');
      expect(evidence['timedOut']).toBe(true);
      expect(evidence['reapError']).toBeUndefined(); // the group kill itself succeeded
      expect(result['error']).toBe('capability_execution_failed');
      expect(listResolverStages().filter((n) => !before.has(n))).toEqual([]); // the stage dir was removed
      // Exactly one group kill, the watchdog's: grace expiry never signals the group again.
      expect(kill.targets).toEqual([-detachedSpawnPids[0]!]);
      // The kill succeeded, yet something still held the output open: the agent and the operator
      // must both hear that a descendant may still be running.
      expect(String(result['message'])).toMatch(/timedOut=true, closeNotObserved=true\)/);
      expectOneCloseNotObservedWarning(id);
    } finally {
      // Runs whether or not the run settled.
      kill.restore();
      const gcPid = readFixturePid(pidFile);
      // The descendant is alive and leads its own group, so that group id is still allocated.
      if (gcPid !== undefined) reapFixtureGroups([-gcPid]);
      const gone = gcPid === undefined ? true : await waitForPidGone(gcPid);
      // A run still pending here settles once the descendant is gone; let it finish before the DB closes.
      await settleWithin(run, 2_000, 'the run did not settle after teardown').catch(() => undefined);
      expect(gone).toBe(true);
    }
    // 30 s: a hung run costs the start-up, the 18 s bound, up to 2 s of waitForPidGone and the 2 s
    // settle, and all of it must finish before the test timeout.
  }, 30_000);

  it('a child error event sweeps the resolver group before the run rejects', async () => {
    // A pid far outside any live pgid range: the spy answers the sweep, so nothing real is signalled.
    const fakePid = 2 ** 30;
    const kill = interceptResolverGroupKill(() => { /* delivered */ });
    const id = seedObligation();
    freshAttestation();
    let result: Record<string, unknown> = {};
    const { runtime } = makeRuntime({
      onDispatch: async (tool) => {
        spawnOverride = () => {
          const child = new FakeChild(fakePid);
          detachedSpawnPids.push(fakePid); // the override bypasses the mock's recording
          setImmediate(() => child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
          return child;
        };
        result = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        spawnOverride = null;
      },
    });
    try {
      await runtime.tickOnce();
      expect(result['error']).toBe('capability_execution');
      expect(String(result['message'])).toContain('Capability resolver could not be started');
      const rows = receiptRows(id);
      expect(rows).toHaveLength(1);
      expect(evidenceOf(rows[0]!)['reason']).toBe('resolver_spawn_failed');
      expect(kill.targets).toEqual([-fakePid]);
    } finally {
      kill.restore();
    }
  }, 20_000);

  it('a failed error-path sweep keeps its reapError: on the rejected error, in the reap warning and in the receipt', async () => {
    // A pid far outside any live pgid range: the spy answers the sweep with EINVAL, so nothing real
    // is signalled and the membership probe is never asked.
    const fakePid = 2 ** 30;
    const kill = interceptResolverGroupKill(throwOnly('EINVAL', []));
    const id = seedObligation();
    freshAttestation();
    let result: Record<string, unknown> = {};
    const { runtime } = makeRuntime({
      onDispatch: async (tool) => {
        spawnOverride = () => {
          const child = new FakeChild(fakePid);
          detachedSpawnPids.push(fakePid); // the override bypasses the mock's recording
          setImmediate(() => child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })));
          return child;
        };
        result = (await tool.handler({ source: SOURCE_URL }, TOOL_SESSION)) as Record<string, unknown>;
        spawnOverride = null;
      },
    });
    try {
      await runtime.tickOnce();
      expect(result['error']).toBe('capability_execution');
      // The group was started and not proven reaped, so the agent's message names reapError and
      // does not claim the resolver never started.
      expect(String(result['message'])).toMatch(/reapError=group kill failed: EINVAL/);
      expect(String(result['message'])).not.toContain('could not be started');
      expect(kill.targets).toEqual([-fakePid]);
      const rows = receiptRows(id);
      expect(rows).toHaveLength(1);
      const evidence = evidenceOf(rows[0]!);
      expect(evidence['reason']).toBe('resolver_spawn_failed');
      // The rejected error carries the sweep's reapError to the call site.
      const spawnFailedWarns = executionToolWarns.filter(([, message]) => message === 'capability resolver spawn failed');
      expect(spawnFailedWarns).toHaveLength(1);
      const [spawnFailedFields] = spawnFailedWarns[0]!;
      expect(String((spawnFailedFields as { err?: { reapError?: unknown } }).err?.reapError)).toMatch(/group kill failed: EINVAL/);
      // The call site names the group in the reap warning, and the receipt records it.
      expectOneReapWarning(id, /group kill failed: EINVAL/);
      expect(String(evidence['reapError'])).toMatch(/group kill failed: EINVAL/);
    } finally {
      kill.restore();
    }
  }, 20_000);

  it('a resolver that mutates its snapshot and leaves its group unproven keeps reapError in the receipt and the tool error', async () => {
    // The resolver changes its snapshot, prints and exits; the close-time sweep then meets EPERM,
    // and a probe that cannot read `ps` answers `unknown`.
    let probeCalls = 0;
    psOverride = () => { probeCalls += 1; return { status: 1, stdout: '' }; };
    const execution = isolatedResolver('media-reap', `${SNAPSHOT_MUTATION}console.log('processed-and-mutated-ok');`);
    const mediaPath = join(reapResolverDirs.make('media-reap-work'), 'clip.webm');
    const kill = interceptResolverGroupKill(throwOnly('EPERM', []));
    try {
      const { id, result } = await runMediaToolOnce(execution, { path: mediaPath, content: 'ORIGINAL-MEDIA-BYTES' });
      expect(probeCalls).toBeGreaterThan(0);
      const rows = receiptRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result_status).toBe('error');
      const evidence = evidenceOf(rows[0]!);
      expect(evidence['reason']).toBe('media_mutated_during_execution');
      // The media failure must not hide a group the run could not prove reaped.
      expect(evidence['reapError']).toBe('group kill failed: EPERM; group membership probe: unknown');
      expect(result['error']).toBe('capability_execution_failed');
      expect(result['message']).toBe('Retained media changed during execution, reapError=group kill failed: EPERM; group membership probe: unknown');
      expectOneReapWarning(id, /EPERM; group membership probe: unknown/);
    } finally {
      kill.restore(); // no fixture reap: the leader exited and was reaped, so its group id may be reused
    }
  }, 20_000);

  it('a resolver that mutates its snapshot while a setsid descendant holds stdout keeps closeNotObserved in the receipt and the tool error', async () => {
    // The resolver changes its snapshot first, then leaves a setsid descendant that holds stdout and
    // stderr until this test's teardown, so the run settles on the reap grace.
    const pidFile = join(reapResolverDirs.make('media-setsid-pid'), 'grandchild.pid');
    const execution = isolatedResolver(
      'media-setsid',
      SNAPSHOT_MUTATION + grandchildResolverSource(pidFile, { holdStdio: true, setsid: true, block: true }),
      3_000,
    );
    const mediaPath = join(reapResolverDirs.make('media-setsid-work'), 'clip.webm');
    const run = runMediaToolOnce(execution, { path: mediaPath, content: 'ORIGINAL-MEDIA-BYTES' });
    try {
      // 3 s watchdog + 5 s grace: a run that never arms the grace hangs, and this bound fails it.
      const { id, result } = await settleWithin(run, 18_000, 'the run did not settle within 18 s: no reap grace after a successful watchdog kill');
      expect(existsSync(pidFile)).toBe(true); // the descendant existed before the watchdog fired
      const rows = receiptRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result_status).toBe('error');
      const evidence = evidenceOf(rows[0]!);
      expect(evidence['reason']).toBe('media_mutated_during_execution');
      // The media failure must not hide that a descendant may still be running.
      expect(evidence['closeNotObserved']).toBe(true);
      expect(evidence['reapError']).toBeUndefined(); // the group kill itself succeeded
      expect(result['error']).toBe('capability_execution_failed');
      expect(result['message']).toBe('Retained media changed during execution, closeNotObserved=true');
      expectOneCloseNotObservedWarning(id);
    } finally {
      const gcPid = readFixturePid(pidFile);
      // The descendant is alive and leads its own group, so that group id is still allocated.
      if (gcPid !== undefined) reapFixtureGroups([-gcPid]);
      const gone = gcPid === undefined ? true : await waitForPidGone(gcPid);
      // A run still pending here settles once the descendant is gone; let it finish before the DB closes.
      await settleWithin(run, 2_000, 'the run did not settle after teardown').catch(() => undefined);
      expect(gone).toBe(true);
    }
    // 30 s: a hung run costs the start-up, the 18 s bound, up to 2 s of waitForPidGone and the 2 s
    // settle, and all of it must finish before the test timeout.
  }, 30_000);
});
