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

function extractKeyringLookup(source: string): string {
  const start = source.indexOf('keyring_lookup() {');
  const end = source.indexOf('\n}\n\n# Pinned Node path', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

function extractTmpdirBlock(source: string): string {
  const start = source.indexOf('# Pin process temp files');
  const end = source.indexOf('\n# Detect instance type', start);
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

function runKeyringLookupProbe(
  platform: 'Darwin' | 'Linux',
  scenario: 'canonical-hit' | 'canonical-miss-legacy-hit' = 'canonical-hit',
): { stdout: string; log: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-wrapper-health-token-'));
  tmpDirs.push(tmpDir);
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir);
  const logPath = path.join(tmpDir, 'calls.log');
  const source = fs.readFileSync('deploy/whatsoup', 'utf8');

  writeExecutable(path.join(binDir, 'uname'), `#!/usr/bin/env bash\nprintf '%s\\n' '${platform}'\n`);
  writeExecutable(path.join(binDir, 'security'), `#!/usr/bin/env bash\nprintf 'security %s\\n' "$*" >> "$LOG_PATH"\nif [ "$SCENARIO" = "canonical-hit" ] && [ "$1" = "find-generic-password" ] && [ "$3" = "whatsoup-health-token" ] && [ "$5" = "mwlab" ]; then\n  printf 'canonical-secret\\n'\n  exit 0\nfi\nif [ "$SCENARIO" = "canonical-miss-legacy-hit" ] && [ "$1" = "find-generic-password" ] && [ "$3" = "whatsoup_health" ]; then\n  printf 'legacy-keyring-token\\n'\n  exit 0\nfi\nexit 1\n`);
  writeExecutable(path.join(binDir, 'timeout'), `#!/usr/bin/env bash\nprintf 'timeout %s\\n' "$*" >> "$LOG_PATH"\nshift\nexec "$@"\n`);
  writeExecutable(path.join(binDir, 'secret-tool'), `#!/usr/bin/env bash\nprintf 'secret-tool %s\\n' "$*" >> "$LOG_PATH"\nif [ "$SCENARIO" = "canonical-hit" ] && [ "$1" = "lookup" ] && [ "$3" = "whatsoup-health-token" ] && [ "$4" = "user" ] && [ "$5" = "mwlab" ]; then\n  printf 'canonical-secret\\n'\n  exit 0\nfi\nif [ "$SCENARIO" = "canonical-miss-legacy-hit" ] && [ "$1" = "lookup" ] && [ "$3" = "whatsoup_health" ]; then\n  printf 'legacy-keyring-token\\n'\n  exit 0\nfi\nexit 1\n`);

  const scriptPath = path.join(tmpDir, 'probe.sh');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\nPATH="${binDir}:$PATH"\nexport LOG_PATH="${logPath}"\nexport SCENARIO="${scenario}"\nUSER=local-user\nWHATSOUP_HEALTH_TOKEN=shared-env-token\n${extractKeyringLookup(source)}\nTOKEN="$(keyring_lookup whatsoup-health-token "" user mwlab)"\nif [ -z "$TOKEN" ]; then\n  TOKEN="$(keyring_lookup whatsoup_health WHATSOUP_HEALTH_TOKEN)"\nfi\nprintf '%s\\n' "$TOKEN"\n`, 'utf8');
  fs.chmodSync(scriptPath, 0o700);

  const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
  const log = fs.readFileSync(logPath, 'utf8');
  return { stdout, log };
}

function runVersionExposureProbe(scenario: 'main' | 'detached' | 'non-git' | 'git-error'): {
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
  "non-git:rev-parse --is-inside-work-tree")
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
  it('deploy/whatsoup checks canonical health token before legacy fallback', () => {
    const source = fs.readFileSync('deploy/whatsoup', 'utf8');
    const canonical = source.indexOf('keyring_lookup whatsoup-health-token "" user "$INSTANCE"');
    const legacy = source.indexOf('keyring_lookup whatsoup_health WHATSOUP_HEALTH_TOKEN');
    expect(canonical).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(-1);
    expect(canonical).toBeLessThan(legacy);
    expect(source).not.toContain('echo "$WHATSOUP_HEALTH_TOKEN"');
  });

  it('deploy/whatsoup uses the instance account for scoped macOS lookup before shared env fallback', () => {
    const { stdout, log } = runKeyringLookupProbe('Darwin');

    expect(stdout).toBe('canonical-secret');
    expect(log).toContain('security find-generic-password -s whatsoup-health-token -a mwlab -w');
    expect(log).not.toContain('-a local-user');
  });

  it('deploy/whatsoup uses the instance secret-tool attributes before shared env fallback', () => {
    const { stdout, log } = runKeyringLookupProbe('Linux');

    expect(stdout).toBe('canonical-secret');
    expect(log).toContain('timeout 3s secret-tool lookup service whatsoup-health-token user mwlab');
    expect(log).toContain('secret-tool lookup service whatsoup-health-token user mwlab');
    expect(stdout).not.toBe('shared-env-token');
  });

  it('deploy/whatsoup checks legacy keyring before shared env after scoped canonical miss', () => {
    const { stdout, log } = runKeyringLookupProbe('Linux', 'canonical-miss-legacy-hit');

    expect(stdout).toBe('legacy-keyring-token');
    expect(log).toContain('timeout 3s secret-tool lookup service whatsoup-health-token user mwlab');
    expect(log).toContain('timeout 3s secret-tool lookup service whatsoup_health');
    expect(log).toContain('secret-tool lookup service whatsoup-health-token user mwlab');
    expect(log).toContain('secret-tool lookup service whatsoup_health');
    expect(stdout).not.toBe('shared-env-token');
  });

  it('deploy/whatsoup prefers an already-loaded WHATSOUP_HEALTH_TOKEN over keyring lookups', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-wrapper-env-first-'));
    tmpDirs.push(tmpDir);
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    const logPath = path.join(tmpDir, 'calls.log');
    const source = fs.readFileSync('deploy/whatsoup', 'utf8');

    writeExecutable(path.join(binDir, 'uname'), `#!/usr/bin/env bash\nprintf '%s\\n' 'Linux'\n`);
    writeExecutable(path.join(binDir, 'security'), `#!/usr/bin/env bash\nprintf 'security %s\\n' "$*" >> "$LOG_PATH"\nexit 1\n`);
    writeExecutable(path.join(binDir, 'secret-tool'), `#!/usr/bin/env bash\nprintf 'secret-tool %s\\n' "$*" >> "$LOG_PATH"\nexit 1\n`);
    writeExecutable(path.join(binDir, 'timeout'), `#!/usr/bin/env bash\nprintf 'timeout %s\\n' "$*" >> "$LOG_PATH"\nshift\nexec "$@"\n`);

    const start = source.indexOf('# Health server auth token');
    const end = source.indexOf('exec "$NODE"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);

    const scriptPath = path.join(tmpDir, 'probe-env-first.sh');
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\nset -euo pipefail\nPATH="${binDir}:$PATH"\nexport LOG_PATH="${logPath}"\nINSTANCE=mwlab\nWHATSOUP_HEALTH_TOKEN=preloaded-token\n${extractKeyringLookup(source)}\n${block}\nprintf '%s\\n' "$WHATSOUP_HEALTH_TOKEN"\n`,
      'utf8',
    );
    fs.chmodSync(scriptPath, 0o700);

    const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';

    expect(stdout).toBe('preloaded-token');
    expect(log).not.toContain('secret-tool lookup');
    expect(log).not.toContain('security find-generic-password');
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
