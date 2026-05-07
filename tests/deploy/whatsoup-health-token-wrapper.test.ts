import { afterEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
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
