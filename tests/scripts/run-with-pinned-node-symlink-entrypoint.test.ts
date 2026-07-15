/**
 * Regression test for #1831 — pinned-node guards must fail CLOSED when the
 * wrapper is invoked from a symlinked / out-of-tree worktree.
 *
 * Mechanism: `scripts/run-with-pinned-node.sh` exec'd Node with a *logical*
 * (non-realpath'd) entrypoint path. Node canonicalises the main module, so
 * `import.meta.url` is always the *physical* file:// URL. Every guard gates its
 * body on `import.meta.url === pathToFileURL(process.argv[1]).href`. From a
 * symlinked path (e.g. macOS `/tmp -> /private/tmp`) the two sides disagree,
 * the gate is false, the guard body never runs, and the guard silently exits 0
 * — a fail-OPEN. The fix realpaths the entrypoint in the wrapper so
 * `process.argv[1]` matches Node's realpath'd `import.meta.url`.
 *
 * This test does NOT rely on the ambient `/tmp -> /private/tmp` indirection
 * (which does not exist on Linux CI, where the bug would be invisible). It
 * creates its OWN directory symlink and invokes the wrapper through it, so the
 * regression is reproduced identically on macOS and Linux. It asserts the
 * guard's finding marker — not merely a non-zero exit — so a wrapper FATAL or a
 * broken harness cannot make the test pass for the wrong reason.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const realWrapper = path.join(repoRoot, 'scripts', 'run-with-pinned-node.sh');

// A minimal guard fixture that uses the EXACT canonical main-module gate idiom
// shared by the real guards (source-runtime-drift, doc-drift, publication,
// boundaries, repo). When the gate fires it emits a distinctive finding marker
// and fails closed. If the wrapper hands Node a logical (non-realpath'd) path,
// the gate is false and this body never runs — the fail-open under test.
const FINDING_MARKER = 'FIXTURE-GUARD-1831-RAN:known-bad-finding';
const FIXTURE_GUARD = [
  "import { pathToFileURL } from 'node:url';",
  '',
  'function run(): void {',
  `  console.error('${FINDING_MARKER}');`,
  '  process.exitCode = 1;',
  '}',
  '',
  'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {',
  '  run();',
  '}',
  '',
].join('\n');

const tmpBases: string[] = [];

afterEach(() => {
  for (const dir of tmpBases.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build a self-contained fixture repo (real wrapper copy + .nvmrc + package.json
 * + fixture guard) and a directory symlink pointing at it. `base` is realpath'd
 * so the ONLY symlinked component in the alias path is the alias itself.
 */
function makeSymlinkedFixture(): { realRepo: string; aliasRepo: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-1831-')));
  tmpBases.push(base);

  const realRepo = path.join(base, 'real-repo');
  fs.mkdirSync(path.join(realRepo, 'scripts'), { recursive: true });
  fs.copyFileSync(realWrapper, path.join(realRepo, 'scripts', 'run-with-pinned-node.sh'));
  fs.writeFileSync(path.join(realRepo, 'scripts', 'fixture-guard.ts'), FIXTURE_GUARD, 'utf8');
  fs.writeFileSync(path.join(realRepo, '.nvmrc'), '24.15.0\n', 'utf8');
  fs.writeFileSync(
    path.join(realRepo, 'package.json'),
    JSON.stringify({ name: 'ws-1831-fixture', type: 'module', engines: { node: '>=24.0.0 <26' } }),
    'utf8',
  );

  const aliasRepo = path.join(base, 'alias-repo');
  fs.symlinkSync(realRepo, aliasRepo);

  return { realRepo, aliasRepo };
}

function runGuard(repoDir: string): { stdout: string; stderr: string; exitCode: number } {
  // Invoke the wrapper via an ABSOLUTE path rooted in `repoDir` so REPO_ROOT is
  // derived from that path (independent of any PWD normalisation).
  const wrapper = path.join(repoDir, 'scripts', 'run-with-pinned-node.sh');
  const result = spawnSync('bash', [wrapper, 'scripts/fixture-guard.ts'], {
    encoding: 'utf8',
    cwd: repoDir,
    env: {
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env['HOME'] ?? os.homedir(),
      USER: process.env['USER'] ?? 'testuser',
      // Use the very Node running this test (the pinned runtime) so the version
      // gate and --experimental-strip-types check pass without a real nvm tree.
      WHATSOUP_NODE: process.execPath,
    },
    timeout: 15_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('scripts/run-with-pinned-node.sh — symlinked-worktree entrypoint (#1831)', () => {
  it('runs the guard (fails CLOSED) when invoked through a directory symlink', () => {
    const { aliasRepo } = makeSymlinkedFixture();
    const { stdout, stderr, exitCode } = runGuard(aliasRepo);

    // The guard body MUST execute: assert the finding marker, not just the exit
    // code, so a wrapper FATAL / harness error can't pass for the wrong reason.
    expect(
      stderr,
      `guard body must run from a symlinked path (fail-closed). stdout=<${stdout}> stderr=<${stderr}>`,
    ).toContain(FINDING_MARKER);
    expect(exitCode, 'guard must propagate its non-zero finding exit through the wrapper').toBe(1);
    expect(stderr, 'wrapper must not FATAL from a symlinked path').not.toContain('FATAL');
  });

  it('control: runs the guard through the real (non-symlinked) path too', () => {
    const { realRepo } = makeSymlinkedFixture();
    const { stderr, exitCode } = runGuard(realRepo);
    expect(stderr).toContain(FINDING_MARKER);
    expect(exitCode).toBe(1);
  });
});
