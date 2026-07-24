import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  collectReleaseSnapshotDrift,
  createReleaseSnapshotPlan,
  parseReleaseSnapshotManifest,
  run,
  validateReleaseManifestFile,
} from '../../scripts/release-snapshot-plan.ts';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function makeFixtureSource(): string {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-release-snapshot-'));
  const sourceRoot = path.join(tmpRoot, 'source');
  mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"whatsoup-fixture"}\n', 'utf8');
  writeFileSync(path.join(sourceRoot, 'src/main.ts'), 'export const main = true;\n', 'utf8');
  return sourceRoot;
}

function execGit(cwd: string, args: string[]): void {
  const proc = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'whatsoup-test',
      GIT_AUTHOR_NAME: 'WhatSoup Test',
      GIT_COMMITTER_EMAIL: 'whatsoup-test',
      GIT_COMMITTER_NAME: 'WhatSoup Test',
    },
  });
  expect(proc.status, proc.stderr || proc.stdout).toBe(0);
}

function makeGitFixtureSource(): string {
  const sourceRoot = makeFixtureSource();
  execGit(sourceRoot, ['init']);
  execGit(sourceRoot, ['add', 'package.json', 'src/main.ts']);
  execGit(sourceRoot, ['commit', '-m', 'fixture']);
  return sourceRoot;
}

describe('release snapshot planning', () => {
  it('builds a deterministic dry-run manifest with rollback and exact copy actions', () => {
    const sourceRoot = makeFixtureSource();
    const plan = createReleaseSnapshotPlan({
      sourceRoot,
      sourceRef: 'main',
      sourceCommit: 'abc123def4567890',
      releaseRoot: path.join(tmpRoot, 'releases'),
      releaseName: 'WhatSoup-release-abc123def456',
      rollbackRoot: path.join(tmpRoot, 'rollback'),
      buildTime: '2026-06-13T06:00:00.000Z',
      trackedFiles: ['src/main.ts', 'package.json'],
    });

    expect(plan.manifest).toMatchObject({
      schemaVersion: 2,
      source: {
        commit: 'abc123def4567890',
        ref: 'main',
      },
      release: {
        path: path.join(tmpRoot, 'releases', 'WhatSoup-release-abc123def456'),
        createdAt: '2026-06-13T06:00:00.000Z',
        mutablePathExcludes: expect.arrayContaining(['node_modules/**', '**/*.log', '**/auth/**']),
      },
      rollback: {
        path: path.join(tmpRoot, 'rollback', 'WhatSoup-release-abc123def456-before'),
      },
    });
    expect(plan.manifest.files.map((file) => file.path)).toEqual(['package.json', 'src/main.ts']);
    expect(plan.actions).toEqual([
      expect.objectContaining({ kind: 'prepare-rollback', path: plan.manifest.rollback.path }),
      expect.objectContaining({ kind: 'create-directory', path: plan.manifest.release.path }),
      expect.objectContaining({ kind: 'copy-file', repoPath: 'package.json' }),
      expect.objectContaining({ kind: 'copy-file', repoPath: 'src/main.ts' }),
      expect.objectContaining({ kind: 'write-manifest', path: path.join(plan.manifest.release.path, '.whatsoup-release-manifest.json') }),
      expect.objectContaining({ kind: 'approval-required', operation: 'repoint-launchd-and-restart' }),
    ]);
  });

  it('parses manifests and rejects unsafe release paths', () => {
    expect(() => parseReleaseSnapshotManifest({
      schemaVersion: 1,
      source: { commit: 'abc123', ref: 'main' },
      release: {
        path: '../relative-release',
        createdAt: '2026-06-13T06:00:00.000Z',
        mutablePathExcludes: [],
      },
      rollback: { path: '/tmp/rollback' },
      files: [],
    })).toThrow(/absolute/);
  });

  it('flags code drift while ignoring mutable release paths', () => {
    const sourceRoot = makeFixtureSource();
    const releaseRoot = path.join(tmpRoot, 'releases');
    const plan = createReleaseSnapshotPlan({
      sourceRoot,
      sourceRef: 'main',
      sourceCommit: 'abc123def4567890',
      releaseRoot,
      buildTime: '2026-06-13T06:00:00.000Z',
      trackedFiles: ['package.json', 'src/main.ts'],
    });
    const releasePath = plan.manifest.release.path;
    mkdirSync(path.join(releasePath, 'src'), { recursive: true });
    writeFileSync(path.join(releasePath, 'package.json'), readFileSync(path.join(sourceRoot, 'package.json')));
    writeFileSync(path.join(releasePath, 'src/main.ts'), 'export const main = false;\n', 'utf8');
    writeFileSync(path.join(releasePath, 'src/hotpatch.ts'), 'export const hotpatch = true;\n', 'utf8');
    mkdirSync(path.join(releasePath, 'node_modules/cache'), { recursive: true });
    mkdirSync(path.join(releasePath, 'auth'), { recursive: true });
    writeFileSync(path.join(releasePath, 'node_modules/cache/file.js'), 'ignored\n', 'utf8');
    writeFileSync(path.join(releasePath, 'stdout.log'), 'ignored\n', 'utf8');
    writeFileSync(path.join(releasePath, 'auth/creds.json'), 'ignored\n', 'utf8');

    expect(collectReleaseSnapshotDrift(releasePath, plan.manifest)).toEqual([
      expect.objectContaining({ kind: 'file-sha256-drift', path: 'src/main.ts' }),
      expect.objectContaining({ kind: 'extra-file', path: 'src/hotpatch.ts' }),
    ]);
  });

  it('flags a declared required build output that is absent from the release', () => {
    // A release that ships without its built console assets (untracked by git,
    // so never in the file manifest) previously drifted CLEAN — the packaging
    // blind spot behind the mini7 console 404. requiredOutputs closes it.
    const sourceRoot = makeFixtureSource();
    const releaseRoot = path.join(tmpRoot, 'releases');
    const plan = createReleaseSnapshotPlan({
      sourceRoot,
      sourceRef: 'main',
      sourceCommit: 'abc123def4567890',
      releaseRoot,
      buildTime: '2026-06-13T06:00:00.000Z',
      trackedFiles: ['package.json', 'src/main.ts'],
      requiredOutputs: ['dist/index.html'],
    });
    expect(plan.manifest.requiredOutputs).toEqual(['dist/index.html']);
    const releasePath = plan.manifest.release.path;
    mkdirSync(path.join(releasePath, 'src'), { recursive: true });
    writeFileSync(path.join(releasePath, 'package.json'), readFileSync(path.join(sourceRoot, 'package.json')));
    writeFileSync(path.join(releasePath, 'src/main.ts'), readFileSync(path.join(sourceRoot, 'src/main.ts')));
    // dist/index.html deliberately NOT written — the release omits the console build.

    expect(collectReleaseSnapshotDrift(releasePath, plan.manifest)).toEqual([
      expect.objectContaining({ kind: 'required-output-missing', path: 'dist/index.html' }),
    ]);
  });

  it('passes drift when the declared required output is present', () => {
    const sourceRoot = makeFixtureSource();
    const releaseRoot = path.join(tmpRoot, 'releases');
    const plan = createReleaseSnapshotPlan({
      sourceRoot,
      sourceRef: 'main',
      sourceCommit: 'abc123def4567890',
      releaseRoot,
      buildTime: '2026-06-13T06:00:00.000Z',
      trackedFiles: ['package.json', 'src/main.ts'],
      requiredOutputs: ['dist/index.html'],
    });
    const releasePath = plan.manifest.release.path;
    mkdirSync(path.join(releasePath, 'src'), { recursive: true });
    mkdirSync(path.join(releasePath, 'dist'), { recursive: true });
    writeFileSync(path.join(releasePath, 'package.json'), readFileSync(path.join(sourceRoot, 'package.json')));
    writeFileSync(path.join(releasePath, 'src/main.ts'), readFileSync(path.join(sourceRoot, 'src/main.ts')));
    writeFileSync(path.join(releasePath, 'dist/index.html'), '<!doctype html><html></html>', 'utf8');

    expect(collectReleaseSnapshotDrift(releasePath, plan.manifest)).toEqual([]);
  });

  it('accepts a legacy v1 manifest with no requiredOutputs (back-compat)', () => {
    const manifest = parseReleaseSnapshotManifest({
      schemaVersion: 1,
      source: { commit: 'abc123', ref: 'main' },
      release: {
        path: '/tmp/whatsoup-legacy/releases/legacy',
        createdAt: '2026-06-13T06:00:00.000Z',
        mutablePathExcludes: [],
      },
      rollback: { path: '/tmp/whatsoup-legacy/rollback/legacy-before' },
      files: [],
    });
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.requiredOutputs).toEqual([]);
  });

  it('flags manifest path mismatches and non-regular release files', () => {
    const sourceRoot = makeFixtureSource();
    const releaseRoot = path.join(tmpRoot, 'releases');
    const plan = createReleaseSnapshotPlan({
      sourceRoot,
      sourceRef: 'main',
      sourceCommit: 'abc123def4567890',
      releaseRoot,
      buildTime: '2026-06-13T06:00:00.000Z',
      trackedFiles: ['package.json', 'src/main.ts'],
    });
    const releasePath = plan.manifest.release.path;
    mkdirSync(path.join(releasePath, 'src'), { recursive: true });
    writeFileSync(path.join(releasePath, 'package.json'), readFileSync(path.join(sourceRoot, 'package.json')));
    symlinkSync(path.join(sourceRoot, 'src/main.ts'), path.join(releasePath, 'src/main.ts'));
    symlinkSync(path.join(sourceRoot, 'package.json'), path.join(releasePath, 'src/hotpatch-link.ts'));

    expect(collectReleaseSnapshotDrift(releasePath, {
      ...plan.manifest,
      release: {
        ...plan.manifest.release,
        path: path.join(tmpRoot, 'other-release'),
      },
    })).toEqual([
      expect.objectContaining({ kind: 'manifest-release-path-mismatch' }),
      expect.objectContaining({ kind: 'file-type-drift', path: 'src/main.ts', actual: 'symlink' }),
      expect.objectContaining({ kind: 'extra-file', path: 'src/hotpatch-link.ts' }),
    ]);
  });

  it('CLI check-release mode exits clean for a manifest-matching release', () => {
    const sourceRoot = makeFixtureSource();
    const releaseRoot = path.join(tmpRoot, 'releases');
    const plan = createReleaseSnapshotPlan({
      sourceRoot,
      sourceRef: 'main',
      sourceCommit: 'abc123def4567890',
      releaseRoot,
      buildTime: '2026-06-13T06:00:00.000Z',
      trackedFiles: ['package.json', 'src/main.ts'],
    });
    const releasePath = plan.manifest.release.path;
    mkdirSync(path.join(releasePath, 'src'), { recursive: true });
    writeFileSync(path.join(releasePath, 'package.json'), readFileSync(path.join(sourceRoot, 'package.json')));
    writeFileSync(path.join(releasePath, 'src/main.ts'), readFileSync(path.join(sourceRoot, 'src/main.ts')));
    writeFileSync(
      path.join(releasePath, '.whatsoup-release-manifest.json'),
      `${JSON.stringify(plan.manifest, null, 2)}\n`,
      'utf8',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const report = run(['--check-release', releasePath, '--json'], sourceRoot);

    expect(process.exitCode).toBeUndefined();
    expect(report).toMatchObject({
      check: 'release-drift',
      ok: true,
      releasePath,
      issues: [],
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      check: 'release-drift',
      ok: true,
      releasePath,
      issues: [],
    });
  });

  it('CLI check-release mode exits nonzero and reports release drift', () => {
    const sourceRoot = makeFixtureSource();
    const releaseRoot = path.join(tmpRoot, 'releases');
    const plan = createReleaseSnapshotPlan({
      sourceRoot,
      sourceRef: 'main',
      sourceCommit: 'abc123def4567890',
      releaseRoot,
      buildTime: '2026-06-13T06:00:00.000Z',
      trackedFiles: ['package.json', 'src/main.ts'],
    });
    const releasePath = plan.manifest.release.path;
    mkdirSync(path.join(releasePath, 'src'), { recursive: true });
    writeFileSync(path.join(releasePath, 'package.json'), readFileSync(path.join(sourceRoot, 'package.json')));
    writeFileSync(path.join(releasePath, 'src/main.ts'), 'export const main = false;\n', 'utf8');
    writeFileSync(
      path.join(releasePath, '.whatsoup-release-manifest.json'),
      `${JSON.stringify(plan.manifest, null, 2)}\n`,
      'utf8',
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const report = run(['--check-release', releasePath], sourceRoot);

    expect(process.exitCode).toBe(1);
    expect(report).toMatchObject({
      check: 'release-drift',
      ok: false,
      releasePath,
      issues: [expect.objectContaining({ kind: 'file-sha256-drift', path: 'src/main.ts' })],
    });
    expect(error.mock.calls.flat().join('\n')).toContain('file-sha256-drift: src/main.ts');
  });

  it('CLI check-release mode reports pre-manifest releases as structured drift', () => {
    const sourceRoot = makeFixtureSource();
    const releasePath = path.join(tmpRoot, 'WhatSoup-release-pre-manifest');
    mkdirSync(releasePath, { recursive: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const report = run(['--check-release', releasePath, '--json'], sourceRoot);

    expect(process.exitCode).toBe(1);
    expect(report).toMatchObject({
      check: 'release-drift',
      ok: false,
      releasePath,
      manifestPath: path.join(releasePath, '.whatsoup-release-manifest.json'),
      source: null,
      issues: [expect.objectContaining({ kind: 'manifest-missing' })],
    });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      check: 'release-drift',
      ok: false,
      source: null,
      issues: [expect.objectContaining({ kind: 'manifest-missing' })],
    });
  });

  it('CLI planning mode emits JSON when invoked through an absolute script path', () => {
    const sourceRoot = makeGitFixtureSource();
    const releaseRoot = path.join(tmpRoot, 'releases');
    const scriptPath = path.join(process.cwd(), 'scripts/release-snapshot-plan.ts');

    const proc = spawnSync(process.execPath, [
      '--disable-warning=ExperimentalWarning',
      '--experimental-strip-types',
      scriptPath,
      '--release-root',
      releaseRoot,
      '--source-ref',
      'HEAD',
      '--build-time',
      '2026-06-13T06:00:00.000Z',
      '--json',
    ], {
      cwd: sourceRoot,
      encoding: 'utf8',
    });

    expect(proc.status, proc.stderr || proc.stdout).toBe(0);
    expect(proc.stderr).toBe('');
    const plan = JSON.parse(proc.stdout) as ReturnType<typeof createReleaseSnapshotPlan>;
    expect(plan.dryRun).toBe(true);
    expect(plan.manifest.release.path).toBe(path.join(
      releaseRoot,
      `WhatSoup-release-${plan.manifest.source.commit.slice(0, 12)}`,
    ));
    expect(plan.manifest.files.map((file) => file.path)).toEqual(['package.json', 'src/main.ts']);
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'write-manifest' }),
      expect.objectContaining({ kind: 'approval-required', operation: 'repoint-launchd-and-restart' }),
    ]));
  });

  it('documented npm JSON planning command emits parseable JSON when run silent', () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-release-npm-smoke-'));
    const releaseRoot = path.join(tmpRoot, 'releases');

    const proc = spawnSync('npm', [
      '--silent',
      'run',
      'release:snapshot',
      '--',
      '--release-root',
      releaseRoot,
      '--source-ref',
      'HEAD',
      '--build-time',
      '2026-06-13T06:00:00.000Z',
      '--json',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    expect(proc.status, proc.stderr || proc.stdout).toBe(0);
    const plan = JSON.parse(proc.stdout) as ReturnType<typeof createReleaseSnapshotPlan>;
    expect(plan.dryRun).toBe(true);
    expect(plan.manifest.source.ref).toBe('HEAD');
    expect(plan.manifest.files.length).toBeGreaterThan(0);
  });

  it('rejects check-release mixed with planning-only flags', () => {
    expect(() => run([
      '--check-release',
      path.join(tmpdir(), 'release'),
      '--release-root',
      path.join(tmpdir(), 'releases'),
    ])).toThrow(/cannot be combined with release planning flags: --release-root/);
  });
});

describe('validateReleaseManifestFile error-kind split', () => {
  // Pre-fix, the file-read (readFileSync) and JSON.parse(...) calls shared a
  // single try/catch, so a read failure (permission denied, I/O error) was
  // reported as kind='invalid-json' with a "not valid JSON" message -- the
  // wrong diagnosis and the wrong remediation (re-exporting the release does
  // nothing for a permissions problem). This suite pins the split: a genuine
  // read failure gets its own 'unreadable' kind, and a merely-malformed but
  // readable file still gets 'invalid-json'.
  let manifestPath = '';

  afterEach(() => {
    if (manifestPath) {
      try {
        chmodSync(manifestPath, 0o644);
      } catch {
        // best-effort restore; the file lives under tmpRoot, which afterEach
        // above removes regardless
      }
    }
    manifestPath = '';
  });

  it('reports kind=unreadable when the manifest exists but cannot be read', () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-manifest-validate-'));
    manifestPath = path.join(tmpRoot, '.whatsoup-release-manifest.json');
    writeFileSync(manifestPath, '{"schemaVersion":1}\n', 'utf8');
    chmodSync(manifestPath, 0o000);

    if (process.getuid && process.getuid() === 0) {
      // root bypasses file-mode permission checks entirely -- chmod 000
      // cannot produce a read failure to observe, so this environment
      // cannot exercise the falsifier. Skip rather than report a false
      // pass/fail that says nothing about the code under test.
      return;
    }

    const report = validateReleaseManifestFile(manifestPath);

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('unreadable');
    expect(report.error?.message).not.toContain('valid JSON');
  });

  it('still reports kind=invalid-json for a readable but malformed manifest', () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-manifest-validate-'));
    manifestPath = path.join(tmpRoot, '.whatsoup-release-manifest.json');
    writeFileSync(manifestPath, '{not valid json', 'utf8');

    const report = validateReleaseManifestFile(manifestPath);

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('invalid-json');
  });

  it('still reports kind=missing when the manifest does not exist', () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-manifest-validate-'));
    manifestPath = path.join(tmpRoot, '.whatsoup-release-manifest.json');

    const report = validateReleaseManifestFile(manifestPath);

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('missing');
  });

  it('still reports kind=invalid-schema for valid JSON missing required fields', () => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-manifest-validate-'));
    manifestPath = path.join(tmpRoot, '.whatsoup-release-manifest.json');
    writeFileSync(manifestPath, '{"files":[]}\n', 'utf8');

    const report = validateReleaseManifestFile(manifestPath);

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe('invalid-schema');
  });
});
