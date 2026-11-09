import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertRepositoryInputUnchanged,
  captureRepositoryInputSnapshot,
} from '../../scripts/lib/source-mutation.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('source-mutation-');

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeRepository(): string {
  const cwd = tmp.make('repo');
  mkdirSync(join(cwd, 'src', 'lib'), { recursive: true });
  mkdirSync(join(cwd, 'tests', 'fixtures'), { recursive: true });
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  writeFileSync(join(cwd, '.gitignore'), 'dist/\ncoverage/\n.local/\n');
  writeFileSync(join(cwd, 'src', 'main.ts'), 'export const main = true;\n');
  writeFileSync(join(cwd, 'src', 'lib', 'helper.ts'), 'export const helper = true;\n');
  writeFileSync(join(cwd, 'tests', 'fixtures', 'input.ts'), 'export const fixture = true;\n');
  symlinkSync('/outside-the-repository', join(cwd, 'src', 'lib', 'external-link.ts'));
  git(cwd, ['init', '--quiet']);
  git(cwd, ['add', '.']);
  return cwd;
}

describe('repository input snapshot', () => {
  it('accepts unchanged dirty inputs and ignores generated paths', () => {
    const cwd = makeRepository();
    writeFileSync(join(cwd, 'src', 'lib', 'helper.ts'), 'export const helper = "dirty before snapshot";\n');
    const snapshot = captureRepositoryInputSnapshot({ cwd });

    mkdirSync(join(cwd, 'dist'), { recursive: true });
    mkdirSync(join(cwd, 'coverage'), { recursive: true });
    writeFileSync(join(cwd, 'dist', 'generated.ts'), 'not an input\n');
    writeFileSync(join(cwd, 'coverage', 'summary.json'), '{}\n');

    expect(() => assertRepositoryInputUnchanged({
      cwd,
      snapshot,
      stage: 'fixture-positive',
      report: () => {},
    })).not.toThrow();
  });

  it('fails closed when a tracked non-main source helper changes after capture', () => {
    const cwd = makeRepository();
    const snapshot = captureRepositoryInputSnapshot({ cwd });
    const reports: string[] = [];
    writeFileSync(join(cwd, 'src', 'lib', 'helper.ts'), 'export const helper = false;\n');

    expect(() => assertRepositoryInputUnchanged({
      cwd,
      snapshot,
      stage: 'fixture-helper-change',
      report: (message) => reports.push(message),
    })).toThrow('FINAL-SOURCE drift: stage=fixture-helper-change changed=src/lib/helper.ts');
    expect(reports).toHaveLength(1);
  });

  it('treats a tracked deletion that predates capture as an input state, then detects a later deletion', () => {
    const cwd = makeRepository();
    unlinkSync(join(cwd, 'src', 'lib', 'helper.ts'));
    const preDeleted = captureRepositoryInputSnapshot({ cwd });
    expect(() => assertRepositoryInputUnchanged({
      cwd,
      snapshot: preDeleted,
      stage: 'fixture-pre-deleted',
      report: () => {},
    })).not.toThrow();

    const fresh = makeRepository();
    const snapshot = captureRepositoryInputSnapshot({ cwd: fresh });
    unlinkSync(join(fresh, 'src', 'lib', 'helper.ts'));
    expect(() => assertRepositoryInputUnchanged({
      cwd: fresh,
      snapshot,
      stage: 'fixture-later-deleted',
      report: () => {},
    })).toThrow('FINAL-SOURCE drift: stage=fixture-later-deleted deleted=src/lib/helper.ts');
  });

  it('detects a new nonignored input after capture', () => {
    const cwd = makeRepository();
    const snapshot = captureRepositoryInputSnapshot({ cwd });
    writeFileSync(join(cwd, 'scripts', 'new-input.ts'), 'export const newInput = true;\n');

    expect(() => assertRepositoryInputUnchanged({
      cwd,
      snapshot,
      stage: 'fixture-added',
      report: () => {},
    })).toThrow('FINAL-SOURCE drift: stage=fixture-added added=scripts/new-input.ts');
  });

  it('fails closed when Git cannot enumerate the repository inputs', () => {
    const cwd = makeRepository();
    expect(() => captureRepositoryInputSnapshot({
      cwd,
      dependencies: {
        listFiles: () => {
          throw new Error('simulated Git enumeration failure');
        },
      },
    })).toThrow('FINAL-SOURCE cannot enumerate repository inputs: simulated Git enumeration failure');
  });
});
