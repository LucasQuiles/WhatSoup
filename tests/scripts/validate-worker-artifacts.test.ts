import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseArgs,
  run,
  validateWorkerArtifacts,
} from '../../scripts/validate-worker-artifacts.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('worker-');

function tempDir(): string {
  return tmp.make('artifacts');
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

function writeReportWithMetadata(
  dir: string,
  basename: string,
  body: string,
  overrides: Record<string, unknown> = {},
): void {
  writeFileSync(joinPath(dir, `${basename}.out`), body);
  writeSuccessfulMetadata(dir, basename, body, overrides);
}

function sortedCodes(result: { issues: { code: string }[] }): string[] {
  return result.issues.map((issue) => issue.code).sort();
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
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

  it('treats nested manifest directories as separate validation scopes', () => {
    const dir = tempDir();
    const parentBody = 'Verdict: parent manifest complete\n';
    writeFileSync(joinPath(dir, 'parent.out'), parentBody);
    writeFileSync(joinPath(dir, 'parent.err'), '');
    writeSuccessfulMetadata(dir, 'parent', parentBody, {
      report: 'parent.out',
      stderr: 'parent.err',
      stderrBytes: 0,
    });
    writeManifest(dir, [
      [
        'parent.out',
        'parent.meta.json',
        'parent.err',
        'deepseek/deepseek-chat',
        '0',
        String(Buffer.byteLength(parentBody)),
        '0',
        digest(parentBody),
        '2026-06-10T21:50:00Z',
        '2026-06-10T21:51:00Z',
      ].join('\t'),
    ]);

    const acceptedDir = joinPath(dir, 'accepted');
    mkdirSync(acceptedDir);
    const acceptedBody = 'Verdict: accepted child manifest complete\n';
    writeFileSync(joinPath(acceptedDir, 'accepted.out'), acceptedBody);
    writeFileSync(joinPath(acceptedDir, 'accepted.err'), '');
    writeSuccessfulMetadata(acceptedDir, 'accepted', acceptedBody, {
      report: 'accepted.out',
      stderr: 'accepted.err',
      stderrBytes: 0,
    });
    writeManifest(acceptedDir, [
      [
        'accepted.out',
        'accepted.meta.json',
        'accepted.err',
        'deepseek/deepseek-chat',
        '0',
        String(Buffer.byteLength(acceptedBody)),
        '0',
        digest(acceptedBody),
        '2026-06-10T21:50:00Z',
        '2026-06-10T21:51:00Z',
      ].join('\t'),
    ]);

    expect(validateWorkerArtifacts({ dir, requireMetadata: true, requireManifest: true })).toEqual({
      ok: true,
      checked: 1,
      issues: [],
    });
    expect(validateWorkerArtifacts({ dir: acceptedDir, requireMetadata: true, requireManifest: true })).toEqual({
      ok: true,
      checked: 1,
      issues: [],
    });
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

  it('rejects missing, malformed, duplicate, and incomplete worker manifests', () => {
    const missingManifestDir = tempDir();
    expect(sortedCodes(validateWorkerArtifacts({
      dir: missingManifestDir,
      requireManifest: true,
    }))).toEqual([
      'missing-worker-manifest',
      'no-worker-reports',
    ]);

    const missingColumnsDir = tempDir();
    writeFileSync(joinPath(missingColumnsDir, 'review.out'), 'Verdict: missing columns\n');
    writeFileSync(
      joinPath(missingColumnsDir, 'worker-run-manifest.tsv'),
      'report\tmetadata\nreview.out\treview.meta.json\n',
    );
    expect(sortedCodes(validateWorkerArtifacts({ dir: missingColumnsDir, requireManifest: true }))).toEqual([
      'invalid-worker-manifest',
      'worker-report-missing-from-manifest',
    ]);

    const emptyColumnDir = tempDir();
    writeFileSync(joinPath(emptyColumnDir, 'review.out'), 'Verdict: empty column\n');
    writeManifest(emptyColumnDir, [
      [
        'review.out',
        'review.meta.json',
        'review.err',
        '',
        '0',
        '22',
        '0',
        '0'.repeat(64),
        '2026-06-10T21:50:00Z',
        '2026-06-10T21:51:00Z',
      ].join('\t'),
    ]);
    expect(sortedCodes(validateWorkerArtifacts({ dir: emptyColumnDir, requireManifest: true }))).toEqual([
      'invalid-worker-manifest-row',
      'worker-report-missing-from-manifest',
    ]);

    const duplicateDir = tempDir();
    const duplicateBody = 'Verdict: duplicate manifest\n';
    writeFileSync(joinPath(duplicateDir, 'review.out'), duplicateBody);
    writeFileSync(joinPath(duplicateDir, 'review.err'), '');
    writeSuccessfulMetadata(duplicateDir, 'review', duplicateBody);
    const duplicateRow = [
      'review.out',
      'review.meta.json',
      'review.err',
      'deepseek/deepseek-chat',
      '0',
      String(Buffer.byteLength(duplicateBody)),
      '0',
      digest(duplicateBody),
      '2026-06-10T21:50:00Z',
      '2026-06-10T21:51:00Z',
    ].join('\t');
    writeManifest(duplicateDir, [duplicateRow, duplicateRow]);
    expect(sortedCodes(validateWorkerArtifacts({ dir: duplicateDir, requireManifest: true }))).toEqual([
      'duplicate-worker-manifest-report',
    ]);
  });

  it('rejects manifests that point to missing or unvalidated report paths', () => {
    const dir = tempDir();
    const body = 'Verdict: actual report\n';
    writeFileSync(joinPath(dir, 'actual.out'), body);
    writeSuccessfulMetadata(dir, 'actual', body);
    writeManifest(dir, [
      [
        'ghost.out',
        'ghost.meta.json',
        'ghost.err',
        'deepseek/deepseek-chat',
        '0',
        '12',
        '0',
        '0'.repeat(64),
        '2026-06-10T21:50:00Z',
        '2026-06-10T21:51:00Z',
      ].join('\t'),
    ]);

    expect(sortedCodes(validateWorkerArtifacts({ dir, requireManifest: true }))).toEqual([
      'worker-manifest-path-missing',
      'worker-manifest-path-missing',
      'worker-manifest-path-missing',
      'worker-manifest-report-missing',
      'worker-report-missing-from-manifest',
    ]);
  });

  it('rejects incomplete metadata evidence for successful worker reports', () => {
    const dir = tempDir();
    writeReportWithMetadata(dir, 'missing-model', 'Verdict: missing model\n', { model: '' });
    writeReportWithMetadata(dir, 'missing-stdout', 'Verdict: missing stdout\n', { stdoutBytes: 0 });
    writeReportWithMetadata(dir, 'missing-hash', 'Verdict: missing hash\n', { outputSha256: 'not-a-digest' });
    writeReportWithMetadata(dir, 'report-mismatch', 'Verdict: report mismatch\n', { report: 'other.out' });
    writeReportWithMetadata(dir, 'stderr-missing', 'Verdict: missing stderr\n', {
      stderr: 'missing.err',
      stderrBytes: 0,
    });
    writeFileSync(joinPath(dir, 'stderr-size.err'), 'stderr\n');
    writeReportWithMetadata(dir, 'stderr-size', 'Verdict: stderr size\n', {
      stderr: 'stderr-size.err',
      stderrBytes: 999,
    });
    writeReportWithMetadata(dir, 'bad-time', 'Verdict: bad time\n', {
      startedAt: 'not-a-date',
      endedAt: '2026-06-10T21:51:00Z',
    });
    writeReportWithMetadata(dir, 'reverse-time', 'Verdict: reverse time\n', {
      startedAt: '2026-06-10T21:52:00Z',
      endedAt: '2026-06-10T21:51:00Z',
    });

    expect(sortedCodes(validateWorkerArtifacts({ dir, requireMetadata: true }))).toEqual([
      'worker-invalid-time-bounds',
      'worker-missing-model',
      'worker-missing-output-sha256',
      'worker-missing-stdout-bytes',
      'worker-missing-time-bounds',
      'worker-report-path-mismatch',
      'worker-stderr-byte-mismatch',
      'worker-stderr-missing',
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

  it('rejects invalid CLI arguments with remediation-specific messages', () => {
    expect(() => parseArgs(['--dir'])).toThrow('--dir requires a path');
    expect(() => parseArgs(['--max-age-minutes', '-1'])).toThrow('--max-age-minutes must be a non-negative number');
    expect(() => parseArgs(['--max-age-minutes'])).toThrow('--max-age-minutes requires a number');
    expect(() => parseArgs(['--max-duration-minutes', 'NaN'])).toThrow('--max-duration-minutes must be a non-negative number');
    expect(() => parseArgs(['--max-duration-minutes'])).toThrow('--max-duration-minutes requires a number');
    expect(() => parseArgs(['--required-marker'])).toThrow('--required-marker requires text');
    expect(() => parseArgs(['--unknown'])).toThrow('Unknown argument: --unknown');
  });

  it('runs the CLI success, failure, help, and thrown-error paths', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const successDir = tempDir();
    writeFileSync(joinPath(successDir, 'review.out'), 'Verdict: cli success\n');
    expect(run(['--dir', successDir])).toEqual({ ok: true, checked: 1, issues: [] });
    expect(log).toHaveBeenLastCalledWith('worker artifact validation passed (1 reports)');
    expect(process.exitCode).toBeUndefined();

    const helpResult = run(['--help']);
    expect(helpResult).toEqual({ ok: true, checked: 0, issues: [] });
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('Usage: npm run guard:worker-artifacts');

    const failDir = tempDir();
    expect(run(['--dir', failDir]).ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain('no-worker-reports');

    process.exitCode = undefined;
    expect(() => run(['--dir'])).toThrow('--dir requires a path');
  });
});
