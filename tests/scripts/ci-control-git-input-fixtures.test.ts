import type { ExecFileSyncOptions } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

type FixtureModule = typeof import('./support/ci-control-git-input-fixtures.ts');

interface CapturedSpawn {
  file: string;
  args: string[];
  options: ExecFileSyncOptions & { input?: unknown };
}

const FIXTURE_ROOT = '/nonexistent-fixture-root';

// #3561: a fixture git sat for 26 minutes inside a release gate. A synchronous
// spawn blocks the worker's event loop, so vitest's testTimeout never fires;
// these cases pin the spawn bound and the diagnostic instead of reproducing
// the hang. The spawn is mocked, so nothing here can block.
async function withMockedFixtureSpawn(
  execute: (file: string, args: string[], options: CapturedSpawn['options']) => string,
  run: (fixtures: FixtureModule) => void,
): Promise<void> {
  vi.resetModules();
  vi.doMock('node:child_process', () => ({ execFileSync: execute }));
  try {
    const fixtures = await import('./support/ci-control-git-input-fixtures.ts');
    try {
      run(fixtures);
    } finally {
      fixtures.cleanupTemporaryRoots();
    }
  } finally {
    vi.doUnmock('node:child_process');
    vi.resetModules();
  }
}

async function captureFixtureSpawns(run: (fixtures: FixtureModule) => void): Promise<CapturedSpawn[]> {
  const captured: CapturedSpawn[] = [];
  await withMockedFixtureSpawn((file, args, options) => {
    captured.push({ file, args, options });
    return '';
  }, run);
  return captured;
}

function expectBoundedSpawn(spawn: CapturedSpawn): void {
  expect(spawn.file).toBe('git');
  expect(spawn.options).toMatchObject({
    timeout: expect.any(Number),
    killSignal: 'SIGKILL',
  });
  expect(spawn.options.timeout).toBeGreaterThan(0);
  expect(spawn.options.timeout).toBeLessThanOrEqual(60_000);
}

function syntheticKill(overrides: Record<string, unknown>): Error {
  return Object.assign(new Error('spawnSync git ETIMEDOUT'), {
    code: 'ETIMEDOUT',
    signal: 'SIGKILL',
    stderr: `fatal: synthetic partial stderr\n${'x'.repeat(8_192)}`,
    ...overrides,
  });
}

async function killMessage(
  failure: Error,
  run: (fixtures: FixtureModule) => void,
): Promise<string> {
  let thrown: unknown;
  await withMockedFixtureSpawn(() => {
    throw failure;
  }, (fixtures) => {
    try {
      run(fixtures);
    } catch (error) {
      thrown = error;
    }
  });
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBe(failure);
  return (thrown as Error).message;
}

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.resetModules();
});

describe('ci-control git fixture spawns', () => {
  it('bounds the plain fixture git spawn with a SIGKILL timeout and an ignored stdin', async () => {
    const spawns = await captureFixtureSpawns(({ git }) => {
      git(FIXTURE_ROOT, ['rev-parse', 'HEAD']);
    });
    expect(spawns).toHaveLength(1);
    expectBoundedSpawn(spawns[0]!);
    expect(spawns[0]!.options.stdio?.[0]).toBe('ignore');
  }, 5_000);

  it('bounds the stdin-fed fixture git spawn and still passes its input', async () => {
    const input = Buffer.from('fixture\n');
    const spawns = await captureFixtureSpawns(({ hashBlob }) => {
      hashBlob(FIXTURE_ROOT, input);
    });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.args).toEqual(['hash-object', '-w', '--stdin']);
    expectBoundedSpawn(spawns[0]!);
    expect(spawns[0]!.options.input).toBe(input);
  }, 5_000);

  it('reports the args, cwd and bounded partial stderr when a fixture git times out', async () => {
    const message = await killMessage(syntheticKill({}), ({ gitWithInput }) => {
      gitWithInput(FIXTURE_ROOT, ['hash-object', '--stdin'], Buffer.from('fixture\n'));
    });
    expect(message).toContain('["hash-object","--stdin"]');
    expect(message).toContain(FIXTURE_ROOT);
    expect(message).toContain('ETIMEDOUT');
    expect(message).toContain('fatal: synthetic partial stderr');
    expect(message.length).toBeLessThan(2_048 + 512);
  }, 5_000);

  it('reports the args and cwd when a plain fixture git is SIGKILLed without ETIMEDOUT', async () => {
    const message = await killMessage(syntheticKill({ code: undefined, stderr: '' }), ({ git }) => {
      git(FIXTURE_ROOT, ['commit', '--quiet', '-m', 'fixture']);
    });
    expect(message).toContain('["commit","--quiet","-m","fixture"]');
    expect(message).toContain(FIXTURE_ROOT);
    expect(message).toContain('SIGKILL');
  }, 5_000);

  it('rethrows a non-kill git failure unchanged', async () => {
    const failure = Object.assign(new Error('Command failed: git rev-parse HEAD'), { status: 128 });
    let thrown: unknown;
    await withMockedFixtureSpawn(() => {
      throw failure;
    }, ({ git }) => {
      try {
        git(FIXTURE_ROOT, ['rev-parse', 'HEAD']);
      } catch (error) {
        thrown = error;
      }
    });
    expect(thrown).toBe(failure);
  }, 5_000);
});
