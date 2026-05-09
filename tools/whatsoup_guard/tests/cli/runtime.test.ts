import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, '../..');
const TSX_BIN = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
const TSX_RUNNER = join(PACKAGE_ROOT, 'node_modules', '.bin', TSX_BIN);
const CLI_PATH = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));

function runGuardCli(args: string[]) {
  return spawnSync(TSX_RUNNER, [CLI_PATH, ...args], { encoding: 'utf8' });
}

describe('cli runtime', () => {
  it('runs through package-local tsx for ping', () => {
    const result = runGuardCli(['ping']);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('pong v1\n');
    expect(result.stderr).toBe('');
  });

  it('returns usage through package-local tsx for unknown commands', () => {
    const result = runGuardCli(['no-such-command']);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('unknown command: no-such-command');
    expect(result.stdout).toContain('usage: whatsoup-guard <ping|cycle|mute|status|simulate|watchdog>');
    expect(result.stderr).toBe('');
  });
});
