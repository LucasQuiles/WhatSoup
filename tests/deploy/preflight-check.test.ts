// tests/deploy/preflight-check.test.ts
//
// Black-box tests for the restart-safety pre-flight gate
// (deploy/preflight-check.sh + deploy/preflight-probe.ts) and its wiring into
// the launch wrapper (deploy/whatsoup).
//
// These tests reproduce the exact restart-landmine incident class
// (2026-06-12: mini1 personal + nucles hub): a tree whose live import graph
// references a module/export that exists nowhere on disk. The OLD cached process
// runs fine; a RESTART loads the broken on-disk code and crash-loops at module
// link time. The gate must refuse to start such a tree.
//
// Strategy: build minimal fixture trees with a deliberate phantom import (and a
// clean tree, a cred-only-failing tree, and a missing-file tree), spawn the gate
// with WHATSOUP_NODE pointed at the pinned interpreter, and assert the exit code
// and operator message. No sleeps — synchronous spawn + result inspection.

import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const PREFLIGHT = join(REPO_ROOT, 'deploy/preflight-check.sh');
const WRAPPER = join(REPO_ROOT, 'deploy/whatsoup');
const SPAWN_TIMEOUT_MS = 15_000;

// The pinned interpreter under test. The fixture repo is generated to match the
// same Node that runs this suite, so the preflight behavior stays portable across
// fleet hosts instead of depending on a host nvm install.
const PINNED_NODE = process.execPath;
const PINNED_NODE_VERSION = process.versions.node;
const PINNED_NODE_MAJOR = Number(PINNED_NODE_VERSION.split('.')[0]);
const FIXTURE_NODE_RANGE = `>=${PINNED_NODE_MAJOR}.0.0 <${PINNED_NODE_MAJOR + 1}`;

// The preflight script's import-graph probe behaves differently on
// Node >=26 (outside the repo's >=24 <26 pin) — every scenario exits 1 there
// while the 24.x/25.x CI matrix is green. Skip on out-of-pin hosts rather than
// reporting false failures; the pin itself is enforced by guard:node-pin-consistency.
const NODE_IN_PIN = PINNED_NODE_MAJOR >= 24 && PINNED_NODE_MAJOR < 26;

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-test-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Builds a minimal repo-shaped fixture tree (.nvmrc + package.json + src/main.ts).
 * mainTs is the literal contents of src/main.ts; extraFiles maps relative paths
 * (under the fixture root) to file contents.
 */
function makeFixtureTree(
  mainTs: string,
  extraFiles: Record<string, string> = {},
): string {
  const root = makeTmpDir();
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.nvmrc'), `${PINNED_NODE_VERSION}\n`, 'utf8');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', engines: { node: FIXTURE_NODE_RANGE } }),
    'utf8',
  );
  writeFileSync(join(root, 'src', 'main.ts'), mainTs, 'utf8');
  for (const [rel, contents] of Object.entries(extraFiles)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }
  return root;
}

const GIT_FIXTURE_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@local',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@local',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function gitFixture(repoRoot: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: GIT_FIXTURE_ENV,
    timeout: SPAWN_TIMEOUT_MS,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

function runPreflight(
  repoRoot: string,
  instance = '',
  env: Record<string, string> = {},
): { status: number; stderr: string; stdout: string } {
  const result = spawnSync('bash', [PREFLIGHT, repoRoot, instance], {
    encoding: 'utf8',
    env: { ...process.env, WHATSOUP_NODE: PINNED_NODE, ...env },
    timeout: SPAWN_TIMEOUT_MS,
  });
  return {
    status: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

// @skip-env this suite validates the restart-safety preflight under the repo's
// supported Node pin; out-of-pin Node versions produce false preflight failures.
describe.skipIf(!NODE_IN_PIN)('deploy/preflight-check.sh — restart-safety gate', () => {
  it('exists and is executable shell', () => {
    expect(existsSync(PREFLIGHT)).toBe(true);
    expect(() => accessSync(PREFLIGHT, fsConstants.X_OK)).not.toThrow();
    const synCheck = spawnSync('bash', ['-n', PREFLIGHT], {
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    expect(synCheck.status).toBe(0);
  });

  it('(a) blocks a tree with a phantom EXPORT — the nucles incident — exit 3', () => {
    // helper.ts exists but does NOT export `isProviderPolicyBlockMessage`,
    // exactly mirroring nucles failure-taxonomy.ts missing that export.
    const root = makeFixtureTree(
      "import { isProviderPolicyBlockMessage } from './failure-taxonomy.ts';\nconsole.log(isProviderPolicyBlockMessage);\n",
      {
        'src/failure-taxonomy.ts':
          'export const isPromptTooLongMessage = () => false;\n',
      },
    );
    const { status, stderr } = runPreflight(root, 'q-bot');

    expect(status).toBe(3);
    expect(stderr).toContain('PREFLIGHT-FAIL');
    expect(stderr).toContain('REFUSING TO START');
    expect(stderr).toContain('isProviderPolicyBlockMessage');
    expect(stderr).toContain('last-known-good');
  });

  it('(a2) blocks a tree with a phantom MODULE (missing file) — exit 3', () => {
    const root = makeFixtureTree("import './does-not-exist.ts';\n");
    const { status, stderr } = runPreflight(root);

    expect(status).toBe(3);
    expect(stderr).toContain('PREFLIGHT-FAIL');
    expect(stderr).toContain('missing module');
  });

  it('blocks a phantom MODULE reachable only from the lazy agent session path', () => {
    const root = makeFixtureTree('export const mainOk = true;\n', {
      'src/runtimes/agent/session.ts': "import './prompt-compose.ts';\n",
    });
    const { status, stderr } = runPreflight(root);

    expect(status).toBe(3);
    expect(stderr).toContain('PREFLIGHT-FAIL');
    expect(stderr).toContain('session.ts');
    expect(stderr).toContain('missing module');
  });

  it('(b) allows a clean, link-resolvable tree — exit 0', () => {
    const root = makeFixtureTree(
      "import { ok } from './helper.ts';\nconsole.log(ok);\n",
      { 'src/helper.ts': 'export const ok = true;\n' },
    );
    const { status, stderr } = runPreflight(root);

    expect(status).toBe(0);
    expect(stderr).toContain('PREFLIGHT-OK');
  });

  it('(c) treats a credential/env-only init failure as SAFE — exit 0', () => {
    // Import graph fully links; module throws at init only for missing creds.
    const root = makeFixtureTree(
      "throw new Error('Missing credentials. Please set the OPENAI_API_KEY environment variable.');\n",
    );
    const { status, stderr } = runPreflight(root);

    expect(status).toBe(0);
    expect(stderr).toContain('CRED-OK');
    expect(stderr).toContain('PREFLIGHT-OK');
  });

  it('refuses a git tree with tracked file drift before restart', () => {
    const root = makeFixtureTree(
      "import { ok } from './helper.ts';\nconsole.log(ok);\n",
      { 'src/helper.ts': 'export const ok = true;\n' },
    );
    gitFixture(root, ['init', '-q']);
    gitFixture(root, ['add', '.']);
    gitFixture(root, ['commit', '-m', 'base']);
    writeFileSync(join(root, 'src', 'helper.ts'), 'export const ok = false;\n', 'utf8');

    const { status, stderr } = runPreflight(root);

    expect(status).toBe(3);
    expect(stderr).toContain('tracked file drift');
    expect(stderr).toContain('git diff HEAD --exit-code');
  });

  it('refuses a lockfile-backed tree when root node_modules is absent', () => {
    const root = makeFixtureTree('export const mainOk = true;\n');
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }),
      'utf8',
    );

    const { status, stderr } = runPreflight(root);

    expect(status).toBe(3);
    expect(stderr).toContain('dependencies are not installed');
    expect(stderr).toContain('npm ci');
  });

  it('emits a dirty-tree advisory but still resolves verdict on a git tree', () => {
    const root = makeFixtureTree(
      "import { ok } from './helper.ts';\nconsole.log(ok);\n",
      { 'src/helper.ts': 'export const ok = true;\n' },
    );
    // Make it a git repo with an uncommitted file so the advisory fires.
    // Strip hook-injected git env so init targets the fixture, not the repo
    // whose hook may be running this suite (pre-push exports GIT_DIR).
    const gitEnv = { ...process.env };
    delete gitEnv['GIT_DIR'];
    delete gitEnv['GIT_WORK_TREE'];
    delete gitEnv['GIT_INDEX_FILE'];
    spawnSync('git', ['init', '-q'], { cwd: root, env: gitEnv, timeout: SPAWN_TIMEOUT_MS });
    writeFileSync(join(root, 'untracked.txt'), 'dirty\n', 'utf8');
    const { status, stderr } = runPreflight(root);

    expect(status).toBe(0);
    expect(stderr).toContain('PREFLIGHT-WARN');
    expect(stderr).toMatch(/uncommitted|untracked/);
  });
});

// @skip-env this wrapper behavior test shells through the same pinned preflight
// path; out-of-pin Node versions are covered by guard:node-pin-consistency.
describe.skipIf(!NODE_IN_PIN)('deploy/whatsoup — pre-flight behavior', () => {
  it('refuses to launch when preflight fails (phantom export), not exec node', () => {
    const root = makeFixtureTree(
      "import { phantom } from './helper.ts';\nconsole.log(phantom);\n",
      { 'src/helper.ts': 'export const real = 1;\n' },
    );
    // Invoke the gate the same way the wrapper does (the wrapper passes
    // WHATSOUP_NODE through to preflight-check.sh).
    const { status, stderr } = runPreflight(root, 'q-bot');
    expect(status).toBe(3);
    expect(stderr).toContain('REFUSING TO START');
  });
});

describe('deploy/whatsoup — source wiring', () => {
  it('declares skip-preflight as an explicit =1 emergency override with a warning', () => {
    const wrapper = readFileSync(WRAPPER, 'utf8');
    expect(wrapper).toContain('if [ "${WHATSOUP_SKIP_PREFLIGHT:-}" = "1" ]; then');
    expect(wrapper).toContain('restart-safety pre-flight gate BYPASSED');
    expect(wrapper).toContain('Set WHATSOUP_SKIP_PREFLIGHT=1 to override in an emergency');
  });

  it('fails closed when preflight-check refuses wrapper startup', () => {
    const wrapper = readFileSync(WRAPPER, 'utf8');
    const preflightStart = wrapper.indexOf('if ! WHATSOUP_NODE="$NODE" "$SCRIPT_DIR/preflight-check.sh" "$REPO_ROOT" "$INSTANCE"; then');
    const bootstrapExec = wrapper.indexOf('"$REPO_ROOT/src/bootstrap.ts" "$INSTANCE"');
    expect(preflightStart).toBeGreaterThan(-1);
    expect(bootstrapExec).toBeGreaterThan(preflightStart);

    const preBootstrap = wrapper.slice(preflightStart, bootstrapExec);
    expect(preBootstrap).toContain('FATAL: restart-safety pre-flight gate refused to start');
    expect(preBootstrap).toMatch(/\n\s*exit 1\n/);
  });

  it('wires preflight-check BEFORE the node exec of bootstrap.ts', () => {
    const wrapper = readFileSync(WRAPPER, 'utf8');
    const preflightIndex = wrapper.indexOf('preflight-check.sh');
    const bootstrapIndex = wrapper.lastIndexOf('bootstrap.ts');
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeLessThan(bootstrapIndex);
  });

  it('shares node-pin logic via deploy/lib/resolve-node.sh (DRY with wrapper)', () => {
    expect(readFileSync(WRAPPER, 'utf8')).toContain('lib/resolve-node.sh');
    expect(readFileSync(PREFLIGHT, 'utf8')).toContain('lib/resolve-node.sh');
  });
});
