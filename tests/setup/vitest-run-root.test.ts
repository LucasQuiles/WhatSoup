import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
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

const repoRoot = process.cwd();
// Hang guards, not performance bounds: a nested run starts Vite and one fork.
const NESTED_RUN_TIMEOUT_MS = 60_000;
const NESTED_TEST_TIMEOUT_MS = NESTED_RUN_TIMEOUT_MS + 30_000;

interface ProbeRecord {
  event: 'module' | 'afterAll';
  home?: string;
  runRoot?: string | null;
}

// How the probe's fork ends. Neither way runs its afterAll or emits `exit`.
// - sigterm: a referenced timer keeps the fork alive after its file, as an open
//   handle in a real test file does. A fork with nothing left to run exits on
//   its own once Vitest's stop request removes its message listeners, and its
//   `exit` fallback then removes the HOME; this one waits for Vitest's SIGTERM.
// - sigkill: the fork ends itself with SIGKILL inside its test.
type ForkEnd = 'sigterm' | 'sigkill';

// One nested Vitest run over one probe file, with the isolation setup file and,
// when asked, this globalSetup. The probe records its worker HOME and run root
// from module code, which also runs in a `vitest list` pass, and records its
// afterAll, so a fork whose hooks ran is visible.
function nestedRun(options: {
  command: 'run' | 'list';
  end: ForkEnd;
  globalSetup: boolean;
  env?: NodeJS.ProcessEnv;
}): { records: ProbeRecord[]; status: number | null; output: string } {
  const dir = realpathSync(tmp.make('nested'));
  const recordsFile = join(dir, 'records.jsonl');
  const config = join(dir, 'vitest.config.mts');
  writeFileSync(config, `export default ${JSON.stringify({
    root: dir,
    cacheDir: join(dir, '.vite'),
    test: {
      include: ['probe.test.mjs'],
      ...(options.globalSetup ? { globalSetup: [resolve(repoRoot, 'tests/setup/vitest-run-root.ts')] } : {}),
      setupFiles: [resolve(repoRoot, 'tests/setup/bot-errors-vitest-isolation.ts')],
      maxWorkers: 1,
      fileParallelism: false,
    },
  })};`);
  writeFileSync(join(dir, 'probe.test.mjs'), [
    `import { afterAll, it } from ${JSON.stringify(resolve(repoRoot, 'node_modules/vitest/dist/index.js'))};`,
    "import { appendFileSync } from 'node:fs';",
    'const record = (row) => appendFileSync(process.env.WHATSOUP_RUN_ROOT_PROBE_RECORDS, `${JSON.stringify(row)}\\n`);',
    "record({ event: 'module', home: process.env.WHATSOUP_VITEST_HOME, runRoot: process.env.WHATSOUP_VITEST_RUN_ROOT ?? null });",
    "afterAll(() => record({ event: 'afterAll' }));",
    options.end === 'sigkill'
      ? "it('ends its own fork by signal', () => { process.kill(process.pid, 'SIGKILL'); });"
      : 'setInterval(() => {}, 60_000);\nit(\'keeps its fork alive\', () => {});',
  ].join('\n'));
  const child = spawnSync(process.execPath, [
    resolve(repoRoot, 'node_modules/vitest/vitest.mjs'), options.command, '--config', config, '--pool=forks',
  ], {
    cwd: repoRoot,
    env: { ...process.env, ...options.env, WHATSOUP_RUN_ROOT_PROBE_RECORDS: recordsFile },
    encoding: 'utf8', timeout: NESTED_RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024,
  });
  const output = `${child.stdout}${child.stderr}`;
  expect(child.error, output).toBeUndefined();
  // Records before status: a setup or import failure in the nested run records
  // nothing, so it cannot pass for a removed HOME.
  expect(existsSync(recordsFile), `the nested probe did not run:\n${output}`).toBe(true);
  const records = readFileSync(recordsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ProbeRecord);
  return { records, status: child.status, output };
}

// The module record, after checking that the fork's hooks never ran: the
// probe's afterAll would run before the setup file's, which removes the HOME.
function onlyModuleRecord(records: ProbeRecord[], output: string): { home: string; runRoot: string | null } {
  expect(records.map((row) => row.event), output).toEqual(['module']);
  const [record] = records;
  expect(record!.home, output).toBeTruthy();
  return { home: record!.home!, runRoot: record!.runRoot ?? null };
}

// `exitsCleanly`: a `vitest list` pass succeeds; a run whose fork died fails.
const FORK_ROUTES = [
  { route: 'a `vitest list` pass, its fork ended by SIGTERM', command: 'list', end: 'sigterm', exitsCleanly: true },
  { route: 'a `vitest run` whose fork dies by SIGKILL in its test', command: 'run', end: 'sigkill', exitsCleanly: false },
] as const;

describe.each(FORK_ROUTES)('the worker HOME of $route', ({ command, end, exitsCleanly }) => {
  it('is removed with the run root by the globalSetup', () => {
    const { records, status, output } = nestedRun({ command, end, globalSetup: true });
    const { home, runRoot } = onlyModuleRecord(records, output);

    expect(status === 0, output).toBe(exitsCleanly);
    // A fresh root under /tmp, as a nested run under the outer run makes.
    expect(dirname(runRoot!)).toBe(defaultTempParent());
    expect(dirname(home)).toBe(runRoot);
    expect(existsSync(home), output).toBe(false);
    expect(existsSync(runRoot!), output).toBe(false);
  }, NESTED_TEST_TIMEOUT_MS);

  // Control: the fork's own cleanup does not run, so without the globalSetup
  // the HOME stays. It stays in a marked root this test owns, which the
  // temporary-directory cleanup removes, never in /tmp.
  it('stays without the globalSetup', () => {
    const inherited = realpathSync(tmp.make('inherited'));
    writeFileSync(join(inherited, RUN_ROOT_MARKER), 'control');

    const { records, status, output } = nestedRun({
      command, end, globalSetup: false, env: { [RUN_ROOT_ENV]: inherited },
    });
    const { home, runRoot } = onlyModuleRecord(records, output);

    expect(status === 0, output).toBe(exitsCleanly);
    expect(runRoot).toBe(inherited);
    expect(dirname(home)).toBe(inherited);
    expect(existsSync(home), output).toBe(true);
  }, NESTED_TEST_TIMEOUT_MS);
});
