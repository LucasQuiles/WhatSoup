import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { writeKeychainFixture } from './keychain-security-preload-fixture.ts';

const repoRoot = path.resolve('.');
const helperPath = path.join(repoRoot, 'deploy/lib/read-keychain-secret.mjs');
const checkerPath = path.join(repoRoot, 'deploy/check-keyring-presence.sh');
const SPAWN_TIMEOUT_MS = 5_000;
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'whatsoup-keyring-presence-'));
  roots.push(root);
  return root;
}

function writeExecutable(filePath: string, body: string): void {
  writeFileSync(filePath, body, { mode: 0o700 });
  chmodSync(filePath, 0o700);
}

function withoutUser(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.USER;
  return env;
}

type KeychainProbeRecord = {
  phase: 'ready' | 'exec';
  fixturePath?: string;
  command?: string;
  args?: string[];
  childPath?: string | null;
  childHome?: string | null;
  childHasSentinel?: boolean;
  timeout?: number | null;
  killSignal?: string | null;
  maxBuffer?: number | null;
  stdio?: unknown;
};

function readKeychainProbeRecords(logPath: string): KeychainProbeRecord[] {
  return readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as KeychainProbeRecord);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('deploy keyring probes without USER', () => {
  it('binds a direct macOS helper lookup to trusted PATH without ambient child environment', () => {
    const root = makeRoot();
    const log = path.join(root, 'keychain-probe.jsonl');
    const fixture = writeKeychainFixture(root);
    const account = os.userInfo().username;
    const sentinel = 'ambient-child-env-sentinel';

    const result = spawnSync(fixture.node, [helperPath, 'openai', ''], {
      encoding: 'utf8',
      env: withoutUser({
        HOME: root,
        PATH: path.join(root, 'untrusted-bin') + ':' + (process.env.PATH ?? '/usr/bin:/bin'),
        WHATSOUP_TEST_KEYCHAIN_CHILD_ENV_SENTINEL: sentinel,
        WHATSOUP_TEST_KEYCHAIN_PROBE_ARMED: '1',
        WHATSOUP_TEST_KEYCHAIN_PROBE_LOG: log,
        WHATSOUP_TEST_KEYCHAIN_SECURITY_FIXTURE: fixture.securityFixture,
        WHATSOUP_TEST_KEYCHAIN_PROBE_RESPONSES: JSON.stringify({ ['openai\u0000' + account]: 'synthetic-value\n' }),
      }),
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('synthetic-value\n');
    const records = readKeychainProbeRecords(log);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ phase: 'ready', fixturePath: fixture.securityFixture });
    expect(records[1]?.childPath).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
    expect(records[1]?.childHome).toBe(root);
    expect(records[1]?.childHasSentinel).toBe(false);
    expect(records[1]).toMatchObject({
      phase: 'exec',
      command: 'security',
      args: ['find-generic-password', '-s', 'openai', '-a', account, '-w'],
      timeout: 3_000,
      killSignal: 'SIGKILL',
      maxBuffer: 4_096,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  });

  it('fails before the helper when the test preload is missing', () => {
    const root = makeRoot();
    const log = path.join(root, 'keychain-probe.jsonl');
    const fixture = writeKeychainFixture(root);
    const result = spawnSync(process.execPath, [
      '--import', pathToFileURL(path.join(root, 'missing-preload.mjs')).href,
      helperPath, 'openai', os.userInfo().username,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WHATSOUP_TEST_KEYCHAIN_PROBE_ARMED: '1',
        WHATSOUP_TEST_KEYCHAIN_PROBE_LOG: log,
        WHATSOUP_TEST_KEYCHAIN_SECURITY_FIXTURE: fixture.securityFixture,
        WHATSOUP_TEST_KEYCHAIN_PROBE_RESPONSES: '{}',
      },
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND');
    expect(existsSync(log)).toBe(false);
  });


  it('fails before the helper when the test preload is malformed', () => {
    const root = makeRoot();
    const log = path.join(root, 'keychain-probe.jsonl');
    const fixture = writeKeychainFixture(root);
    const malformed = path.join(root, 'malformed-preload.mjs');
    writeFileSync(malformed, 'this is not JavaScript', { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      '--import', pathToFileURL(malformed).href,
      helperPath, 'openai', os.userInfo().username,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WHATSOUP_TEST_KEYCHAIN_PROBE_ARMED: '1',
        WHATSOUP_TEST_KEYCHAIN_PROBE_LOG: log,
        WHATSOUP_TEST_KEYCHAIN_SECURITY_FIXTURE: fixture.securityFixture,
        WHATSOUP_TEST_KEYCHAIN_PROBE_RESPONSES: '{}',
      },
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SyntaxError');
    expect(existsSync(log)).toBe(false);
  });

  it('rejects an unexpected executable without starting the synthetic security fixture', () => {
    const root = makeRoot();
    const log = path.join(root, 'keychain-probe.jsonl');
    const fixture = writeKeychainFixture(root);
    const probe = path.join(root, 'unexpected-command.mjs');
    writeFileSync(probe, "import { execFileSync } from 'node:child_process'; execFileSync('unexpected-command');", { mode: 0o600 });
    const result = spawnSync(fixture.node, [probe], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WHATSOUP_TEST_KEYCHAIN_PROBE_ARMED: '1',
        WHATSOUP_TEST_KEYCHAIN_PROBE_LOG: log,
        WHATSOUP_TEST_KEYCHAIN_SECURITY_FIXTURE: fixture.securityFixture,
        WHATSOUP_TEST_KEYCHAIN_PROBE_RESPONSES: '{}',
      },
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unexpected synthetic child command');
    expect(readKeychainProbeRecords(log)).toEqual([
      expect.objectContaining({ phase: 'ready', fixturePath: fixture.securityFixture }),
    ]);
  });

  it('refuses an unmapped helper service and account before synthetic execution', () => {
    const root = makeRoot();
    const log = path.join(root, 'keychain-probe.jsonl');
    const fixture = writeKeychainFixture(root);
    const result = spawnSync(fixture.node, [helperPath, 'unmapped-service', 'unmapped-account'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WHATSOUP_TEST_KEYCHAIN_PROBE_ARMED: '1',
        WHATSOUP_TEST_KEYCHAIN_PROBE_LOG: log,
        WHATSOUP_TEST_KEYCHAIN_SECURITY_FIXTURE: fixture.securityFixture,
        WHATSOUP_TEST_KEYCHAIN_PROBE_RESPONSES: '{}',
      },
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(readKeychainProbeRecords(log)).toEqual([
      expect.objectContaining({ phase: 'ready', fixturePath: fixture.securityFixture }),
    ]);
  });

  it('runs the actual presence checker without USER and keeps returned values off stdout', () => {
    const root = makeRoot();
    const bin = path.join(root, 'bin');
    const calls = path.join(root, 'helper-calls.log');
    const nvmrc = readFileSync(path.join(repoRoot, '.nvmrc'), 'utf8').trim();
    const major = nvmrc.split('.')[0];
    const engine = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).engines.node as string;
    const upper = /<\s*(\d+)/.exec(engine)?.[1];
    expect(upper).toMatch(/^\d+$/);
    mkdirSync(bin);
    writeExecutable(path.join(bin, 'uname'), `#!/usr/bin/env bash\nprintf 'Darwin\n'\n`);
    const fakeNode = path.join(bin, 'node');
    writeExecutable(
      fakeNode,
      [
        '#!/usr/bin/env bash',
        'case "$1" in',
        `  -e) printf '%s' ${JSON.stringify(upper)} ;;`,
        `  -p) printf '%s' ${JSON.stringify(major)} ;;`,
        `  --version) printf 'v%s\\n' ${JSON.stringify(nvmrc)} ;;`,
        `  ${JSON.stringify(helperPath)})`,
        `    printf 'service=%s account=<%s>\\n' "\${2:-}" "\${3-}" >> ${JSON.stringify(calls)}`,
        `    printf 'synthetic-value\\n'`,
        '    ;;',
        '  *) exit 64 ;;',
        'esac',
        '',
      ].join('\n'),
    );

    const result = spawnSync('/bin/bash', [checkerPath], {
      encoding: 'utf8',
      env: withoutUser({
        HOME: root,
        PATH: `${bin}:/usr/bin:/bin`,
        WHATSOUP_NODE: fakeNode,
      }),
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('✓ anthropic — present in keyring');
    expect(result.stdout).toContain('✓ openai — present in keyring');
    expect(result.stdout).toContain('✓ pinecone — present in keyring');
    expect(result.stdout).not.toContain('synthetic-value');
    expect(readFileSync(calls, 'utf8')).toBe(
      'service=anthropic account=<>\nservice=openai account=<>\nservice=pinecone account=<>\n',
    );
  });
});
