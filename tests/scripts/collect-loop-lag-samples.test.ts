import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendBoundedCollectorRecord,
  run,
} from '../../scripts/collect-loop-lag-samples.ts';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function fixture() {
  root = mkdtempSync(join(tmpdir(), 'loop-lag-collector-'));
  chmodSync(root, 0o700);
  const tokenFile = join(root, 'tokens.env');
  const output = join(root, 'evidence.jsonl');
  const token = 'e'.repeat(64);
  writeFileSync(tokenFile, `WHATSOUP_HEALTH_TOKEN=${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  return { tokenFile, output, token };
}

function endpointBody() {
  return {
    schema_version: 'health.event-loop-samples.v1',
    generated_at: '2026-08-15T00:00:00.000Z',
    process: { pid: 42, started_at_ms: 1_785_000_000_000, commit: 'a'.repeat(40) },
    cadence_ms: 500,
    oldest_sequence: 1,
    latest_sequence: 1,
    next_after: 1,
    truncated: false,
    gap: null,
    samples: [{ sequence: 1, at_ms: 500, wall_at_ms: 1_785_000_000_500, lag_ms: 300, source: 'interval', discontinuity: false, elu_utilization: 0.1, cpu_delta_ms: 2 }],
  };
}

describe('collect-loop-lag-samples schema', () => {
  it('is offline and reports effects plus exit codes as one JSON object', async () => {
    const stdout: string[] = [];
    const fetchMock = vi.fn();
    const code = await run(['schema', '--format', 'json'], {
      stdout: (text) => stdout.push(text),
      stderr: vi.fn(),
      fetch: fetchMock,
    });
    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    const value = JSON.parse(stdout[0]!);
    expect(value.effects).toEqual({
      network_effect: 'read_only_loopback',
      filesystem_effect: 'append_private_artifact',
      destructive: false,
      idempotent_samples: true,
      supports_dry_run: false,
    });
    expect(value.exit_codes).toMatchObject({ complete: 0, partial: 1, invalid: 2, authentication_failed: 3, endpoint_unsupported: 4, no_successful_poll: 5, output_failed: 6 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('collect-loop-lag-samples collect', () => {
  it('writes a private complete JSONL run without exposing the token', async () => {
    const { tokenFile, output, token } = fixture();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await run([
      'collect', '--instance', 'line-a', '--base-url', 'http://127.0.0.1:9091',
      '--token-file', tokenFile, '--output', output, '--once', '--limit', '160', '--format', 'json',
    ], {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(endpointBody()), { status: 200 })),
      nowIso: () => '2026-08-15T00:00:10.000Z',
      randomUuid: () => '00000000-0000-4000-8000-000000000001',
    });

    expect(code).toBe(0);
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(output).mode & 0o777).toBe(0o600);
    const lines = readFileSync(output, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.record_type)).toEqual(['run_started', 'sample', 'run_completed']);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, outcome: 'complete', successful_polls: 1, sample_count: 1 });
    expect(`${stdout.join('')} ${stderr.join('')} ${JSON.stringify(lines)}`).not.toContain(token);
    expect(JSON.stringify(lines)).not.toContain(tokenFile);
  });

  it.each([
    [401, 3, 'authentication_failed'],
    [404, 4, 'endpoint_unsupported'],
    [503, 5, 'no_successful_poll'],
  ] as const)('maps HTTP %i to exit %i', async (status, exitCode, outcome) => {
    const { tokenFile, output } = fixture();
    const stdout: string[] = [];
    const code = await run([
      'collect', '--instance', 'line-a', '--base-url', 'http://localhost:9091',
      '--token-file', tokenFile, '--output', output, '--once', '--format', 'json',
    ], {
      stdout: (text) => stdout.push(text),
      stderr: vi.fn(),
      fetch: vi.fn().mockResolvedValue(new Response('private body', { status })),
      nowIso: () => '2026-08-15T00:00:10.000Z',
      randomUuid: () => '00000000-0000-4000-8000-000000000001',
    });
    expect(code).toBe(exitCode);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: false, outcome });
    expect(readFileSync(output, 'utf8')).not.toContain('private body');
  });

  it('rejects unsafe or ambiguous arguments before network access', async () => {
    const fetchMock = vi.fn();
    const code = await run([
      'collect', '--instance', 'line-a', '--base-url', 'https://example.com',
      '--token-file', 'relative', '--output', 'relative', '--once', '--once', '--format', 'json',
    ], { stdout: vi.fn(), stderr: vi.fn(), fetch: fetchMock });
    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed prior tail before network access', async () => {
    const { tokenFile, output } = fixture();
    writeFileSync(output, '{bad json}\n', { mode: 0o600 });
    chmodSync(output, 0o600);
    const fetchMock = vi.fn();
    const code = await run([
      'collect', '--instance', 'line-a', '--base-url', 'http://localhost:9091',
      '--token-file', tokenFile, '--output', output, '--once', '--format', 'json',
    ], { stdout: vi.fn(), stderr: vi.fn(), fetch: fetchMock });
    expect(code).toBe(6);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drains every truncated page even when limit is one', async () => {
    const { tokenFile, output } = fixture();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const after = Number(new URL(String(input)).searchParams.get('after'));
      const sequence = after + 1;
      return new Response(JSON.stringify({
        ...endpointBody(),
        latest_sequence: 6,
        next_after: sequence,
        truncated: sequence < 6,
        samples: [{ ...endpointBody().samples[0], sequence }],
      }), { status: 200 });
    });
    const stdout: string[] = [];
    const code = await run([
      'collect', '--instance', 'line-a', '--base-url', 'http://localhost:9091',
      '--token-file', tokenFile, '--output', output, '--once', '--limit', '1', '--format', 'json',
    ], {
      stdout: (text) => stdout.push(text),
      stderr: vi.fn(),
      fetch: fetchMock,
      nowIso: () => '2026-08-15T00:00:10.000Z',
      randomUuid: () => '00000000-0000-4000-8000-000000000001',
    });
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ sample_count: 6, next_after: 6 });
  });
});

describe('appendBoundedCollectorRecord', () => {
  it('retains only whole valid records at the byte boundary', () => {
    const { output } = fixture();
    for (let index = 0; index < 8; index += 1) {
      appendBoundedCollectorRecord(output, {
        schema_version: 1,
        record_type: 'sample',
        run_id: 'run',
        observed_at: '2026-08-15T00:00:00.000Z',
        instance: 'line-a',
        index,
      }, 520);
    }
    const raw = readFileSync(output, 'utf8');
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(520);
    expect(raw.endsWith('\n')).toBe(true);
    const rows = raw.trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(rows.at(-1).index).toBe(7);
    expect(rows.length).toBeLessThan(8);
  });
});
