import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  RUN_ROOT_ENV,
  RUN_ROOT_MARKER,
  defaultTempParent,
  resolveWorkerTempRoot,
  startRunRoot,
} from './vitest-run-root.ts';

const tmp = trackTmpDirs('vitest-run-root-');

// A worker HOME as bot-errors-vitest-isolation.ts lays it out.
function workerHome(runRoot: string, layout: 'intact' | 'partial'): string {
  const home = mkdtempSync(join(runRoot, 'ws-vh-'));
  mkdirSync(join(home, 'credential-bin'), { mode: 0o700 });
  writeFileSync(join(home, 'credential-bin', 'secret-tool'), '#!/bin/sh\nexit 127\n', { mode: 0o700 });
  mkdirSync(join(home, 'tmp', 'child-output', 'deeper'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'tmp', 'child-output', 'deeper', 'late-write.log'), 'written after afterAll\n');
  // A partially removed HOME lost its marker before the removal failed.
  if (layout === 'intact') writeFileSync(join(home, '.whatsoup-vitest-home'), 'token', { mode: 0o600 });
  return home;
}

function withRunRoot(parent: string, run: (root: string, teardown: () => void) => void): void {
  const previous = process.env[RUN_ROOT_ENV];
  const teardown = startRunRoot(parent);
  try {
    run(process.env[RUN_ROOT_ENV]!, teardown);
  } finally {
    teardown();
    expect(process.env[RUN_ROOT_ENV]).toBe(previous);
  }
}

describe('Vitest run root', () => {
  it('creates a marked root, exports it, and removes the worker HOMEs left in it', () => {
    const parent = realpathSync(tmp.make('parent'));
    const exitListeners = process.listenerCount('exit');

    withRunRoot(parent, (root, teardown) => {
      expect(dirname(root)).toBe(parent);
      expect(basename(root)).toMatch(/^ws-vr-/);
      expect(existsSync(join(root, RUN_ROOT_MARKER))).toBe(true);
      expect(resolveWorkerTempRoot()).toBe(root);
      expect(process.listenerCount('exit')).toBe(exitListeners + 1);

      const intact = workerHome(root, 'intact');
      const partial = workerHome(root, 'partial');
      expect(readdirSync(root).sort()).toEqual([RUN_ROOT_MARKER, basename(intact), basename(partial)].sort());

      teardown();
      expect(existsSync(root)).toBe(false);
      expect(readdirSync(parent)).toEqual([]);
      expect(process.listenerCount('exit')).toBe(exitListeners);
    });
  });

  it('leaves a root whose marker is not its own in place and does not throw', () => {
    const parent = realpathSync(tmp.make('parent'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      withRunRoot(parent, (root, teardown) => {
        workerHome(root, 'intact');
        writeFileSync(join(root, RUN_ROOT_MARKER), 'another-run');

        expect(() => teardown()).not.toThrow();
        expect(existsSync(root)).toBe(true);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`refusing to remove ${root}`));
      });
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('worker temporary root', () => {
  it('is /tmp when no run root is exported, as under a config without the globalSetup', () => {
    expect(resolveWorkerTempRoot({})).toBe(defaultTempParent());
    expect(resolveWorkerTempRoot({ [RUN_ROOT_ENV]: '' })).toBe(defaultTempParent());
    expect(defaultTempParent()).toBe(realpathSync('/tmp'));
  });

  it('is the exported run root when it carries the marker', () => {
    const root = realpathSync(tmp.make('root'));
    writeFileSync(join(root, RUN_ROOT_MARKER), 'token');

    expect(resolveWorkerTempRoot({ [RUN_ROOT_ENV]: root })).toBe(root);
  });

  it('refuses an exported run root that is unmarked, missing, relative or a symlink', () => {
    const unmarked = realpathSync(tmp.make('unmarked'));
    const marked = realpathSync(tmp.make('marked'));
    writeFileSync(join(marked, RUN_ROOT_MARKER), 'token');
    const link = join(realpathSync(tmp.make('link')), 'run-root');
    symlinkSync(marked, link);

    for (const value of [unmarked, join(unmarked, 'missing'), basename(marked), link]) {
      expect(() => resolveWorkerTempRoot({ [RUN_ROOT_ENV]: value })).toThrow(
        `${RUN_ROOT_ENV} is set but does not name a marked Vitest run root`,
      );
    }
  });
});
