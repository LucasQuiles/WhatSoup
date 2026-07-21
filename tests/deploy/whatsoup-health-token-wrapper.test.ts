import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, 'utf8');
  fs.chmodSync(filePath, 0o700);
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

  writeExecutable(path.join(binDir, 'uname'), '#!/usr/bin/env bash\nprintf "Darwin\\n"\n');
  writeExecutable(
    path.join(binDir, 'security'),
    '#!/usr/bin/env bash\nprintf "security %s\\n" "$*" >> "$LOG_PATH"\nsleep 30\n',
  );
  writeExecutable(path.join(binDir, 'stat'), `#!/usr/bin/env bash
set -euo pipefail
case "$1:$2" in
  '-f:%u') printf '%s\n' "$(id -u)" ;;
  '-f:%Lp')
    case "${'$'}{!#}" in
      */tokens.env) printf '600\n' ;;
      *) printf '700\n' ;;
    esac
    ;;
  *) exit 64 ;;
esac
`);
  const pinnedNode = path.join(binDir, 'pinned-node');
  writeExecutable(pinnedNode, `#!/usr/bin/env bash
case "${'$'}{1-}" in
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

describe('health token shell tooling', () => {
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

  it('uses a bounded pinned-Node helper for Darwin keychain reads', () => {
    const helper = fs.readFileSync('deploy/lib/read-keychain-secret.mjs', 'utf8');
    const checker = fs.readFileSync('deploy/check-health-token-keyring.sh', 'utf8');

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

  it('keeps the fleet token-file reader descriptor-safe', () => {
    const helper = fs.readFileSync('deploy/lib/read-private-health-token.mjs', 'utf8');
    const reader = fs.readFileSync('src/fleet/health-token-file.ts', 'utf8');

    expect(helper).toContain('readPrivateHealthTokenFileSync');
    expect(reader).toContain('constants.O_NOFOLLOW');
    expect(reader).toContain('fstatSync(fd)');
    expect(reader).toContain('Buffer.alloc(MAX_CANONICAL_FILE_BYTES + 1)');
    expect(reader).toContain('readSync(fd, buffer');
    expect(reader).not.toContain('readFileSync(filePath');
  });

  it('keeps heal-notify canonical-before-legacy and value-silent', () => {
    const source = fs.readFileSync('deploy/scripts/heal-notify.sh', 'utf8');
    const canonical = source.indexOf('secret-tool lookup service whatsoup-health-token user "$INSTANCE"');
    const legacy = source.indexOf('secret-tool lookup service whatsoup_health');

    expect(canonical).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(canonical);
    expect(source).not.toContain('echo "$TOKEN"');
    expect(source).toContain('WHATSOUP_ALERT_BIN');
  });
});
