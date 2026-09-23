// tests/helpers/isolated-child-hook.ts
// Test harness for src/lib/private-fs-isolated.ts. The isolated writers run
// their temp write, fsync, and rename inside a child (an ES module spawned
// through a bounded supervisor), so a parent-side `node:fs` mock cannot observe
// or fault them. Instead, a hook module is imported ahead of the child source:
// static imports evaluate first, and the hook patches the shared `node:fs`
// object the child calls through. The supervisor is also told to pass the test
// environment through to the child so hooks can read configuration from env.
import type { SpawnSyncOptionsWithBufferEncoding } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { vi } from 'vitest';

export function assertIsolatedStaticArgv(args: readonly string[]): void {
  if (
    args.length !== 6
    || args[0] !== '--input-type=module'
    || args[1] !== '--eval'
    || typeof args[2] !== 'string'
    || typeof args[3] !== 'string'
  ) throw new Error('isolated supervisor argv is not the static contract');
}

export function injectIsolatedChildHook(args: readonly string[], hookPath: string): string[] {
  assertIsolatedStaticArgv(args);
  return [
    args[0],
    args[1],
    args[2].replace(
      "env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },",
      "env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },",
    ),
    `import ${JSON.stringify(pathToFileURL(hookPath).href)};\n${args[3]}`,
    args[4],
    args[5],
  ];
}

/**
 * vi.doMock `node:child_process` so every isolated write runs the given hook in
 * its child. Call vi.resetModules() first and import the module under test
 * afterwards; vi.doUnmock('node:child_process') in afterEach.
 */
export async function mockIsolatedChildWithHook(
  hookPath: string,
  env: Record<string, string> = {},
): Promise<{ spawned: () => boolean }> {
  const actualChildProcess = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  let spawned = false;
  vi.doMock('node:child_process', () => ({
    ...actualChildProcess,
    spawnSync: vi.fn((command: string, args: readonly string[], options: SpawnSyncOptionsWithBufferEncoding) => {
      spawned = true;
      return actualChildProcess.spawnSync(command, injectIsolatedChildHook(args, hookPath), {
        ...options,
        env: { ...options.env, ...env },
      });
    }),
  }));
  return { spawned: () => spawned };
}

/** Write an ES-module hook file (mode 0600) and return its path. */
export function writeIsolatedChildHook(dir: string, name: string, source: string): string {
  const hookPath = join(dir, name);
  writeFileSync(hookPath, source, { mode: 0o600 });
  return hookPath;
}
