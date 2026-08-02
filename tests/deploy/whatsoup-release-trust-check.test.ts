// deploy/whatsoup database-bootstrap trust check × release exports.
//
// The trust check guards the database-compatibility bootstrap closure against
// tampering before any of it is imported. It verified that closure exclusively
// through git — but the deployed shape of a release is a NON-git export whose
// integrity root is `.whatsoup-release-manifest.json` (see the release
// runbook and preflight-check.sh, which both treat the manifest as the
// hard invariant for exactly this shape). The git-only check made every
// manifest-based release export refuse to boot ("requires a committed git
// work tree") — surfaced live on mini11, 2026-07-29, first standard-release
// deployment attempted on a wrapper this new.
//
// Contract pinned here: git work tree → git trust (unchanged); non-git with a
// manifest → every closure file must be a regular non-symlink file whose
// sha256 matches the manifest entry; anything else → FATAL, boot refused.
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('whatsoup-trust-');

const TRUST_PATHS = [
  'scripts/source-runtime-drift-check.ts',
  'scripts/lib/guard-core.ts',
  'src/lib/git-env.ts',
  'src/lib/type-guards.ts',
];

/** Extract the trust-check block: from the checker-var declaration up to (not including) the checker invocation. */
function extractTrustBlock(): string {
  const source = fs.readFileSync('deploy/whatsoup', 'utf8');
  const start = source.indexOf('DATABASE_BOOTSTRAP_TRUST_CHECKER=');
  const end = source.indexOf('if ! (\n  cd "$REPO_ROOT"');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('could not locate the database-bootstrap trust block in deploy/whatsoup');
  }
  return source.slice(start, end);
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function makeReleaseTree(root: string): void {
  for (const rel of TRUST_PATHS) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `// fixture ${rel}\n`);
  }
}

function writeManifest(root: string, over?: (files: Array<{ path: string; sha256: string; sizeBytes: number }>) => void): void {
  const files = TRUST_PATHS.map((rel) => {
    const buf = fs.readFileSync(path.join(root, rel));
    return { path: rel, sha256: sha256(buf), sizeBytes: buf.length };
  });
  over?.(files);
  const manifest = {
    schemaVersion: 2,
    source: { ref: 'fixture', commit: 'f'.repeat(40) },
    release: { path: root, createdAt: '2026-07-29T00:00:00.000Z', mutablePathExcludes: ['node_modules/**'] },
    rollback: { path: `${root}-before` },
    files,
  };
  fs.writeFileSync(path.join(root, '.whatsoup-release-manifest.json'), JSON.stringify(manifest, null, 2));
}

function runTrustBlock(repoRoot: string): { status: number | null; stderr: string } {
  const runnerDir = tmp.make('runner');
  const script = path.join(runnerDir, 'run-trust.sh');
  fs.writeFileSync(script, [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    `REPO_ROOT="${repoRoot}"`,
    `NODE="${process.execPath}"`,
    extractTrustBlock(),
    'echo TRUST-BLOCK-PASSED',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(script, 0o700);
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stderr: r.stderr };
}

function makeRelease(): string {
  const root = tmp.make('release');
  makeReleaseTree(root);
  return root;
}

describe('database-bootstrap trust check on non-git release exports', () => {
  it('accepts a release export whose closure files match the manifest hashes', () => {
    const root = makeRelease();
    writeManifest(root);
    const r = runTrustBlock(root);
    expect(r.stderr).not.toContain('FATAL');
    expect(r.status).toBe(0);
  });

  it('refuses when a closure file is tampered (hash mismatch)', () => {
    const root = makeRelease();
    writeManifest(root);
    fs.appendFileSync(path.join(root, 'scripts/lib/guard-core.ts'), '// tampered\n');
    const r = runTrustBlock(root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('FATAL');
  });

  it('refuses when the manifest lacks an entry for a closure file', () => {
    const root = makeRelease();
    writeManifest(root, (files) => {
      const i = files.findIndex((f) => f.path === 'src/lib/git-env.ts');
      files.splice(i, 1);
    });
    const r = runTrustBlock(root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('FATAL');
  });

  it('refuses when a closure file is a symlink even with a matching manifest entry', () => {
    const root = makeRelease();
    const target = path.join(root, 'scripts/real-checker.ts');
    fs.renameSync(path.join(root, 'scripts/source-runtime-drift-check.ts'), target);
    fs.symlinkSync(target, path.join(root, 'scripts/source-runtime-drift-check.ts'));
    writeManifest(root);
    const r = runTrustBlock(root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('FATAL');
  });

  it('still refuses a non-git tree with no manifest at all', () => {
    const root = makeRelease();
    const r = runTrustBlock(root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('FATAL');
  });

  it('keeps the git path: a clean committed work tree passes', () => {
    const root = makeRelease();
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    execFileSync('git', ['init', '-q'], { cwd: root, env });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: root, env });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: root, env });
    const r = runTrustBlock(root);
    expect(r.stderr).not.toContain('FATAL');
    expect(r.status).toBe(0);
  });

  it('keeps the git path strict: a dirty closure file in a git tree refuses', () => {
    const root = makeRelease();
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    execFileSync('git', ['init', '-q'], { cwd: root, env });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: root, env });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], { cwd: root, env });
    fs.appendFileSync(path.join(root, 'src/lib/git-env.ts'), '// dirty\n');
    const r = runTrustBlock(root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('FATAL');
  });
});
