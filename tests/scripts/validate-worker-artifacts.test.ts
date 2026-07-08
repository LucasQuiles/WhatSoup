import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseArgs,
  validateWorkerArtifacts,
} from '../../scripts/validate-worker-artifacts.ts';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(joinPath(tmpdir(), 'worker-artifacts-'));
  tempDirs.push(dir);
  return dir;
}

function digest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function writeSuccessfulMetadata(
  dir: string,
  basename: string,
  body: string,
  overrides: Record<string, unknown> = {},
): void {
  writeFileSync(joinPath(dir, `${basename}.meta.json`), JSON.stringify({
    exitCode: 0,
    model: 'deepseek/deepseek-chat',
    stdoutBytes: Buffer.byteLength(body),
    outputSha256: digest(body),
    startedAt: '2026-06-10T21:50:00Z',
    endedAt: '2026-06-10T21:51:00Z',
    ...overrides,
  }));
}

function writeManifest(dir: string, rows: string[]): void {
  writeFileSync(
    joinPath(dir, 'worker-run-manifest.tsv'),
    [
      'report\tmetadata\tstderr\tmodel\texitCode\tstdoutBytes\tstderrBytes\toutputSha256\tstartedAt\tendedAt',
      ...rows,
    ].join('\n'),
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('worker artifact validator', () => {
  it('accepts non-empty report artifacts and ignores metadata files', () => {
    const dir = tempDir();
    writeFileSync(joinPath(dir, 'review.out'), 'verdict: no-go\n');
    writeFileSync(joinPath(dir, 'worker.err'), '');
    writeFileSync(joinPath(dir, 'worker.pid'), '');

    const result = validateWorkerArtifacts({ dir });

    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it('accepts reports with successful metadata and required markers', () => {
    const dir = tempDir();
    const body = 'Verdict: no-go\n';
    writeFileSync(joinPath(dir, 'review.out'), body);
    writeSuccessfulMetadata(dir, 'review', body);

    const result = validateWorkerArtifacts({
      dir,
      requireMetadata: true,
      requiredMarkers: ['Verdict'],
    });

    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
  });

  it('rejects empty and whitespace-only report artifacts', () => {
    const dir = tempDir();
    writeFileSync(joinPath(dir, 'empty.md'), '');
    writeFileSync(joinPath(dir, 'blank.out'), ' \n\t');

    const result = validateWorkerArtifacts({ dir });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'blank-worker-report',
      'empty-worker-report',
    ]);
  });

  it('rejects malformed JSON report artifacts', () => {
    const dir = tempDir();
    writeFileSync(joinPath(dir, 'worker.json'), '{not-json');

    const result = validateWorkerArtifacts({ dir });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['malformed-worker-json']);
  });

  it('rejects reports without required metadata or markers', () => {
    const dir = tempDir();
    writeFileSync(joinPath(dir, 'review.out'), 'stack trace but no review marker\n');

    const result = validateWorkerArtifacts({
      dir,
      requireMetadata: true,
      requiredMarkers: ['Verdict'],
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'missing-or-malformed-worker-metadata',
      'missing-worker-marker',
    ]);
  });

  it('rejects non-zero worker exit metadata', () => {
    const dir = tempDir();
    const body = 'Verdict: failed\n';
    writeFileSync(joinPath(dir, 'review.out'), body);
    writeFileSync(joinPath(dir, 'review.meta.json'), JSON.stringify({
      exitCode: 1,
      model: 'minimax/MiniMax-M2.7-highspeed',
      stdoutBytes: Buffer.byteLength(body),
      outputSha256: digest(body),
      startedAt: '2026-06-10T21:50:00Z',
      endedAt: '2026-06-10T21:51:00Z',
    }));

    const result = validateWorkerArtifacts({ dir, requireMetadata: true });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['worker-nonzero-exit']);
  });

  it('rejects report content that does not match the metadata hash', () => {
    const dir = tempDir();
    const body = 'Verdict: changed after metadata\n';
    writeFileSync(joinPath(dir, 'review.out'), body);
    writeSuccessfulMetadata(dir, 'review', body, {
      outputSha256: '0'.repeat(64),
    });

    const result = validateWorkerArtifacts({ dir, requireMetadata: true });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['worker-sha256-mismatch']);
  });

  it('rejects report byte counts that do not match metadata', () => {
    const dir = tempDir();
    const body = 'Verdict: byte count mismatch\n';
    writeFileSync(joinPath(dir, 'review.out'), body);
    writeSuccessfulMetadata(dir, 'review', body, {
      stdoutBytes: 999,
    });

    const result = validateWorkerArtifacts({ dir, requireMetadata: true });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['worker-stdout-byte-mismatch']);
  });

  it('rejects worker runs that exceed the configured duration budget', () => {
    const dir = tempDir();
    const body = 'Verdict: too slow\n';
    writeFileSync(joinPath(dir, 'review.out'), body);
    writeSuccessfulMetadata(dir, 'review', body, {
      startedAt: '2026-06-10T21:00:00Z',
      endedAt: '2026-06-10T21:20:01Z',
    });

    const result = validateWorkerArtifacts({
      dir,
      requireMetadata: true,
      maxDurationMs: 20 * 60 * 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['worker-duration-exceeded']);
  });

  it('rejects stale report artifacts when an age budget is supplied', () => {
    const dir = tempDir();
    writeFileSync(joinPath(dir, 'review.out'), 'older review\n');

    const result = validateWorkerArtifacts({
      dir,
      now: new Date(Date.now() + 120_000),
      maxAgeMs: 60_000,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['stale-worker-report']);
  });

  it('uses metadata endedAt for staleness instead of mutable file mtime', () => {
    const dir = tempDir();
    const body = 'Verdict: stale by metadata\n';
    writeFileSync(joinPath(dir, 'review.out'), body);
    writeSuccessfulMetadata(dir, 'review', body, {
      startedAt: '2026-06-10T19:00:00Z',
      endedAt: '2026-06-10T19:01:00Z',
    });

    const result = validateWorkerArtifacts({
      dir,
      requireMetadata: true,
      now: new Date('2026-06-10T21:00:00Z'),
      maxAgeMs: 30 * 60 * 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['stale-worker-report']);
  });

  it('accepts a complete manifest when every report is declared', () => {
    const dir = tempDir();
    const body = 'Verdict: manifest complete\n';
    writeFileSync(joinPath(dir, 'review.out'), body);
    writeFileSync(joinPath(dir, 'review.err'), 'stderr\n');
    writeSuccessfulMetadata(dir, 'review', body, {
      report: 'review.out',
      stderr: 'review.err',
      stderrBytes: Buffer.byteLength('stderr\n'),
    });
    writeManifest(dir, [
      [
        'review.out',
        'review.meta.json',
        'review.err',
        'deepseek/deepseek-chat',
        '0',
        String(Buffer.byteLength(body)),
        String(Buffer.byteLength('stderr\n')),
        digest(body),
        '2026-06-10T21:50:00Z',
        '2026-06-10T21:51:00Z',
      ].join('\t'),
    ]);

    const result = validateWorkerArtifacts({
      dir,
      requireMetadata: true,
      requireManifest: true,
      requiredMarkers: ['Verdict'],
    });

    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
  });

  it('rejects report artifacts missing from the manifest', () => {
    const dir = tempDir();
    const body = 'Verdict: manifest hole\n';
    writeFileSync(joinPath(dir, 'review.out'), body);
    writeSuccessfulMetadata(dir, 'review', body);
    writeManifest(dir, []);

    const result = validateWorkerArtifacts({ dir, requireManifest: true });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      'empty-worker-manifest',
      'worker-report-missing-from-manifest',
    ]);
  });

  it('rejects missing report artifacts unless explicitly allowed', () => {
    const dir = tempDir();

    expect(validateWorkerArtifacts({ dir }).issues.map((issue) => issue.code)).toEqual(['no-worker-reports']);
    expect(validateWorkerArtifacts({ dir, allowNoReports: true }).ok).toBe(true);
  });

  it('parses CLI arguments', () => {
    expect(parseArgs([
      '--dir',
      'artifacts/workers',
      '--max-age-minutes',
      '30',
      '--max-duration-minutes',
      '10',
      '--allow-no-reports',
      '--require-manifest',
    ])).toEqual({
      dir: 'artifacts/workers',
      maxAgeMs: 30 * 60 * 1000,
      maxDurationMs: 10 * 60 * 1000,
      allowNoReports: true,
      requireMetadata: false,
      requireManifest: true,
      requiredMarkers: [],
      help: false,
    });
  });

  it('parses metadata and marker requirements', () => {
    expect(parseArgs(['--require-metadata', '--required-marker', 'Verdict'])).toMatchObject({
      requireMetadata: true,
      requiredMarkers: ['Verdict'],
    });
  });
});
