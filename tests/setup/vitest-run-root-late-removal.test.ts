import { describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { RUN_ROOT_ENV, RUN_ROOT_MARKER, type RunRootOptions, startRunRoot, workerHomePrefix } from './vitest-run-root.ts';

const tmp = trackTmpDirs('vitest-run-root-late-');

type ExitListener = (...args: unknown[]) => void;

interface LateRun {
  root: string;
  teardown: () => void;
  exitHooks: () => ExitListener[];
  reports: () => string;
}

// A worker HOME as bot-errors-vitest-isolation.ts lays it out.
function workerHome(runRoot: string): string {
  const home = mkdtempSync(workerHomePrefix(runRoot));
  writeFileSync(join(home, '.whatsoup-vitest-home'), 'token', { mode: 0o600 });
  mkdirSync(join(home, 'credential-bin'), { mode: 0o700 });
  writeFileSync(join(home, 'credential-bin', 'secret-tool'), '#!/bin/sh\nexit 127\n', { mode: 0o700 });
  mkdirSync(join(home, 'tmp'), { mode: 0o700 });
  writeFileSync(join(home, 'tmp', 'late-0.log'), 'late write\n');
  return home;
}

// Starts a run root with one worker HOME in it from a clean exit status, and
// hands back the exit hooks it added, the exit status, stderr and the
// environment afterwards.
function withLateRun(options: RunRootOptions, run: (late: LateRun) => void): void {
  const parent = realpathSync(tmp.make('parent'));
  const exitCode = process.exitCode;
  const previous = process.env[RUN_ROOT_ENV];
  const before = new Set<unknown>(process.listeners('exit'));
  const exitHooks = (): ExitListener[] => (process.listeners('exit') as unknown as ExitListener[])
    .filter((listener) => !before.has(listener));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const teardown = startRunRoot(parent, options);
    const root = process.env[RUN_ROOT_ENV]!;
    workerHome(root);
    process.exitCode = undefined;
    run({ root, teardown, exitHooks, reports: () => stderr.mock.calls.map(([chunk]) => String(chunk)).join('') });
  } finally {
    for (const listener of exitHooks()) process.off('exit', listener);
    stderr.mockRestore();
    process.exitCode = exitCode;
    if (previous === undefined) delete process.env[RUN_ROOT_ENV];
    else process.env[RUN_ROOT_ENV] = previous;
  }
}

describe('Vitest run root after a removal that stopped part way', () => {
  // On Linux, Node's rmSync returns as if done when remove_all meets an entry
  // that another process removed first (ENOENT), as a worker's own exit-hook
  // HOME removal does during teardown. The marker may be gone by then.
  it('removes the root in the exit hook and keeps the run clean after a removal that deleted the marker', () => {
    let calls = 0;
    const remove = (root: string): void => {
      calls += 1;
      if (calls > 1) {
        rmSync(root, { recursive: true, force: true });
        return;
      }
      rmSync(join(root, RUN_ROOT_MARKER));
      for (const home of readdirSync(root)) rmSync(join(root, home, 'credential-bin'), { recursive: true, force: true });
    };
    withLateRun({ remove, exitWaitMs: 1_000 }, ({ root, teardown, exitHooks, reports }) => {
      teardown();
      expect(existsSync(root)).toBe(true);
      expect(existsSync(join(root, RUN_ROOT_MARKER))).toBe(false);
      expect(process.exitCode).toBeUndefined();
      expect(reports()).toContain(`${root} is still present after removal`);
      expect(exitHooks()).toHaveLength(1);

      exitHooks()[0]!();
      expect(existsSync(root)).toBe(false);
      expect(process.exitCode).toBeUndefined();
      expect(reports()).not.toContain('refusing to remove');
      expect(calls).toBe(2);
    });
  });

  it('treats a root that another process already removed as a clean run', () => {
    const remove = vi.fn((root: string): void => rmSync(root, { recursive: true, force: true }));
    withLateRun({ remove }, ({ root, teardown, exitHooks, reports }) => {
      rmSync(root, { recursive: true, force: true });

      teardown();
      expect(process.exitCode).toBeUndefined();
      expect(exitHooks()).toHaveLength(0);
      expect(reports()).toBe('');
      expect(remove).not.toHaveBeenCalled();
    });
  });

  it('waits in the exit hook, pausing between attempts, until a late writer stops', () => {
    let calls = 0;
    const remove = (root: string): void => {
      calls += 1;
      // The writer keeps the root alive for the teardown attempt and the
      // first two attempts of the exit hook.
      if (calls > 3) rmSync(root, { recursive: true, force: true });
    };
    withLateRun({ remove, exitWaitMs: 5_000 }, ({ root, teardown, exitHooks }) => {
      teardown();
      expect(process.exitCode).toBeUndefined();

      const started = performance.now();
      exitHooks()[0]!();
      // Two pauses of 100 ms, measured from below only.
      expect(performance.now() - started).toBeGreaterThanOrEqual(150);
      expect(calls).toBe(4);
      expect(existsSync(root)).toBe(false);
      expect(process.exitCode).toBeUndefined();
    });
  });

  it('still refuses a root that carries another marker after its own removal started', () => {
    let calls = 0;
    const remove = (root: string): void => {
      calls += 1;
      rmSync(join(root, RUN_ROOT_MARKER), { force: true });
    };
    withLateRun({ remove, exitWaitMs: 5_000 }, ({ root, teardown, exitHooks, reports }) => {
      teardown();
      expect(process.exitCode).toBeUndefined();
      writeFileSync(join(root, RUN_ROOT_MARKER), 'another-run');

      exitHooks()[0]!();
      expect(existsSync(join(root, RUN_ROOT_MARKER))).toBe(true);
      expect(process.exitCode).toBe(1);
      expect(reports()).toContain(`refusing to remove ${root}: not this run's marked root`);
      // Refused at once: no removal attempt after the marker changed.
      expect(calls).toBe(1);
    });
  });

  it('refuses a root whose marker is missing before any removal of this run started', () => {
    const remove = vi.fn((root: string): void => rmSync(root, { recursive: true, force: true }));
    withLateRun({ remove, exitWaitMs: 5_000 }, ({ root, teardown, reports }) => {
      rmSync(join(root, RUN_ROOT_MARKER));

      teardown();
      expect(existsSync(root)).toBe(true);
      expect(process.exitCode).toBe(1);
      expect(reports()).toContain(`refusing to remove ${root}: not this run's marked root`);
      expect(remove).not.toHaveBeenCalled();
    });
  });

  it('names at most 20 remaining top-level entries when the last attempt fails', () => {
    withLateRun({ remove: () => {}, exitWaitMs: 0 }, ({ root, teardown, exitHooks, reports }) => {
      // This case lays out its own tree: the marker, a nested directory and 24 files.
      for (const name of readdirSync(root)) if (name !== RUN_ROOT_MARKER) rmSync(join(root, name), { recursive: true });
      mkdirSync(join(root, 'a-nested', 'inner'), { recursive: true });
      for (let i = 0; i < 24; i += 1) writeFileSync(join(root, `f${String(i).padStart(2, '0')}`), 'x');

      teardown();
      exitHooks()[0]!();
      expect(process.exitCode).toBe(1);
      const final = reports().split('\n').find((line) => line.includes('entries remain'));
      expect(final).toContain(`could not remove ${root} within 0 ms`);
      expect(final).toContain('26 top-level entries remain (20 shown): ');
      const shown = final!.split('shown): ')[1]!.split(', ');
      expect(shown).toEqual([
        RUN_ROOT_MARKER,
        'a-nested',
        ...Array.from({ length: 18 }, (_, i) => `f${String(i).padStart(2, '0')}`),
      ]);
    });
  });

  it('starts no attempt after the deadline', () => {
    const starts: number[] = [];
    let hookStarted = 0;
    const remove = (): void => {
      if (hookStarted > 0) starts.push(performance.now() - hookStarted);
    };
    withLateRun({ remove, exitWaitMs: 250 }, ({ teardown, exitHooks }) => {
      teardown();
      hookStarted = performance.now();
      exitHooks()[0]!();
      expect(process.exitCode).toBe(1);
      // Attempts start at about 0, 100 and 200 ms; none at or after 250 ms.
      expect(starts.length).toBeGreaterThanOrEqual(2);
      expect(Math.max(...starts)).toBeLessThan(250);
    });
  });
});

// A pathname is not reserved: after a rename, another directory can take it.
// Only the directory this run made may be removed.
describe('Vitest run root whose path another directory took', () => {
  function replaceRoot(root: string, marker?: string): void {
    renameSync(root, `${root}-moved`);
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, 'replacement.txt'), 'keep');
    if (marker !== undefined) writeFileSync(join(root, RUN_ROOT_MARKER), marker);
  }

  // The first removal deletes the marker and returns with the root present.
  function markerOnlyRemoval(): { remove: (root: string) => void; calls: () => number } {
    let calls = 0;
    return {
      remove: (root) => {
        calls += 1;
        if (calls > 1) rmSync(root, { recursive: true, force: true });
        else rmSync(join(root, RUN_ROOT_MARKER));
      },
      calls: () => calls,
    };
  }

  it('refuses an unmarked directory at the root path after its own removal started', () => {
    const removal = markerOnlyRemoval();
    withLateRun({ remove: removal.remove, exitWaitMs: 1_000 }, ({ root, teardown, exitHooks, reports }) => {
      teardown();
      expect(process.exitCode).toBeUndefined();
      replaceRoot(root);

      exitHooks()[0]!();
      expect(readFileSync(join(root, 'replacement.txt'), 'utf8')).toBe('keep');
      expect(process.exitCode).toBe(1);
      expect(reports()).toContain(`refusing to remove ${root}: not this run's marked root`);
      expect(removal.calls()).toBe(1);
    });
  });

  it("refuses a directory at the root path that carries this run's marker", () => {
    const remove = vi.fn((root: string): void => rmSync(root, { recursive: true, force: true }));
    withLateRun({ remove }, ({ root, teardown, reports }) => {
      replaceRoot(root, readFileSync(join(root, RUN_ROOT_MARKER), 'utf8'));

      teardown();
      expect(readFileSync(join(root, 'replacement.txt'), 'utf8')).toBe('keep');
      expect(process.exitCode).toBe(1);
      expect(reports()).toContain(`refusing to remove ${root}: not this run's marked root`);
      expect(remove).not.toHaveBeenCalled();
    });
  });

  it('refuses its own root when the marker became a dangling symlink after its removal started', () => {
    const removal = markerOnlyRemoval();
    withLateRun({ remove: removal.remove, exitWaitMs: 1_000 }, ({ root, teardown, exitHooks, reports }) => {
      teardown();
      symlinkSync(join(root, 'no-such-marker'), join(root, RUN_ROOT_MARKER));

      exitHooks()[0]!();
      expect(lstatSync(join(root, RUN_ROOT_MARKER)).isSymbolicLink()).toBe(true);
      expect(process.exitCode).toBe(1);
      expect(reports()).toContain(`refusing to remove ${root}: not this run's marked root`);
      expect(removal.calls()).toBe(1);
    });
  });

  it('refuses an otherwise intact root whose marker is a dangling symlink', () => {
    const remove = vi.fn((root: string): void => rmSync(root, { recursive: true, force: true }));
    withLateRun({ remove }, ({ root, teardown, reports }) => {
      rmSync(join(root, RUN_ROOT_MARKER));
      symlinkSync(join(root, 'no-such-marker'), join(root, RUN_ROOT_MARKER));

      teardown();
      expect(lstatSync(join(root, RUN_ROOT_MARKER)).isSymbolicLink()).toBe(true);
      expect(process.exitCode).toBe(1);
      expect(reports()).toContain(`refusing to remove ${root}: not this run's marked root`);
      expect(remove).not.toHaveBeenCalled();
    });
  });
});
