/**
 * Regression: child processes spawned by the fleet server must resolve their
 * script paths against the repo root, not `process.cwd()`. Under systemd the
 * unit file ships with no `WorkingDirectory=`, so `process.cwd()` is the
 * service user's `$HOME` and relative `src/bootstrap*.ts` strings ENOENT (#419).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { repoRoot } from '../../src/fleet/paths.ts';

const spawnMock = vi.fn();

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

// Import platform AFTER the mock is in scope so DockerSupervisorServiceManager
// sees the mocked spawn.
const { DockerSupervisorServiceManager } = await import('../../src/fleet/platform.ts');

const REL_BOOTSTRAP_AUTH = 'src/bootstrap-auth.ts';

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  child.kill = vi.fn();
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

describe('fleet spawn argv uses absolute repo-root paths (#419)', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    spawnMock.mockReset();
  });

  it('repoRoot is absolute and points at the WhatSoup checkout', () => {
    expect(path.isAbsolute(repoRoot)).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'src', 'bootstrap.ts'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'src', 'bootstrap-auth.ts'))).toBe(true);
  });

  it('DockerSupervisorServiceManager.start spawns bootstrap.ts with an absolute path under repoRoot', async () => {
    process.chdir('/tmp');
    spawnMock.mockImplementation(() => makeFakeChild());

    const mgr = new DockerSupervisorServiceManager();
    await mgr.start('test-instance');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = spawnMock.mock.calls[0]!;
    const argv = call[1] as ReadonlyArray<string>;

    const scriptArg = argv.find((a) => a.endsWith('bootstrap.ts'));
    expect(scriptArg).toBeTruthy();
    expect(path.isAbsolute(scriptArg!)).toBe(true);
    expect(scriptArg).toBe(path.join(repoRoot, 'src', 'bootstrap.ts'));

    const opts = call[2] as { cwd?: string } | undefined;
    const effectiveCwd = opts?.cwd ?? repoRoot;
    expect(effectiveCwd).toBe(repoRoot);
  });

  it('ops.ts handleAuth uses path.join(repoRoot, ...) for bootstrap-auth.ts', () => {
    const opsPath = path.join(repoRoot, 'src', 'fleet', 'routes', 'ops.ts');
    const source = fs.readFileSync(opsPath, 'utf-8');
    const relativeOccurrences = source.includes(`'${REL_BOOTSTRAP_AUTH}'`)
      || source.includes(`"${REL_BOOTSTRAP_AUTH}"`);
    expect(relativeOccurrences).toBe(false);
    expect(source.includes('path.join(repoRoot')).toBe(true);
    expect(source.includes('bootstrap-auth.ts')).toBe(true);
  });
});
