import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('deploy keyring probes without USER', () => {
  it('uses the OS account for a direct macOS helper lookup with no account argument', () => {
    const root = makeRoot();
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'security.log');
    mkdirSync(bin);
    writeExecutable(
      path.join(bin, 'security'),
      [
        '#!/usr/bin/env bash',
        `printf '%s\\n' "$*" > ${JSON.stringify(log)}`,
        `printf 'synthetic-value\\n'`,
        '',
      ].join('\n'),
    );

    const result = spawnSync(process.execPath, [helperPath, 'openai', ''], {
      encoding: 'utf8',
      env: withoutUser({ PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` }),
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('synthetic-value\n');
    expect(readFileSync(log, 'utf8')).toBe(
      `find-generic-password -s openai -a ${os.userInfo().username} -w\n`,
    );
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
