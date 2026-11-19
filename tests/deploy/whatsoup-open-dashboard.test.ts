import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(process.cwd(), 'deploy/scripts/whatsoup-open-dashboard');
const UNLOCK_SCRIPT = join(process.cwd(), 'deploy/scripts/whatsoup-console-unlock');
let dir: string;

function executable(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o700);
  return file;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whatsoup-open-dashboard-'));
});

describe('whatsoup-console-unlock', () => {
  // The helper reads the token file itself (tests/deploy/whatsoup-console-unlock.test.ts);
  // the wrapper must neither look the token up nor hand it over.
  it('starts the helper without a keychain lookup and without a token in argv or the environment', () => {
    const token = 'a'.repeat(64);
    const configDir = join(dir, '.config', 'whatsoup');
    const binDir = join(dir, 'bin');
    const localBin = join(dir, '.local', 'bin');
    const log = join(dir, 'unlock.log');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    mkdirSync(localBin, { recursive: true });
    writeFileSync(join(configDir, 'fleet-tokens.json'), JSON.stringify({ active: token, accept: [], rotatedAt: 'now' }));
    writeFileSync(join(localBin, 'whatsoup-console-unlock.mjs'), '');
    // A keychain that would answer, so any lookup shows up in the log.
    executable('security', `printf 'security %s\\n' "$*" >> ${JSON.stringify(log)}\nprintf '%s\\n' ${JSON.stringify(token)}`);
    executable('curl', 'exit 0');
    executable(
      'node',
      `printf 'node %s token=%s cdp=%s fleet=%s\\n' "$*" "\${WHATSOUP_CONSOLE_TOKEN-unset}" "$CDP_PORT" "$FLEET" >> ${JSON.stringify(log)}`,
    );
    for (const name of ['security', 'curl', 'node']) {
      const source = join(dir, name);
      const target = join(binDir, name);
      writeFileSync(target, readFileSync(source));
      chmodSync(target, 0o700);
    }

    const result = spawnSync('bash', [UNLOCK_SCRIPT], {
      encoding: 'utf8',
      env: { HOME: dir, PATH: `${binDir}:/usr/bin:/bin`, CDP_PORT: '9333', FLEET: 'http://127.0.0.1:9099' },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe(
      `node ${join(localBin, 'whatsoup-console-unlock.mjs')} token=unset cdp=9333 fleet=http://127.0.0.1:9099\n`,
    );
  });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('whatsoup-open-dashboard', () => {
  it('opens a dedicated browser and unlocks it without putting a token in the URL', () => {
    const log = join(dir, 'calls.log');
    const browserReady = join(dir, 'browser-ready');
    const curl = executable(
      'curl',
      `case "$*" in *9099*) exit 0;; esac\n[ -f ${JSON.stringify(browserReady)} ]`,
    );
    const open = executable(
      'open',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}\ntouch ${JSON.stringify(browserReady)}`,
    );
    const unlock = executable(
      'unlock',
      `printf 'fleet=%s cdp=%s\\n' "$FLEET" "$CDP_PORT" >> ${JSON.stringify(log)}`,
    );

    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WHATSOUP_CURL_BIN: curl,
        WHATSOUP_OPEN_BIN: open,
        WHATSOUP_CONSOLE_UNLOCK_BIN: unlock,
        FLEET: 'http://127.0.0.1:9099',
        CDP_PORT: '9333',
      },
    });

    expect(result.status).toBe(0);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('http://127.0.0.1:9099/');
    expect(calls).toContain('fleet=http://127.0.0.1:9099 cdp=9333');
    expect(calls).not.toMatch(/[?&]token=/);
  });

  it('fails closed before opening a browser when the fleet is unavailable', () => {
    const log = join(dir, 'calls.log');
    const curl = executable('curl', 'exit 1');
    const open = executable('open', `printf 'opened\\n' >> ${JSON.stringify(log)}`);
    const unlock = executable('unlock', `printf 'unlocked\\n' >> ${JSON.stringify(log)}`);

    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WHATSOUP_CURL_BIN: curl,
        WHATSOUP_OPEN_BIN: open,
        WHATSOUP_CONSOLE_UNLOCK_BIN: unlock,
        WHATSOUP_DASHBOARD_RETRIES: '1',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fleet not reachable');
  });
});
