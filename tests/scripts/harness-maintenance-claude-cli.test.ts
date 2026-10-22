import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// CLI contract for the agent CLI update planner (task d02): every invocation prints exactly one
// JSON line on stdout. Exit 0 = a plan was computed (the action is in the JSON); exit 2 = the
// request was rejected (invalid argument or unreadable evidence) with action "error".
const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const guard = path.join(repoRoot, 'scripts', 'harness-maintenance-guard.ts');
const timeJson = path.join(repoRoot, 'tests', 'fixtures', 'claude-npm-time.json');
const scratch = mkdtempSync(path.join(tmpdir(), 'harness-claude-cli-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface CliResult {
  status: number | null;
  lines: string[];
  json: () => Record<string, unknown>;
}

function runGuard(args: string[]): CliResult {
  const child = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', guard, ...args],
    { cwd: repoRoot, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' },
  );
  // Only the single terminating newline is removed: a blank line anywhere is a contract breach.
  const lines = child.stdout === '' ? [] : child.stdout.replace(/\n$/, '').split('\n');
  return {
    status: child.status,
    lines,
    json: () => JSON.parse(lines.at(-1) ?? '') as Record<string, unknown>,
  };
}

const planArgs = (overrides: Record<string, string | null> = {}): string[] => {
  const values: Record<string, string | null> = {
    current: '2.1.280',
    'time-json': timeJson,
    'cooldown-minutes': '10080',
    layout: 'native',
    now: '2026-09-26T08:30:00Z',
    ...overrides,
  };
  const args = ['--claude-update-plan'];
  for (const [key, value] of Object.entries(values)) {
    if (value !== null) args.push(`--${key}`, value);
  }
  return args;
};

function expectPlan(result: CliResult, action: string): Record<string, unknown> {
  expect(result.status).toBe(0);
  expect(result.lines).toHaveLength(1);
  const payload = result.json();
  expect(payload.action).toBe(action);
  return payload;
}

function expectRejected(result: CliResult, code: string): Record<string, unknown> {
  expect(result.status).toBe(2);
  expect(result.lines).toHaveLength(1);
  const payload = result.json();
  expect(payload).toMatchObject({ action: 'error', target: null, error: { code } });
  return payload;
}

describe('--claude-update-plan CLI contract', () => {
  it('prints one JSON plan line and exits 0', () => {
    expect(expectPlan(runGuard(planArgs()), 'install').target).toBe('2.1.282');
  });

  it('treats an empty --current (binary missing in the shell) as the missing action', () => {
    expectPlan(runGuard(planArgs({ current: '' })), 'missing');
  });

  it('treats the none sentinel and an absent --current as missing', () => {
    expectPlan(runGuard(planArgs({ current: 'none' })), 'missing');
    expectPlan(runGuard(planArgs({ current: null })), 'missing');
  });

  it('holds on a publish-time file that is not valid JSON', () => {
    const bad = path.join(scratch, 'bad-time.json');
    writeFileSync(bad, '{not json');
    expectPlan(runGuard(planArgs({ 'time-json': bad })), 'held');
  });

  it('rejects an unreadable publish-time file as missing evidence', () => {
    expectRejected(runGuard(planArgs({ 'time-json': path.join(scratch, 'absent.json') })), 'EVIDENCE_MISSING');
  });

  it('rejects an invalid cooldown instead of reading it as zero', () => {
    for (const value of ['', ' ', 'abc', '-5', 'Infinity', 'NaN', '10.5', '1e5']) {
      expectRejected(runGuard(planArgs({ 'cooldown-minutes': value })), 'INVALID_ARGUMENT');
    }
  });

  it('rejects a cooldown below the manifest floor of seven days', () => {
    expectRejected(runGuard(planArgs({ 'cooldown-minutes': '10079' })), 'INVALID_ARGUMENT');
    expectPlan(runGuard(planArgs({ 'cooldown-minutes': '10080' })), 'install');
  });

  it('rejects a clock that is not an ISO 8601 timestamp', () => {
    for (const value of ['', 'yesterday', '1758875400', '2026-13-45T00:00:00Z', '2026-02-30T00:00:00Z', '2026-09-26T24:00:00Z']) {
      expectRejected(runGuard(planArgs({ now: value })), 'INVALID_ARGUMENT');
    }
  });

  it('rejects an unknown layout, an unknown flag, a positional argument and a missing --time-json', () => {
    expectRejected(runGuard(planArgs({ layout: 'bogus' })), 'INVALID_ARGUMENT');
    expectRejected(runGuard([...planArgs(), '--bogus', 'x']), 'INVALID_ARGUMENT');
    expectRejected(runGuard([...planArgs(), 'stray']), 'INVALID_ARGUMENT');
    expectRejected(runGuard(planArgs({ 'time-json': null })), 'INVALID_ARGUMENT');
  });

  it('rejects a repeated flag and a flag used as the value of --current', () => {
    expectRejected(runGuard([...planArgs(), '--layout', 'native']), 'INVALID_ARGUMENT');
    expectRejected(
      runGuard(['--claude-update-plan', '--current', '--time-json', timeJson, '--cooldown-minutes', '10080']),
      'INVALID_ARGUMENT',
    );
  });
});
