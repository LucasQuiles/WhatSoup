import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../scripts/run-vitest.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'guard-runner-'));
  roots.push(root);
  const bin = join(root, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'vitest'), `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  return root;
}

describe('guard test runner scratch', () => {
  it('supports tsx IPC beneath a long enclosing TMPDIR and removes its scratch', () => {
    const root = fixture(`
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const scratch = process.env.TMPDIR;
console.log(JSON.stringify({ scratch }));
const ipc = path.join(scratch, 'tsx-' + process.getuid());
fs.mkdirSync(ipc);
const server = net.createServer();
server.once('error', error => { console.error(error); process.exitCode = 1; });
server.listen(path.join(ipc, '2147483647.pipe'), () => server.close());
`);
    const parent = join(root, 'enclosing-runner-with-a-deliberately-long-scratch-directory-name');
    mkdirSync(parent);
    const result = spawnSync(process.execPath, [runner], {
      cwd: root,
      env: { ...process.env, TMPDIR: parent, WHATSOUP_GUARD_TEST_TMPDIR: '' },
      encoding: 'utf8', timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const { scratch } = JSON.parse(result.stdout) as { scratch: string };
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(parent)).toBe(true);
  });

  it('preserves the child failure and cleans only its owned scratch', () => {
    const root = fixture('console.log(JSON.stringify({ scratch: process.env.TMPDIR })); process.exit(23);');
    const result = spawnSync(process.execPath, [runner], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(23);
    const { scratch } = JSON.parse(result.stdout) as { scratch: string };
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });
});
