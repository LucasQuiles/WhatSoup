/**
 * Phantom-dependency guard — end-to-end, including the red proof.
 *
 * `dependency-declarations.test.ts` covers the pure rules. What this proves is the part that
 * only works end-to-end: that the guard enumerates tracked files, walks the package.json
 * chain PER FILE, and refuses to call an unscannable tree clean.
 *
 * The `--repo` seam points the production path at a throwaway git repo; resolution, parsing
 * and the phantom rules are unchanged.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const guardPath = resolve(repoRoot, 'scripts/phantom-dependency-guard.ts');

const tempRoots: string[] = [];
afterAll(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined } as NodeJS.ProcessEnv,
  });
}

/**
 * A throwaway repo. `files` is path -> contents; `manifests` is dir -> dependency names.
 * Padding is added so the scan clears the guard's non-vacuity floors (200 files / 300 sites).
 */
function makeRepo(files: Record<string, string>, manifests: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-dep-'));
  tempRoots.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'guard@test.invalid']);
  git(dir, ['config', 'user.name', 'guard test']);

  for (const [dirPath, deps] of Object.entries(manifests)) {
    const abs = join(dir, dirPath);
    mkdirSync(abs, { recursive: true });
    writeFileSync(
      join(abs, 'package.json'),
      JSON.stringify({ name: dirPath || 'root', dependencies: Object.fromEntries(deps.map((d) => [d, '1.0.0'])) }, null, 2),
    );
  }

  const all: Record<string, string> = { ...files };
  // 250 padding modules, two relative import sites each -> clears both floors honestly.
  for (let i = 0; i < 250; i++) {
    all[`src/pad/p${i}.ts`] =
      `import { v${(i + 1) % 250} } from './p${(i + 1) % 250}.ts';\n` +
      `import { v${(i + 2) % 250} } from './p${(i + 2) % 250}.ts';\n` +
      `export const v${i} = 1;\n`;
  }

  for (const [name, body] of Object.entries(all)) {
    const abs = join(dir, name);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'fixture']);
  return dir;
}

function runGuard(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', guardPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('phantom-dependency guard — the red proof', () => {
  it('BLOCKS (exit 1) on an import of an undeclared package', () => {
    const dir = makeRepo(
      { 'src/a.ts': `import ghost from 'ghost-pkg';\nexport const a = ghost;\n` },
      { '': ['pino'] },
    );

    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', resolve(repoRoot, 'scripts/phantom-dependency-guard.ts'), '--repo', dir],
      { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
    );
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    if (result.status !== 1) console.error(`guard exited ${result.status}, expected 1:\n${out}`);
    expect(result.status).toBe(1);
    expect(out).toMatch(/ghost-pkg/);
    expect(out).toMatch(/src\/a\.ts/);
    expect(out, 'must say why it matters').toMatch(/clean install/);
  });

  it('PASSES (exit 0) when the package is declared at the root', () => {
    const dir = makeRepo(
      { 'src/a.ts': `import pino from 'pino';\nexport const a = pino;\n` },
      { '': ['pino'] },
    );
    const { status, out } = runGuard(['--repo', dir]);
    expect(status, out).toBe(0);
  });

  it('PASSES when only a SUB-PACKAGE declares it — resolution is per file', () => {
    // The real false positive from the first recon pass: tools/whatsoup_guard declares
    // better-sqlite3 and the root does not. A root-only comparison calls this a phantom.
    const dir = makeRepo(
      { 'tools/sub/x.ts': `import type { D } from 'sub-only-pkg';\nexport type T = D;\n` },
      { '': ['pino'], 'tools/sub': ['sub-only-pkg'] },
    );
    const { status, out } = runGuard(['--repo', dir]);
    expect(status, `sub-package declaration must satisfy the import:\n${out}`).toBe(0);
  });

  it('PASSES when intermediate directories have no package.json', () => {
    const dir = makeRepo(
      { 'tools/nested/deep/x.ts': `import pino from 'pino';\nexport const x = pino;\n` },
      { '': ['pino'] },
    );
    const { status, out } = runGuard(['--repo', dir]);
    expect(status, `an absent intermediate manifest is not an error:\n${out}`).toBe(0);
  });

  it('is INCONCLUSIVE when a manifest in the import chain is malformed', () => {
    const dir = makeRepo(
      { 'tools/sub/x.ts': `import pino from 'pino';\nexport const x = pino;\n` },
      { '': ['pino'], 'tools/sub': ['pino'] },
    );
    writeFileSync(join(dir, 'tools/sub/package.json'), '{ malformed');

    const { status, out } = runGuard(['--repo', dir]);
    expect(status, `a malformed manifest must not inherit a clean root declaration:\n${out}`).toBe(2);
    expect(out).toMatch(/tools\/sub\/package\.json/);
    expect(out).toMatch(/inconclusive/i);
    expect(out).not.toContain(dir);
  });

  it('is INCONCLUSIVE when a tracked source file cannot be read', () => {
    const dir = makeRepo({}, { '': ['pino'] });
    symlinkSync('missing-target.ts', join(dir, 'src/unreadable.ts'));
    git(dir, ['add', 'src/unreadable.ts']);
    git(dir, ['commit', '-qm', 'add unreadable tracked source']);

    const { status, out } = runGuard(['--repo', dir]);
    expect(status, `an unreadable tracked source must not be skipped:\n${out}`).toBe(2);
    expect(out).toMatch(/src\/unreadable\.ts/);
    expect(out).toMatch(/inconclusive/i);
    expect(out).not.toContain(dir);
  });

  it('BLOCKS when a sibling declares it but the importer does not inherit it', () => {
    // Declarations flow UP from the file, never sideways. tools/other's manifest must not
    // satisfy an import in src/.
    const dir = makeRepo(
      { 'src/a.ts': `import x from 'sibling-pkg';\nexport const a = x;\n` },
      { '': ['pino'], 'tools/other': ['sibling-pkg'] },
    );
    const { status, out } = runGuard(['--repo', dir]);
    expect(status, out).toBe(1);
    expect(out).toMatch(/sibling-pkg/);
  });

  it('BLOCKS a phantom in a tracked source whose name contains node_modules', () => {
    const dir = makeRepo(
      {
        'src/node_modules-helper.ts':
          `import ghost from 'ghost-pkg';\nexport const helper = ghost;\n`,
      },
      { '': ['pino'] },
    );
    const { status, out } = runGuard(['--repo', dir]);
    expect(status, `a pathname substring must not remove tracked source from the scan:\n${out}`).toBe(1);
    expect(out).toMatch(/ghost-pkg/);
    expect(out).toMatch(/src\/node_modules-helper\.ts/);
  });

  it('BLOCKS a phantom in a tracked source with a newline in its name', () => {
    const dir = makeRepo(
      {
        'src/line\nbreak.ts': `import ghost from 'ghost-pkg';\nexport const line = ghost;\n`,
      },
      { '': ['pino'] },
    );
    const { status, out } = runGuard(['--repo', dir]);
    expect(status, `NUL-delimited enumeration must preserve unusual tracked names:\n${out}`).toBe(1);
    expect(out).toMatch(/ghost-pkg/);
    expect(out).toContain('src/line\\nbreak.ts');
    expect(out).not.toContain('src/line\nbreak.ts');
  });

  it('IGNORES node builtins in both spellings', () => {
    const dir = makeRepo(
      {
        'src/a.ts':
          `import { readFileSync } from 'node:fs';\n` +
          `import { join } from 'path';\n` +
          `import { x } from './pad/p0.ts';\n` +
          `export const a = [readFileSync, join, x];\n`,
      },
      { '': ['pino'] },
    );
    const { status, out } = runGuard(['--repo', dir]);
    expect(status, `builtins must not be reported as phantoms:\n${out}`).toBe(0);
  });

  it('is INCONCLUSIVE (exit 2), never a pass, when the scan is implausibly small', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phantom-dep-tiny-'));
    tempRoots.push(dir);
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'g@t.invalid']);
    git(dir, ['config', 'user.name', 'g']);
    writeFileSync(join(dir, 'package.json'), '{"name":"tiny"}');
    writeFileSync(join(dir, 'only.ts'), `import g from 'ghost-pkg';\nexport const x = g;\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'tiny']);

    const { status, out } = runGuard(['--repo', dir]);
    expect(status, `expected INCONCLUSIVE, got ${status}:\n${out}`).toBe(2);
    expect(out).toMatch(/implausibly small/);
  });

  it('refuses a flag-shaped value instead of using it as a path', () => {
    const { status, out } = runGuard(['--repo', '--json']);
    expect(status).toBe(2);
    expect(out).toMatch(/another flag/);
  });

  it('refuses an unknown flag rather than silently ignoring it', () => {
    const { status, out } = runGuard(['--repoo', '/tmp']);
    expect(status).toBe(2);
    expect(out).toMatch(/Unknown argument/);
  });
});

describe('phantom-dependency guard — this repo', () => {
  it('reports no phantoms over a non-vacuous scan', () => {
    // Green on arrival: 1972 tracked source files / 9818 import sites / 0 phantoms when
    // written. The counts are asserted so a pass over an empty scan cannot look identical
    // to a pass over the real tree.
    const { status, out } = runGuard(['--json']);
    expect(status, `guard is not green on arrival:\n${out}`).toBe(0);
    const report = JSON.parse(out) as {
      files: number;
      importSites: number;
      phantoms: unknown[];
      unverifiable: unknown[];
    };
    expect(report.phantoms).toEqual([]);
    expect(report.unverifiable).toEqual([]);
    expect(report.files).toBeGreaterThan(1000);
    expect(report.importSites).toBeGreaterThan(5000);
  });
});
