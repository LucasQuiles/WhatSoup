import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const [command, ...args] = manifest.scripts.postinstall.trim().split(/\s+/) as string[];
if (command !== 'patch-package' || args.some((arg) => !arg.startsWith('--'))) {
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

function withPatchFixture(contents: string, check: (run: () => ReturnType<typeof spawnSync>, read: () => string) => void) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'whatsoup-patch-contract-'));
  const dependency = path.join(cwd, 'node_modules/fixture-dependency');
  try {
    mkdirSync(dependency, { recursive: true });
    mkdirSync(path.join(cwd, 'patches'));
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'patch-contract', version: '1.0.0' }));
    writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'fixture-dependency', version: '1.0.0' }));
    writeFileSync(path.join(dependency, 'index.js'), contents);
    writeFileSync(path.join(cwd, 'patches/fixture-dependency+1.0.0.patch'), patch);
    check(() => spawnSync(process.execPath, [path.join(repoRoot, 'node_modules/patch-package/index.js'), ...args], {
      cwd,
      env: { PATH: '/usr/bin:/bin', CI: 'false', NODE_ENV: 'development', NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 10_000,
    }), () => readFileSync(path.join(dependency, 'index.js'), 'utf8'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('required dependency patch installation', () => {
  it('reports a patch conflict as failure outside CI without changing the target', () => {
    const conflict = "module.exports = 'unrelated';\n";
    withPatchFixture(conflict, (run, read) => {
      const result = run();
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(String(result.stdout) + String(result.stderr)).toContain('Failed to apply patch');
      expect(read()).toBe(conflict);
    });
  });

  it('applies a valid patch and accepts an already-applied patch', () => {
    withPatchFixture(before, (run, read) => {
      for (const attempt of ['first application', 'repeat application']) {
        const result = run();
        expect(result.error, attempt).toBeUndefined();
        expect(result.signal, attempt).toBeNull();
        expect(result.status, String(result.stdout) + String(result.stderr)).toBe(0);
        expect(read(), attempt).toBe(after);
      }
    });
  });
});
