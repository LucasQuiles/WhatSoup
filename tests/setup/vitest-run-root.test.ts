import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import {
  RUN_ROOT_ENV,
  RUN_ROOT_MARKER,
  defaultTempParent,
  resolveWorkerTempRoot,
  startRunRoot,
  workerHomePrefix,
} from './vitest-run-root.ts';

const repoRoot = process.cwd();
const tmp = trackTmpDirs('vitest-run-root-');

// RUN_ROOT_PREFIX and the six characters mkdtempSync appends.
const RUN_ROOT_NAME = /^w[A-Za-z0-9]{6}$/;

// A worker HOME as bot-errors-vitest-isolation.ts lays it out.
function workerHome(runRoot: string, layout: 'intact' | 'partial'): string {
  const home = mkdtempSync(workerHomePrefix(runRoot));
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

type ExitListener = (...args: unknown[]) => void;

// A fail-closed teardown sets this worker's exit status and keeps its exit hook;
// the test hands both back.
function withExitState(run: (addedExitListeners: () => ExitListener[]) => void): void {
  const exitCode = process.exitCode;
  const before = new Set<unknown>(process.listeners('exit'));
  const added = (): ExitListener[] => (process.listeners('exit') as unknown as ExitListener[])
    .filter((listener) => !before.has(listener));
  try {
    run(added);
  } finally {
    for (const listener of added()) process.off('exit', listener);
    process.exitCode = exitCode;
  }
}

describe('Vitest run root', () => {
  it('creates a marked root, exports it, and removes the worker HOMEs left in it', () => {
    const parent = realpathSync(tmp.make('parent'));
    const exitListeners = process.listenerCount('exit');

    withRunRoot(parent, (root, teardown) => {
      expect(dirname(root)).toBe(parent);
      expect(basename(root)).toMatch(RUN_ROOT_NAME);
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

  it('leaves a root whose marker is not its own in place and fails the run closed', () => {
    const parent = realpathSync(tmp.make('parent'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      withExitState(() => {
        process.exitCode = undefined;
        withRunRoot(parent, (root, teardown) => {
          workerHome(root, 'intact');
          writeFileSync(join(root, RUN_ROOT_MARKER), 'another-run');

          expect(() => teardown()).not.toThrow();
          expect(existsSync(root)).toBe(true);
          expect(process.exitCode).toBe(1);
          expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`refusing to remove ${root}`));
        });
      });
    } finally {
      stderr.mockRestore();
    }
  });

  // The retry window can expire while a writer is still active. Teardown then
  // leaves the verdict to the exit hook, the last attempt: the run is clean when
  // the hook removes the root, and fails closed when the root outlasts its wait.
  it.each([
    {
      outcome: 'a removal that exhausts its retries',
      block: (root: string): void => {
        throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${root}'`), { code: 'ENOTEMPTY' });
      },
      report: 'could not remove',
      writerStops: true,
    },
    {
      outcome: 'a removal that returns with the root still present',
      block: (): void => {},
      report: 'is still present after removal',
      writerStops: true,
    },
    {
      outcome: 'a writer that never stops',
      block: (): void => {},
      report: 'is still present after removal',
      writerStops: false,
    },
  ])('keeps its exit hook after $outcome and lets the hook decide the exit status', ({ block, report, writerStops }) => {
    const parent = realpathSync(tmp.make('parent'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      withExitState((addedExitListeners) => {
        const previous = process.env[RUN_ROOT_ENV];
        let writerActive = true;
        const teardown = startRunRoot(parent, {
          remove: (root) => {
            if (writerActive) block(root);
            else rmSync(root, { recursive: true, force: true });
          },
          exitWaitMs: 50,
        });
        const root = process.env[RUN_ROOT_ENV]!;
        const home = workerHome(root, 'intact');
        process.exitCode = undefined;

        expect(() => teardown()).not.toThrow();
        expect(process.env[RUN_ROOT_ENV]).toBe(previous);
        expect(existsSync(root)).toBe(true);
        expect(process.exitCode).toBeUndefined();
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining(report));
        const remaining = addedExitListeners();
        expect(remaining).toHaveLength(1);

        // The writer has stopped by the time the process exits, or never does.
        writerActive = !writerStops;
        remaining[0]!();
        expect(existsSync(root)).toBe(!writerStops);
        expect(process.exitCode).toBe(writerStops ? undefined : 1);
        const reports = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
        expect(reports.includes(`could not remove ${root} within 50 ms`)).toBe(!writerStops);
        expect(reports.includes(`2 top-level entries remain (2 shown): ${RUN_ROOT_MARKER}, ${basename(home)}`)).toBe(!writerStops);
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

// Writes into one existing directory every 5 ms for a fixed time, and stops at
// the first failed write, so it never recreates a removed directory.
const LATE_WRITER = [
  "const { writeFileSync } = require('node:fs');",
  "const { join } = require('node:path');",
  'const [dir, ms] = process.argv.slice(1);',
  'const end = Date.now() + Number(ms);',
  'let n = 0;',
  'const tick = () => {',
  '  if (Date.now() >= end) return;',
  "  try { writeFileSync(join(dir, 'late-' + String(n++) + '.log'), 'late write\\n'); } catch { return; }",
  '  setTimeout(tick, 5);',
  '};',
  'tick();',
].join('\n');

describe('vitest list under the run root', () => {
  // The doc-drift guard runs `vitest list` in a child process. Collection loads
  // the setup file, so a worker HOME exists, but no afterAll runs and Vitest ends
  // the worker by signal: only the run root's teardown removes that HOME. The
  // probe keeps a detached writer active in its HOME past the per-file retry
  // window, so the run's own bounded removal has to outlast it.
  it('leaves no run root or worker HOME after a list run with a late writer', () => {
    const dir = realpathSync(tmp.make('list'));
    const witnessPath = join(dir, 'run-root-witness.json');
    const config = join(dir, 'vitest.config.mts');
    writeFileSync(config, `export default ${JSON.stringify({
      root: dir,
      cacheDir: join(dir, '.vite'),
      test: {
        include: ['probe.test.mjs'],
        globalSetup: [resolve(repoRoot, 'tests/setup/vitest-run-root.ts')],
        setupFiles: [resolve(repoRoot, 'tests/setup/bot-errors-vitest-isolation.ts')],
        maxWorkers: 1,
        fileParallelism: false,
      },
    })};`);
    writeFileSync(join(dir, 'probe.test.mjs'), [
      `import { it } from ${JSON.stringify(resolve(repoRoot, 'node_modules/vitest/dist/index.js'))};`,
      "import { spawn } from 'node:child_process';",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const runRoot = process.env.WHATSOUP_VITEST_RUN_ROOT;',
      'const home = process.env.WHATSOUP_VITEST_HOME;',
      `const token = readFileSync(join(runRoot, ${JSON.stringify(RUN_ROOT_MARKER)}), 'utf8');`,
      'writeFileSync(process.env.WHATSOUP_RUN_ROOT_WITNESS, JSON.stringify({ runRoot, home, token }));',
      // Detached, so the end of the worker does not stop it; it stops by itself.
      `spawn(process.execPath, ['-e', ${JSON.stringify(LATE_WRITER)}, home, '2500'], { detached: true, stdio: 'ignore' }).unref();`,
      "it('is listed', () => {});",
    ].join('\n'));
    const child = spawnSync(process.execPath, [
      resolve(repoRoot, 'node_modules/vitest/vitest.mjs'), 'list', '--config', config, '--pool=forks',
    ], {
      cwd: repoRoot,
      env: { ...process.env, WHATSOUP_RUN_ROOT_WITNESS: witnessPath },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const output = child.stdout + child.stderr;
    let witness: { runRoot: string; home: string; token: string } | undefined;
    try {
      if (existsSync(witnessPath)) {
        witness = JSON.parse(readFileSync(witnessPath, 'utf8')) as { runRoot: string; home: string; token: string };
      }
      expect(child.error, output).toBeUndefined();
      expect(child.signal, output).toBeNull();
      expect(child.status, output).toBe(0);
      expect(witness, `the list run did not record its run root:\n${output}`).toBeDefined();
      expect(dirname(witness!.runRoot)).toBe(defaultTempParent());
      expect(basename(witness!.runRoot)).toMatch(RUN_ROOT_NAME);
      expect(dirname(witness!.home)).toBe(witness!.runRoot);
      expect(lstatSync(witness!.runRoot, { throwIfNoEntry: false }), `run root survived the list run: ${witness!.runRoot}`)
        .toBeUndefined();
    } finally {
      // A failing regression removes only the witnessed root, and only while it
      // still carries that run's token.
      if (witness && dirname(witness.runRoot) === defaultTempParent() && RUN_ROOT_NAME.test(basename(witness.runRoot))) {
        try {
          if (readFileSync(join(witness.runRoot, RUN_ROOT_MARKER), 'utf8') === witness.token) {
            rmSync(witness.runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
          }
        } catch {
          // Already gone, or its marker is: leave it.
        }
      }
    }
  }, 45_000);
});
