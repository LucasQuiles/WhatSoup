import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
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
  it('hashes all bytes across read chunks, including the final partial chunk', () => {
    const cwd = makeRepository();
    const contents = Buffer.alloc(131_079, 7);
    contents[65_536] = 19;
    contents[contents.length - 1] = 31;
    writeFileSync(join(cwd, 'chunked.bin'), contents);
    const snapshot = captureRepositoryInputSnapshot({ cwd });
    expect(snapshot.entries.get('chunked.bin')).toBe(`file:${createHash('sha256').update(contents).digest('hex')}`);
    contents[contents.length - 1] = 32;
    writeFileSync(join(cwd, 'chunked.bin'), contents);
    expect(() => assertRepositoryInputUnchanged({ cwd, snapshot, stage: 'chunk-tail', report: () => {} }))
      .toThrow('changed=chunked.bin');
  });

  it('refuses an oversized sparse input with a controlled diagnostic', () => {
    const cwd = makeRepository();
    const input = join(cwd, 'oversized.bin');
    writeFileSync(input, '');
    truncateSync(input, 64 * 1024 * 1024 + 1);
    expect(() => captureRepositoryInputSnapshot({ cwd }))
      .toThrow('FINAL-SOURCE cannot snapshot repository input: oversized.bin exceeds 67108864-byte file limit');
  });

  it('refuses an aggregate input size above the snapshot budget', () => {
    const cwd = makeRepository();
    for (let index = 0; index < 9; index += 1) {
      const input = join(cwd, `part-${index}.bin`);
      writeFileSync(input, '');
      truncateSync(input, 64 * 1024 * 1024);
    }
    expect(() => captureRepositoryInputSnapshot({ cwd }))
      .toThrow('repository inputs exceed 536870912-byte snapshot limit');
  });

  it('refuses excess input count before inspecting any path', () => {
    const cwd = makeRepository();
    expect(() => captureRepositoryInputSnapshot({
      cwd,
      dependencies: { listFiles: () => Array.from({ length: 50_001 }, (_, index) => `missing-${index}`) },
    })).toThrow('repository inputs exceed 50000-path snapshot limit');
  });

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
