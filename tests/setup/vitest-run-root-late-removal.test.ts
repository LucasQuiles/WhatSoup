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
import { basename, dirname, join } from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { RUN_ROOT_ENV, RUN_ROOT_MARKER, type RunRootOptions, startRunRoot, workerHomePrefix } from './vitest-run-root.ts';

const tmp = trackTmpDirs('vitest-run-root-late-');

type ExitListener = (...args: unknown[]) => void;

interface LateRun {
  root: string;
  home: string;
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
    const home = workerHome(root);
    process.exitCode = undefined;
    run({ root, home, teardown, exitHooks, reports: () => stderr.mock.calls.map(([chunk]) => String(chunk)).join('') });
  } finally {
    for (const listener of exitHooks()) process.off('exit', listener);
    stderr.mockRestore();
    process.exitCode = exitCode;
    if (previous === undefined) delete process.env[RUN_ROOT_ENV];
    else process.env[RUN_ROOT_ENV] = previous;
  }
}

// A per-entry removal whose first call stops part way, as Node's rmSync does on
// Linux when remove_all meets an entry that another process removed first: it
// removes part of a worker HOME and returns. Later calls remove the entry. It
// records whether the run root's marker was present at each call.
function partialFirstRemoval(): { removeEntry: (path: string) => void; markerSeen: boolean[] } {
  const markerSeen: boolean[] = [];
  return {
    removeEntry: (path) => {
      markerSeen.push(existsSync(join(dirname(path), RUN_ROOT_MARKER)));
      if (markerSeen.length === 1) rmSync(join(path, 'credential-bin'), { recursive: true, force: true });
      else rmSync(path, { recursive: true, force: true });
    },
    markerSeen,
  };
}

describe('Vitest run root after a removal that stopped part way', () => {
  it('keeps the marker through a removal that stopped part way and removes it last on the next attempt', () => {
    const removal = partialFirstRemoval();
    withLateRun({ removeEntry: removal.removeEntry, exitWaitMs: 1_000 }, ({ root, teardown, exitHooks, reports }) => {
      teardown();
      expect(existsSync(root)).toBe(true);
      expect(readFileSync(join(root, RUN_ROOT_MARKER), 'utf8')).not.toBe('');
      expect(process.exitCode).toBeUndefined();
      expect(reports()).toContain(`${root} is still present after removal`);
      expect(exitHooks()).toHaveLength(1);

      exitHooks()[0]!();
      expect(existsSync(root)).toBe(false);
      expect(process.exitCode).toBeUndefined();
      expect(reports()).not.toContain('refusing to remove');
      // One entry per attempt, and the marker was there both times.
      expect(removal.markerSeen).toEqual([true, true]);
    });
  });

  it('still tries the other entries when one fails, and keeps the marker', () => {
    let failed = false;
    const removeEntry = (path: string): void => {
      if (!failed && basename(path) !== 'second') {
        failed = true;
        throw new Error(`EBUSY: resource busy or locked, rmdir '${path}'`);
      }
      rmSync(path, { recursive: true, force: true });
    };
    withLateRun({ removeEntry, exitWaitMs: 1_000 }, ({ root, home, teardown, exitHooks, reports }) => {
      mkdirSync(join(root, 'second'));

      teardown();
      expect(existsSync(join(root, 'second'))).toBe(false);
      expect(existsSync(home)).toBe(true);
      expect(existsSync(join(root, RUN_ROOT_MARKER))).toBe(true);
      expect(process.exitCode).toBeUndefined();
      expect(reports()).toContain(`could not remove ${root}: EBUSY: resource busy or locked`);

      exitHooks()[0]!();
      expect(existsSync(root)).toBe(false);
      expect(process.exitCode).toBeUndefined();
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

      exitHooks()[0]!();
      expect(calls).toBe(4);
      expect(existsSync(root)).toBe(false);
      expect(process.exitCode).toBeUndefined();
    });
  });

  it('refuses a root that carries another marker after its own removal started', () => {
    const removal = partialFirstRemoval();
    withLateRun({ removeEntry: removal.removeEntry, exitWaitMs: 5_000 }, ({ root, teardown, exitHooks, reports }) => {
      teardown();
      expect(process.exitCode).toBeUndefined();
      writeFileSync(join(root, RUN_ROOT_MARKER), 'another-run');

      exitHooks()[0]!();
      expect(readFileSync(join(root, RUN_ROOT_MARKER), 'utf8')).toBe('another-run');
      expect(process.exitCode).toBe(1);
      expect(reports()).toContain(`refusing to remove ${root}: not this run's marked root`);
      // Refused at once: no removal after the marker changed.
      expect(removal.markerSeen).toHaveLength(1);
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

  it('refuses a root whose marker went missing after an earlier attempt of this run removed entries', () => {
    const removal = partialFirstRemoval();
    withLateRun({ removeEntry: removal.removeEntry, exitWaitMs: 5_000 }, ({ root, home, teardown, exitHooks, reports }) => {
      teardown();
      expect(process.exitCode).toBeUndefined();
      rmSync(join(root, RUN_ROOT_MARKER));

      exitHooks()[0]!();
      expect(existsSync(home)).toBe(true);
      expect(process.exitCode).toBe(1);
      expect(reports()).toContain(`refusing to remove ${root}: not this run's marked root`);
      expect(reports()).toContain(`1 top-level entries remain (1 shown): ${basename(home)}`);
      expect(removal.markerSeen).toHaveLength(1);
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
});

// A pathname is not reserved: after a rename, another directory can take it.
// Without this run's token it is never removed.
describe('Vitest run root whose path another directory took', () => {
  it.each([
    { marker: undefined, holds: 'no marker' },
    { marker: 'another-run', holds: "another run's marker" },
  ])('refuses a directory at the root path that holds $holds, after a removal that stopped part way', ({ marker }) => {
    const removal = partialFirstRemoval();
    withLateRun({ removeEntry: removal.removeEntry, exitWaitMs: 1_000 }, ({ root, teardown, exitHooks, reports }) => {
      teardown();
      expect(process.exitCode).toBeUndefined();
      renameSync(root, `${root}-moved`);
      mkdirSync(root, { mode: 0o700 });
      writeFileSync(join(root, 'replacement.txt'), 'keep');
      if (marker !== undefined) writeFileSync(join(root, RUN_ROOT_MARKER), marker);

      exitHooks()[0]!();
      expect(readFileSync(join(root, 'replacement.txt'), 'utf8')).toBe('keep');
      expect(process.exitCode).toBe(1);
      expect(reports()).toContain(`refusing to remove ${root}: not this run's marked root`);
      expect(removal.markerSeen).toHaveLength(1);
    });
  });
});

// The exit hook's deadline, on a scripted monotonic clock: each value is what
// one performance.now() call in the hook returns, in order. The pauses are real
// but short, and nothing here measures elapsed time.
describe('Vitest run root exit hook deadline', () => {
  function withScriptedClock(times: number[], run: () => void): void {
    const now = vi.spyOn(performance, 'now');
    for (const time of times) now.mockReturnValueOnce(time);
    try {
      run();
    } finally {
      now.mockRestore();
    }
  }

  // A removal that never succeeds, counting the calls the exit hook makes. A
  // hook that ignores its bound stops at the sixth call, when the root goes.
  function stuckRemoval(): { remove: (root: string) => void; hookCalls: () => number } {
    let calls = 0;
    return {
      remove: (root) => {
        calls += 1;
        if (calls >= 7) rmSync(root, { recursive: true, force: true });
      },
      hookCalls: () => calls - 1,
    };
  }

  it('stops when the clock passes the deadline during the first pause', () => {
    const removal = stuckRemoval();
    withLateRun({ remove: removal.remove, exitWaitMs: 1_000 }, ({ teardown, exitHooks }) => {
      teardown();
      // Deadline at 1000; 1000 left after the first attempt; 5000 after the pause.
      withScriptedClock([0, 0, 5_000], () => exitHooks()[0]!());
      expect(removal.hookCalls()).toBe(1);
      expect(process.exitCode).toBe(1);
    });
  });

  it('keeps retrying while the clock stays inside the bound', () => {
    const removal = stuckRemoval();
    withLateRun({ remove: removal.remove, exitWaitMs: 1_000 }, ({ teardown, exitHooks }) => {
      teardown();
      // Deadline at 1000; two pauses end at 200 and 400; the third check is past it.
      withScriptedClock([0, 100, 200, 300, 400, 5_000], () => exitHooks()[0]!());
      expect(removal.hookCalls()).toBe(3);
      expect(process.exitCode).toBe(1);
    });
  });

  it.each([{ exitWaitMs: Number.NaN }, { exitWaitMs: -1 }])('uses the default bound for exitWaitMs $exitWaitMs', ({ exitWaitMs }) => {
    const removal = stuckRemoval();
    withLateRun({ remove: removal.remove, exitWaitMs }, ({ teardown, exitHooks, reports }) => {
      teardown();
      // With the 10 s default the deadline is 10000: a pause ending at 9500
      // still allows a second attempt, and 10001 ends the wait.
      withScriptedClock([0, 9_000, 9_500, 10_001], () => exitHooks()[0]!());
      expect(removal.hookCalls()).toBe(2);
      expect(process.exitCode).toBe(1);
      expect(reports()).toContain('within 10000 ms');
    });
  });
});
