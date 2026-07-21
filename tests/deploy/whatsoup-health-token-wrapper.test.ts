import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function extractTmpdirBlock(source: string): string {
  const start = source.indexOf('# Pin process temp files');
  const end = source.indexOf('\n# Do not inherit protected credentials', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function extractVersionExposureBlock(source: string): string {
  const start = source.indexOf('# Expose checkout version metadata');
  const end = source.indexOf('\n# Ensure PATH includes', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, 'utf8');
  fs.chmodSync(filePath, 0o700);
}

function runVersionExposureProbe(
  scenario: 'main' | 'detached' | 'non-git' | 'git-error' | 'non-git-manifest' | 'non-git-manifest-malformed',
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-wrapper-version-'));
  tmpDirs.push(tmpDir);
  const binDir = path.join(tmpDir, 'bin');
  const repoRoot = path.join(tmpDir, 'repo');
  fs.mkdirSync(binDir);
  fs.mkdirSync(repoRoot);

  // Non-git release snapshots carry provenance in .whatsoup-release-manifest.json
  // (written by scripts/release-snapshot-plan.ts as { source: { ref, commit } }).
  if (scenario === 'non-git-manifest') {
    fs.writeFileSync(
      path.join(repoRoot, '.whatsoup-release-manifest.json'),
      JSON.stringify({ source: { ref: 'release/v1', commit: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' } }),
      'utf8',
    );
  } else if (scenario === 'non-git-manifest-malformed') {
    fs.writeFileSync(
      path.join(repoRoot, '.whatsoup-release-manifest.json'),
      '{ this is not valid json',
      'utf8',
    );
  }

  writeExecutable(path.join(binDir, 'git'), `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "-C" ]; then
  shift 2
fi
case "$SCENARIO:$*" in
  "main:rev-parse --is-inside-work-tree"|"detached:rev-parse --is-inside-work-tree")
    printf 'true\\n'
    exit 0
    ;;
  "main:rev-parse HEAD"|"detached:rev-parse HEAD")
    printf '1234567890abcdef1234567890abcdef12345678\\n'
    exit 0
    ;;
  "main:symbolic-ref --quiet --short HEAD")
    printf 'main\\n'
    exit 0
    ;;
  "detached:symbolic-ref --quiet --short HEAD")
    exit 1
    ;;
  "non-git:rev-parse --is-inside-work-tree"|"non-git-manifest:rev-parse --is-inside-work-tree"|"non-git-manifest-malformed:rev-parse --is-inside-work-tree")
    exit 1
    ;;
  "git-error:rev-parse --is-inside-work-tree")
    printf 'git unavailable\\n' >&2
    exit 127
    ;;
esac
printf 'unexpected git invocation: %s\\n' "$*" >&2
exit 64
`);

  const source = fs.readFileSync('deploy/whatsoup', 'utf8');
  const scriptPath = path.join(tmpDir, 'probe-version.sh');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
PATH="${binDir}:$PATH"
export SCENARIO="${scenario}"
REPO_ROOT="${repoRoot}"
NODE="${process.execPath}"
${extractVersionExposureBlock(source)}
printf 'sha=%s\\nbranch=%s\\n' "\${WHATSOUP_GIT_SHA-}" "\${WHATSOUP_GIT_BRANCH-}"
`,
    'utf8',
  );
  fs.chmodSync(scriptPath, 0o700);

  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

describe('health token shell wrappers', () => {
  it('deploy/whatsoup keeps protected credentials out of the parent process', () => {
    const source = fs.readFileSync('deploy/whatsoup', 'utf8');
    expect(source).toContain('unset ANTHROPIC_API_KEY OPENAI_API_KEY PINECONE_API_KEY WHATSOUP_HEALTH_TOKEN');
    expect(source).not.toContain('keyring_lookup()');
    expect(source).not.toContain('read-private-health-token.sh');
  });

  it('uses a shared descriptor reader with no-follow, fstat, and a bounded read', () => {
    const helper = fs.readFileSync('deploy/lib/read-private-health-token.mjs', 'utf8');
    const reader = fs.readFileSync('src/fleet/health-token-file.ts', 'utf8');

    expect(helper).toContain('readPrivateHealthTokenFileSync');
    expect(reader).toContain('constants.O_NOFOLLOW');
    expect(reader).toContain('fstatSync(fd)');
    expect(reader).toContain('Buffer.alloc(MAX_CANONICAL_FILE_BYTES + 1)');
    expect(reader).toContain('readSync(fd, buffer');
    expect(reader).toContain('(stat.mode & 0o7777) !== PRIVATE_HEALTH_TOKEN_FILE_MODE');
    expect(reader).toContain('stat.uid !== expectedUid');
    expect(reader).not.toContain('readFileSync(filePath');
  });

  it('deploy/whatsoup exports an owned per-instance TMPDIR before Node starts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-wrapper-tmpdir-'));
    tmpDirs.push(tmpDir);
    const source = fs.readFileSync('deploy/whatsoup', 'utf8');
    const scriptPath = path.join(tmpDir, 'probe-tmpdir.sh');
    const homeDir = path.join(tmpDir, 'home');
    const dataHome = path.join(tmpDir, 'data');
    fs.mkdirSync(homeDir);

    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\nset -euo pipefail\nHOME="${homeDir}"\nXDG_DATA_HOME="${dataHome}"\nINSTANCE=media-bot\n${extractTmpdirBlock(source)}\nprintf '%s\\n' "$TMPDIR"\n[ -d "$TMPDIR" ]\n`,
      'utf8',
    );
    fs.chmodSync(scriptPath, 0o700);

    const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();

    expect(stdout).toBe(path.join(dataHome, 'whatsoup', 'tmp', 'media-bot'));
  });

  it('deploy/whatsoup captures full checkout SHA and branch after preflight', () => {
    const source = fs.readFileSync('deploy/whatsoup', 'utf8');
    const preflightIndex = source.indexOf('preflight-check.sh');
    const versionIndex = source.indexOf('# Expose checkout version metadata');
    const pathIndex = source.indexOf('# Ensure PATH includes');
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(versionIndex).toBeGreaterThan(preflightIndex);
    expect(pathIndex).toBeGreaterThan(versionIndex);

    const result = runVersionExposureProbe('main');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('sha=1234567890abcdef1234567890abcdef12345678\nbranch=main');
    expect(result.stderr).toBe('');
  });

  it('deploy/whatsoup marks detached HEAD and leaves non-git hosts warn-only', () => {
    const detached = runVersionExposureProbe('detached');
    expect(detached.status).toBe(0);
    expect(detached.stdout).toBe('sha=1234567890abcdef1234567890abcdef12345678\nbranch=HEAD-detached');

    const nonGit = runVersionExposureProbe('non-git');
    expect(nonGit.status).toBe(0);
    expect(nonGit.stdout).toBe('sha=\nbranch=');
    expect(nonGit.stderr).toContain('WARN:');

    const gitError = runVersionExposureProbe('git-error');
    expect(gitError.status).toBe(0);
    expect(gitError.stdout).toBe('sha=\nbranch=');
    expect(gitError.stderr).toContain('WARN:');
  });

  it('deploy/whatsoup falls back to the release-manifest source.commit on a non-git snapshot (#1868)', () => {
    const withManifest = runVersionExposureProbe('non-git-manifest');
    expect(withManifest.status).toBe(0);
    expect(withManifest.stdout).toBe(
      'sha=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\nbranch=release/v1',
    );

    // A malformed manifest must not surface a bogus sha and must not block startup.
    const malformed = runVersionExposureProbe('non-git-manifest-malformed');
    expect(malformed.status).toBe(0);
    expect(malformed.stdout).toBe('sha=\nbranch=');
    expect(malformed.stderr).toContain('WARN:');
  });

  it('heal-notify checks canonical health token before legacy fallback', () => {
    const source = fs.readFileSync('deploy/scripts/heal-notify.sh', 'utf8');
    const canonical = source.indexOf('secret-tool lookup service whatsoup-health-token user "$INSTANCE"');
    const legacy = source.indexOf('secret-tool lookup service whatsoup_health');
    expect(canonical).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(-1);
    expect(canonical).toBeLessThan(legacy);
    expect(source).not.toContain('echo "$TOKEN"');
  });

  it('heal-notify uses portable grep and configurable alert binary', () => {
    const source = fs.readFileSync('deploy/scripts/heal-notify.sh', 'utf8');

    expect(source).toContain('grep -oE');
    expect(source).not.toContain('grep -oP');
    expect(source).toContain('WHATSOUP_ALERT_BIN');
    expect(source).toContain('exec "$ALERT_BIN"');
  });
});
