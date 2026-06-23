import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderProviderParityMarkdown, run } from '../../scripts/provider-parity-report.ts';

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-provider-parity-'));
  tempRoots.push(root);
  return root;
}

function writeFixture(root: string, payload: unknown): string {
  const file = path.join(root, 'input.json');
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

function happyPayload(): unknown {
  return {
    generatedAtUtc: '2026-06-23T10:24:24Z',
    targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
    expected: [
      {
        host: 'mini3',
        instance: 'agent',
        expected: 'always_on',
        type: 'agent',
        providerProbeExpected: true,
      },
    ],
    statuses: {
      'mini3/agent': {
        primary: { provider: 'claude-cli', model: null, keyPresent: null },
        fallback: {
          provider: 'opencode-cli',
          model: 'minimax/MiniMax-M2',
          keyPresent: true,
          active: false,
          activeUntil: null,
          effectiveProvider: null,
          recoveryProbeRequired: false,
          activeEntry: null,
          chain: [{ provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: true }],
        },
        signal: { status: 'online', confidence: 'confirmed', reason: null, evidence: [] },
        lineReachable: true,
      },
    },
    probes: [{ host: 'mini3', instance: 'agent', provider: 'opencode-cli', state: 'ok' }],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('provider-parity-report CLI', () => {
  it('prints usage and leaves exitCode unset for --help', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const report = run(['--help']);

    expect(report).toBeNull();
    expect(process.exitCode).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: provider-parity-report.ts'));
  });

  it('writes deterministic redacted JSON and Markdown reports with exit 0 for green parity', () => {
    const root = makeRoot();
    const input = writeFixture(root, happyPayload());
    const jsonOut = path.join(root, 'report.json');
    const mdOut = path.join(root, 'report.md');

    const report = run(['--input', input, '--json-out', jsonOut, '--md-out', mdOut], root);

    expect(process.exitCode).toBeUndefined();
    expect(report).not.toBeNull();
    if (report === null) throw new Error('expected provider parity report');
    expect(report.verdict).toBe('green');
    expect(JSON.parse(readFileSync(jsonOut, 'utf8'))).toMatchObject({
      schema: 'provider-parity-report-v1',
      verdict: 'green',
      counts: { green: 1 },
    });
    expect(readFileSync(mdOut, 'utf8')).toContain('| green | mini3 | agent | claude-cli | opencode-cli | mixed | ok |  |');
  });

  it('escapes Markdown table metacharacters and backslashes in rendered cells', () => {
    const markdown = renderProviderParityMarkdown({
      schema: 'provider-parity-report-v1',
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      verdict: 'warn',
      counts: { green: 0, warn: 1, blocked: 0, inconclusive: 0, not_applicable: 0 },
      rows: [
        {
          host: 'mini\\3',
          instance: 'agent',
          verdict: 'warn',
          reasons: ['back\\slash|pipe\nnewline'],
          primaryProvider: 'claude-cli',
          fallbackProviders: ['opencode-cli'],
          credentialState: 'mixed',
          probeState: 'ok',
          fallbackActive: true,
          evidenceRefs: [],
        },
      ],
    });

    expect(markdown).toContain('| warn | mini\\\\3 | agent | claude-cli | opencode-cli | mixed | ok | back\\\\slash\\|pipe newline |');
  });

  it('sets exit 1 when the report contains warn, blocked, or inconclusive rows', () => {
    const root = makeRoot();
    const payload = happyPayload() as Record<string, unknown>;
    payload.probes = [];
    const input = writeFixture(root, payload);
    const jsonOut = path.join(root, 'report.json');

    const report = run(['--input', input, '--json-out', jsonOut], root);

    expect(process.exitCode).toBe(1);
    expect(report).not.toBeNull();
    if (report === null) throw new Error('expected provider parity report');
    expect(report.verdict).toBe('inconclusive');
    expect(readFileSync(jsonOut, 'utf8')).toContain('provider_probe_missing');
  });

  it('sets exit 2 and writes no outputs for parse/schema errors', () => {
    const root = makeRoot();
    const input = path.join(root, 'input.json');
    const jsonOut = path.join(root, 'report.json');
    writeFileSync(input, '{not-json', 'utf8');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const report = run(['--input', input, '--json-out', jsonOut], root);

    expect(report).toBeNull();
    expect(process.exitCode).toBe(2);
    expect(() => readFileSync(jsonOut, 'utf8')).toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('provider parity report failed'));
  });

  it('sets exit 2 for malformed expected instance rows instead of reporting a false green no-op', () => {
    const root = makeRoot();
    const payload = {
      generatedAtUtc: '2026-06-23T10:24:24Z',
      targetMain: 'f9a0a62b3a298dba4e076ed5840f9694dbfb6097',
      expected: [{}],
      statuses: {},
      probes: [],
    };
    const input = writeFixture(root, payload);
    const jsonOut = path.join(root, 'report.json');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const report = run(['--input', input, '--json-out', jsonOut], root);

    expect(report).toBeNull();
    expect(process.exitCode).toBe(2);
    expect(() => readFileSync(jsonOut, 'utf8')).toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('expected[0].host must be a string'));
  });

  it('sets exit 2 for malformed provider-status snapshots before writing outputs', () => {
    const root = makeRoot();
    const payload = happyPayload() as Record<string, unknown>;
    const statuses = payload.statuses as Record<string, Record<string, unknown>>;
    const status = statuses['mini3/agent'];
    if (!status) throw new Error('expected fixture status');
    status.lineReachable = 'yes';
    const input = writeFixture(root, payload);
    const mdOut = path.join(root, 'report.md');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const report = run(['--input', input, '--md-out', mdOut], root);

    expect(report).toBeNull();
    expect(process.exitCode).toBe(2);
    expect(() => readFileSync(mdOut, 'utf8')).toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('statuses.mini3/agent.lineReachable must be a boolean'));
  });

  it('sets exit 2 for malformed provider-probe rows before writing outputs', () => {
    const root = makeRoot();
    const payload = happyPayload() as Record<string, unknown>;
    payload.probes = [{ host: 'mini3', instance: 'agent', provider: 'opencode-cli', state: 'maybe' }];
    const input = writeFixture(root, payload);
    const jsonOut = path.join(root, 'report.json');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const report = run(['--input', input, '--json-out', jsonOut], root);

    expect(report).toBeNull();
    expect(process.exitCode).toBe(2);
    expect(() => readFileSync(jsonOut, 'utf8')).toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('probes[0].state must be one of'));
  });

  it('sets exit 2 before writing when report output contains secret-like material', () => {
    const root = makeRoot();
    const payload = happyPayload() as Record<string, unknown>;
    const secretLike = ['Bea', 'rer sk-', 'test-secret-material-1234567890'].join('');
    payload.probes = [
      {
        host: 'mini3',
        instance: 'agent',
        provider: 'opencode-cli',
        state: 'failed',
        reason: secretLike,
      },
    ];
    const input = writeFixture(root, payload);
    const jsonOut = path.join(root, 'report.json');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const report = run(['--input', input, '--json-out', jsonOut], root);

    expect(report).toBeNull();
    expect(process.exitCode).toBe(2);
    expect(() => readFileSync(jsonOut, 'utf8')).toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('redaction_violation'));
  });
});
