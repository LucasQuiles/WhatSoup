import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  findScannerArtifact, IntegrityReleaseError, releaseSource, verifyScannerReceipt, waitForScannerArtifact,
} from '../../scripts/private-integrity-release.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('integrity-release-');

const source = { runId: 123, attempt: 2, head: 'a'.repeat(40) };
const repository = { full_name: 'LucasQuiles/WhatSoup' };
const artifact = {
  id: 789, name: 'private-integrity-123-2', expired: false, size_in_bytes: 512, workflow_run: { id: 456 },
};
const producer = { artifactId: 789, scannerRunId: 456, scannerAttempt: 1, scannerConclusion: 'success' as const };
const receipt = { schema_version: 1, source_run_id: 123, source_run_attempt: 2, head_sha: source.head, conclusion: 'pass', scanner_run_id: 456, scanner_run_attempt: 1 };

function fixtures(): Record<string, unknown> {
  return {
    '': { ...repository, default_branch: 'main' },
    'actions/runs/123': {
      id: 123, workflow_id: 272306769, name: 'Quality', path: '.github/workflows/quality.yml',
      event: 'push', status: 'completed', conclusion: 'success', run_attempt: 2,
      head_sha: source.head, head_branch: 'v1.2.3', repository, head_repository: repository,
    },
    'actions/workflows/private-test-integrity.yml': {
      id: 234, name: 'Private test integrity', path: '.github/workflows/private-test-integrity.yml', state: 'active',
    },
    'actions/artifacts?name=private-integrity-123-2&per_page=100': { total_count: 1, artifacts: [artifact] },
    'actions/runs/456': {
      id: 456, workflow_id: 234, path: '.github/workflows/private-test-integrity.yml',
      event: 'workflow_run', status: 'completed', conclusion: 'success', run_attempt: 1, repository, head_repository: repository,
    },
  };
}

function reader(data = fixtures()): (path: string) => unknown {
  return (path) => {
    if (!Object.hasOwn(data, path)) throw new Error(`unexpected request: ${path}`);
    return structuredClone(data[path]);
  };
}

describe('trusted private scanner release consumption', () => {
  it('selects the artifact from the successful trusted workflow for one exact source attempt', () => {
    expect(findScannerArtifact(reader(), source)).toEqual(producer);
    expect(() => verifyScannerReceipt(receipt, source, producer)).not.toThrow();
  });

  it.each([
    { workflow_id: 272306769 }, { event: 'pull_request' }, { path: '.github/workflows/forged.yml' },
    { repository: { full_name: 'attacker/WhatSoup' } },
    { head_repository: { full_name: 'attacker/WhatSoup' } },
    { status: 'in_progress' },
  ])('does not accept a forged or unfinished artifact producer: %j', (override) => {
    const data = fixtures();
    data['actions/runs/456'] = { ...(data['actions/runs/456'] as object), ...override };
    expect(findScannerArtifact(reader(data), source)).toBeNull();
  });

  it('consumes failure evidence without waiting for the deadline and cannot accept a pass from a failed workflow', () => {
    const data = fixtures();
    data['actions/runs/456'] = { ...(data['actions/runs/456'] as object), conclusion: 'failure' };
    const selected = findScannerArtifact(reader(data), source)!;
    expect(selected).toEqual({ ...producer, scannerConclusion: 'failure' });
    expect(() => verifyScannerReceipt({ ...receipt, conclusion: 'fail' }, source, selected))
      .toThrow(new IntegrityReleaseError('Private test integrity failed', 1));
    expect(() => verifyScannerReceipt({ ...receipt, conclusion: 'inconclusive' }, source, selected))
      .toThrow('Private test integrity is inconclusive');
    expect(() => verifyScannerReceipt(receipt, source, selected)).toThrow('did not finish successfully');
  });

  it.each([{ run_attempt: 3 }, { head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { head_branch: 'main' }])
    ('rejects changed or non-release Quality identity: %j', (override) => {
      const data = fixtures();
      data['actions/runs/123'] = { ...(data['actions/runs/123'] as object), ...override };
      expect(() => findScannerArtifact(reader(data), source)).toThrow('Quality source binding is unavailable or changed');
    });

  it('cannot replace failed Quality with a successful private receipt', () => {
    const data = fixtures();
    data['actions/runs/123'] = { ...(data['actions/runs/123'] as object), conclusion: 'cancelled' };
    expect(() => findScannerArtifact(reader(data), source)).toThrow('Quality did not succeed for this release');
  });

  it.each([{ expired: true }, { size_in_bytes: 5000 }, { name: 'private-integrity-123-1' }])
    ('does not consume expired, oversized or stale artifact metadata: %j', (override) => {
      const data = fixtures();
      data['actions/artifacts?name=private-integrity-123-2&per_page=100'] = { total_count: 1, artifacts: [{ ...artifact, ...override }] };
      expect(findScannerArtifact(reader(data), source)).toBeNull();
    });

  it('rejects incomplete and ambiguous listings', () => {
    const data = fixtures();
    const path = 'actions/artifacts?name=private-integrity-123-2&per_page=100';
    data[path] = { total_count: 2, artifacts: [artifact] };
    expect(() => findScannerArtifact(reader(data), source)).toThrow('listing is incomplete or ambiguous');
    data[path] = { total_count: 2, artifacts: [artifact, { ...artifact, id: 790 }] };
    expect(() => findScannerArtifact(reader(data), source)).toThrow('Multiple trusted scanner receipts');
  });

  it('accepts a retried scanner only with its replacement artifact and current attempt', () => {
    const data = fixtures();
    data['actions/runs/456'] = { ...(data['actions/runs/456'] as object), run_attempt: 2 };
    data['actions/artifacts?name=private-integrity-123-2&per_page=100'] = {
      total_count: 1, artifacts: [{ ...artifact, id: 790 }],
    };
    const current = findScannerArtifact(reader(data), source)!;
    expect(current).toEqual({ ...producer, artifactId: 790, scannerAttempt: 2 });
    expect(() => verifyScannerReceipt(receipt, source, current)).toThrow('does not match');
    expect(() => verifyScannerReceipt({ ...receipt, scanner_run_attempt: 2 }, source, current)).not.toThrow();
  });

  it.each([
    { source_run_id: 999 }, { source_run_attempt: 1 }, { head_sha: 'b'.repeat(40) },
    { schema_version: 2 }, { private_diagnostics: 'must never be in this receipt' },
    { scanner_run_id: 111 }, { scanner_run_attempt: 0 },
  ])('rejects a mismatched or unexpected receipt field: %j', (override) => {
    expect(() => verifyScannerReceipt({ ...receipt, ...override }, source, producer)).toThrow('does not match');
  });

  it('distinguishes failed and inconclusive receipts', () => {
    for (const [conclusion, exitCode] of [['fail', 1], ['inconclusive', 125], ['success', 125]] as const) {
      try {
        verifyScannerReceipt({ ...receipt, conclusion }, source, producer);
        expect.unreachable('a non-pass receipt must reject release');
      } catch (error) {
        expect(error).toBeInstanceOf(IntegrityReleaseError);
        expect((error as IntegrityReleaseError).exitCode).toBe(exitCode);
      }
    }
  });

  it('waits for an actual trusted completion and stops at the deadline without another request', async () => {
    let time = 0;
    const data = fixtures();
    data['actions/artifacts?name=private-integrity-123-2&per_page=100'] = { total_count: 0, artifacts: [] };
    const get = vi.fn(reader(data));
    const wait = vi.fn(async (ms: number) => { time += ms; });
    await expect(waitForScannerArtifact(get, source, { deadline: 100, now: () => time, wait }))
      .rejects.toThrow('Timed out waiting');
    expect(wait).toHaveBeenCalledExactlyOnceWith(100);
    expect(get.mock.calls.filter(([path]) => path === 'actions/runs/123')).toHaveLength(1);
  });

  it('observes queued-to-completed without treating the queued state as pass', async () => {
    let time = 0;
    const data = fixtures();
    const original = data['actions/runs/456'];
    data['actions/runs/456'] = { ...(original as object), status: 'queued' };
    const wait = vi.fn(async (ms: number) => { time += ms; data['actions/runs/456'] = original; });
    await expect(waitForScannerArtifact(reader(data), source, { deadline: 30_000, now: () => time, wait }))
      .resolves.toEqual(producer);
    expect(wait).toHaveBeenCalledExactlyOnceWith(10_000);
  });

  it('requires exact source metadata rather than defaulting missing inputs', () => {
    expect(releaseSource({ QUALITY_RUN_ID: '123', QUALITY_RUN_ATTEMPT: '2', QUALITY_HEAD_SHA: source.head })).toEqual(source);
    expect(() => releaseSource({ QUALITY_HEAD_SHA: source.head })).toThrow('Exact Quality run');
  });

  it('uses canonical API paths through the CLI and propagates a failed receipt', () => {
    const scratch = tmp.make('cli');
    const responses = join(scratch, 'responses.json');
    const output = join(scratch, 'outputs.txt');
    const receiptPath = join(scratch, 'receipt.json');
    writeFileSync(responses, JSON.stringify(Object.fromEntries(
      Object.entries(fixtures()).map(([suffix, value]) => [
        `repos/LucasQuiles/WhatSoup${suffix ? `/${suffix}` : ''}`, value,
      ]),
    )));
    const gh = join(scratch, 'gh');
    writeFileSync(gh, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const endpoint = process.argv.at(-1);
const data = JSON.parse(fs.readFileSync(${JSON.stringify(responses)}, 'utf8'));
if (process.env.UNRELATED_TEST_SECRET !== undefined || process.env.GH_TOKEN !== 'synthetic-token') process.exit(4);
if (!Object.hasOwn(data, endpoint)) process.exit(3);
process.stdout.write(JSON.stringify(data[endpoint]));
`);
    chmodSync(gh, 0o700);
    const env = {
      ...process.env, PATH: `${scratch}:${dirname(process.execPath)}:/usr/bin:/bin`,
      GH_TOKEN: 'synthetic-token', UNRELATED_TEST_SECRET: 'must-stay-in-parent', GITHUB_OUTPUT: output,
      QUALITY_RUN_ID: '123', QUALITY_RUN_ATTEMPT: '2', QUALITY_HEAD_SHA: source.head,
      SCANNER_RUN_ID: '456', SCANNER_ARTIFACT_ID: '789',
    };
    const cli = resolve('scripts/private-integrity-release.ts');
    const selected = spawnSync(process.execPath, [cli, 'select'], { env, encoding: 'utf8', timeout: 10_000 });
    expect(selected.status, selected.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('artifact-id=789\nscanner-run-id=456\n');

    writeFileSync(receiptPath, JSON.stringify(receipt));
    const valid = spawnSync(process.execPath, [cli, 'verify', '--receipt', receiptPath], { env, encoding: 'utf8', timeout: 10_000 });
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout).toContain(`Quality 123 attempt 2 at ${source.head}`);

    writeFileSync(receiptPath, JSON.stringify({ ...receipt, conclusion: 'fail' }));
    const rejected = spawnSync(process.execPath, [cli, 'verify', '--receipt', receiptPath], { env, encoding: 'utf8', timeout: 10_000 });
    expect(rejected.status, rejected.stderr).toBe(1);
    expect(rejected.stderr).toContain('Private test integrity failed');
    expect(rejected.stdout).toBe('');
  });
});
