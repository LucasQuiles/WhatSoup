/**
 * capability-obligation-attest (round-15 finding 1 front-door): the operator
 * command derives the binding and records an ADMISSIBLE attestation only on a
 * passing canary. Dry-run (no canary) records nothing; a failed canary records
 * nothing (fail-closed). The canary outcome is injected here — no resolver runs.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { attestationBindingDigest, findAdmissibleAttestation } from '../../src/core/capability-attestation.ts';
import { parseCapabilityObligationsOptions, type CapabilityObligationsOptions } from '../../src/core/capability-contract.ts';
import { directoryManifestDigest, resolverCompositeDigest } from '../../src/core/capability-resolver-artifact.ts';
import { Database } from '../../src/core/database.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { trustedNodePath } from '../helpers/trusted-node.ts';
import {
  assertArgsMatchConfig,
  assertMediaRootReadable,
  attest,
  bindingForAttestArgs,
  loadObligationOptionsFromConfig,
  observeResolverArtifact,
  parseAttestArgs,
  runResolverCanary,
  type AttestArgs,
} from '../../scripts/capability-obligation-attest.ts';

let db: Database;

const CLI_PATH = fileURLToPath(new URL('../../scripts/capability-obligation-attest.ts', import.meta.url));
const tmp = trackTmpDirs('attest-cli-', { base: realpathSync(tmpdir()) });
// The resolver INTERPRETER must live at a trusted path. `process.execPath` is world-writable on CI
// (hostedtoolcache) / a Homebrew node, which the r21 F1 guard refuses. Byte-identical to the
// running node; module-scoped so every describe block below can reference it.
const NODE = trustedNodePath();

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

/**
 * A parsed `capabilityObligations` block whose mediaRoot / contract version /
 * attestation identity MATCH the `args()` helper below, so the binding the CLI
 * derives from args equals the binding the live supervisor derives from config.
 */
function configOptions(over: Record<string, unknown> = {}): CapabilityObligationsOptions {
  const parsed = parseCapabilityObligationsOptions({
    enabled: true,
    contract: { version: 'c/1', rules: [{ id: 'r-watch', kind: 'leading_token', token: '/watch', capability: 'child_process_tools' }] },
    mediaRoot: '/var/media',
    retentionPolicyVersion: 'ret/1',
    retentionHorizonDays: 30,
    execution: { interpreter: null, resolverArtifactPath: 'resolver', args: ['{source}'], timeoutMs: 5000, minOutputBytes: 1 },
    attestation: {
      skillName: 'watch', skillVersion: '1.0.0', skillDigest: 'sd', resolverDigest: 'rd',
      dependencyVersions: { 'yt-dlp': '2026.03.17' }, probeVersion: 'p/1', canaryId: 'can-1',
    },
    ...over,
  });
  if (parsed === null) throw new Error('test config did not parse');
  return parsed;
}

function args(over: Partial<AttestArgs> = {}): AttestArgs {
  return {
    dbPath: ':memory:', providerId: 'claude-cli', contractVersion: 'c/1', capability: 'child_process_tools',
    skill: {
      skillName: 'watch', skillVersion: '1.0.0', skillDigest: 'sd', resolverDigest: 'rd',
      dependencyVersions: { 'yt-dlp': '2026.03.17' }, probeVersion: 'p/1', canaryId: 'can-1',
    },
    mediaRoot: '/var/media', releaseSha: 'rel-1', validForSeconds: 3600, runId: 'run-1',
    hostId: 'test-host', runtimeUser: 'test-user', configPath: null, probeSource: null, receiptOut: null,
    runCanary: false, confirm: false, json: false,
    ...over,
  };
}

beforeEach(() => { db = new Database(':memory:'); db.open(); });
afterEach(() => db.close());

describe('attest (operator attestation producer front-door)', () => {
  it('dry-run (no canary) derives the digest and records NOTHING', () => {
    const result = attest(db, args(), null, new Date(), null);
    expect(result).toMatchObject({ mode: 'dry-run', recorded: false, attestationDigest: expect.any(String) });
    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM capability_attestations').get() as { c: number }).c).toBe(0);
  });

  it('a PASSING canary records an attestation that ADMITS the derived binding', () => {
    const a = args();
    const result = attest(db, a, { result: 'pass', nonce: 'run-1' }, new Date(), true);
    expect(result).toMatchObject({ mode: 'record', recorded: true, attestationId: expect.any(Number) });
    expect(findAdmissibleAttestation(db, bindingForAttestArgs(a))).toMatchObject({ outcome: 'admissible' });
  });

  it('FALSIFIER: a FAILED canary records nothing and admission stays closed', () => {
    const a = args();
    const result = attest(db, a, { result: 'fail', nonce: 'run-1' }, new Date(), true);
    expect(result).toMatchObject({ mode: 'record', recorded: false, reason: 'canary_failed' });
    expect(findAdmissibleAttestation(db, bindingForAttestArgs(a))).toMatchObject({ outcome: 'skip' });
  });

  it('parseAttestArgs requires the core binding flags, collects --dep, and reads --config/--probe-source', () => {
    const parsed = parseAttestArgs([
      '--db', 'x.db', '--provider', 'claude-cli', '--contract-version', 'c/1', '--capability', 'child_process_tools',
      '--skill-name', 'watch', '--skill-digest', 'sd', '--probe-version', 'p/1', '--canary-id', 'can-1',
      '--media-root', '/var/media', '--release-sha', 'rel-1', '--valid-seconds', '3600', '--run-id', 'run-1',
      '--dep', 'yt-dlp=2026.03.17', '--host', 'h', '--runtime-user', 'u',
      '--config', '/etc/instance.json', '--probe-source', 'https://probe/x', '--run-canary', '--confirm',
    ]);
    expect(parsed.skill.dependencyVersions).toEqual({ 'yt-dlp': '2026.03.17' });
    expect(parsed.configPath).toBe('/etc/instance.json');
    expect(parsed.probeSource).toBe('https://probe/x');
    expect(parsed.runCanary).toBe(true);
    expect(parsed.confirm).toBe(true);
    expect(() => parseAttestArgs(['--db', 'x.db'])).toThrow(/--provider is required/);
  });
});

describe('assertArgsMatchConfig (attestation must be admittable by the live instance)', () => {
  it('accepts a binding whose mediaRoot/contract/skill match the config', () => {
    expect(() => assertArgsMatchConfig(args(), configOptions())).not.toThrow();
  });

  it('FALSIFIER: refuses a binding whose skill digest differs from config (would never admit a live obligation)', () => {
    const bad = args({ skill: { ...args().skill, skillDigest: 'DIFFERENT' } });
    expect(() => assertArgsMatchConfig(bad, configOptions())).toThrow(/does not match --config/);
  });

  it('FALSIFIER: refuses a binding whose mediaRoot differs from config (proves the digest covers mediaRoot)', () => {
    const bad = args({ mediaRoot: '/other/media' });
    expect(() => assertArgsMatchConfig(bad, configOptions())).toThrow(/does not match --config/);
  });

  it('FALSIFIER: refuses a binding whose contract version differs from config (proves the digest covers contractVersion)', () => {
    const bad = args({ contractVersion: 'c/2' });
    // The config contract is version c/1; c/2 differs, so the derived binding cannot match.
    expect(() => assertArgsMatchConfig(bad, configOptions())).toThrow(/does not match --config/);
  });

  it('FALSIFIER: refuses a capability the config contract does not declare', () => {
    // Binding identity still matches (capability is on both sides), but no rule requires it.
    const opts = configOptions({
      contract: { version: 'c/1', rules: [{ id: 'r-other', kind: 'leading_token', token: '/other', capability: 'other_capability' }] },
    });
    expect(() => assertArgsMatchConfig(args(), opts)).toThrow(/not declared by the config contract/);
  });
});

describe('loadObligationOptionsFromConfig', () => {
  it('fails closed on a path that cannot be read', () => {
    expect(() => loadObligationOptionsFromConfig('/nonexistent/does-not-exist.json')).toThrow(/could not be read/);
  });
});

describe('runResolverCanary (bounded, non-sending resolver probe)', () => {
  // round-20 finding 3: the canary now STAGES a real artifact and executes the STAGED copy
  // (previously it spawned the original path while the runtime ran a `.pinned-*` copy — they
  // could diverge). Build a real resolver script + its composite so canary == runtime bytes.
  function canaryInput(
    dir: string,
    src: string,
    over: { name?: string; command?: readonly string[]; interpreted?: boolean; timeoutMs?: number; minOutputBytes?: number; declaredResolverDigest?: string } = {},
  ): { execution: { command: readonly string[]; resolverArtifactPath: string; interpreted: boolean; timeoutMs: number; minOutputBytes: number }; declaredResolverDigest: string } {
    const resolverPath = join(dir, over.name ?? 'resolver.cjs');
    writeFileSync(resolverPath, src);
    const command = over.command ?? [NODE, resolverPath, '{source}'];
    const interpreted = over.interpreted ?? true;
    const execution = { command, resolverArtifactPath: resolverPath, interpreted, timeoutMs: over.timeoutMs ?? 10_000, minOutputBytes: over.minOutputBytes ?? 5 };
    const contentDigest = createHash('sha256').update(readFileSync(realpathSync(resolverPath))).digest('hex');
    const interpreterDigest = interpreted ? createHash('sha256').update(readFileSync(realpathSync(command[0]!))).digest('hex') : null;
    // round-20 (advisor): the composite binds the whole resolver directory manifest. The canary dir
    // holds only the resolver (+ any intentional sibling, e.g. the reap grandchild), so this manifest
    // equals what runResolverCanary's stageResolverArtifact recomputes over the staged copy.
    const manifestDigest = directoryManifestDigest(dirname(realpathSync(resolverPath)));
    const declaredResolverDigest = over.declaredResolverDigest ?? resolverCompositeDigest(contentDigest, manifestDigest, execution, interpreterDigest);
    return { execution, declaredResolverDigest };
  }

  it('PASS: a resolver that exits 0 with sufficient output over the substituted source', async () => {
    const dir = tmp.make('canary-pass');
    const outcome = await runResolverCanary({ ...canaryInput(dir, 'process.stdout.write("processed:" + process.argv[2])\n'), probeSource: 'https://probe.example/clip', nonce: 'run-1' });
    expect(outcome).toMatchObject({ result: 'pass', nonce: 'run-1' });
  });

  it('FALSIFIER: a resolver that exits non-zero fails', async () => {
    const dir = tmp.make('canary-nonzero');
    const outcome = await runResolverCanary({ ...canaryInput(dir, 'process.stdout.write("x".repeat(50));process.exit(4)\n', { minOutputBytes: 1 }), probeSource: 'https://probe.example/clip', nonce: 'run-1' });
    expect(outcome.result).toBe('fail');
  });

  it('FALSIFIER: a resolver whose output is under minOutputBytes fails even on exit 0', async () => {
    const dir = tmp.make('canary-short');
    const outcome = await runResolverCanary({ ...canaryInput(dir, 'process.stdout.write("x")\n', { minOutputBytes: 100 }), probeSource: 'https://probe.example/clip', nonce: 'run-1' });
    expect(outcome.result).toBe('fail');
  });

  it('FALSIFIER (finding 3): a resolver whose bytes do not match the declared digest is REFUSED before spawn (never executes)', async () => {
    const dir = tmp.make('canary-mismatch');
    // A deliberately-wrong declared digest: the staged copy's composite cannot equal it, so the
    // canary refuses without spawning — the canary executes ONLY the verified bytes.
    const outcome = await runResolverCanary({ ...canaryInput(dir, 'process.stdout.write("processed:" + process.argv[2])\n', { declaredResolverDigest: 'deadbeef'.repeat(8) }), probeSource: 'https://probe.example/clip', nonce: 'run-1' });
    expect(outcome.result).toBe('fail');
    expect((outcome.detail as Record<string, unknown>)?.['reason']).toBe('resolver_digest_mismatch');
  });

  it('R21 F5 FALSIFIER: a NUL byte in the probe source fails cleanly (resolver_arg_contains_nul) and leaks NO staging root', async () => {
    const dir = tmp.make('canary-nul');
    // A NUL in the substituted {source} makes spawn() throw SYNCHRONOUSLY (ERR_INVALID_ARG_VALUE),
    // before any 'error' listener is attached — without the guard the ws-resolver-stage-* dir leaks
    // (cleanup ran only from child events) and the promise rejects instead of failing cleanly.
    const stageParent = tmpdir();
    const listStages = (): string[] => readdirSync(stageParent).filter((n) => n.startsWith('ws-resolver-stage-'));
    const before = new Set(listStages());
    const outcome = await runResolverCanary({ ...canaryInput(dir, 'process.stdout.write("processed:" + process.argv[2])\n'), probeSource: 'evil\0injected', nonce: 'run-nul' });
    expect(outcome.result).toBe('fail'); // revert the guard → await throws → RED
    expect((outcome.detail as Record<string, unknown>)?.['reason']).toBe('resolver_arg_contains_nul');
    const leaked = listStages().filter((n) => !before.has(n));
    expect(leaked).toEqual([]); // no staging root left behind
  });

  it('END-TO-END: a real passing canary outcome piped into attest records an ADMISSIBLE attestation', async () => {
    const dir = tmp.make('canary-e2e');
    const a = args();
    const canary = await runResolverCanary({ ...canaryInput(dir, 'process.stdout.write("processed:" + process.argv[2])\n'), probeSource: 'https://probe.example/clip', nonce: a.runId });
    expect(canary.result).toBe('pass');
    const result = attest(db, a, canary, new Date(), true);
    expect(result).toMatchObject({ mode: 'record', recorded: true });
    expect(findAdmissibleAttestation(db, bindingForAttestArgs(a))).toMatchObject({ outcome: 'admissible' });
  });

  it('BLOCKER-3 FALSIFIER: a resolver that exits 0 cleanly cannot leave a grandchild to write AFTER the outcome', async () => {
    const dir = tmp.make('reap');
    const marker = join(dir, 'grandchild-marker');
    const grandchild = join(dir, 'grandchild.cjs');
    // grandchild: 600ms after the parent's clean exit, write the marker (no try/catch — a
    // reaped process is SIGKILLed before the timer fires, so the write simply never happens).
    writeFileSync(grandchild, 'const fs=require("node:fs");setTimeout(function(){fs.writeFileSync(process.argv[2],"escaped")},600);');
    // parent (the "resolver" artifact): fork the same-group grandchild, print output, exit 0.
    const parentSrc = `const cp=require("node:child_process");const m=process.argv[2];const gc=cp.spawn(process.execPath,[${JSON.stringify(grandchild)},m],{stdio:"ignore"});gc.unref();process.stdout.write("processed-with-grandchild");process.exit(0);`;
    const outcome = await runResolverCanary({ ...canaryInput(dir, parentSrc, { name: 'parent.cjs' }), probeSource: marker, nonce: 'reap-1' });
    expect(outcome.result).toBe('pass'); // the parent exited 0 with output — a naive canary would stop here
    await TIMING(1_000); // let real time pass the grandchild's 600ms timer
    // With the close-handler group reap, the grandchild was SIGKILLed → the marker never lands.
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});

describe('capability-obligation-attest CLI (the operator front-door records end-to-end)', () => {
  /**
   * Runs the ACTUAL script main block as a subprocess — the surface that carried
   * the original defect (it printed "refusing to guess" and exited before ever
   * recording). Proves that `--run-canary --confirm --config --probe-source`
   * executes the config's resolver canary and writes an admissible attestation.
   */
  // Round-17 finding 2: the resolver is a real installed SCRIPT; the config + CLI
  // declare the SCRIPT's digest, and artifact observation hashes the SCRIPT — never the
  // node interpreter. (`node -e '<inline>'` has no artifact and is correctly unattestable.)
  const RESOLVER_SRC = 'const s = process.argv[2]; process.stdout.write("processed:" + s);\n';

  // findings 1+2: the attested `resolverDigest` is now a COMPOSITE (artifact CONTENT folded
  // with the canonical execution SHAPE). Derive it from the config the CLI actually reads,
  // exactly as the producer/executor do, so admission and the drain-seam re-comparison match.
  function compositeFromConfigFile(configFile: string): string {
    // #3221 Debt 4: the config carries the TYPED { interpreter, resolverArtifactPath, args }
    // struct; derive command/interpreted exactly as the schema transform does.
    const cfg = JSON.parse(readFileSync(configFile, 'utf8')) as {
      agentOptions: { capabilityObligations: { execution: { interpreter: string | null; resolverArtifactPath: string; args: string[]; timeoutMs: number; minOutputBytes: number } } };
    };
    const ex = cfg.agentOptions.capabilityObligations.execution;
    if (!Array.isArray(ex.args)) {
      // A rawExecution falsifier config (legacy free-form shape): no composite is derivable —
      // and none is needed, because config LOAD refuses the shape before any digest comparison.
      return 'ff'.repeat(32);
    }
    const interpreted = ex.interpreter !== null;
    const command = interpreted
      ? [ex.interpreter!, ex.resolverArtifactPath, ...ex.args]
      : [ex.resolverArtifactPath, ...ex.args];
    const contentDigest = createHash('sha256').update(readFileSync(realpathSync(ex.resolverArtifactPath))).digest('hex');
    // round-20: the composite binds the interpreter content, the envelope (timeoutMs/minOutputBytes),
    // AND the whole resolver-directory manifest.
    const interpreterDigest = interpreted ? createHash('sha256').update(readFileSync(realpathSync(command[0]!))).digest('hex') : null;
    const manifestDigest = directoryManifestDigest(dirname(realpathSync(ex.resolverArtifactPath)));
    return resolverCompositeDigest(contentDigest, manifestDigest, { command, resolverArtifactPath: ex.resolverArtifactPath, interpreted, timeoutMs: ex.timeoutMs, minOutputBytes: ex.minOutputBytes }, interpreterDigest);
  }

  function writeConfig(dir: string, over: { mediaRoot?: string; resolverDigest?: string; command?: readonly string[]; resolverArtifactPath?: string; interpreted?: boolean; rawExecution?: Record<string, unknown> } = {}): string {
    // round-20 (advisor): the composite now binds the WHOLE resolver directory. `dir` itself
    // accumulates instance.json, obligations.db, media, and receipts, which would poison and drift
    // the manifest — so the resolver lives in its own isolated subdirectory holding ONLY resolver.cjs.
    const resolverDir = join(dir, 'resolver-src');
    mkdirSync(resolverDir, { recursive: true });
    const resolverPath = over.resolverArtifactPath ?? join(resolverDir, 'resolver.cjs');
    writeFileSync(resolverPath, RESOLVER_SRC);
    const command = over.command ?? [NODE, resolverPath, '{source}'];
    const resolverArtifactPath = over.resolverArtifactPath ?? resolverPath;
    const interpreted = over.interpreted ?? true;
    const timeoutMs = 10_000;
    const minOutputBytes = 5;
    // The config declares the COMPOSITE (unless a test overrides with a deliberately-wrong one).
    // round-20: the composite binds the interpreter content, the envelope, AND the directory manifest.
    const interpreterDigest = interpreted ? createHash('sha256').update(readFileSync(realpathSync(command[0]!))).digest('hex') : null;
    const manifestDigest = directoryManifestDigest(dirname(realpathSync(resolverPath)));
    const composite = resolverCompositeDigest(createHash('sha256').update(RESOLVER_SRC).digest('hex'), manifestDigest, { command, resolverArtifactPath, interpreted, timeoutMs, minOutputBytes }, interpreterDigest);
    const configFile = join(dir, 'instance.json');
    writeFileSync(configFile, JSON.stringify({
      agentOptions: {
        capabilityObligations: {
          enabled: true,
          contract: { version: 'c/1', rules: [{ id: 'r-watch', kind: 'leading_token', token: '/watch', capability: 'child_process_tools' }] },
          mediaRoot: over.mediaRoot ?? dir, // a real readable directory
          retentionPolicyVersion: 'ret/1',
          retentionHorizonDays: 30,
          // #3221 Debt 4: the TYPED execution struct — command/interpreted are derived
          // by the schema; a legacy free-form `command` body is unrepresentable
          // (`rawExecution` below lets a falsifier write one to prove the refusal).
          execution: over.rawExecution ?? {
            interpreter: interpreted ? command[0]! : null,
            // round-18 finding 1: explicit artifact declaration (verified, never inferred).
            resolverArtifactPath,
            args: command.slice(interpreted ? 2 : 1),
            timeoutMs, minOutputBytes,
          },
          attestation: {
            skillName: 'watch', skillVersion: '1.0.0', skillDigest: 'sd', resolverDigest: over.resolverDigest ?? composite,
            dependencyVersions: { 'yt-dlp': '2026.03.17' }, probeVersion: 'p/1', canaryId: 'can-1',
          },
        },
      },
    }));
    return configFile;
  }

  function seedSchemaCurrentDb(dir: string): string {
    const dbFile = join(dir, 'obligations.db');
    const seed = new Database(dbFile);
    seed.open(); // runs migrations up to CURRENT_SCHEMA_MIGRATION and persists them
    seed.close();
    return dbFile;
  }

  function runCli(dbFile: string, configFile: string, mediaRoot: string, extra: readonly string[] = [], resolverDigest?: string): ReturnType<typeof spawnSync> {
    const digest = resolverDigest ?? compositeFromConfigFile(configFile);
    const cliArgs = [
      '--db', dbFile, '--provider', 'claude-cli', '--contract-version', 'c/1', '--capability', 'child_process_tools',
      '--skill-name', 'watch', '--skill-version', '1.0.0', '--skill-digest', 'sd', '--resolver-digest', digest,
      '--dep', 'yt-dlp=2026.03.17', '--probe-version', 'p/1', '--canary-id', 'can-1',
      '--media-root', mediaRoot, '--release-sha', 'rel-1', '--valid-seconds', '3600', '--run-id', 'run-1',
      '--host', 'test-host', '--runtime-user', 'test-user', '--config', configFile, ...extra,
    ];
    return spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', CLI_PATH, ...cliArgs],
      { encoding: 'utf8' },
    );
  }

  function admissibleOutcome(dbFile: string, mediaRoot: string, configFile: string): string {
    const check = new Database(dbFile);
    check.open();
    try {
      const a = args({ dbPath: dbFile, hostId: 'test-host', runtimeUser: 'test-user', mediaRoot, skill: { ...args().skill, resolverDigest: compositeFromConfigFile(configFile) } });
      return (findAdmissibleAttestation(check, bindingForAttestArgs(a)) as { outcome: string }).outcome;
    } finally {
      check.close();
    }
  }

  it('--run-canary --confirm observes the resolver + media root, RECORDS an admissible attestation, and preserves a probe receipt', () => {
    const dir = tmp.make('record');
    const dbFile = seedSchemaCurrentDb(dir);
    const configFile = writeConfig(dir);
    const receiptOut = join(dir, 'probe-receipt.json');
    const result = runCli(dbFile, configFile, dir, ['--run-canary', '--confirm', '--probe-source', 'https://probe.example/clip', '--receipt-out', receiptOut]);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/RECORDED attest child_process_tools/);
    expect(admissibleOutcome(dbFile, dir, configFile)).toBe('admissible');
    // Evidence preserved: the receipt carries the probe streams' digests + verified artifact.
    expect(existsSync(receiptOut)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptOut, 'utf8')) as Record<string, unknown>;
    // Round-17: the receipt records probe evidence, does NOT assert admission, and is digest-bound.
    expect(receipt).toMatchObject({ canaryResult: 'pass', resolverArtifact: { observed: true, verified: true } });
    expect((receipt.canary as { detail: { stdoutSha256: string; stderrSha256: string; probeSourceDigest: string } }).detail.probeSourceDigest).toEqual(expect.any(String));
    // digest-bound: the receipt's binding digest equals the digest recomputable from the binding (the "digest-bound" half of finding 1)
    const boundArgs = args({ dbPath: dbFile, hostId: 'test-host', runtimeUser: 'test-user', mediaRoot: dir, skill: { ...args().skill, resolverDigest: compositeFromConfigFile(configFile) } });
    expect(receipt.attestationBindingDigest).toBe(attestationBindingDigest(bindingForAttestArgs(boundArgs)));
    expect(receipt.nonce).toBe('run-1');
  }, 30_000);

  it('FALSIFIER (finding 1): an UNWRITABLE --receipt-out refuses AND admits nothing (receipt durable before admission)', () => {
    const dir = tmp.make('badreceipt');
    const dbFile = seedSchemaCurrentDb(dir);
    const configFile = writeConfig(dir);
    const receiptOut = join(dir, 'no-such-subdir', 'r.json'); // parent dir does not exist → unwritable
    const result = runCli(dbFile, configFile, dir, ['--run-canary', '--confirm', '--probe-source', 'https://probe.example/clip', '--receipt-out', receiptOut]);
    expect(result.status).not.toBe(0);
    expect(existsSync(receiptOut)).toBe(false);
    expect(admissibleOutcome(dbFile, dir, configFile)).toBe('skip'); // ZERO admissible rows — no fail-open row without a durable receipt
  }, 30_000);

  it('FALSIFIER (finding 1, r18 → #3221 Debt 4): an inline `-e` free-form command config is UNREPRESENTABLE — refused at config load, admits nothing', () => {
    const dir = tmp.make('codeflag');
    const dbFile = seedSchemaCurrentDb(dir);
    // The old defect: `node -e '<inline>'` verified a decoy while inline code ran. The typed
    // { interpreter, resolverArtifactPath, args } struct cannot express it — the artifact is
    // always the executing token by construction — so the legacy free-form command body is
    // refused at LOAD (strict schema), before any observation or canary.
    const configFile = writeConfig(dir, {
      rawExecution: { command: [process.execPath, '-e', 'process.stdout.write("processed:x")', '{source}'], timeoutMs: 10_000, minOutputBytes: 5, resolverArtifactPath: join(dir, 'resolver-src', 'resolver.cjs'), interpreted: true },
    });
    const receiptOut = join(dir, 'r.json');
    const result = runCli(dbFile, configFile, dir, ['--run-canary', '--confirm', '--probe-source', 'https://probe.example/clip', '--receipt-out', receiptOut]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/[Uu]nrecognized key|interpreter|args/);
    expect(existsSync(receiptOut)).toBe(false);
  }, 30_000);

  it('FALSIFIER (finding 2, r18): a second --run-canary to the SAME --receipt-out is REFUSED (evidence is write-once, no clobber)', () => {
    const dir = tmp.make('receipt-clobber');
    const dbFile = seedSchemaCurrentDb(dir);
    const configFile = writeConfig(dir);
    const receiptOut = join(dir, 'r.json');
    const first = runCli(dbFile, configFile, dir, ['--run-canary', '--confirm', '--probe-source', 'https://probe.example/clip', '--receipt-out', receiptOut]);
    expect(first.status, `stderr: ${first.stderr}`).toBe(0);
    const firstReceipt = readFileSync(receiptOut, 'utf8');
    // A second run to the same path must NOT overwrite the first receipt's evidence.
    const second = runCli(dbFile, configFile, dir, ['--run-canary', '--confirm', '--probe-source', 'https://probe.example/other', '--receipt-out', receiptOut]);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/already exists|write-once/);
    expect(readFileSync(receiptOut, 'utf8')).toBe(firstReceipt); // first evidence intact
  }, 30_000);

  it('FALSIFIER: an installed-resolver digest MISMATCH refuses to record (never trusts the declared digest)', () => {
    const dir = tmp.make('mismatch');
    const dbFile = seedSchemaCurrentDb(dir);
    // config + CLI both declare a WRONG resolver digest; observation of the real resolver script fails.
    const configFile = writeConfig(dir, { resolverDigest: 'de'.repeat(32) });
    const receiptOut = join(dir, 'r.json');
    const result = runCli(dbFile, configFile, dir, ['--run-canary', '--confirm', '--probe-source', 'https://probe.example/clip', '--receipt-out', receiptOut], 'de'.repeat(32));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/does not match declared --resolver-digest/);
    expect(admissibleOutcome(dbFile, dir, configFile)).toBe('skip');
  }, 30_000);

  it('FALSIFIER: an unreadable media root refuses to record', () => {
    const dir = tmp.make('badmedia');
    const dbFile = seedSchemaCurrentDb(dir);
    const configFile = writeConfig(dir, { mediaRoot: '/no/such/media/root' });
    const receiptOut = join(dir, 'r.json');
    const result = runCli(dbFile, configFile, '/no/such/media/root', ['--run-canary', '--confirm', '--probe-source', 'https://probe.example/clip', '--receipt-out', receiptOut]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/media root .* is not readable/);
  }, 30_000);

  it('FALSIFIER: --run-canary without --receipt-out refuses (evidence must be preserved)', () => {
    const dir = tmp.make('noreceipt');
    const dbFile = seedSchemaCurrentDb(dir);
    const configFile = writeConfig(dir);
    const result = runCli(dbFile, configFile, dir, ['--run-canary', '--confirm', '--probe-source', 'https://probe.example/clip']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--run-canary requires --receipt-out/);
    expect(admissibleOutcome(dbFile, dir, configFile)).toBe('skip');
  }, 30_000);

  it('FALSIFIER: the default dry-run records NOTHING (admission stays closed)', () => {
    const dir = tmp.make('dryrun');
    const dbFile = seedSchemaCurrentDb(dir);
    const configFile = writeConfig(dir);
    const result = runCli(dbFile, configFile, dir, []); // no --run-canary
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/DRY-RUN attest child_process_tools/);
    expect(admissibleOutcome(dbFile, dir, configFile)).toBe('skip'); // nothing recorded → not admissible
  }, 30_000);

  it('FALSIFIER: --run-canary without --confirm refuses (exit non-zero, records nothing)', () => {
    const dir = tmp.make('noconfirm');
    const dbFile = seedSchemaCurrentDb(dir);
    const configFile = writeConfig(dir);
    const result = runCli(dbFile, configFile, dir, ['--run-canary', '--probe-source', 'https://probe.example/clip', '--receipt-out', join(dir, 'r.json')]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--run-canary requires --confirm/);
    expect(admissibleOutcome(dbFile, dir, configFile)).toBe('skip');
  }, 30_000);
});

describe('observeResolverArtifact (round-18: verify the EXPLICITLY-declared artifact + digest compare)', () => {
  function writeScript(name: string): { path: string; digest: string } {
    const dir = tmp.make('obs');
    const path = join(dir, name);
    writeFileSync(path, 'process.stdout.write("ok")\n');
    return { path, digest: createHash('sha256').update(readFileSync(path)).digest('hex') };
  }

  it('verifies the declared interpreted SCRIPT and returns its COMPOSITE digest (content + shape)', () => {
    const { path, digest } = writeScript('r.cjs');
    const execution = { command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true };
    const interpreterDigest = createHash('sha256').update(readFileSync(realpathSync(NODE))).digest('hex');
    const manifestDigest = directoryManifestDigest(dirname(realpathSync(path)));
    const composite = resolverCompositeDigest(digest, manifestDigest, execution, interpreterDigest);
    expect(observeResolverArtifact(execution, composite))
      .toMatchObject({ observed: true, verified: true, digest: composite, contentDigest: digest, interpreted: true });
  });

  it('FALSIFIER: a MISMATCHED declared --resolver-digest throws', () => {
    const { path } = writeScript('r.cjs');
    expect(() => observeResolverArtifact({ command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true }, 'ab'.repeat(32)))
      .toThrow(/does not match declared --resolver-digest/);
  });

  it('FALSIFIER: a null/empty --resolver-digest throws (verification is mandatory)', () => {
    const { path } = writeScript('r.cjs');
    expect(() => observeResolverArtifact({ command: [NODE, path, '{source}'], resolverArtifactPath: path, interpreted: true }, null))
      .toThrow(/--resolver-digest is required/);
  });

  it('FALSIFIER: an UNDECLARED artifact (would be inferred from argv) is refused', () => {
    const { path, digest } = writeScript('r.cjs');
    expect(() => observeResolverArtifact({ command: [NODE, path, '{source}'] }, digest))
      .toThrow(/resolverArtifactPath is required/);
  });

  it('assertMediaRootReadable passes for a real dir and FALSIFIER-throws for a missing one', () => {
    expect(() => assertMediaRootReadable(tmp.make('mr'))).not.toThrow();
    expect(() => assertMediaRootReadable('/no/such/dir/xyz')).toThrow(/not readable/);
  });
});
