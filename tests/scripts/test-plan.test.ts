import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestPlan, parseTestOptions } from '../../scripts/test-plan.ts';
import { EXPLICIT_REQUIRED_RUNTIME_PATHS } from '../../scripts/check-bot-errors-runtime-manifest.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('test-plan-');

function repository(): string {
  const cwd = tmp.make('repo');
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  mkdirSync(join(cwd, 'src/lib'), { recursive: true });
  writeFileSync(join(cwd, 'src/lib/format.ts'), 'export const format = String;\n');
  writeFileSync(join(cwd, 'README.md'), 'Example\n');
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  return cwd;
}

function writeValidManifest(cwd: string, extraPath: string): void {
  const files = [...EXPLICIT_REQUIRED_RUNTIME_PATHS, extraPath].map((path) => {
    const absolute = join(cwd, path);
    mkdirSync(dirname(absolute), { recursive: true });
    if (!existsSync(absolute)) writeFileSync(absolute, 'fixture\n');
    return { path, sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') };
  });
  writeFileSync(join(cwd, 'deploy/bot-errors-runtime-manifest.json'), JSON.stringify({ schemaVersion: 1, files }));
}

describe('test planning', () => {
  it('treats docs as no application work and --full as all lanes', () => {
    const docs = createTestPlan(process.cwd(), parseTestOptions(['--files', 'README.md']));
    expect(docs.profile).toBe('docs');
    expect(Object.values(docs.lanes)).toEqual(Array(7).fill(false));
    const full = createTestPlan(process.cwd(), parseTestOptions(['--full']));
    expect(full.profile).toBe('full');
    expect(Object.values(full.lanes)).toEqual(Array(7).fill(true));
  });

  it.each([
    ['--base'], ['--max-workers', '0'], ['--max-workers', '5'],
    ['--timeout-ms', 'NaN'], ['--timeout-ms', '2147483648'],
    ['--suite', 'surprise'], ['--bsae', 'HEAD'], ['--files'],
    ['--base', 'HEAD', '--files', 'README.md'], ['--base', '--full'],
    ['--coverage', '--suite', 'browser'], ['--files', '../README.md'],
  ])('rejects invalid arguments without silently broadening or skipping: %j', (...args) => {
    expect(() => parseTestOptions(args)).toThrow();
  });

  it('detects deletion even when only an otherwise low risk source disappears', () => {
    const cwd = repository();
    execFileSync('git', ['rm', 'src/lib/format.ts'], { cwd, timeout: 10_000 });
    const plan = createTestPlan(cwd, parseTestOptions(['--base', 'HEAD']));
    expect(plan.profile).toBe('full');
    expect(plan.reasons.join(' ')).toMatch(/delet|rename/i);
    expect(plan.changedFiles).toContain('src/lib/format.ts');
  });

  it('includes untracked inputs and worktree edits against the merge base', () => {
    const cwd = repository();
    writeFileSync(join(cwd, 'README.md'), 'Changed\n');
    writeFileSync(join(cwd, 'unknown.dat'), 'fixture');
    const plan = createTestPlan(cwd, parseTestOptions(['--base', 'HEAD']));
    expect(plan.changedFiles).toEqual(['README.md', 'unknown.dat']);
    expect(plan.profile).toBe('full');
  });

  it('rejects a missing base instead of inventing a clean diff', () => {
    expect(() => createTestPlan(repository(), parseTestOptions(['--base', 'missing-ref']))).toThrow();
  });

  it('uses the maintained deployment manifest to select Python parity for an ordinary library path', () => {
    const cwd = repository();
    writeValidManifest(cwd, 'src/lib/format.ts');
    const plan = createTestPlan(cwd, parseTestOptions(['--files', 'src/lib/format.ts']));
    expect(plan.profile).toBe('full');
    expect(plan.lanes.python).toBe(true);
    expect(plan.reasons).toEqual(['deployment runtime change: src/lib/format.ts']);
  });

  it('keeps an unrelated library change on the affected path with a valid manifest', () => {
    const cwd = repository();
    writeValidManifest(cwd, 'src/lib/another.ts');
    const plan = createTestPlan(cwd, parseTestOptions(['--files', 'src/lib/format.ts']));
    expect(plan.profile).toBe('affected');
    expect(plan.lanes).toMatchObject({ root: true, compatibility: true, python: false });
  });

  it.each(['missing', 'changed'])('selects full validation when deployment evidence is %s', (condition) => {
    const cwd = repository();
    writeValidManifest(cwd, 'src/lib/another.ts');
    if (condition === 'missing') unlinkSync(join(cwd, 'src/lib/another.ts'));
    else writeFileSync(join(cwd, 'src/lib/another.ts'), 'drift\n');
    const plan = createTestPlan(cwd, parseTestOptions(['--files', 'src/lib/format.ts']));
    expect(plan.profile).toBe('full');
    expect(plan.lanes.python).toBe(true);
    expect(plan.reasons).toEqual(['Invalid deployment runtime manifest requires full validation']);
  });

  it.each([undefined, '{', '{"schemaVersion":1,"files":[]}', '{"schemaVersion":2,"files":[]}'])
    ('fails closed on an unavailable or invalid deployment manifest: %s', (manifest) => {
      const cwd = repository();
      if (manifest !== undefined) {
        mkdirSync(join(cwd, 'deploy'));
        writeFileSync(join(cwd, 'deploy/bot-errors-runtime-manifest.json'), manifest);
      }
      const plan = createTestPlan(cwd, parseTestOptions(['--files', 'src/lib/format.ts']));
      expect(plan.profile).toBe('full');
      expect(plan.lanes.python).toBe(true);
      expect(plan.reasons.join(' ')).toMatch(/deployment runtime manifest requires full validation/);
    });

  it('preserves an explicit small time budget even when full validation is selected', () => {
    const plan = createTestPlan(process.cwd(), parseTestOptions(['--full', '--timeout-ms', '120000']));
    expect(plan.timeoutMs).toBe(120000);
  });

  it('runs the dependency-free CLI from a checkout with no installed packages', () => {
    const result = spawnSync(process.execPath, [resolve('scripts/test-plan.ts'), '--files', 'README.md', '--json'], {
      cwd: repository(), encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, profile: 'docs', effect: 'read-only' });
  });
});
