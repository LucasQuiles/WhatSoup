import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BaselineStore } from '../../src/store/baseline.ts';
import { openDatabase } from '../../src/store/connection.ts';
import type { Event } from '../../src/types.ts';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsxBin = join(packageRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const cliEntry = join(packageRoot, 'src', 'cli', 'index.ts');
const developmentPolicy = join(packageRoot, 'src', 'policy', 'profiles', 'development.yaml');
const baselineHmacKeyFile = 'baseline-hmac.key';
const cycleTimeoutMs = 10_000;
const baselineKey = Buffer.from('blackbox-cycle-baseline-key');

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-blackbox-cycle-'));
  dirs.push(dir);
  return dir;
}

interface CycleRun {
  command: string;
  result: SpawnSyncReturns<string>;
}

function runCycle(stateDir: string, env: NodeJS.ProcessEnv = {}, policyPath = developmentPolicy): CycleRun {
  const args = [cliEntry, 'cycle', '--policy', policyPath, '--state-dir', stateDir];
  const result = spawnSync(tsxBin, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: cycleTimeoutMs,
  });

  return {
    command: [tsxBin, ...args].join(' '),
    result,
  };
}

function runDiagnostics(run: CycleRun): string {
  return [
    `command: ${run.command}`,
    `timeoutMs: ${cycleTimeoutMs}`,
    `error: ${run.result.error?.message ?? '<none>'}`,
    `status: ${run.result.status ?? '<null>'}`,
    `signal: ${run.result.signal ?? '<null>'}`,
    `stdout:\n${run.result.stdout}`,
    `stderr:\n${run.result.stderr}`,
  ].join('\n');
}

function expectNoSubprocessTimeout(run: CycleRun): void {
  const errorCode = (run.result.error as NodeJS.ErrnoException | undefined)?.code;

  expect.soft(errorCode, runDiagnostics(run)).not.toBe('ETIMEDOUT');
  expect.soft(run.result.signal, runDiagnostics(run)).not.toBe('SIGTERM');
}

function seedBaseline(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true });
  const keyPath = join(stateDir, baselineHmacKeyFile);
  writeFileSync(keyPath, baselineKey, { mode: 0o400 });
  chmodSync(keyPath, 0o400);

  const db = openDatabase(join(stateDir, 'state.sqlite'));
  try {
    const baselines = new BaselineStore(db, baselineKey);
    baselines.set({
      probe_id: 'fixture.change',
      scope_id: 'scope-a',
      expected_doc: JSON.stringify({ routes: ['/healthz'] }),
      captured_at: '2026-05-08T09:00:00.000Z',
      captured_by: 'fixture',
    });
  } finally {
    db.close();
  }
}

function readLedgerEvents(stateDir: string): Event[] {
  const path = join(stateDir, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Event);
}

function writeChangeFixturePolicy(policyPath: string, options: { changeEnabled?: boolean } = {}): void {
  const lines = [
    'extends: development',
    'inventory:',
    '  hosts:',
    '    - id: scope-a',
    '      platform: linux',
    '      collectors: [fixture.change]',
    '      fixture_docs:',
    '        fixture.change:',
    '          fields:',
    '            routes: [/healthz, /admin]',
    '          captured_at: 2026-05-08T10:00:00.000Z',
  ];

  if (options.changeEnabled !== undefined) {
    lines.push(
      '',
      'domains:',
      '  change:',
      `    enabled: ${String(options.changeEnabled)}`,
    );
  }

  writeFileSync(policyPath, [...lines, ''].join('\n'));
}

describe('cycle source CLI black box', () => {
  it('runs the development policy through the real source entrypoint', () => {
    const stateDir = tempDir();
    const run = runCycle(stateDir);
    const { result } = run;
    const combinedOutput = `${result.stdout}${result.stderr}`;

    expectNoSubprocessTimeout(run);
    expect.soft(result.error, runDiagnostics(run)).toBeUndefined();
    expect.soft(result.signal).toBeNull();
    expect.soft(result.status).toBe(0);
    expect.soft(combinedOutput).not.toContain('runtime dependency missing');
    expect.soft(result.stdout).toContain('baseline_integrity_fail=0');
    expect.soft(result.stdout).toContain('token_aging=0');
    expect.soft(result.stdout).toContain('self_secret_widened=0');
    expect.soft(existsSync(join(stateDir, 'state.sqlite')) || existsSync(join(stateDir, 'events.jsonl'))).toBe(true);
  });

  it('keeps human stdout free of pino json log records', () => {
    const stateDir = tempDir();
    const run = runCycle(stateDir);
    const { result } = run;
    const stdout = result.stdout.trimStart();

    expectNoSubprocessTimeout(run);
    expect.soft(result.error, runDiagnostics(run)).toBeUndefined();
    expect.soft(stdout.startsWith('{')).toBe(false);
    expect.soft(result.stdout).not.toContain('"level"');
  });

  it('routes configured pino json logs to stderr without polluting human stdout', () => {
    const stateDir = tempDir();
    const run = runCycle(stateDir, { WHATSOUP_GUARD_LOG_LEVEL: 'info' });
    const { result } = run;

    expectNoSubprocessTimeout(run);
    expect.soft(result.error, runDiagnostics(run)).toBeUndefined();
    expect.soft(result.status).toBe(0);
    expect.soft(result.stdout).toContain('baseline_integrity_fail=0');
    expect.soft(result.stdout).not.toContain('"level"');
    expect.soft(result.stderr).toContain('"level"');
    expect.soft(result.stderr).toContain('"name":"whatsoup-guard"');
    expect.soft(result.stderr).toContain('"event":"database_open_start"');
  });

  it('emits change-domain drift for fixture change collectors through the real source CLI path', () => {
    const dir = tempDir();
    const stateDir = join(dir, 'state');
    const policyPath = join(dir, 'enabled-change-policy.yaml');
    writeChangeFixturePolicy(policyPath);
    seedBaseline(stateDir);

    const run = runCycle(stateDir, {}, policyPath);
    const { result } = run;
    const events = readLedgerEvents(stateDir);
    const driftEvents = events.filter((event) => event.kind === 'drift');

    expectNoSubprocessTimeout(run);
    expect.soft(result.error, runDiagnostics(run)).toBeUndefined();
    expect.soft(result.signal).toBeNull();
    expect.soft(result.status, runDiagnostics(run)).toBe(1);
    expect.soft(result.stdout).toContain('drifts=1');
    expect.soft(result.stdout).toContain('probe_errors=0');
    expect.soft(driftEvents).toHaveLength(1);
    expect.soft(driftEvents[0]).toMatchObject({
      kind: 'drift',
      domain: 'change',
      scope_id: 'scope-a',
      probe_id: 'fixture.change',
      payload: expect.objectContaining({
        reason_code: 'change.new_application_route',
      }),
    });
  });

  it('suppresses disabled change-domain drifts through the real source CLI path', () => {
    const dir = tempDir();
    const stateDir = join(dir, 'state');
    const policyPath = join(dir, 'disabled-change-policy.yaml');
    writeChangeFixturePolicy(policyPath, { changeEnabled: false });
    seedBaseline(stateDir);

    const run = runCycle(stateDir, {}, policyPath);
    const { result } = run;
    const events = readLedgerEvents(stateDir);
    const eventKinds = events.map((event) => event.kind);

    expectNoSubprocessTimeout(run);
    expect.soft(result.error, runDiagnostics(run)).toBeUndefined();
    expect.soft(result.signal).toBeNull();
    expect.soft(result.status, runDiagnostics(run)).toBe(0);
    expect.soft(result.stdout).toContain('drifts=0');
    expect.soft(result.stdout).toContain('probe_errors=0');
    expect.soft(eventKinds).toContain('heartbeat');
    expect.soft(eventKinds).not.toContain('drift');
    expect.soft(eventKinds.filter((kind) => kind.startsWith('alert_delivery'))).toEqual([]);
  });

  it('documents current operator behavior in the package README', () => {
    const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8');

    expect(readme).toContain('cycle --policy <policy.yaml> --state-dir <state-dir>');
    expect(readme).not.toContain('runtime-dependency error');
    expect(readme).not.toContain('runtime dependency missing');
    expect(readme).toContain('If no meta-alert sink is enabled');
    expect(readme).toContain('alert_delivery_failed_all');
    expect(readme).toContain('When `--scenario` is omitted');
    expect(readme).toContain('Package-local green is not release green');
    expect(readme).toContain('root');
    expect(readme).toContain('CI');
  });
});
