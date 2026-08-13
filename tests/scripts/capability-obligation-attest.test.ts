/**
 * capability-obligation-attest (round-15 finding 1 front-door): the operator
 * command derives the binding and records an ADMISSIBLE attestation only on a
 * passing canary. Dry-run (no canary) records nothing; a failed canary records
 * nothing (fail-closed). The canary outcome is injected here — no resolver runs.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findAdmissibleAttestation } from '../../src/core/capability-attestation.ts';
import { parseCapabilityObligationsOptions, type CapabilityObligationsOptions } from '../../src/core/capability-contract.ts';
import { Database } from '../../src/core/database.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  assertArgsMatchConfig,
  attest,
  bindingForAttestArgs,
  loadObligationOptionsFromConfig,
  parseAttestArgs,
  runResolverCanary,
  type AttestArgs,
} from '../../scripts/capability-obligation-attest.ts';

let db: Database;

const CLI_PATH = fileURLToPath(new URL('../../scripts/capability-obligation-attest.ts', import.meta.url));
const tmp = trackTmpDirs('attest-cli-', { base: realpathSync(tmpdir()) });

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
    execution: { command: ['resolver', '{source}'], timeoutMs: 5000, minOutputBytes: 1 },
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
    hostId: 'test-host', runtimeUser: 'test-user', configPath: null, probeSource: null,
    runCanary: false, confirm: false, json: false,
    ...over,
  };
}

beforeEach(() => { db = new Database(':memory:'); db.open(); });
afterEach(() => db.close());

describe('attest (operator attestation producer front-door)', () => {
  it('dry-run (no canary) derives the digest and records NOTHING', () => {
    const result = attest(db, args(), null, new Date());
    expect(result).toMatchObject({ mode: 'dry-run', recorded: false, attestationDigest: expect.any(String) });
    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM capability_attestations').get() as { c: number }).c).toBe(0);
  });

  it('a PASSING canary records an attestation that ADMITS the derived binding', () => {
    const a = args();
    const result = attest(db, a, { result: 'pass', nonce: 'run-1' }, new Date());
    expect(result).toMatchObject({ mode: 'record', recorded: true, attestationId: expect.any(Number) });
    expect(findAdmissibleAttestation(db, bindingForAttestArgs(a))).toMatchObject({ outcome: 'admissible' });
  });

  it('FALSIFIER: a FAILED canary records nothing and admission stays closed', () => {
    const a = args();
    const result = attest(db, a, { result: 'fail', nonce: 'run-1' }, new Date());
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
  const NODE = process.execPath;

  it('PASS: a resolver that exits 0 with sufficient output over the substituted source', async () => {
    const outcome = await runResolverCanary({
      command: [NODE, '-e', 'process.stdout.write("processed:" + process.argv[1])', '{source}'],
      probeSource: 'https://probe.example/clip', timeoutMs: 10_000, minOutputBytes: 5, nonce: 'run-1',
    });
    expect(outcome).toMatchObject({ result: 'pass', nonce: 'run-1' });
  });

  it('FALSIFIER: a resolver that exits non-zero fails', async () => {
    const outcome = await runResolverCanary({
      command: [NODE, '-e', 'process.exit(4)', '{source}'],
      probeSource: 'https://probe.example/clip', timeoutMs: 10_000, minOutputBytes: 1, nonce: 'run-1',
    });
    expect(outcome.result).toBe('fail');
  });

  it('FALSIFIER: a resolver whose output is under minOutputBytes fails even on exit 0', async () => {
    const outcome = await runResolverCanary({
      command: [NODE, '-e', 'process.stdout.write("x")', '{source}'],
      probeSource: 'https://probe.example/clip', timeoutMs: 10_000, minOutputBytes: 100, nonce: 'run-1',
    });
    expect(outcome.result).toBe('fail');
  });

  it('END-TO-END: a real passing canary outcome piped into attest records an ADMISSIBLE attestation', async () => {
    const a = args();
    const canary = await runResolverCanary({
      command: [NODE, '-e', 'process.stdout.write("processed:" + process.argv[1])', '{source}'],
      probeSource: 'https://probe.example/clip', timeoutMs: 10_000, minOutputBytes: 5, nonce: a.runId,
    });
    expect(canary.result).toBe('pass');
    const result = attest(db, a, canary, new Date());
    expect(result).toMatchObject({ mode: 'record', recorded: true });
    expect(findAdmissibleAttestation(db, bindingForAttestArgs(a))).toMatchObject({ outcome: 'admissible' });
  });
});

describe('capability-obligation-attest CLI (the operator front-door records end-to-end)', () => {
  /**
   * Runs the ACTUAL script main block as a subprocess — the surface that carried
   * the original defect (it printed "refusing to guess" and exited before ever
   * recording). Proves that `--run-canary --confirm --config --probe-source`
   * executes the config's resolver canary and writes an admissible attestation.
   */
  function writeConfig(dir: string): string {
    const configFile = join(dir, 'instance.json');
    writeFileSync(configFile, JSON.stringify({
      agentOptions: {
        capabilityObligations: {
          enabled: true,
          contract: { version: 'c/1', rules: [{ id: 'r-watch', kind: 'leading_token', token: '/watch', capability: 'child_process_tools' }] },
          mediaRoot: '/var/media',
          retentionPolicyVersion: 'ret/1',
          retentionHorizonDays: 30,
          execution: {
            command: [process.execPath, '-e', 'process.stdout.write("processed:" + process.argv[1])', '{source}'],
            timeoutMs: 10_000, minOutputBytes: 5,
          },
          attestation: {
            skillName: 'watch', skillVersion: '1.0.0', skillDigest: 'sd', resolverDigest: 'rd',
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

  function runCli(dbFile: string, configFile: string, extra: readonly string[] = []): ReturnType<typeof spawnSync> {
    const cliArgs = [
      '--db', dbFile, '--provider', 'claude-cli', '--contract-version', 'c/1', '--capability', 'child_process_tools',
      '--skill-name', 'watch', '--skill-version', '1.0.0', '--skill-digest', 'sd', '--resolver-digest', 'rd',
      '--dep', 'yt-dlp=2026.03.17', '--probe-version', 'p/1', '--canary-id', 'can-1',
      '--media-root', '/var/media', '--release-sha', 'rel-1', '--valid-seconds', '3600', '--run-id', 'run-1',
      '--host', 'test-host', '--runtime-user', 'test-user', '--config', configFile, ...extra,
    ];
    return spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', CLI_PATH, ...cliArgs],
      { encoding: 'utf8' },
    );
  }

  function admissibleCount(dbFile: string): 'admissible' | 'skip' | string {
    const check = new Database(dbFile);
    check.open();
    try {
      const a = args({ dbPath: dbFile, hostId: 'test-host', runtimeUser: 'test-user' });
      return (findAdmissibleAttestation(check, bindingForAttestArgs(a)) as { outcome: string }).outcome;
    } finally {
      check.close();
    }
  }

  it('--run-canary --confirm executes the config resolver and RECORDS an admissible attestation', () => {
    const dir = tmp.make('record');
    const dbFile = seedSchemaCurrentDb(dir);
    const configFile = writeConfig(dir);
    const result = runCli(dbFile, configFile, ['--run-canary', '--confirm', '--probe-source', 'https://probe.example/clip']);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/RECORDED attest child_process_tools/);
    expect(admissibleCount(dbFile)).toBe('admissible');
  }, 30_000);

  it('FALSIFIER: the default dry-run records NOTHING (admission stays closed)', () => {
    const dir = tmp.make('dryrun');
    const dbFile = seedSchemaCurrentDb(dir);
    const configFile = writeConfig(dir);
    const result = runCli(dbFile, configFile, []); // no --run-canary
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/DRY-RUN attest child_process_tools/);
    expect(admissibleCount(dbFile)).toBe('skip'); // nothing recorded → not admissible
  }, 30_000);

  it('FALSIFIER: --run-canary without --confirm refuses (exit non-zero, records nothing)', () => {
    const dir = tmp.make('noconfirm');
    const dbFile = seedSchemaCurrentDb(dir);
    const configFile = writeConfig(dir);
    const result = runCli(dbFile, configFile, ['--run-canary', '--probe-source', 'https://probe.example/clip']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--run-canary requires --confirm/);
    expect(admissibleCount(dbFile)).toBe('skip');
  }, 30_000);
});
