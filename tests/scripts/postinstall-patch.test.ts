import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const [command, ...args] = manifest.scripts.postinstall.trim().split(/\s+/) as string[];
if (command !== 'node' || args.length !== 1 || args[0] !== 'patches/apply.mjs') {
  throw new Error('Review the patch-tool fixture when the installation command changes');
}

const before = "module.exports = 'before';\n";
const after = "module.exports = 'after';\n";
const patch = `diff --git a/node_modules/fixture-dependency/index.js b/node_modules/fixture-dependency/index.js
--- a/node_modules/fixture-dependency/index.js
+++ b/node_modules/fixture-dependency/index.js
@@ -1 +1 @@
-module.exports = 'before';
+module.exports = 'after';
`;

function withPatchFixture(contents: string, check: (fixture: {
  run: (extraEnv?: NodeJS.ProcessEnv) => ReturnType<typeof spawnSync>;
  read: () => string;
  patchPath: string;
  targetPath: string;
  cwd: string;
}) => void) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'whatsoup patch contract '));
  const cwd = path.join(fixtureRoot, 'release');
  const dependency = path.join(cwd, 'node_modules/fixture-dependency');
  const patchPath = path.join(cwd, 'patches/fixture-dependency+1.0.0.patch');
  const targetPath = path.join(dependency, 'index.js');
  try {
    mkdirSync(dependency, { recursive: true });
    mkdirSync(path.join(cwd, 'patches'));
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'patch-contract', version: '1.0.0' }));
    writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0' }));
    writeFileSync(targetPath, contents);
    writeFileSync(patchPath, patch);
    copyFileSync(path.join(repoRoot, args[0]!), path.join(cwd, args[0]!));
    check({
      run: (extraEnv = {}) => spawnSync(process.execPath, args, {
        cwd,
        env: { PATH: '/usr/bin:/bin', CI: 'false', NODE_ENV: 'development', NO_COLOR: '1', ...extraEnv },
        encoding: 'utf8',
        timeout: 10_000,
      }),
      read: () => readFileSync(targetPath, 'utf8'),
      patchPath,
      targetPath,
      cwd,
    });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe('required dependency patch installation', () => {
  it('reports a patch conflict as failure outside CI without changing the target', () => {
    const conflict = "module.exports = 'unrelated';\n";
    withPatchFixture(conflict, ({ run, read }) => {
      const result = run();
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(String(result.stdout) + String(result.stderr)).toContain('Required dependency patch conflicts');
      expect(read()).toBe(conflict);
    });
  });

  it('applies a valid patch and accepts an already-applied patch', () => {
    withPatchFixture(before, ({ run, read }) => {
      for (const attempt of ['first application', 'repeat application']) {
        const result = run();
        expect(result.error, attempt).toBeUndefined();
        expect(result.signal, attempt).toBeNull();
        expect(result.status, String(result.stdout) + String(result.stderr)).toBe(0);
        expect(read(), attempt).toBe(after);
      }
    });
  });

  it('fails without Git instead of treating the patch as already applied', () => {
    withPatchFixture(before, ({ run, read }) => {
      const result = run({ PATH: '' });
      expect(result.status).toBe(1);
      expect(String(result.stderr)).toContain('Cannot run required dependency patch');
      expect(read()).toBe(before);
    });
  });

  it('fails when the required patch file is missing', () => {
    withPatchFixture(before, ({ run, read, patchPath }) => {
      rmSync(patchPath);
      const result = run();
      expect(result.status).toBe(1);
      expect(String(result.stderr)).toContain('No required dependency patch files found');
      expect(read()).toBe(before);
    });
  });

  it('rejects malformed patches without changing the target', () => {
    withPatchFixture(before, ({ run, read, patchPath }) => {
      writeFileSync(patchPath, 'not a patch\n');
      expect(run().status).toBe(1);
      expect(read()).toBe(before);
    });
  });

  it('fails when the installed dependency target is missing', () => {
    withPatchFixture(before, ({ run, targetPath }) => {
      rmSync(targetPath);
      expect(run().status).toBe(1);
    });
  });

  it.each(['automatic parent discovery', 'inherited repository environment'])(
    'applies a nested release export despite %s',
    (context) => {
      withPatchFixture(before, ({ run, read, cwd }) => {
        const foreign = path.dirname(cwd);
        const init = spawnSync('git', ['init', '--quiet', foreign], { encoding: 'utf8' });
        expect(init.status, String(init.stderr)).toBe(0);
        const result = run(context === 'inherited repository environment'
          ? { GIT_DIR: path.join(foreign, '.git'), GIT_WORK_TREE: foreign }
          : {});
        expect(result.status, String(result.stderr)).toBe(0);
        expect(read()).toBe(after);
      });
    },
  );

  it('stages the patch entry point and Git before the Docker production install', () => {
    const dockerfile = readFileSync(path.join(repoRoot, 'docker/Dockerfile'), 'utf8');
    const deps = dockerfile.split(/^FROM /m)[1]!;
    const install = deps.indexOf('RUN npm ci --omit=dev');
    expect(install).toBeGreaterThan(0);
    const beforeInstall = deps.slice(0, install).replace(/\\\n/g, ' ');
    expect(beforeInstall).toMatch(/^COPY patches\/ \.\/patches\/$/m);
    expect(beforeInstall).toMatch(/apt-get install\b[^\n]*\bgit\b/);
    expect(deps.slice(install)).not.toContain('--ignore-scripts');
  });
});
