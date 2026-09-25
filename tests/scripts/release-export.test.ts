import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { resolveTestPython } from '../helpers/python-interpreter.ts';

let tmpRoot = '';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const QUALIFICATION_CLOSURE_SOURCES = [
  'deploy/scripts/qualify-health-deployment.py',
  'deploy/scripts/health-deployment-qualification-profile.json',
  'deploy/scripts/deployment-qualification-profile.json',
  'docs/operations/runtime-test-qualification.json',
  'deploy/scripts/lib/health_reader.py',
  'deploy/scripts/lib/durable_json.py',
  'deploy/scripts/lib/deployment_effective_config.py',
  'deploy/scripts/lib/deployment_qualification_bundle.py',
] as const;

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

function makeQualificationGitFixture(): Fixture {
  const fixture = makeGitFixture();
  for (const sourcePath of QUALIFICATION_CLOSURE_SOURCES) {
    const destination = path.join(fixture.sourceRoot, sourcePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(path.join(REPO_ROOT, sourcePath)));
  }
  execGit(fixture.sourceRoot, ['add', '-A']);
  execGit(fixture.sourceRoot, ['commit', '-m', 'qualification closure']);
  fixture.commit = execGit(fixture.sourceRoot, ['rev-parse', 'HEAD']);
  return fixture;
}

function qualificationBinding(fixture: Fixture) {
  return {
    sourceCommit: fixture.commit,
    arcCommit: 'a'.repeat(40),
    qfleetCommit: 'b'.repeat(40),
    policyVersion: 'whatsoup.deployment-qualification-profile.v1',
    qualifier: 'deploy/scripts/qualify-health-deployment.py',
    sourceTestProfile: 'docs/operations/runtime-test-qualification.json',
    deploymentProfiles: [
      'deploy/scripts/health-deployment-qualification-profile.json',
      'deploy/scripts/deployment-qualification-profile.json',
    ],
    healthHelpers: [
      'deploy/scripts/lib/health_reader.py',
      'deploy/scripts/lib/durable_json.py',
      'deploy/scripts/lib/deployment_effective_config.py',
      'deploy/scripts/lib/deployment_qualification_bundle.py',
    ],
  };
}

function recommitFixture(fixture: Fixture, message: string): void {
  execGit(fixture.sourceRoot, ['add', '-A']);
  execGit(fixture.sourceRoot, ['commit', '-m', message]);
  fixture.commit = execGit(fixture.sourceRoot, ['rev-parse', 'HEAD']);
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

  it('exports an exact configured qualification closure that the Python verifier accepts', () => {
    const fixture = makeQualificationGitFixture();
    const binding = qualificationBinding(fixture);
    const report = exportOk(fixture, { qualificationBundle: binding });

    expect(report.qualificationBundle).toEqual(expect.objectContaining({
      sourceCommit: fixture.commit,
      arcCommit: binding.arcCommit,
      qfleetCommit: binding.qfleetCommit,
      policyVersion: binding.policyVersion,
      manifestPath: path.join(report.releasePath, 'qualification-bundle.json'),
    }));
    const bundle = report.qualificationBundle as NonNullable<typeof report.qualificationBundle>;
    expect(existsSync(bundle.manifestPath)).toBe(true);
    expect(existsSync(path.join(report.releasePath, 'deployment-qualification', 'qualify-health-deployment.py'))).toBe(true);

    const verifier = [
      'from pathlib import Path',
      'import sys',
      'root = Path(sys.argv[1])',
      'sys.path.insert(0, str(root / "deployment-qualification"))',
      'from lib.deployment_qualification_bundle import load_qualification_bundle',
      'bundle = load_qualification_bundle(root, Path(sys.argv[2]), expected_sha256=sys.argv[3], expected_source_commit=sys.argv[4], expected_arc_commit=sys.argv[5], expected_qfleet_commit=sys.argv[6], expected_policy_version=sys.argv[7])',
      'assert bundle.qualifier_path == root / "deployment-qualification" / "qualify-health-deployment.py"',
      'print("verified")',
    ].join('\n');
    const result = spawnSync(resolveTestPython(), [
      '-B',
      '-c',
      verifier,
      report.releasePath,
      bundle.manifestPath,
      bundle.manifestSha256,
      fixture.commit,
      binding.arcCommit,
      binding.qfleetCommit,
      binding.policyVersion,
    ], { encoding: 'utf8', cwd: REPO_ROOT, timeout: 15_000, maxBuffer: 64 * 1024 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('verified');
  });

  it.each([
    ['missing profile', (binding: ReturnType<typeof qualificationBinding>) => ({
      ...binding,
      deploymentProfiles: binding.deploymentProfiles.slice(0, 1),
    })],
    ['wrong helper', (binding: ReturnType<typeof qualificationBinding>) => ({
      ...binding,
      healthHelpers: [...binding.healthHelpers.slice(0, 3), 'deploy/scripts/lib/not-a-health-helper.py'],
    })],
    ['invalid compatible commit', (binding: ReturnType<typeof qualificationBinding>) => ({
      ...binding,
      arcCommit: 'not-a-commit',
    })],
    ['invalid policy version', (binding: ReturnType<typeof qualificationBinding>) => ({
      ...binding,
      policyVersion: '',
    })],
    ['valid-looking wrong policy version', (binding: ReturnType<typeof qualificationBinding>) => ({
      ...binding,
      policyVersion: 'whatsoup.deployment-policy.v1',
    })],
  ])('refuses a qualification bundle binding with %s before publication', (_case, change) => {
    const fixture = makeQualificationGitFixture();
    const binding = change(qualificationBinding(fixture));

    expect(() => exportRelease({
      repoRoot: fixture.sourceRoot,
      commit: fixture.commit,
      releaseRoot: fixture.releaseRoot,
      buildTime: '2026-08-26T17:00:00.000Z',
      qualificationBundle: binding,
    })).toThrow(/qualification/i);
    expect(existsSync(path.join(fixture.releaseRoot, `WhatSoup-release-${fixture.commit.slice(0, 12)}`))).toBe(false);
  });

  it('refuses a declared qualification helper missing from the exact commit before publication', () => {
    const fixture = makeQualificationGitFixture();
    execGit(fixture.sourceRoot, ['rm', 'deploy/scripts/lib/durable_json.py']);
    execGit(fixture.sourceRoot, ['commit', '-m', 'remove declared helper']);
    fixture.commit = execGit(fixture.sourceRoot, ['rev-parse', 'HEAD']);

    expect(() => exportRelease({
      repoRoot: fixture.sourceRoot,
      commit: fixture.commit,
      releaseRoot: fixture.releaseRoot,
      buildTime: '2026-08-26T17:00:00.000Z',
      qualificationBundle: qualificationBinding(fixture),
    })).toThrow(/qualification/i);
    expect(existsSync(path.join(fixture.releaseRoot, `WhatSoup-release-${fixture.commit.slice(0, 12)}`))).toBe(false);
  });

  it.each([
    ['malformed deployment profile', 'deploy/scripts/deployment-qualification-profile.json', '{'],
    ['wrong health deployment profile schema', 'deploy/scripts/health-deployment-qualification-profile.json', '{"schema_version":"health.deployment-qualification-profile.v9","profile_kind":"deployment"}\n'],
    ['wrong deployment qualification profile schema', 'deploy/scripts/deployment-qualification-profile.json', '{"schema_version":"whatsoup.deployment-qualification-profile.v9","profile_kind":"deployment_qualification"}\n'],
    ['empty source-test profile', 'docs/operations/runtime-test-qualification.json', '{"schema_version":1,"commands":[]}\n'],
  ])('refuses a %s before publication', (_case, sourcePath, contents) => {
    const fixture = makeQualificationGitFixture();
    writeFileSync(path.join(fixture.sourceRoot, sourcePath), contents, 'utf8');
    recommitFixture(fixture, 'change qualification profile');

    expect(() => exportRelease({
      repoRoot: fixture.sourceRoot,
      commit: fixture.commit,
      releaseRoot: fixture.releaseRoot,
      buildTime: '2026-08-26T17:00:00.000Z',
      qualificationBundle: qualificationBinding(fixture),
    })).toThrow(/qualification/i);
    expect(existsSync(path.join(fixture.releaseRoot, `WhatSoup-release-${fixture.commit.slice(0, 12)}`))).toBe(false);
  });

  it('excludes dirty and untracked closure bytes from the exact bundle', () => {
    const fixture = makeQualificationGitFixture();
    const qualifierPath = path.join(fixture.sourceRoot, 'deploy/scripts/qualify-health-deployment.py');
    const committedQualifier = execGit(fixture.sourceRoot, ['show', `${fixture.commit}:deploy/scripts/qualify-health-deployment.py`]);
    writeFileSync(qualifierPath, 'print("dirty")\n', 'utf8');
    writeFileSync(path.join(fixture.sourceRoot, 'deploy/scripts/lib/untracked.py'), 'print("untracked")\n', 'utf8');

    const report = exportOk(fixture, { qualificationBundle: qualificationBinding(fixture) });
    expect(readFileSync(path.join(report.releasePath, 'deployment-qualification', 'qualify-health-deployment.py'), 'utf8')).toBe(`${committedQualifier}\n`);
    expect(existsSync(path.join(report.releasePath, 'deployment-qualification', 'lib/untracked.py'))).toBe(false);
  });

  it('refuses a source-parent symlink before bundle staging can traverse it', () => {
    const fixture = makeQualificationGitFixture();
    const externalHelpers = path.join(tmpRoot, 'external-helpers');
    mkdirSync(externalHelpers, { recursive: true });
    writeFileSync(path.join(externalHelpers, 'durable_json.py'), 'OUTSIDE = True\n', 'utf8');
    rmSync(path.join(fixture.sourceRoot, 'deploy/scripts/lib'), { recursive: true, force: true });
    symlinkSync(externalHelpers, path.join(fixture.sourceRoot, 'deploy/scripts/lib'), 'dir');
    recommitFixture(fixture, 'replace helpers with symlink');

    expect(() => exportRelease({
      repoRoot: fixture.sourceRoot,
      commit: fixture.commit,
      releaseRoot: fixture.releaseRoot,
      buildTime: '2026-08-26T17:00:00.000Z',
      qualificationBundle: qualificationBinding(fixture),
    })).toThrow(/regular file|symlink/i);
    expect(existsSync(path.join(fixture.releaseRoot, `WhatSoup-release-${fixture.commit.slice(0, 12)}`))).toBe(false);
  });

  it.each([
    ['manifest', 'qualification-bundle.json'],
    ['execution root', 'deployment-qualification/existing.txt'],
  ])('refuses an exact-commit collision with the generated bundle %s path', (_case, collisionPath) => {
    const fixture = makeQualificationGitFixture();
    const collision = path.join(fixture.sourceRoot, collisionPath);
    mkdirSync(path.dirname(collision), { recursive: true });
    writeFileSync(collision, 'tracked collision\n', 'utf8');
    recommitFixture(fixture, 'add generated path collision');

    expect(() => exportRelease({
      repoRoot: fixture.sourceRoot,
      commit: fixture.commit,
      releaseRoot: fixture.releaseRoot,
      buildTime: '2026-08-26T17:00:00.000Z',
      qualificationBundle: qualificationBinding(fixture),
    })).toThrow(/qualification.*collide/i);
    expect(existsSync(path.join(fixture.releaseRoot, `WhatSoup-release-${fixture.commit.slice(0, 12)}`))).toBe(false);
  });
});
