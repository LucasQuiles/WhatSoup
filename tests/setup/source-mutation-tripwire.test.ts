import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertSourceMutationUnchanged,
  establishSourceMutationAnchor,
} from '../../scripts/lib/source-mutation.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const repoRoot = process.cwd();
const vitestCli = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const tripwireSetup = join(repoRoot, 'tests', 'setup', 'source-mutation-tripwire.ts');
const tmp = trackTmpDirs('source-mutation-tripwire-', { base: realpathSync(tmpdir()) });

function runFixture(
  testBody: string,
  options: { fixtureEnv?: NodeJS.ProcessEnv; parentEnv?: NodeJS.ProcessEnv } = {},
): { status: number | null; output: string } {
  const dir = tmp.make('fixture');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const original = true;\n');
  writeFileSync(join(dir, 'vitest.config.ts'), [
    'export default {',
    '  test: {',
    "    include: ['tripwire.fixture.test.ts'],",
    `    setupFiles: [${JSON.stringify(tripwireSetup)}],`,
    '    maxWorkers: 1,',
    '    fileParallelism: false,',
    '  },',
    '};',
  ].join('\n'));
  writeFileSync(join(dir, 'tripwire.fixture.test.ts'), testBody);

  // The nested Vitest process owns a different src/main.ts. A parent suite anchor describes
  // this repository, so forwarding it would reject the fixture before its mutation control runs.
  const { WHATSOUP_TRIPWIRE_MAIN_SHA256: _parentAnchor, ...fixtureParentEnv } = options.parentEnv ?? process.env;

  const result = spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    vitestCli,
    'run',
    '--config',
    join(dir, 'vitest.config.ts'),
    '--pool=forks',
  ], {
    cwd: dir,
    env: { ...fixtureParentEnv, ...options.fixtureEnv },
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe('source-mutation tripwire', () => {
  it('reports the actual worker and module boundaries only when tracing is enabled', () => {
    const body = "import { expect, it } from 'vitest'; it('fixture', () => { expect(process.pid).toBeGreaterThan(0); });";
    const traced = runFixture(body, { fixtureEnv: { WHATSOUP_TEST_TRACE: '1' } });
    expect(traced.status).toBe(0);
    const events = traced.output.split('\n').filter((line) => line.startsWith('test-module: '))
      .map((line) => JSON.parse(line.slice('test-module: '.length)));
    expect(events.map((event) => event.event)).toEqual(['start', 'end']);
    expect(events[0].spec).toMatch(/\/tripwire\.fixture\.test\.ts$/);
    expect(events[0].pid).toBeGreaterThan(0);
    expect(events[0].pid).not.toBe(process.pid);
    expect(events[0].ppid).toBeGreaterThan(0);
    expect(events[1]).toMatchObject({ pid: events[0].pid, spec: events[0].spec });
    expect(events[1].at).toBeGreaterThanOrEqual(events[0].at);
    const quiet = runFixture(body, { fixtureEnv: { WHATSOUP_TEST_TRACE: '0' } });
    expect(quiet.status).toBe(0);
    expect(quiet.output).not.toContain('test-module: ');
  });

  it('fails the actual Vitest hook when a fixture mutates its own src/main.ts', () => {
    const result = runFixture([
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { expect, it } from 'vitest';",
      "it('changes fixture source', () => {",
      "  writeFileSync('src/main.ts', 'export const changed = true;\\n');",
      "  expect(readFileSync('src/main.ts', 'utf8')).toBe('export const changed = true;\\n');",
      '});',
    ].join('\n'));

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('TRIPWIRE src/main.ts mutated: stage=exit-vs-own-entry');
  });

  it('fails before fixture tests when the supplied suite anchor differs from fixture source', () => {
    const result = runFixture([
      "import { expect, it } from 'vitest';",
      "import { original } from './src/main.ts';",
      "it('would pass without the tripwire', () => { expect(original).toBe(true); });",
    ].join('\n'), {
      fixtureEnv: {
        WHATSOUP_TRIPWIRE_MAIN_SHA256: 'f'.repeat(64),
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('TRIPWIRE src/main.ts mutated: stage=enter-vs-suite-anchor');
  });

  it('drops a real inherited parent anchor so the fixture mutation reaches the exit hook', () => {
    const parentAnchor = establishSourceMutationAnchor({ cwd: repoRoot });
    const result = runFixture([
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { expect, it } from 'vitest';",
      "it('changes fixture source', () => {",
      "  writeFileSync('src/main.ts', 'export const changed = true;\\n');",
      "  expect(readFileSync('src/main.ts', 'utf8')).toBe('export const changed = true;\\n');",
      '});',
    ].join('\n'), {
      parentEnv: { ...process.env, WHATSOUP_TRIPWIRE_MAIN_SHA256: parentAnchor },
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('TRIPWIRE src/main.ts mutated: stage=exit-vs-own-entry');
    expect(result.output).not.toContain('stage=enter-vs-suite-anchor');
  });

  it('uses a real fixture change and fails closed when src/main.ts cannot be read', () => {
    const dir = tmp.make('helper');
    mkdirSync(join(dir, 'src'));
    const source = join(dir, 'src', 'main.ts');
    writeFileSync(source, 'export const original = true;\n');
    const anchor = establishSourceMutationAnchor({ cwd: dir });
    writeFileSync(source, 'export const changed = true;\n');
    const reports: string[] = [];

    expect(() => assertSourceMutationUnchanged({
      cwd: dir,
      expectedDigest: anchor,
      stage: 'fixture-change',
      spec: 'source-mutation-tripwire.test.ts',
      report: (message) => reports.push(message),
    })).toThrow('TRIPWIRE src/main.ts mutated: stage=fixture-change');
    expect(reports).toHaveLength(1);

    const missingDir = tmp.make('missing');
    expect(() => establishSourceMutationAnchor({ cwd: missingDir })).toThrow('cannot read src/main.ts');
  });
});
