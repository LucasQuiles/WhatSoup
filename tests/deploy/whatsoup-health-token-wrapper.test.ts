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
  const helperStart = source.indexOf('macos_keychain_lookup() {');
  const keyringStart = source.indexOf('keyring_lookup() {');
  const start = helperStart >= 0 ? helperStart : keyringStart;
  const end = source.indexOf('\n}\n\n# Pinned Node path', start);
  expect(keyringStart).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

function extractHealthTokenFileReader(source: string): string {
  expect(source).toContain('. "$SCRIPT_DIR/lib/read-private-health-token.sh"');
  return fs.readFileSync('deploy/lib/read-private-health-token.sh', 'utf8');
}

function extractHealthTokenBlock(source: string): string {
  const start = source.indexOf('# Health server auth token');
  const end = source.indexOf('\nexec "$NODE"', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
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
  writeExecutable(path.join(binDir, 'security'), `#!/usr/bin/env bash\nprintf 'security %s\\n' "$*" >> "$LOG_PATH"\nif [ "$SCENARIO" = "canonical-hit" ] && [ "$1" = "find-generic-password" ] && [ "$3" = "whatsoup-health-token" ] && [ "$5" = "test-instance" ]; then\n  printf 'canonical-secret\\n'\n  exit 0\nfi\nif [ "$SCENARIO" = "canonical-miss-legacy-hit" ] && [ "$1" = "find-generic-password" ] && [ "$3" = "whatsoup_health" ]; then\n  printf 'legacy-keyring-token\\n'\n  exit 0\nfi\nexit 1\n`);
  writeExecutable(path.join(binDir, 'timeout'), `#!/usr/bin/env bash\nprintf 'timeout %s\\n' "$*" >> "$LOG_PATH"\nshift\nexec "$@"\n`);
  writeExecutable(path.join(binDir, 'secret-tool'), `#!/usr/bin/env bash\nprintf 'secret-tool %s\\n' "$*" >> "$LOG_PATH"\nif [ "$SCENARIO" = "canonical-hit" ] && [ "$1" = "lookup" ] && [ "$3" = "whatsoup-health-token" ] && [ "$4" = "user" ] && [ "$5" = "test-instance" ]; then\n  printf 'canonical-secret\\n'\n  exit 0\nfi\nif [ "$SCENARIO" = "canonical-miss-legacy-hit" ] && [ "$1" = "lookup" ] && [ "$3" = "whatsoup_health" ]; then\n  printf 'legacy-keyring-token\\n'\n  exit 0\nfi\nexit 1\n`);

  const scriptPath = path.join(tmpDir, 'probe.sh');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\nPATH="${binDir}:$PATH"\nexport LOG_PATH="${logPath}"\nexport SCENARIO="${scenario}"\nUSER=local-user\nNODE="${process.execPath}"\nSCRIPT_DIR="${path.resolve('deploy')}"\nWHATSOUP_HEALTH_TOKEN=shared-env-token\n${extractKeyringLookup(source)}\nTOKEN="$(keyring_lookup whatsoup-health-token "" user test-instance)"\nif [ -z "$TOKEN" ]; then\n  TOKEN="$(keyring_lookup whatsoup_health WHATSOUP_HEALTH_TOKEN)"\nfi\nprintf '%s\\n' "$TOKEN"\n`, 'utf8');
  fs.chmodSync(scriptPath, 0o700);

  const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
  const log = fs.readFileSync(logPath, 'utf8');
  return { stdout, log };
}

type HealthTokenFileScenario =
  | 'safe-file'
  | 'keyring-hit'
  | 'keyring-only'
  | 'preloaded-env'
  | 'keyring-hang'
  | 'legacy-hit'
  | 'missing-file'
  | 'bad-mode'
  | 'special-file-mode'
  | 'bad-dir-mode'
  | 'special-dir-mode'
  | 'bad-dir-owner'
  | 'dir-symlink'
  | 'symlink'
  | 'race-symlink-swap'
  | 'malformed'
  | 'duplicate';

function runHealthTokenFileProbe(
  platform: 'Darwin' | 'Linux',
  scenario: HealthTokenFileScenario,
): { status: number | null; stdout: string; stderr: string; log: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-wrapper-health-token-file-'));
  tmpDirs.push(tmpDir);
  const binDir = path.join(tmpDir, 'bin');
  const homeDir = path.join(tmpDir, 'home');
  const instanceDir = path.join(homeDir, '.config', 'whatsoup', 'instances', 'fixture-bot');
  const tokenPath = path.join(instanceDir, 'tokens.env');
  const raceTargetPath = path.join(tmpDir, 'race-target.env');
  const logPath = path.join(tmpDir, 'calls.log');
  fs.mkdirSync(binDir);
  fs.mkdirSync(path.dirname(instanceDir), { recursive: true, mode: 0o700 });
  if (scenario === 'dir-symlink') {
    const targetDir = path.join(tmpDir, 'instance-target');
    fs.mkdirSync(targetDir, { mode: 0o700 });
    fs.symlinkSync(targetDir, instanceDir);
  } else {
    fs.mkdirSync(instanceDir, { mode: 0o700 });
  }

  const token = 'a'.repeat(64);
  if (scenario === 'symlink') {
    const targetPath = path.join(tmpDir, 'token-target');
    fs.writeFileSync(targetPath, `WHATSOUP_HEALTH_TOKEN=${token}\n`, { mode: 0o600 });
    fs.symlinkSync(targetPath, tokenPath);
  } else if (
    scenario !== 'missing-file'
    && scenario !== 'keyring-only'
    && scenario !== 'keyring-hang'
  ) {
    const contents = scenario === 'malformed'
      ? 'WHATSOUP_HEALTH_TOKEN=not-a-canonical-token\n'
      : scenario === 'duplicate'
        ? `WHATSOUP_HEALTH_TOKEN=${token}\nWHATSOUP_HEALTH_TOKEN=${'b'.repeat(64)}\n`
        : `WHATSOUP_HEALTH_TOKEN=${token}\n`;
    fs.writeFileSync(tokenPath, contents, { mode: 0o600 });
  }
  if (scenario === 'race-symlink-swap') {
    fs.writeFileSync(
      raceTargetPath,
      `WHATSOUP_HEALTH_TOKEN=${'b'.repeat(64)}\n`,
      { mode: 0o600 },
    );
  }
  if (scenario === 'bad-mode') fs.chmodSync(tokenPath, 0o644);
  if (scenario === 'special-file-mode') fs.chmodSync(tokenPath, 0o1600);
  if (scenario === 'bad-dir-mode') fs.chmodSync(instanceDir, 0o770);
  if (scenario === 'special-dir-mode') fs.chmodSync(instanceDir, 0o1700);

  writeExecutable(path.join(binDir, 'uname'), `#!/usr/bin/env bash\nprintf '%s\\n' '${platform}'\n`);
  writeExecutable(path.join(binDir, 'security'), `#!/usr/bin/env bash\nprintf 'security %s\\n' "$*" >> "$LOG_PATH"\nif [ "$SCENARIO" = "keyring-hang" ] && [ "\${3:-}" = "whatsoup-health-token" ]; then sleep 30; fi\nif { [ "$SCENARIO" = "keyring-hit" ] || [ "$SCENARIO" = "keyring-only" ]; } && [ "$3" = "whatsoup-health-token" ]; then printf '%s\\n' '${'c'.repeat(64)}'; exit 0; fi\nif [ "$SCENARIO" = "legacy-hit" ] && [ "$3" = "whatsoup_health" ]; then printf '%s\\n' '${'d'.repeat(64)}'; exit 0; fi\nexit 1\n`);
  writeExecutable(path.join(binDir, 'timeout'), `#!/usr/bin/env bash\nprintf 'timeout %s\\n' "$*" >> "$LOG_PATH"\nshift\nexec "$@"\n`);
  writeExecutable(path.join(binDir, 'secret-tool'), `#!/usr/bin/env bash\nprintf 'secret-tool %s\\n' "$*" >> "$LOG_PATH"\nif { [ "$SCENARIO" = "keyring-hit" ] || [ "$SCENARIO" = "keyring-only" ]; } && [ "$3" = "whatsoup-health-token" ]; then printf '%s\\n' '${'c'.repeat(64)}'; exit 0; fi\nif [ "$SCENARIO" = "legacy-hit" ] && [ "$3" = "whatsoup_health" ]; then printf '%s\\n' '${'d'.repeat(64)}'; exit 0; fi\nexit 1\n`);
  writeExecutable(path.join(binDir, 'stat'), `#!/usr/bin/env bash
set -euo pipefail
printf 'stat %s\\n' "$*" >> "$LOG_PATH"
target="\${!#}"
if [ "$SCENARIO" = "bad-dir-owner" ] && [[ "$target" != */tokens.env ]]; then owner=$((TEST_UID + 1));
else owner="$TEST_UID"; fi
if [[ "$target" == */tokens.env ]]; then
  if [ "$SCENARIO" = "bad-mode" ]; then mode=644;
  elif [ "$SCENARIO" = "special-file-mode" ]; then mode=1600;
  else mode=600; fi
else
  if [ "$SCENARIO" = "bad-dir-mode" ]; then mode=770;
  elif [ "$SCENARIO" = "special-dir-mode" ]; then mode=1700;
  else mode=700; fi
fi
case "$1:$2" in
  '-f:%u'|'-c:%u') printf '%s\\n' "$owner" ;;
  '-f:%Lp'|'-c:%a')
    if [ "$SCENARIO" = "race-symlink-swap" ] && [[ "$target" != */tokens.env ]]; then
      rm -f -- "$TOKEN_PATH"
      ln -s -- "$RACE_TARGET_PATH" "$TOKEN_PATH"
    fi
    printf '%s\\n' "$mode"
    ;;
  *) exit 64 ;;
esac
`);

  const source = fs.readFileSync('deploy/whatsoup', 'utf8');
  const scriptPath = path.join(tmpDir, 'probe-health-token-file.sh');
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
set -euo pipefail
PATH="${binDir}:$PATH"
HOME="${homeDir}"
XDG_CONFIG_HOME="$HOME/.config"
XDG_CONFIG="$XDG_CONFIG_HOME"
INSTANCE=fixture-bot
NODE="${process.execPath}"
SCRIPT_DIR="${path.resolve('deploy')}"
WHATSOUP_HEALTH_TOKEN=${scenario === 'preloaded-env' ? 'e'.repeat(64) : ''}
export LOG_PATH="${logPath}"
export SCENARIO="${scenario}"
export TEST_UID="$(id -u)"
export TOKEN_PATH="${tokenPath}"
export RACE_TARGET_PATH="${raceTargetPath}"
${extractKeyringLookup(source)}
${extractHealthTokenFileReader(source)}
${extractHealthTokenBlock(source)}
printf 'resolved=%s\\n' "\${WHATSOUP_HEALTH_TOKEN-}"
`,
    'utf8',
  );
  fs.chmodSync(scriptPath, 0o700);

  const result = spawnSync('/bin/bash', [scriptPath], { encoding: 'utf8', timeout: 5_000 });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    log: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '',
  };
}

function runHealthTokenCheckerProbe(): {
  status: number | null;
  stdout: string;
  stderr: string;
  log: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-health-token-checker-'));
  tmpDirs.push(tmpDir);
  const binDir = path.join(tmpDir, 'bin');
  const configRoot = path.join(tmpDir, 'config');
  const instanceDir = path.join(configRoot, 'whatsoup', 'instances', 'fixture-checker');
  const tokenPath = path.join(instanceDir, 'tokens.env');
  const logPath = path.join(tmpDir, 'calls.log');
  fs.mkdirSync(binDir);
  fs.mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    tokenPath,
    `WHATSOUP_HEALTH_TOKEN=${'a'.repeat(64)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(instanceDir, 0o700);
  fs.chmodSync(tokenPath, 0o600);

  writeExecutable(path.join(binDir, 'uname'), `#!/usr/bin/env bash\nprintf 'Darwin\\n'\n`);
  writeExecutable(path.join(binDir, 'security'), `#!/usr/bin/env bash\nprintf 'security %s\\n' "$*" >> "$LOG_PATH"\nsleep 30\n`);
  writeExecutable(path.join(binDir, 'stat'), `#!/usr/bin/env bash
set -euo pipefail
case "$1:$2" in
  '-f:%u') printf '%s\n' "$(id -u)" ;;
  '-f:%Lp') printf '700\n' ;;
  *) exit 64 ;;
esac
`);
  const pinnedNode = path.join(binDir, 'pinned-node');
  writeExecutable(pinnedNode, `#!/usr/bin/env bash
case "\${1-}" in
  -e) printf '26' ;;
  -p) printf '24' ;;
  --version) printf 'v24.15.0\n' ;;
  *) exec "${process.execPath}" "$@" ;;
esac
`);

  const result = spawnSync(
    '/bin/bash',
    ['deploy/check-health-token-keyring.sh', 'fixture-checker'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        LOG_PATH: logPath,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        WHATSOUP_NODE: pinnedNode,
        XDG_CONFIG_HOME: configRoot,
      },
      timeout: 5_000,
    },
  );

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    log: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '',
  };
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
  it('deploy/whatsoup checks canonical health token before legacy fallback', () => {
    const source = fs.readFileSync('deploy/whatsoup', 'utf8');
    const canonical = source.indexOf('keyring_lookup whatsoup-health-token "" user "$INSTANCE"');
    const legacy = source.indexOf('keyring_lookup whatsoup_health WHATSOUP_HEALTH_TOKEN');
    expect(canonical).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(-1);
    expect(canonical).toBeLessThan(legacy);
    expect(source).not.toContain('echo "$WHATSOUP_HEALTH_TOKEN"');
    expect(source).not.toContain('source "$HEALTH_TOKEN_FILE"');
    expect(source).not.toContain('. "$HEALTH_TOKEN_FILE"');
    expect(extractHealthTokenBlock(source)).not.toContain('eval ');
    const nodeResolution = source.indexOf('if ! NODE="$(whatsoup_resolve_node "$REPO_ROOT")"');
    const readerSource = source.indexOf('. "$SCRIPT_DIR/lib/read-private-health-token.sh"');
    const databaseGate = source.indexOf('DATABASE_BOOTSTRAP_TS=');
    expect(readerSource).toBeGreaterThan(nodeResolution);
    expect(readerSource).toBeLessThan(databaseGate);
  });

  it('deploy/whatsoup uses the instance account for scoped macOS lookup before shared env fallback', () => {
    const { stdout, log } = runKeyringLookupProbe('Darwin');

    expect(stdout).toBe('canonical-secret');
    expect(log).toContain('security find-generic-password -s whatsoup-health-token -a test-instance -w');
    expect(log).not.toContain('-a local-user');
  });

  it('deploy/whatsoup uses the instance secret-tool attributes before shared env fallback', () => {
    const { stdout, log } = runKeyringLookupProbe('Linux');

    expect(stdout).toBe('canonical-secret');
    expect(log).toContain('timeout 3s secret-tool lookup service whatsoup-health-token user test-instance');
    expect(log).toContain('secret-tool lookup service whatsoup-health-token user test-instance');
    expect(stdout).not.toBe('shared-env-token');
  });

  it('deploy/whatsoup checks legacy keyring before shared env after scoped canonical miss', () => {
    const { stdout, log } = runKeyringLookupProbe('Linux', 'canonical-miss-legacy-hit');

    expect(stdout).toBe('legacy-keyring-token');
    expect(log).toContain('timeout 3s secret-tool lookup service whatsoup-health-token user test-instance');
    expect(log).toContain('timeout 3s secret-tool lookup service whatsoup_health');
    expect(log).toContain('secret-tool lookup service whatsoup-health-token user test-instance');
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
      `#!/usr/bin/env bash\nset -euo pipefail\nPATH="${binDir}:$PATH"\nexport LOG_PATH="${logPath}"\nINSTANCE=fixture-bot\nXDG_CONFIG="${tmpDir}/config"\nNODE="${process.execPath}"\nSCRIPT_DIR="${path.resolve('deploy')}"\nWHATSOUP_HEALTH_TOKEN=${'f'.repeat(64)}\n${extractKeyringLookup(source)}\n${extractHealthTokenFileReader(source)}\n${block}\nprintf '%s\\n' "$WHATSOUP_HEALTH_TOKEN"\n`,
      'utf8',
    );
    fs.chmodSync(scriptPath, 0o700);

    const stdout = execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';

    expect(stdout).toBe('f'.repeat(64));
    expect(log).not.toContain('secret-tool lookup');
    expect(log).not.toContain('security find-generic-password');
  });

  it.each(['Darwin', 'Linux'] as const)(
    'deploy/whatsoup loads a canonical private per-instance token file without consulting the %s keyring',
    (platform) => {
      const result = runHealthTokenFileProbe(platform, 'safe-file');

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`resolved=${'a'.repeat(64)}`);
      expect(result.stderr).toBe('');
      expect(result.log).not.toContain('whatsoup-health-token');
      expect(result.log).toContain('stat ');
      expect(result.log).not.toContain('a'.repeat(64));
    },
  );

  it.each(['Darwin', 'Linux'] as const)(
    'deploy/whatsoup keeps a private per-instance file authoritative over the shared %s legacy token',
    (platform) => {
      const result = runHealthTokenFileProbe(platform, 'legacy-hit');

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`resolved=${'a'.repeat(64)}`);
      expect(result.stderr).toBe('');
      expect(result.log).not.toContain('whatsoup_health');
      expect(result.log).not.toContain('d'.repeat(64));
    },
  );

  it.each(['Darwin', 'Linux'] as const)(
    'deploy/whatsoup keeps the private per-instance file authoritative over a stale scoped %s keyring token',
    (platform) => {
      const result = runHealthTokenFileProbe(platform, 'keyring-hit');

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`resolved=${'a'.repeat(64)}`);
      expect(result.stderr).toBe('');
      expect(result.log).not.toContain('whatsoup-health-token');
      expect(result.log).not.toContain('c'.repeat(64));
    },
  );

  it.each(['Darwin', 'Linux'] as const)(
    'deploy/whatsoup keeps an already-loaded %s environment token authoritative over the private file',
    (platform) => {
      const result = runHealthTokenFileProbe(platform, 'preloaded-env');

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`resolved=${'e'.repeat(64)}`);
      expect(result.stderr).toBe('');
      expect(result.log).not.toContain('whatsoup-health-token');
      expect(result.log).not.toContain('stat ');
      expect(`${result.stdout}\n${result.stderr}\n${result.log}`).not.toContain('a'.repeat(64));
    },
  );

  it('bounds a hanging Darwin keychain child under the five-second outer harness', () => {
    const result = runHealthTokenFileProbe('Darwin', 'keyring-hang');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('resolved=');
    expect(result.stderr).toBe('');
    expect(result.log).toContain(
      'security find-generic-password -s whatsoup-health-token -a fixture-bot -w',
    );
  }, 8_000);

  it('bounds a hanging Darwin keychain child in the parity checker', () => {
    const result = runHealthTokenCheckerProbe();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('scoped keyring mirror is missing');
    expect(result.stderr).toBe('');
    expect(result.log.trim()).toBe(
      'security find-generic-password -s whatsoup-health-token -a fixture-checker -w',
    );
    expect(`${result.stdout}\n${result.stderr}\n${result.log}`).not.toContain('a'.repeat(64));
  }, 8_000);

  it('uses one bounded pinned-Node helper for Darwin keychain reads', () => {
    const helper = fs.readFileSync('deploy/lib/read-keychain-secret.mjs', 'utf8');
    const wrapper = fs.readFileSync('deploy/whatsoup', 'utf8');
    const checker = fs.readFileSync('deploy/check-health-token-keyring.sh', 'utf8');

    expect(wrapper).toContain('"$SCRIPT_DIR/lib/read-keychain-secret.mjs"');
    expect(checker).toContain('"$SCRIPT_DIR/lib/read-keychain-secret.mjs"');
    expect(checker).toContain('. "$SCRIPT_DIR/lib/resolve-node.sh"');
    expect(checker).toContain('whatsoup_resolve_node "$REPO_ROOT"');
    expect(checker).not.toContain('command -v node');
    expect(helper).toContain("['find-generic-password', '-s', service, '-a', account, '-w']");
    expect(helper).toContain('timeout: 3_000');
    expect(helper).toContain("killSignal: 'SIGKILL'");
    expect(helper).toContain('maxBuffer: 4_096');
    expect(helper).toContain("stdio: ['ignore', 'pipe', 'ignore']");
  });

  it.each(['Darwin', 'Linux'] as const)(
    'deploy/whatsoup falls back to an instance-scoped %s keyring token when tokens.env is absent',
    (platform) => {
      const result = runHealthTokenFileProbe(platform, 'keyring-only');

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`resolved=${'c'.repeat(64)}`);
      expect(result.stderr).toBe('');
      expect(result.log).toContain('whatsoup-health-token');
      expect(result.log).not.toContain('stat ');
    },
  );

  it('deploy/whatsoup preserves fail-closed request auth when neither keyring nor tokens.env exists', () => {
    const result = runHealthTokenFileProbe('Darwin', 'missing-file');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('resolved=');
    expect(result.stderr).toBe('');
  });

  it.each([
    ['bad-mode', 'mode 0600'],
    ['special-file-mode', 'mode 0600'],
    ['bad-dir-mode', 'must not be group- or world-writable'],
    ['bad-dir-owner', 'directory must be owned by the current uid'],
    ['dir-symlink', 'directory must be a real non-symlink'],
    ['symlink', 'regular non-symlink'],
    ['malformed', 'exactly one canonical'],
    ['duplicate', 'exactly one canonical'],
  ] as const)('deploy/whatsoup rejects an unsafe %s token file without disclosing its value', (scenario, detail) => {
    const result = runHealthTokenFileProbe('Darwin', scenario);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('FATAL:');
    expect(result.stderr).toContain(detail);
    expect(`${result.stdout}\n${result.stderr}\n${result.log}`).not.toContain('a'.repeat(64));
    expect(`${result.stdout}\n${result.stderr}\n${result.log}`).not.toContain('b'.repeat(64));
  });

  it.each(['Darwin', 'Linux'] as const)(
    'deploy/whatsoup accepts a private directory with non-permission special bits on %s',
    (platform) => {
      const result = runHealthTokenFileProbe(platform, 'special-dir-mode');

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`resolved=${'a'.repeat(64)}`);
      expect(result.stderr).toBe('');
    },
  );

  it.each(['Darwin', 'Linux'] as const)(
    'deploy/whatsoup rejects a deterministic metadata-to-symlink swap on %s',
    (platform) => {
      const result = runHealthTokenFileProbe(platform, 'race-symlink-swap');

      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('FATAL:');
      expect(result.stderr).not.toContain('tokens.env');
      expect(`${result.stdout}\n${result.stderr}\n${result.log}`).not.toContain('a'.repeat(64));
      expect(`${result.stdout}\n${result.stderr}\n${result.log}`).not.toContain('b'.repeat(64));
    },
  );

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
