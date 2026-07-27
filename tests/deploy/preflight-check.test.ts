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
  chmodSync,
  copyFileSync,
  constants as fsConstants,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanGitEnv } from '../../src/lib/git-env.ts';
import {
  gitFixture,
  gitFixtureEnv,
} from './preflight-git-fixture-helper.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const PREFLIGHT = join(REPO_ROOT, 'deploy/preflight-check.sh');
const WRAPPER = join(REPO_ROOT, 'deploy/whatsoup');
const RESOLVE_NODE_LIB = join(REPO_ROOT, 'deploy/lib/resolve-node.sh');
const READ_PRIVATE_HEALTH_TOKEN_LIB = join(REPO_ROOT, 'deploy/lib/read-private-health-token.sh');
const READ_PRIVATE_HEALTH_TOKEN_READER = join(REPO_ROOT, 'deploy/lib/read-private-health-token.mjs');
const BOUNDED_EXEC_LIB = join(REPO_ROOT, 'deploy/lib/bounded-exec.sh');
const SOURCE_RUNTIME_CHECK = join(REPO_ROOT, 'scripts/source-runtime-drift-check.ts');
const GUARD_CORE = join(REPO_ROOT, 'scripts/lib/guard-core.ts');
const GIT_ENV = join(REPO_ROOT, 'src/lib/git-env.ts');
const TYPE_GUARDS = join(REPO_ROOT, 'src/lib/type-guards.ts');
const SOURCE_RUNTIME_MANIFEST = join(REPO_ROOT, 'deploy/source-runtime-manifest.json');
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
 * A release manifest that satisfies scripts/release-snapshot-plan.ts's
 * `parseReleaseSnapshotManifest` schema — schemaVersion/source/release/rollback
 * are all required, so a bare `{"files":[]}` fixture is NOT a valid manifest
 * and must not be used to exercise the "manifest present" pass path.
 */
function validReleaseManifestPayload(root: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    source: { ref: 'HEAD', commit: '0'.repeat(40) },
    release: { path: root, createdAt: '2026-01-01T00:00:00.000Z', mutablePathExcludes: [] },
    rollback: { path: join(root, '.rollback') },
    files: [],
    requiredOutputs: [],
  };
}

function writeValidReleaseManifest(root: string): void {
  writeFileSync(
    join(root, '.whatsoup-release-manifest.json'),
    `${JSON.stringify(validReleaseManifestPayload(root))}\n`,
    'utf8',
  );
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
  writeFileSync(
    join(root, 'src', 'database-compatibility-bootstrap.ts'),
    'export const databaseCompatibilityBootstrapFixture = true;\n',
    'utf8',
  );
  // Fixture roots are non-git, so preflight treats them as release exports —
  // which must carry a schema-valid release manifest (manifest gate). Tests
  // probing the missing/malformed-manifest failures overwrite or remove this
  // file explicitly.
  writeValidReleaseManifest(root);
  for (const [rel, contents] of Object.entries(extraFiles)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, 'utf8');
  }
  return root;
}

function runPreflight(
  repoRoot: string,
  instance = '',
  env: Record<string, string> = {},
): { status: number; stderr: string; stdout: string } {
  const result = spawnSync('bash', [PREFLIGHT, repoRoot, instance], {
    encoding: 'utf8',
    env: { ...cleanGitEnv(), WHATSOUP_NODE: PINNED_NODE, ...env },
    timeout: SPAWN_TIMEOUT_MS,
  });
  return {
    status: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

type WrapperFixture = {
  root: string;
  wrapper: string;
  bootstrap: string;
  trustChecker: string;
  fakeNode: string;
  trace: string;
  home: string;
  configHome: string;
  dataHome: string;
};

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

function makeWrapperFixture(): WrapperFixture {
  const root = makeTmpDir();
  const deploy = join(root, 'deploy');
  const lib = join(deploy, 'lib');
  const scripts = join(root, 'scripts');
  const scriptsLib = join(scripts, 'lib');
  const src = join(root, 'src');
  const srcLib = join(src, 'lib');
  const home = join(root, 'home');
  const configHome = join(root, 'config');
  const dataHome = join(root, 'data');
  const wrapper = join(deploy, 'whatsoup');
  const bootstrap = join(src, 'database-compatibility-bootstrap.ts');
  const trustChecker = join(scripts, 'source-runtime-drift-check.ts');
  const fakeNode = join(root, 'fake-node');
  const trace = join(root, 'trace.log');

  for (const path of [lib, scriptsLib, srcLib, home, configHome, dataHome]) {
    mkdirSync(path, { recursive: true });
  }
  copyFileSync(WRAPPER, wrapper);
  chmodSync(wrapper, 0o755);
  copyFileSync(RESOLVE_NODE_LIB, join(lib, 'resolve-node.sh'));
  copyFileSync(READ_PRIVATE_HEALTH_TOKEN_LIB, join(lib, 'read-private-health-token.sh'));
  copyFileSync(READ_PRIVATE_HEALTH_TOKEN_READER, join(lib, 'read-private-health-token.mjs'));
  copyFileSync(BOUNDED_EXEC_LIB, join(lib, 'bounded-exec.sh'));
  copyFileSync(SOURCE_RUNTIME_CHECK, trustChecker);
  copyFileSync(GUARD_CORE, join(scriptsLib, 'guard-core.ts'));
  copyFileSync(GIT_ENV, join(srcLib, 'git-env.ts'));
  copyFileSync(TYPE_GUARDS, join(srcLib, 'type-guards.ts'));
  writeFileSync(join(root, '.nvmrc'), `${PINNED_NODE_VERSION}\n`, 'utf8');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'wrapper-fixture', engines: { node: FIXTURE_NODE_RANGE } }),
    'utf8',
  );
  writeFileSync(bootstrap, "process.stdout.write('ready\\n');\n", 'utf8');
  writeFileSync(join(src, 'bootstrap.ts'), 'process.exit(0);\n', 'utf8');
  const instanceConfig = join(configHome, 'whatsoup', 'instances', 'q-bot');
  mkdirSync(instanceConfig, { recursive: true });
  writeFileSync(join(instanceConfig, 'config.json'), JSON.stringify({ type: 'passive' }), 'utf8');

  writeExecutable(
    join(deploy, 'preflight-check.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'preflight\\n' >> "$WHATSOUP_TEST_TRACE"
exit "\${WHATSOUP_TEST_PREFLIGHT_RC:-0}"
`,
  );
  writeExecutable(
    fakeNode,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-e" ]; then
  if [ "$#" -ge 3 ] && [[ "\${3:-}" == */package.json ]]; then
    printf '${PINNED_NODE_MAJOR + 1}'
  else
    printf 'passive'
  fi
  exit 0
fi
if [ "\${1:-}" = "-p" ]; then
  printf '${PINNED_NODE_MAJOR}'
  exit 0
fi
if [ "\${!#}" = "--check" ]; then
  printf 'db-check\\n' >> "$WHATSOUP_TEST_TRACE"
  case "\${WHATSOUP_TEST_DB_MODE:-ready}" in
    ready) printf 'ready\\n' ;;
    drain) printf 'future_schema\\n' ;;
    exit78) exit 78 ;;
    other) exit 7 ;;
  esac
  exit 0
fi
if [ "\${!#}" = "--hold" ]; then
  printf 'db-hold\\n' >> "$WHATSOUP_TEST_TRACE"
  exit 0
fi
if [[ "$*" == *src/bootstrap.ts* ]]; then
  printf 'runtime\\n' >> "$WHATSOUP_TEST_TRACE"
  exit 0
fi
if [[ "$*" == *scripts/source-runtime-drift-check.ts* ]]; then
  exec ${JSON.stringify(PINNED_NODE)} "$@"
fi
exit 9
`,
  );

  gitFixture(root, ['init', '-q']);
  gitFixture(root, ['add', '.']);
  gitFixture(root, ['commit', '-m', 'wrapper fixture']);

  return {
    root,
    wrapper,
    bootstrap,
    trustChecker,
    fakeNode,
    trace,
    home,
    configHome,
    dataHome,
  };
}

function commitWrapperFixture(fixture: WrapperFixture, message: string): void {
  gitFixture(fixture.root, ['add', '.']);
  gitFixture(fixture.root, ['commit', '-m', message]);
}

function runWrapper(
  fixture: WrapperFixture,
  env: Record<string, string> = {},
): { status: number; stderr: string; stdout: string; trace: string[] } {
  const result = spawnSync('bash', [fixture.wrapper, 'q-bot'], {
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: {
      ...cleanGitEnv(),
      HOME: fixture.home,
      USER: 'test-user',
      XDG_CONFIG_HOME: fixture.configHome,
      XDG_DATA_HOME: fixture.dataHome,
      WHATSOUP_NODE: fixture.fakeNode,
      WHATSOUP_TEST_TRACE: fixture.trace,
      WHATSOUP_TEST_DB_MODE: 'ready',
      WHATSOUP_TEST_PREFLIGHT_RC: '0',
      WHATSOUP_SKIP_PREFLIGHT: '',
      WHATSOUP_HEALTH_TOKEN: 'test-health-token',
      OPENAI_API_KEY: 'test-openai-key',
      PINECONE_API_KEY: 'test-pinecone-key',
      ...env,
    },
  });
  const trace = existsSync(fixture.trace)
    ? readFileSync(fixture.trace, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  return {
    status: result.status ?? -1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
    trace,
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

  it('fails closed when the required database compatibility entrypoint is missing', () => {
    const root = makeFixtureTree('export const mainOk = true;\n');
    const bootstrap = join(root, 'src', 'database-compatibility-bootstrap.ts');
    rmSync(bootstrap);

    const { status, stderr } = runPreflight(root);

    expect(status).toBe(1);
    expect(stderr).toContain('PREFLIGHT-ERROR: required entrypoint not found');
    expect(stderr).toContain(bootstrap);
  });

  it('fails closed when the database compatibility entrypoint is a directory', () => {
    const root = makeFixtureTree('export const mainOk = true;\n');
    const bootstrap = join(root, 'src', 'database-compatibility-bootstrap.ts');
    rmSync(bootstrap);
    mkdirSync(bootstrap);

    const { status, stderr } = runPreflight(root);

    expect(status).toBe(1);
    expect(stderr).toContain('PREFLIGHT-ERROR: unsafe entrypoint');
    expect(stderr).toContain('regular non-symlink file');
    expect(stderr).toContain(bootstrap);
  });

  it('fails closed when the database compatibility entrypoint is a symlink', () => {
    const root = makeFixtureTree('export const mainOk = true;\n');
    const bootstrap = join(root, 'src', 'database-compatibility-bootstrap.ts');
    const target = join(root, 'src', 'database-compatibility-target.ts');
    writeFileSync(target, 'export const targetMustNotBeProbed = true;\n', 'utf8');
    rmSync(bootstrap);
    symlinkSync(target, bootstrap);

    const { status, stderr } = runPreflight(root);

    expect(status).toBe(1);
    expect(stderr).toContain('PREFLIGHT-ERROR: unsafe entrypoint');
    expect(stderr).toContain('regular non-symlink file');
    expect(stderr).toContain(bootstrap);
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

  it('keeps fixture commits inside the fixture when hook Git variables target another repository', () => {
    const ambient = makeFixtureTree('export const ambient = true;\n');
    gitFixture(ambient, ['init', '-q']);
    gitFixture(ambient, ['add', '.']);
    gitFixture(ambient, ['commit', '-m', 'ambient-base']);
    const ambientHead = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: ambient,
      encoding: 'utf8',
      env: gitFixtureEnv(),
    }).stdout.trim();

    const fixtureRoot = makeFixtureTree('export const fixture = true;\n');
    const helperUrl = pathToFileURL(
      join(__dirname, 'preflight-git-fixture-helper.ts'),
    ).href;
    const childProgram = `
      const { gitFixture } = await import(${JSON.stringify(helperUrl)});
      const root = process.env.WHATSOUP_TEST_FIXTURE_ROOT;
      if (!root) throw new Error('missing fixture root');
      gitFixture(root, ['init', '-q']);
      gitFixture(root, ['add', '.']);
      gitFixture(root, ['commit', '-m', 'fixture-base']);
    `;
    const child = spawnSync(
      PINNED_NODE,
      ['--input-type=module', '--eval', childProgram],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        env: {
          ...cleanGitEnv(),
          WHATSOUP_TEST_FIXTURE_ROOT: fixtureRoot,
          GIT_DIR: join(ambient, '.git'),
          GIT_WORK_TREE: ambient,
          GIT_INDEX_FILE: join(ambient, '.git', 'index'),
        },
      },
    );
    expect(child.status, child.stderr || child.stdout || child.error?.message).toBe(0);

    expect(existsSync(join(fixtureRoot, '.git'))).toBe(true);
    const fixtureHead = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: gitFixtureEnv(),
    });
    expect(fixtureHead.status, fixtureHead.stderr).toBe(0);
    const ambientAfter = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: ambient,
      encoding: 'utf8',
      env: gitFixtureEnv(),
    }).stdout.trim();
    expect(ambientAfter).toBe(ambientHead);
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

// #1862: the import probe proves the tree LINKS; the instance-config gate proves
// the NAMED instance's real configuration is loadable/valid. An import-clean tree
// with a missing or runtime-rejected instance config must still fail closed.
function writeInstanceConfig(configHome: string, name: string, config: unknown): void {
  const dir = join(configHome, 'whatsoup', 'instances', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config), 'utf8');
}

const validInstanceConfig = {
  name: 'q-bot',
  type: 'agent',
  accessMode: 'self_only',
  adminPhones: ['15551234567'],
  agentOptions: { sessionScope: 'single' },
};

// @skip-env the instance-config gate shells through the pinned preflight and the
// real validator import graph; out-of-pin Node is covered by node-pin-consistency.
describe.skipIf(!NODE_IN_PIN)('deploy/preflight-check.sh — instance-config gate (#1862)', () => {
  it('fails closed on a nonexistent named instance even when the tree links', () => {
    const root = makeFixtureTree(
      "import { ok } from './helper.ts';\nconsole.log(ok);\n",
      { 'src/helper.ts': 'export const ok = true;\n' },
    );
    const configHome = makeTmpDir(); // empty — instance 'q-bot' is not configured
    const { status, stderr } = runPreflight(root, 'q-bot', { XDG_CONFIG_HOME: configHome });

    expect(status).toBe(3);
    // The import check passed and is reported distinctly from the instance check...
    expect(stderr).toContain('PREFLIGHT-OK: import graph is link-clean');
    // ...but the missing instance config fails the restart closed.
    expect(stderr).toContain('PREFLIGHT-FAIL');
    expect(stderr).toContain('instance configuration is invalid or missing');
  });

  it('fails closed when the instance agent cwd resolves to the user home directory', () => {
    const root = makeFixtureTree(
      "import { ok } from './helper.ts';\nconsole.log(ok);\n",
      { 'src/helper.ts': 'export const ok = true;\n' },
    );
    const configHome = makeTmpDir();
    writeInstanceConfig(configHome, 'q-bot', {
      ...validInstanceConfig,
      agentOptions: { sessionScope: 'single', cwd: homedir() },
    });
    const { status, stderr } = runPreflight(root, 'q-bot', { XDG_CONFIG_HOME: configHome });

    expect(status).toBe(3);
    expect(stderr).toContain('PREFLIGHT-FAIL');
    expect(stderr).toContain('agentOptions.cwd');
  });

  it('passes an import-clean tree with a valid named instance and reports both checks', () => {
    const root = makeFixtureTree(
      "import { ok } from './helper.ts';\nconsole.log(ok);\n",
      { 'src/helper.ts': 'export const ok = true;\n' },
    );
    const configHome = makeTmpDir();
    writeInstanceConfig(configHome, 'q-bot', validInstanceConfig);
    const { status, stderr } = runPreflight(root, 'q-bot', { XDG_CONFIG_HOME: configHome });

    expect(status, stderr).toBe(0);
    expect(stderr).toContain('PREFLIGHT-OK: import graph is link-clean');
    expect(stderr).toContain("instance 'q-bot' configuration is valid");
  });

  it('still reports import-clean and exits 0 when no instance name is supplied', () => {
    const root = makeFixtureTree(
      "import { ok } from './helper.ts';\nconsole.log(ok);\n",
      { 'src/helper.ts': 'export const ok = true;\n' },
    );
    const { status, stderr } = runPreflight(root);

    expect(status).toBe(0);
    expect(stderr).toContain('PREFLIGHT-OK: import graph is link-clean');
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

// @skip-env the wrapper ordering harness executes the pinned TypeScript entrypoint;
// out-of-pin Node versions are covered by guard:node-pin-consistency.
describe.skipIf(!NODE_IN_PIN)('deploy/whatsoup — black-box startup ordering', () => {
  it('runs database check, restart preflight, then runtime on ready', () => {
    const fixture = makeWrapperFixture();

    const result = runWrapper(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.trace).toEqual(['db-check', 'preflight', 'runtime']);
  });

  it('still runs database check when restart preflight is skipped', () => {
    const fixture = makeWrapperFixture();

    const result = runWrapper(fixture, { WHATSOUP_SKIP_PREFLIGHT: '1' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.trace).toEqual(['db-check', 'runtime']);
    expect(result.stderr).toContain('restart-safety pre-flight gate BYPASSED');
  });

  it('execs the database hold without running restart preflight or runtime on drain', () => {
    const fixture = makeWrapperFixture();

    const result = runWrapper(fixture, { WHATSOUP_TEST_DB_MODE: 'drain' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.trace).toEqual(['db-check', 'db-hold']);
  });

  it('preserves database check exit 78', () => {
    const fixture = makeWrapperFixture();

    const result = runWrapper(fixture, { WHATSOUP_TEST_DB_MODE: 'exit78' });

    expect(result.status).toBe(78);
    expect(result.trace).toEqual(['db-check']);
  });

  it('collapses other database check failures to exit 1', () => {
    const fixture = makeWrapperFixture();

    const result = runWrapper(fixture, { WHATSOUP_TEST_DB_MODE: 'other' });

    expect(result.status).toBe(1);
    expect(result.trace).toEqual(['db-check']);
  });

  it('fails before Node when the database compatibility entrypoint is missing', () => {
    const fixture = makeWrapperFixture();
    rmSync(fixture.bootstrap);

    const result = runWrapper(fixture, { WHATSOUP_SKIP_PREFLIGHT: '1' });

    expect(result.status).toBe(1);
    expect(result.trace).toEqual([]);
    expect(result.stderr).toContain('FATAL: database compatibility entrypoint not found');
    expect(result.stderr).toContain(fixture.bootstrap);
  });

  it('fails before Node when the database compatibility entrypoint is a directory', () => {
    const fixture = makeWrapperFixture();
    rmSync(fixture.bootstrap);
    mkdirSync(fixture.bootstrap);

    const result = runWrapper(fixture, { WHATSOUP_SKIP_PREFLIGHT: '1' });

    expect(result.status).toBe(1);
    expect(result.trace).toEqual([]);
    expect(result.stderr).toContain('FATAL: unsafe database compatibility entrypoint');
    expect(result.stderr).toContain('regular non-symlink file');
    expect(result.stderr).toContain(fixture.bootstrap);
  });

  it('rejects a symlink before its database target can execute', () => {
    const fixture = makeWrapperFixture();
    const target = join(fixture.root, 'src', 'database-compatibility-target.ts');
    const sentinel = join(fixture.root, 'symlink-target-executed');
    writeFileSync(
      target,
      `import { writeFileSync } from 'node:fs';
const sentinel = process.env['WHATSOUP_TEST_SENTINEL'];
if (!sentinel) throw new Error('missing test sentinel');
writeFileSync(sentinel, 'executed', 'utf8');
process.stdout.write('ready\\n');
`,
      'utf8',
    );
    rmSync(fixture.bootstrap);
    symlinkSync(target, fixture.bootstrap);

    const result = runWrapper(fixture, {
      WHATSOUP_NODE: PINNED_NODE,
      WHATSOUP_SKIP_PREFLIGHT: '1',
      WHATSOUP_TEST_SENTINEL: sentinel,
    });

    expect(existsSync(sentinel)).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FATAL: unsafe database compatibility entrypoint');
    expect(result.stderr).toContain('regular non-symlink file');
    expect(result.stderr).toContain(fixture.bootstrap);
  });

  it('rejects a dirty regular database bootstrap before its sentinel executes', () => {
    const fixture = makeWrapperFixture();
    const sentinel = join(fixture.root, 'dirty-bootstrap-executed');
    writeFileSync(
      fixture.bootstrap,
      `import { writeFileSync } from 'node:fs';
const sentinel = process.env['WHATSOUP_TEST_SENTINEL'];
if (!sentinel) throw new Error('missing test sentinel');
writeFileSync(sentinel, 'executed', 'utf8');
process.stdout.write('ready\\n');
`,
      'utf8',
    );

    const result = runWrapper(fixture, {
      WHATSOUP_NODE: PINNED_NODE,
      WHATSOUP_SKIP_PREFLIGHT: '1',
      WHATSOUP_TEST_SENTINEL: sentinel,
    });

    expect(existsSync(sentinel)).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FATAL: database compatibility bootstrap trust check failed');
    expect(result.stderr).toContain('file-dirty');
  });

  it('rejects a missing transitive database bootstrap import before its sentinel executes', () => {
    const fixture = makeWrapperFixture();
    const dependency = join(fixture.root, 'src', 'database-compatibility-dependency.ts');
    const sentinel = join(fixture.root, 'partial-graph-executed');
    writeFileSync(dependency, 'export const dependency = true;\n', 'utf8');
    writeFileSync(
      fixture.bootstrap,
      `import './database-compatibility-dependency.ts';
import { writeFileSync } from 'node:fs';
const sentinel = process.env['WHATSOUP_TEST_SENTINEL'];
if (!sentinel) throw new Error('missing test sentinel');
writeFileSync(sentinel, 'executed', 'utf8');
process.stdout.write('ready\\n');
`,
      'utf8',
    );
    commitWrapperFixture(fixture, 'add database compatibility dependency');
    rmSync(dependency);

    const result = runWrapper(fixture, {
      WHATSOUP_NODE: PINNED_NODE,
      WHATSOUP_SKIP_PREFLIGHT: '1',
      WHATSOUP_TEST_SENTINEL: sentinel,
    });

    expect(existsSync(sentinel)).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FATAL: database compatibility bootstrap trust check failed');
    expect(result.stderr).toContain('import-missing');
    expect(result.stderr).toContain('database-compatibility-dependency.ts');
  });

  it('rejects a dirty contained symlink redirect before its target sentinel executes', () => {
    const fixture = makeWrapperFixture();
    const dependency = join(fixture.root, 'src', 'database-compatibility-dependency.ts');
    const redirect = join(fixture.root, 'src', 'database-compatibility-redirect.ts');
    const sentinel = join(fixture.root, 'transitive-symlink-executed');
    writeFileSync(dependency, 'export const dependency = true;\n', 'utf8');
    writeFileSync(
      fixture.bootstrap,
      "import './database-compatibility-dependency.ts';\nprocess.stdout.write('ready\\n');\n",
      'utf8',
    );
    commitWrapperFixture(fixture, 'add regular database compatibility graph');
    writeFileSync(
      redirect,
      `import { writeFileSync } from 'node:fs';
const sentinel = process.env['WHATSOUP_TEST_SENTINEL'];
if (!sentinel) throw new Error('missing test sentinel');
writeFileSync(sentinel, 'executed', 'utf8');
`,
      'utf8',
    );
    rmSync(dependency);
    symlinkSync(redirect, dependency);

    const result = runWrapper(fixture, {
      WHATSOUP_NODE: PINNED_NODE,
      WHATSOUP_SKIP_PREFLIGHT: '1',
      WHATSOUP_TEST_SENTINEL: sentinel,
    });

    expect(existsSync(sentinel)).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FATAL: database compatibility bootstrap trust check failed');
    expect(result.stderr).toContain('file-dirty');
    expect(result.stderr).toContain('database-compatibility-dependency.ts');
  });

  it('rejects a clean contained symlink alias with a dirty target before its sentinel executes', () => {
    const fixture = makeWrapperFixture();
    const dependency = join(fixture.root, 'src', 'database-compatibility-dependency.ts');
    const target = join(fixture.root, 'src', 'database-compatibility-target.ts');
    const sentinel = join(fixture.root, 'contained-symlink-target-executed');
    writeFileSync(target, 'export const dependency = true;\n', 'utf8');
    symlinkSync('./database-compatibility-target.ts', dependency);
    writeFileSync(
      fixture.bootstrap,
      "import './database-compatibility-dependency.ts';\nprocess.stdout.write('ready\\n');\n",
      'utf8',
    );
    commitWrapperFixture(fixture, 'add clean contained database compatibility symlink');
    writeFileSync(
      target,
      `import { writeFileSync } from 'node:fs';
const sentinel = process.env['WHATSOUP_TEST_SENTINEL'];
if (!sentinel) throw new Error('missing test sentinel');
writeFileSync(sentinel, 'executed', 'utf8');
`,
      'utf8',
    );

    const result = runWrapper(fixture, {
      WHATSOUP_NODE: PINNED_NODE,
      WHATSOUP_SKIP_PREFLIGHT: '1',
      WHATSOUP_TEST_SENTINEL: sentinel,
    });

    expect(existsSync(sentinel)).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FATAL: database compatibility bootstrap trust check failed');
    expect(result.stderr).toContain('file-dirty');
    expect(result.stderr).toContain('database-compatibility-target.ts');
  });

  it('rejects a dirty trust checker before checker code can execute', () => {
    const fixture = makeWrapperFixture();
    const sentinel = join(fixture.root, 'dirty-checker-executed');
    writeFileSync(
      fixture.trustChecker,
      `import { writeFileSync } from 'node:fs';
const sentinel = process.env['WHATSOUP_TEST_SENTINEL'];
if (!sentinel) throw new Error('missing test sentinel');
writeFileSync(sentinel, 'executed', 'utf8');
`,
      'utf8',
    );

    const result = runWrapper(fixture, {
      WHATSOUP_NODE: PINNED_NODE,
      WHATSOUP_SKIP_PREFLIGHT: '1',
      WHATSOUP_TEST_SENTINEL: sentinel,
    });

    expect(existsSync(sentinel)).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FATAL: unsafe database bootstrap trust checker');
    expect(result.stderr).toContain('tracked, committed, and clean');
  });

  it('rejects a staged trust dependency before dependency code can execute', () => {
    const fixture = makeWrapperFixture();
    const guardCore = join(fixture.root, 'scripts', 'lib', 'guard-core.ts');
    const sentinel = join(fixture.root, 'staged-checker-dependency-executed');
    writeFileSync(
      guardCore,
      `import { writeFileSync } from 'node:fs';
const sentinel = process.env['WHATSOUP_TEST_SENTINEL'];
if (!sentinel) throw new Error('missing test sentinel');
writeFileSync(sentinel, 'executed', 'utf8');
`,
      'utf8',
    );
    gitFixture(fixture.root, ['add', 'scripts/lib/guard-core.ts']);

    const result = runWrapper(fixture, {
      WHATSOUP_NODE: PINNED_NODE,
      WHATSOUP_SKIP_PREFLIGHT: '1',
      WHATSOUP_TEST_SENTINEL: sentinel,
    });

    expect(existsSync(sentinel)).toBe(false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FATAL: unsafe database bootstrap trust checker');
    expect(result.stderr).toContain('tracked, committed, and clean');
  });

  it('clears injected Git config before the trust precheck can execute a hook', () => {
    const fixture = makeWrapperFixture();
    const sentinel = join(fixture.root, 'injected-git-config-executed');
    const fsmonitor = join(fixture.root, 'fsmonitor-hook');
    writeExecutable(
      fsmonitor,
      `#!/usr/bin/env bash
set -euo pipefail
: > "$WHATSOUP_TEST_SENTINEL"
`,
    );

    const result = runWrapper(fixture, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: fsmonitor,
      WHATSOUP_TEST_SENTINEL: sentinel,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
    expect(result.trace).toEqual(['db-check', 'preflight', 'runtime']);
  });
});

describe('deploy/whatsoup — source wiring', () => {
  it('runs the database compatibility verdict before restart preflight', () => {
    const wrapper = readFileSync(WRAPPER, 'utf8');
    const nodeResolution = wrapper.indexOf('NODE="$(whatsoup_resolve_node "$REPO_ROOT")"');
    const databaseCheck = wrapper.indexOf(
      '"$DATABASE_BOOTSTRAP_TS" "$INSTANCE" --check',
    );
    const skipRestartPreflight = wrapper.indexOf(
      'if [ "${WHATSOUP_SKIP_PREFLIGHT:-}" = "1" ]; then',
    );
    const restartPreflight = wrapper.indexOf(
      'WHATSOUP_NODE="$NODE" "$SCRIPT_DIR/preflight-check.sh" "$REPO_ROOT" "$INSTANCE"',
    );
    expect(nodeResolution).toBeGreaterThan(-1);
    expect(databaseCheck).toBeGreaterThan(-1);
    expect(skipRestartPreflight).toBeGreaterThan(-1);
    expect(restartPreflight).toBeGreaterThan(-1);
    expect(nodeResolution).toBeLessThan(databaseCheck);
    expect(databaseCheck).toBeLessThan(skipRestartPreflight);
    expect(databaseCheck).toBeLessThan(restartPreflight);
  });

  it('tracks the database compatibility bootstrap as a hashed import graph', () => {
    const manifest = JSON.parse(readFileSync(SOURCE_RUNTIME_MANIFEST, 'utf8')) as {
      entrypoints: Array<{
        path: string;
        sha256?: string;
        mustContain?: string[];
        importGraph?: boolean;
      }>;
    };
    const bootstrap = manifest.entrypoints.find(
      (entry) => entry.path === 'src/database-compatibility-bootstrap.ts',
    );

    expect(bootstrap).toBeDefined();
    expect(bootstrap?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bootstrap?.importGraph).toBe(true);
    expect(bootstrap?.mustContain).toEqual(expect.arrayContaining([
      'databaseCompatibilityBootstrap',
      'checkLoadedInstanceDatabase',
    ]));
  });

  it('runs database compatibility before tmp creation and full instance parsing', () => {
    const wrapper = readFileSync(WRAPPER, 'utf8');
    const compatibility = wrapper.indexOf('src/database-compatibility-bootstrap.ts');
    expect(compatibility).toBeGreaterThan(-1);
    expect(compatibility).toBeLessThan(wrapper.indexOf('git -C "$REPO_ROOT"'));
    expect(compatibility).toBeLessThan(wrapper.indexOf('mkdir -p "$TMPDIR"'));
    expect(compatibility).toBeLessThan(wrapper.indexOf('INSTANCE_TYPE='));
  });

  it('propagates the terminal database bootstrap exit status instead of collapsing it to restartable failure', () => {
    const wrapper = readFileSync(WRAPPER, 'utf8');
    expect(wrapper).toContain('DATABASE_COMPATIBILITY_RC=$?');
    expect(wrapper).toContain('DATABASE_COMPATIBILITY_PERMANENT_EXIT_STATUS=78');
    expect(wrapper).toContain('exit "$DATABASE_COMPATIBILITY_PERMANENT_EXIT_STATUS"');
  });

  it('links main in import-only mode without executing production startup effects', () => {
    const preflight = readFileSync(PREFLIGHT, 'utf8');
    const main = readFileSync(join(REPO_ROOT, 'src/main.ts'), 'utf8');
    expect(preflight).toContain('WHATSOUP_PREFLIGHT_IMPORT_ONLY=1');
    expect(preflight).toContain(
      'WHATSOUP_PREFLIGHT_IMPORT_SENTINEL=restart-safety-link-probe-v1',
    );
    const guard = main.indexOf('if (!preflightImportOnlyAuthorized) {');
    expect(guard).toBeGreaterThan(-1);
    for (const effect of [
      'openDatabaseForStartup({',
      'getPineconeReadiness(',
      'createConnection(',
      'startHealthServer(',
      'setInterval(',
      'start().catch(',
    ]) {
      expect(main.indexOf(effect), effect).toBeGreaterThan(guard);
    }
  });

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

  it('scrubs import-only probe identity before the production node exec', () => {
    const wrapper = readFileSync(WRAPPER, 'utf8');
    const scrub = wrapper.indexOf(
      'unset WHATSOUP_PREFLIGHT_IMPORT_ONLY WHATSOUP_PREFLIGHT_IMPORT_SENTINEL',
    );
    const bootstrapIndex = wrapper.lastIndexOf('bootstrap.ts');
    expect(scrub).toBeGreaterThan(-1);
    expect(scrub).toBeLessThan(bootstrapIndex);
  });

  it('runs database compatibility before provider credential resolution', () => {
    const wrapper = readFileSync(WRAPPER, 'utf8');
    const databaseGate = wrapper.indexOf('database-compatibility-bootstrap.ts');
    const providerCredentials = wrapper.indexOf('ANTHROPIC_API_KEY="$(keyring_lookup');
    expect(databaseGate).toBeGreaterThan(-1);
    expect(providerCredentials).toBeGreaterThan(databaseGate);
    const between = wrapper.slice(databaseGate, providerCredentials);
    expect(between).toContain('future_schema|engine_recovery_required');
    expect(between).toContain('--hold');
  });

  it('shares node-pin logic via deploy/lib/resolve-node.sh (DRY with wrapper)', () => {
    expect(readFileSync(WRAPPER, 'utf8')).toContain('lib/resolve-node.sh');
    expect(readFileSync(PREFLIGHT, 'utf8')).toContain('lib/resolve-node.sh');
  });

  it('runs the instance-config gate after the import probe succeeds (#1862)', () => {
    const preflight = readFileSync(PREFLIGHT, 'utf8');
    const importOk = preflight.indexOf('PREFLIGHT-OK: import graph is link-clean');
    const instanceCheck = preflight.indexOf('preflight-instance-check.ts');
    expect(importOk).toBeGreaterThan(-1);
    expect(instanceCheck).toBeGreaterThan(importOk);
    // The instance-config failure is reported distinctly and fails closed.
    expect(preflight).toContain('instance configuration is invalid or missing');
    expect(existsSync(join(REPO_ROOT, 'deploy/preflight-instance-check.ts'))).toBe(true);
  });
});

// P4 follow-on (fleet incident 2026-07-16): WhatSoup-release-ee35101f shipped
// to four hosts without .whatsoup-release-manifest.json, so every host flagged
// release-drift (manifest-missing) forever. The manifest is written only by
// scripts/release-snapshot-plan.ts and nothing on the restart path verified it.
describe.skipIf(!NODE_IN_PIN)('deploy/preflight-check.sh — release-export manifest gate', () => {
  it('fails closed when a non-git release dir lacks the release manifest', () => {
    const root = makeFixtureTree(
      "import { ok } from './helper.ts';\nconsole.log(ok);\n",
      { 'src/helper.ts': 'export const ok = true;\n' },
    );
    rmSync(join(root, '.whatsoup-release-manifest.json'), { force: true });
    const { status, stderr } = runPreflight(root);

    expect(status).toBe(3);
    expect(stderr).toContain('release export lacks .whatsoup-release-manifest.json');
  });

  it('passes the manifest gate when the release manifest is present and schema-valid', () => {
    const root = makeFixtureTree(
      "import { ok } from './helper.ts';\nconsole.log(ok);\n",
      { 'src/helper.ts': 'export const ok = true;\n' },
    );
    writeValidReleaseManifest(root);
    const { status, stderr } = runPreflight(root);

    expect(status).toBe(0);
    expect(stderr).toContain('PREFLIGHT-OK');
    expect(stderr).toContain('release manifest present and schema-valid');
  });

  // TRUTH-03: existence alone was previously sufficient — a manifest that
  // exists but is corrupted (not valid JSON) or incomplete (valid JSON,
  // missing required fields) passed the old `-f` check silently and would
  // never be caught until a real drift comparison ran. Both must now fail
  // closed, with a message distinct from the "missing" case above.
  it('fails closed when the release manifest exists but is not valid JSON (corrupted)', () => {
    const root = makeFixtureTree(
      "import { ok } from './helper.ts';\nconsole.log(ok);\n",
      { 'src/helper.ts': 'export const ok = true;\n' },
    );
    writeFileSync(join(root, '.whatsoup-release-manifest.json'), '{not valid json', 'utf8');
    const { status, stderr } = runPreflight(root);

    expect(status).toBe(3);
    expect(stderr).toContain('PREFLIGHT-FAIL');
    expect(stderr).toContain('release manifest is malformed');
    expect(stderr).toContain('invalid-json');
    expect(stderr).not.toContain('release export lacks .whatsoup-release-manifest.json');
  });

  it('fails closed when the release manifest is valid JSON but fails schema validation', () => {
    const root = makeFixtureTree(
      "import { ok } from './helper.ts';\nconsole.log(ok);\n",
      { 'src/helper.ts': 'export const ok = true;\n' },
    );
    // Valid JSON, but missing every required manifest field (schemaVersion,
    // source, release, rollback) — exactly the shape the old `{"files":[]}`
    // fixture used, which the existence-only check let through.
    writeFileSync(join(root, '.whatsoup-release-manifest.json'), '{"files":[]}\n', 'utf8');
    const { status, stderr } = runPreflight(root);

    expect(status).toBe(3);
    expect(stderr).toContain('PREFLIGHT-FAIL');
    expect(stderr).toContain('release manifest is malformed');
    expect(stderr).toContain('invalid-schema');
    expect(stderr).not.toContain('release export lacks .whatsoup-release-manifest.json');
  });
});
