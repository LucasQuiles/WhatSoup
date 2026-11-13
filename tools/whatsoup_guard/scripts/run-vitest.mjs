#!/usr/bin/env node
import { mkdtempSync, rmSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';

function writableDir(path) {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function baseTmpDir() {
  if (process.env.WHATSOUP_GUARD_TEST_TMPDIR && writableDir(process.env.WHATSOUP_GUARD_TEST_TMPDIR)) {
    return process.env.WHATSOUP_GUARD_TEST_TMPDIR;
  }
  if (process.platform === 'linux' && writableDir('/dev/shm')) return '/dev/shm';
  const inherited = tmpdir();
  // Darwin limits Unix-socket paths to 103 bytes, including tsx's child path.
  if (process.platform === 'darwin'
      && Buffer.byteLength(join(inherited, 'wg-XXXXXX', 'tsx-4294967295', '2147483647.pipe')) > 103
      && writableDir('/private/tmp')) return '/private/tmp';
  return inherited;
}

// Leave room for tsx's IPC socket beneath an enclosing test runner's TMPDIR.
const testTmpDir = mkdtempSync(join(baseTmpDir(), 'wg-'));
const binDir = join(process.cwd(), 'node_modules', '.bin');
const vitestBin = join(binDir, process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
const args = ['run', '--pool=forks', '--fileParallelism=false', ...process.argv.slice(2)];

try {
  const result = spawnSync(vitestBin, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      TMPDIR: testTmpDir,
      TMP: testTmpDir,
      TEMP: testTmpDir,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(testTmpDir, { recursive: true, force: true });
}
