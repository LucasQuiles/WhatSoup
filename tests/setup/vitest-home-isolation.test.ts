import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { resolveWorkerTempRoot } from './vitest-run-root.ts';

const root = process.cwd();
const tmp = trackTmpDirs('home-cleanup-');

describe('Vitest filesystem isolation', () => {
  it('routes HOME and XDG roots into a worker-owned temporary directory', () => {
    const isolatedHome = process.env['WHATSOUP_VITEST_HOME'];
    const isolatedTempRoot = process.env['WHATSOUP_VITEST_TEMP_ROOT'];
    const isolatedTmpdir = process.env['TMPDIR'];

    expect(isolatedHome).toBeTruthy();
    expect(isolatedTempRoot).toBeTruthy();
    expect(isolatedTmpdir).toBeTruthy();
    expect(isAbsolute(isolatedHome!)).toBe(true);
    expect(relative(realpathSync(isolatedTempRoot!), realpathSync(isolatedHome!))).not.toMatch(/^\.\.(?:\/|$)/);
    expect(realpathSync(isolatedTmpdir!)).toBe(isolatedTmpdir);
    expect(relative(realpathSync(isolatedHome!), isolatedTmpdir!)).not.toMatch(/^\.\.(?:\/|$)/);
    expect(process.env['HOME']).toBe(isolatedHome);
    expect(homedir()).toBe(isolatedHome);
    expect(process.env['XDG_CONFIG_HOME']).toBe(join(isolatedHome!, '.config'));
    expect(process.env['XDG_DATA_HOME']).toBe(join(isolatedHome!, '.local', 'share'));
    expect(process.env['XDG_STATE_HOME']).toBe(join(isolatedHome!, '.local', 'state'));
    expect(process.env['XDG_CACHE_HOME']).toBe(join(isolatedHome!, '.cache'));
    expect(process.env['CLAUDE_CONFIG_DIR']).toBeUndefined();
    expect(existsSync(join(isolatedHome!, '.whatsoup-vitest-home'))).toBe(true);
  });

  // The real config's globalSetup exports the run root before the workers fork;
  // the worker HOME and its containment root both sit in it, so the run's
  // teardown removes the HOME even when this worker dies by signal.
  it('nests the worker HOME under the run root that the globalSetup exported', () => {
    const runRoot = process.env['WHATSOUP_VITEST_RUN_ROOT'];
    const isolatedHome = process.env['WHATSOUP_VITEST_HOME']!;

    expect(runRoot).toBeTruthy();
    expect(basename(runRoot!)).toMatch(/^ws-vr-/);
    expect(existsSync(join(runRoot!, '.whatsoup-vitest-run-root'))).toBe(true);
    expect(process.env['WHATSOUP_VITEST_TEMP_ROOT']).toBe(runRoot);
    expect(dirname(isolatedHome)).toBe(runRoot);
    expect(basename(isolatedHome)).toMatch(/^ws-vh-/);
  });

  // The credential-isolation regression loads the setup file through its own
  // config. This pins the same contract under the real one, where a later setup
  // file could undo it.
  it('keeps REQUIRE_OS_KEYRING unset and the synthetic credential commands first on PATH', () => {
    const credentialBin = join(process.env['WHATSOUP_VITEST_HOME']!, 'credential-bin');

    expect(process.env['REQUIRE_OS_KEYRING']).toBeUndefined();
    expect((process.env['PATH'] ?? '').split(delimiter)[0]).toBe(credentialBin);
    for (const command of ['security', 'secret-tool']) {
      expect(() => accessSync(join(credentialBin, command), constants.X_OK)).not.toThrow();
    }
  });

  // A nested run whose config has no globalSetup inherits this run's root through
  // its environment, so its worker HOME nests there (else under /tmp). The child's
  // own afterAll must still remove that exact HOME once its test file finishes.
  it('removes the exact owned HOME after the child test process exits', () => {
    const dir = tmp.make('child');
    const expectedParent = resolveWorkerTempRoot();
    const witnessPath = join(dir, 'home-witness.json');
    const config = join(dir, 'vitest.config.mts');
    writeFileSync(config, `export default ${JSON.stringify({
      root: dir,
      cacheDir: join(dir, '.vite'),
      test: {
        include: ['probe.test.mjs'],
        setupFiles: [resolve(root, 'tests/setup/bot-errors-vitest-isolation.ts')],
        maxWorkers: 1,
        fileParallelism: false,
      },
    })};`);
    writeFileSync(join(dir, 'probe.test.mjs'), [
      `import { it, expect } from ${JSON.stringify(resolve(root, 'node_modules/vitest/dist/index.js'))};`,
      "import { lstatSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "it('records the live owned HOME', () => {",
      '  const home = process.env.WHATSOUP_VITEST_HOME;',
      '  expect(lstatSync(home).isDirectory()).toBe(true);',
      "  const token = readFileSync(join(home, '.whatsoup-vitest-home'), 'utf8');",
      '  expect(token.length).toBeGreaterThan(0);',
      '  writeFileSync(process.env.WHATSOUP_HOME_WITNESS, JSON.stringify({ home, token }));',
      '});',
    ].join('\n'));
    const child = spawnSync(process.execPath, [
      resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--pool=forks',
    ], {
      cwd: root,
      env: { ...process.env, WHATSOUP_HOME_WITNESS: witnessPath },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    const output = child.stdout + child.stderr;
    let witness: { home: string; token: string } | undefined;
    try {
      if (existsSync(witnessPath)) {
        witness = JSON.parse(readFileSync(witnessPath, 'utf8')) as { home: string; token: string };
      }
      expect(child.error, output).toBeUndefined();
      expect(child.signal, output).toBeNull();
      expect(child.status, output).toBe(0);
      expect(witness, `the child did not record its live HOME:\n${output}`).toBeDefined();
      expect(dirname(witness!.home)).toBe(expectedParent);
      expect(basename(witness!.home)).toMatch(/^ws-vh-/);
      expect(lstatSync(witness!.home, { throwIfNoEntry: false }), `child HOME survived process exit: ${witness!.home}`).toBeUndefined();
    } finally {
      // A failing regression must not leave its own witnessed fixture behind.
      if (witness && dirname(witness.home) === expectedParent && basename(witness.home).startsWith('ws-vh-')) {
        const stat = lstatSync(witness.home, { throwIfNoEntry: false });
        if (stat?.isDirectory() && !stat.isSymbolicLink()
          && realpathSync(witness.home) === witness.home
          && readFileSync(join(witness.home, '.whatsoup-vitest-home'), 'utf8') === witness.token) {
          rmSync(witness.home, { recursive: true, force: true });
        }
      }
    }
  }, 45_000);
});
