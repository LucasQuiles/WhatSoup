import { afterEach, describe, expect, it } from 'vitest';
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

function makeHome(): { home: string; instancesDir: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-token-home-'));
  tmpDirs.push(home);
  const instancesDir = path.join(home, '.config', 'whatsoup', 'instances');
  for (const name of ['alpha', 'beta']) {
    const dir = path.join(instancesDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ name, port: 9090 }), 'utf8');
  }
  return { home, instancesDir };
}

function makeFakeBin(platform: 'Linux' | 'Darwin' = 'Linux'): { bin: string; logPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-token-bin-'));
  tmpDirs.push(dir);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const logPath = path.join(dir, 'keyring.log');
  writeExecutable(path.join(bin, 'uname'), `#!/usr/bin/env bash\nprintf '%s\\n' '${platform}'\n`);
  writeExecutable(path.join(bin, 'secret-tool'), [
    '#!/usr/bin/env bash',
    'cat >/dev/null',
    'printf "secret-tool %s\\n" "$*" >> "$LOG_PATH"',
    'exit 0',
    '',
  ].join('\n'));
  writeExecutable(path.join(bin, 'security'), [
    '#!/usr/bin/env bash',
    'printf "security %s\\n" "$*" >> "$LOG_PATH"',
    'exit 0',
    '',
  ].join('\n'));
  return { bin, logPath };
}

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, 'utf8');
  fs.chmodSync(filePath, 0o700);
}

function runGenerator(home: string, fakeBin: string, args: string[] = [], logPath?: string): string {
  return execFileSync('bash', ['deploy/generate-health-tokens.sh', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      LOG_PATH: logPath ?? path.join(home, 'keyring.log'),
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    },
  });
}

function tokenFile(home: string, instance: string): string {
  return path.join(home, '.config', 'whatsoup', 'instances', instance, 'tokens.env');
}

function readToken(home: string, instance: string): string {
  const raw = fs.readFileSync(tokenFile(home, instance), 'utf8').trim();
  expect(raw).toMatch(/^WHATSOUP_HEALTH_TOKEN=[a-f0-9]{64}$/);
  return raw.split('=')[1];
}

describe('generate-health-tokens.sh', () => {
  it('writes per-instance tokens.env files by default without invoking a keyring', () => {
    const { home } = makeHome();
    const { bin, logPath } = makeFakeBin();

    const output = runGenerator(home, bin, [], logPath);

    expect(output).toContain('[alpha] token generated');
    expect(output).toContain('[beta] token generated');
    expect(output).toContain('Done: 2 generated, 0 skipped');
    for (const name of ['alpha', 'beta']) {
      readToken(home, name);
      expect((fs.statSync(tokenFile(home, name)).mode & 0o777).toString(8)).toBe('600');
    }
    expect(fs.readFileSync('deploy/whatsoup@.service', 'utf8')).not.toContain(
      'EnvironmentFile=-%h/.config/whatsoup/instances/%i/tokens.env',
    );
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('preserves existing tokens unless --rotate is passed', () => {
    const { home } = makeHome();
    const { bin, logPath } = makeFakeBin();
    const existing = 'WHATSOUP_HEALTH_TOKEN=existing-token\n';
    fs.writeFileSync(tokenFile(home, 'alpha'), existing, { mode: 0o600 });

    runGenerator(home, bin, [], logPath);
    expect(fs.readFileSync(tokenFile(home, 'alpha'), 'utf8')).toBe(existing);

    runGenerator(home, bin, ['--rotate'], logPath);
    expect(fs.readFileSync(tokenFile(home, 'alpha'), 'utf8')).not.toBe(existing);
    readToken(home, 'alpha');
  });

  it('mirrors to keyring only when --mirror-keyring is passed', () => {
    const { home } = makeHome();
    const { bin, logPath } = makeFakeBin('Linux');

    runGenerator(home, bin, ['--mirror-keyring'], logPath);

    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('secret-tool store --label WhatSoup Health Token (alpha) service whatsoup-health-token user alpha');
    expect(log).toContain('secret-tool store --label WhatSoup Health Token (beta) service whatsoup-health-token user beta');
    expect(log).not.toContain(readToken(home, 'alpha'));
    expect(log).not.toContain(readToken(home, 'beta'));
  });

  it('keeps mirrored macOS tokens off the security command argv', () => {
    const { home } = makeHome();
    const { bin, logPath } = makeFakeBin('Darwin');

    runGenerator(home, bin, ['--mirror-keyring'], logPath);

    const log = fs.readFileSync(logPath, 'utf8');
    expect(log).toContain('security add-generic-password -U -s whatsoup-health-token -a alpha -w');
    expect(log).toContain('security add-generic-password -U -s whatsoup-health-token -a beta -w');
    expect(log).not.toContain(readToken(home, 'alpha'));
    expect(log).not.toContain(readToken(home, 'beta'));
  });
});
