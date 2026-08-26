import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  exportRelease,
  type ReleaseExportReport,
} from '../../scripts/release-export.ts';
import {
  RELEASE_MANIFEST_FILE,
  createReleaseSnapshotDriftReport,
  parseReleaseSnapshotManifest,
  validateReleaseManifestFile,
} from '../../scripts/release-snapshot-plan.ts';

let tmpRoot = '';

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
  process.exitCode = undefined;
});

function execGit(cwd: string, args: string[]): string {
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
  return proc.stdout.trim();
}

interface Fixture {
  sourceRoot: string;
  releaseRoot: string;
  commit: string;
}

function makeGitFixture(): Fixture {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup-release-export-'));
  const sourceRoot = path.join(tmpRoot, 'source');
  const releaseRoot = path.join(tmpRoot, 'releases');
  mkdirSync(path.join(sourceRoot, 'src'), { recursive: true });
  mkdirSync(releaseRoot, { recursive: true });
  writeFileSync(path.join(sourceRoot, 'package.json'), '{"name":"whatsoup-fixture"}\n', 'utf8');
  writeFileSync(path.join(sourceRoot, 'src/main.ts'), 'export const main = true;\n', 'utf8');
  // Secret-shaped and state-shaped tracked files: the export must exclude them
  // even when git tracks them, because the release product must never carry
  // credential or mutable-state material.
  writeFileSync(path.join(sourceRoot, 'tokens.env'), 'WHATSOUP_HEALTH_TOKEN=fixture-secret\n', 'utf8');
  writeFileSync(path.join(sourceRoot, 'state.db'), 'not-a-real-db\n', 'utf8');
  execGit(sourceRoot, ['init']);
  execGit(sourceRoot, ['add', '-A']);
  execGit(sourceRoot, ['commit', '-m', 'fixture v1']);
  const commit = execGit(sourceRoot, ['rev-parse', 'HEAD']);
  return { sourceRoot, releaseRoot, commit };
}

function exportOk(fixture: Fixture, extra: Partial<Parameters<typeof exportRelease>[0]> = {}): ReleaseExportReport {
  const report = exportRelease({
    repoRoot: fixture.sourceRoot,
    commit: fixture.commit,
    releaseRoot: fixture.releaseRoot,
    buildTime: '2026-08-26T17:00:00.000Z',
    ...extra,
  });
  expect(report.ok, JSON.stringify(report, null, 2)).toBe(true);
  return report;
}

describe('exportRelease', () => {
  it('materializes an exact-commit release with a valid manifest and a clean self-check', () => {
    const fixture = makeGitFixture();
    const report = exportOk(fixture);

    expect(report.releasePath).toBe(path.join(fixture.releaseRoot, `WhatSoup-release-${fixture.commit.slice(0, 12)}`));
    expect(existsSync(path.join(report.releasePath, 'src/main.ts'))).toBe(true);

    const manifestPath = path.join(report.releasePath, RELEASE_MANIFEST_FILE);
    expect(validateReleaseManifestFile(manifestPath).ok).toBe(true);
    const manifest = parseReleaseSnapshotManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    expect(manifest.source.commit).toBe(fixture.commit);
    expect(manifest.release.path).toBe(report.releasePath);

    const drift = createReleaseSnapshotDriftReport(report.releasePath);
    expect(drift.ok, JSON.stringify(drift.issues, null, 2)).toBe(true);
    expect(report.selfCheck.ok).toBe(true);
    expect(report.fileCount).toBeGreaterThan(0);
    expect(report.treeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exports the commit bytes, not the working tree', () => {
    const fixture = makeGitFixture();
    // Dirty the working tree AFTER the commit; the export must not see it.
    writeFileSync(path.join(fixture.sourceRoot, 'src/main.ts'), 'export const main = "DIRTY";\n', 'utf8');
    const report = exportOk(fixture);
    const exported = readFileSync(path.join(report.releasePath, 'src/main.ts'), 'utf8');
    expect(exported).toBe('export const main = true;\n');
  });

  it('never ships secret- or state-shaped tracked files', () => {
    const fixture = makeGitFixture();
    const report = exportOk(fixture);
    expect(existsSync(path.join(report.releasePath, 'tokens.env'))).toBe(false);
    expect(existsSync(path.join(report.releasePath, 'state.db'))).toBe(false);
    const manifest = parseReleaseSnapshotManifest(
      JSON.parse(readFileSync(path.join(report.releasePath, RELEASE_MANIFEST_FILE), 'utf8')),
    );
    expect(manifest.files.some((file) => file.path === 'tokens.env' || file.path === 'state.db')).toBe(false);
  });

  it('refuses to clobber an existing release without replace', () => {
    const fixture = makeGitFixture();
    exportOk(fixture);
    expect(() =>
      exportRelease({
        repoRoot: fixture.sourceRoot,
        commit: fixture.commit,
        releaseRoot: fixture.releaseRoot,
        buildTime: '2026-08-26T17:01:00.000Z',
      }),
    ).toThrow(/exists|clobber|replace/i);
  });

  it('with replace, preserves the prior release at the rollback path', () => {
    const fixture = makeGitFixture();
    const first = exportOk(fixture);
    // Tamper the deployed release so the rollback copy is distinguishable.
    writeFileSync(path.join(first.releasePath, 'src/main.ts'), 'export const main = "OLD";\n', 'utf8');
    const second = exportOk(fixture, { replace: true, buildTime: '2026-08-26T17:02:00.000Z' });
    expect(second.rollbackPath && existsSync(second.rollbackPath)).toBe(true);
    const rolledBack = readFileSync(path.join(String(second.rollbackPath), 'src/main.ts'), 'utf8');
    expect(rolledBack).toBe('export const main = "OLD";\n');
    // The fresh export is back to exact-commit bytes.
    expect(readFileSync(path.join(second.releasePath, 'src/main.ts'), 'utf8')).toBe('export const main = true;\n');
  });

  it('rejects an unknown or abbreviated commit', () => {
    const fixture = makeGitFixture();
    expect(() =>
      exportRelease({
        repoRoot: fixture.sourceRoot,
        commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        releaseRoot: fixture.releaseRoot,
        buildTime: '2026-08-26T17:00:00.000Z',
      }),
    ).toThrow(/commit/i);
    expect(() =>
      exportRelease({
        repoRoot: fixture.sourceRoot,
        commit: fixture.commit.slice(0, 12),
        releaseRoot: fixture.releaseRoot,
        buildTime: '2026-08-26T17:00:00.000Z',
      }),
    ).toThrow(/full 40-hex/i);
  });

  it('fails closed and leaves no release when a required output is missing', () => {
    const fixture = makeGitFixture();
    expect(() =>
      exportRelease({
        repoRoot: fixture.sourceRoot,
        commit: fixture.commit,
        releaseRoot: fixture.releaseRoot,
        buildTime: '2026-08-26T17:00:00.000Z',
        requiredOutputs: ['console/dist/index.html'],
      }),
    ).toThrow(/required-output-missing|self-check/i);
    // Fail-closed: the final release path must not exist after a failed export.
    expect(existsSync(path.join(fixture.releaseRoot, `WhatSoup-release-${fixture.commit.slice(0, 12)}`))).toBe(false);
  });

  it('a post-export tamper is caught by the standard drift check', () => {
    const fixture = makeGitFixture();
    const report = exportOk(fixture);
    writeFileSync(path.join(report.releasePath, 'src/main.ts'), 'export const main = "TAMPERED";\n', 'utf8');
    const drift = createReleaseSnapshotDriftReport(report.releasePath);
    expect(drift.ok).toBe(false);
    expect(drift.issues.some((issue) => issue.kind === 'file-sha256-drift')).toBe(true);
  });
});
