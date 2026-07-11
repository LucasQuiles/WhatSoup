/**
 * Tests for the Node major-version compatibility gate in the deploy wrappers.
 *
 * The gate fires AFTER NODE is resolved (including the command -v fallback)
 * and BEFORE exec. It converts a cryptic exit-9 crash-loop into an
 * operator-actionable exit-1 with a clear diagnostic.
 *
 * Background: 2026-05-18 17:12 EDT incident — resolved Node was v20 but the
 * entrypoint requires Node >= 22.6 (--experimental-strip-types). The wrapper
 * execd, hit exit status 9 on the unknown flag, and crash-looped under systemd.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const wrapperPath = path.join(repoRoot, 'deploy', 'whatsoup');

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

/**
 * Build a fake-node binary in a tmpdir.
 *
 * When called with `-p 'process.versions.node.split(".")[0]'` the binary
 * prints `majorStr`. When called with `--version` it prints `v<majorStr>.0.0`.
 * When called with any other arguments it prints `gate-passed` and exits 0.
 *
 * @param binDir  Directory to write the `node` file into.
 * @param majorStr  Major version number to report (as string, e.g. "20").
 */
function writeFakeNode(
  binDir: string,
  majorStr: string,
  opts: { engineMaxMajor?: string | null } = {},
): string {
  const nodePath = path.join(binDir, 'node');
  const engineMaxMajor = opts.engineMaxMajor === undefined ? '26' : opts.engineMaxMajor;
  // Detect -p 'process.versions.node...' by the presence of "process.versions.node"
  // in the arguments list.  Detect --version by checking $1.
  const lines = [
    '#!/usr/bin/env bash',
    'for arg in "$@"; do',
    '  if [[ "$arg" == *"process.versions.node"* ]]; then',
    `    printf '%s\\n' '${majorStr}'`,
    '    exit 0',
    '  fi',
    'done',
    'if [ "${1:-}" = "--version" ]; then',
    `  printf 'v${majorStr}.0.0\\n'`,
    '  exit 0',
    'fi',
    'if [ "${1:-}" = "-e" ]; then',
  ];
  if (engineMaxMajor === null) {
    lines.push('  exit 3');
  } else {
    lines.push(`  printf '%s\\n' '${engineMaxMajor}'`, '  exit 0');
  }
  lines.push(
    'fi',
    '# Any other invocation (i.e., the guarded exec reached through)',
    "printf 'gate-passed\\n'",
    'exit 0',
    '',
  );
  writeExecutable(nodePath, lines.join('\n'));
  return nodePath;
}

function writeFakeNpm(binDir: string): string {
  const npmPath = path.join(binDir, 'npm');
  writeExecutable(npmPath, [
    '#!/usr/bin/env bash',
    'printf "npm-node=%s\\n" "$(node --version)"',
    'printf "npm-args=%s\\n" "$*"',
    'exit 0',
    '',
  ].join('\n'));
  return npmPath;
}

/**
 * Build a minimal HOME fixture (no nvm installation) so the wrapper's
 * DEFAULT_NODE path does not exist and the fallback is tested.
 */
function makeBareHome(): string {
  const home = makeTmpDir('whatsoup-gate-home-');
  // Deliberately no ~/.nvm directory so the nvm-based DEFAULT_NODE is missing.
  return home;
}

/**
 * Run the whatsoup wrapper script as a subprocess, capturing stdout, stderr
 * and exit code.
 */
function runWrapper(opts: {
  home: string;
  env?: Record<string, string>;
  instanceName?: string;
  wrapperOverride?: string;
}): { stdout: string; stderr: string; exitCode: number } {
  const {
    home,
    env = {},
    instanceName = 'test-instance',
    wrapperOverride,
  } = opts;

  const result = spawnSync('bash', [wrapperOverride ?? wrapperPath, instanceName], {
    encoding: 'utf8',
    env: {
      // Minimal safe environment for bash
      PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
      USER: process.env['USER'] ?? 'testuser',
      HOME: home,
      // Prevent any real keyring lookups from blocking
      ANTHROPIC_API_KEY: 'test-key',
      OPENAI_API_KEY: 'test-key',
      PINECONE_API_KEY: 'test-key',
      WHATSOUP_HEALTH_TOKEN: 'test-token',
      // This suite isolates Node resolution/version enforcement. Restart preflight
      // has its own behavioral suite and intentionally rejects dirty tracked trees.
      WHATSOUP_SKIP_PREFLIGHT: '1',
      // Spread caller overrides last so they win
      ...env,
    },
    timeout: 8_000,
  });

  const exitCode = result.status ?? 1;
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode,
  };
}

/**
 * Build a fixture REPO_ROOT containing a copy of deploy/whatsoup and a
 * caller-supplied `.nvmrc` content. The wrapper resolves REPO_ROOT from its
 * own location (SCRIPT_DIR/..), so copying it into fixtureRoot/deploy/whatsoup
 * makes fixtureRoot/.nvmrc the version source.
 *
 * @returns the path to the fixture wrapper script.
 */
function makeFixtureRepoWithNvmrc(
  nvmrcContents: string,
  wrapperRelPath = path.join('deploy', 'whatsoup'),
): string {
  const fixtureRoot = makeTmpDir('whatsoup-gate-fixture-repo-');
  fs.mkdirSync(path.join(fixtureRoot, 'deploy', 'lib'), { recursive: true });
  const wrapperContents = fs.readFileSync(path.join(repoRoot, wrapperRelPath), 'utf8');
  const fixtureWrapper = path.join(fixtureRoot, wrapperRelPath);
  fs.mkdirSync(path.dirname(fixtureWrapper), { recursive: true });
  fs.writeFileSync(fixtureWrapper, wrapperContents, 'utf8');
  fs.chmodSync(fixtureWrapper, 0o755);
  // The wrapper sources its node-resolution gate from deploy/lib relative to
  // its own location — stage the library alongside it.
  fs.copyFileSync(
    path.join(repoRoot, 'deploy', 'lib', 'resolve-node.sh'),
    path.join(fixtureRoot, 'deploy', 'lib', 'resolve-node.sh'),
  );
  fs.writeFileSync(path.join(fixtureRoot, '.nvmrc'), `${nvmrcContents}\n`, 'utf8');
  fs.writeFileSync(
    path.join(fixtureRoot, 'package.json'),
    JSON.stringify({ engines: { node: '>=24.0.0 <26' } }),
    'utf8',
  );
  return fixtureWrapper;
}

describe('deploy/whatsoup — Node major-version gate', () => {
  it('run-with-pinned-npm executes npm from the resolved pinned Node directory', () => {
    const fixtureScript = makeFixtureRepoWithNvmrc('24.15.0', path.join('scripts', 'run-with-pinned-npm.sh'));
    const home = makeBareHome();
    const pinnedBin = path.join(home, '.nvm', 'versions', 'node', 'v24.15.0', 'bin');
    fs.mkdirSync(pinnedBin, { recursive: true });
    writeFakeNode(pinnedBin, '24');
    writeFakeNpm(pinnedBin);

    const result = spawnSync('bash', [fixtureScript, '--prefix', 'tools/whatsoup_guard', 'ci'], {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        USER: process.env['USER'] ?? 'testuser',
        HOME: home,
      },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('npm-node=v24.0.0');
    expect(result.stdout).toContain('npm-args=--prefix tools/whatsoup_guard ci');
    expect(result.stderr).not.toContain('FATAL');
  });

  it('Test 1: old Node fails the gate with a clear diagnostic, not exit 9', () => {
    const binDir = makeTmpDir('whatsoup-gate-bin-');
    const home = makeBareHome();
    writeFakeNode(binDir, '20'); // Too old: .nvmrc pins major 24

    const { stdout, stderr, exitCode } = runWrapper({
      home,
      env: {
        WHATSOUP_NODE: path.join(binDir, 'node'),
      },
    });

    // The gate must fire — exit must be non-zero
    expect(exitCode, 'gate must prevent execution (non-zero exit)').not.toBe(0);
    // Must NOT be exit 9 (that's what --experimental-strip-types produces on old node)
    expect(exitCode, 'gate must exit 1, not 9 (cryptic exec failure)').toBe(1);
    // Stderr must contain the pinned major (24 from .nvmrc 24.15.0)
    expect(stderr, 'stderr must contain pinned major').toContain('24');
    // Stderr must contain the resolved Node's major (20)
    expect(stderr, 'stderr must report resolved major').toContain('20');
    // Must not have reached the exec — fake node prints "gate-passed" only when
    // exec succeeds. The real signal is exit code 1 (not 0, not 9) and no
    // stdout output from the fake node's exec path.
    expect(stdout, 'must not have reached exec (no gate-passed in stdout)').not.toContain(
      'gate-passed',
    );
    // Must contain a remediation hint (nvm install or WHATSOUP_NODE override)
    const hasRemediationHint =
      stderr.includes('nvm install') || stderr.includes('WHATSOUP_NODE');
    expect(hasRemediationHint, 'stderr must contain remediation hint (nvm install or WHATSOUP_NODE)').toBe(
      true,
    );
    // Wrapper must not produce gate-passed in stdout (the exec never ran)
    expect(stdout).not.toContain('gate-passed');
    // Per spec AC #3: direct evidence that the gate fired BEFORE exec —
    // stderr must not echo the exec command's flag.  Prevents a regression
    // where the gate exits 1 but somehow still attempted exec.
    expect(stderr, 'gate must fire before exec — stderr must not mention --experimental-strip-types').not.toContain('--experimental-strip-types');
  });

  it('Test 2: matching Node major passes the gate and reaches exec', () => {
    const binDir = makeTmpDir('whatsoup-gate-pass-bin-');
    const home = makeBareHome();
    writeFakeNode(binDir, '24'); // Matches .nvmrc major 24

    const { stdout, stderr, exitCode } = runWrapper({
      home,
      env: {
        WHATSOUP_NODE: path.join(binDir, 'node'),
      },
    });

    // The gate should pass — exec runs — fake node prints gate-passed and exits 0
    expect(exitCode, 'gate-passing Node should result in exit 0').toBe(0);
    expect(stdout, 'exec output must be visible').toContain('gate-passed');
    // No FATAL / version-gate wording in stderr
    expect(stderr, 'no FATAL in passing case').not.toContain('FATAL');
    expect(stderr, 'no version-gate failure wording').not.toMatch(
      /incompatible|requires major|resolved Node is/i,
    );
  });

  it('Test 2b: Node 25 is allowed because package.json engines permits >=24 <26', () => {
    const binDir = makeTmpDir('whatsoup-gate-node25-bin-');
    const home = makeBareHome();
    writeFakeNode(binDir, '25');

    const { stdout, stderr, exitCode } = runWrapper({
      home,
      env: {
        WHATSOUP_NODE: path.join(binDir, 'node'),
      },
    });

    expect(exitCode, 'Node 25 is within package.json#engines.node').toBe(0);
    expect(stdout).toContain('gate-passed');
    expect(stderr).not.toContain('FATAL');
  });

  it('Test 2c: Node 26 is rejected because package.json engines caps runtime at <26', () => {
    for (const wrapperRelPath of [
      path.join('deploy', 'whatsoup'),
      path.join('deploy', 'whatsoup-auth'),
      path.join('deploy', 'whatsoup-fleet'),
    ]) {
      const fixtureWrapper = makeFixtureRepoWithNvmrc('24.15.0', wrapperRelPath);
      const binDir = makeTmpDir('whatsoup-gate-node26-bin-');
      const home = makeBareHome();
      writeFakeNode(binDir, '26');

      const { stdout, stderr, exitCode } = runWrapper({
        home,
        env: {
          WHATSOUP_NODE: path.join(binDir, 'node'),
        },
        wrapperOverride: fixtureWrapper,
      });

      expect(exitCode, `${wrapperRelPath} must reject Node 26`).toBe(1);
      expect(stderr, `${wrapperRelPath} must cite package.json engines`).toContain('package.json#engines.node');
      expect(stderr, `${wrapperRelPath} must cite the rejected version`).toContain('v26.0.0');
      expect(stdout, `${wrapperRelPath} must not reach exec`).not.toContain('gate-passed');
    }
  });

  it('Test 2d: an unparsable engines upper bound fails closed before exec', () => {
    const fixtureWrapper = makeFixtureRepoWithNvmrc('24.15.0');
    const binDir = makeTmpDir('whatsoup-gate-engine-parse-bin-');
    const home = makeBareHome();
    writeFakeNode(binDir, '24', { engineMaxMajor: null });

    const { stdout, stderr, exitCode } = runWrapper({
      home,
      env: {
        WHATSOUP_NODE: path.join(binDir, 'node'),
      },
      wrapperOverride: fixtureWrapper,
    });

    expect(exitCode, 'unparseable package engines must fail closed').toBe(1);
    expect(stderr).toContain('package.json#engines.node');
    expect(stdout).not.toContain('gate-passed');
  });

  it('Test 3: missing pinned Node fails before any system-node fallback', () => {
    // Simulate: HOME has no nvm dir → DEFAULT_NODE missing. The wrapper must
    // fail here instead of falling through to an older `node` on PATH.
    const binDir = makeTmpDir('whatsoup-gate-fallback-bin-');
    const home = makeBareHome(); // no ~/.nvm/versions/…

    // Write an old fake `node` into binDir. If the wrapper regresses to PATH
    // fallback, this fake node will print "gate-passed" during exec.
    writeFakeNode(binDir, '20');

    // Build a controlled PATH that puts our fake node first.
    // Do NOT set WHATSOUP_NODE so the wrapper uses the missing DEFAULT_NODE path.
    const controlledPath = `${binDir}:${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}`;

    const { stdout, stderr, exitCode } = runWrapper({
      home,
      env: {
        PATH: controlledPath,
        // Explicitly unset WHATSOUP_NODE to exercise the missing pinned-node path.
      },
    });

    // Missing pinned Node must fail cleanly without invoking PATH fallback.
    expect(exitCode, 'missing pinned node must prevent execution').not.toBe(0);
    expect(exitCode, 'missing pinned node must exit 1, not 9').toBe(1);
    expect(stderr, 'stderr must contain pinned major in missing-node case').toContain('24');
    expect(stderr, 'stderr must not run the PATH-node compatibility gate').not.toContain('resolved Node is incompatible');
    expect(stderr, 'stderr must not report a resolved PATH node version').not.toContain('Version:');
    // Must not have hit exec — fake node prints "gate-passed" only when exec succeeds
    expect(stdout, 'must not have reached exec via PATH fallback (no gate-passed in stdout)').not.toContain(
      'gate-passed',
    );
  });

  it('Test 4: non-dotted .nvmrc (lts/iron, latest, ...) fails fast before gate arithmetic', () => {
    // ${NVMRC_VERSION%%.*} on "lts/iron" yields the literal string "lts/iron".
    // The subsequent `[ "$node_major" -lt "lts/iron" ]` arithmetic comparison
    // errors, `2>/dev/null` suppresses the error, the `if` condition
    // evaluates false, and the gate silently fails open. Without a format
    // check up front, a future .nvmrc bump to an nvm alias would disable
    // the gate's entire purpose.
    const fixtureWrapper = makeFixtureRepoWithNvmrc('lts/iron');
    const binDir = makeTmpDir('whatsoup-gate-nvmrc-bin-');
    const home = makeBareHome();
    // Fake node that reports a major matching the would-be required major if
    // the gate ran the broken comparison and fell open — i.e. it would
    // pass through to exec and print gate-passed.  With the format guard in
    // place, the wrapper must abort BEFORE invoking node at all.
    writeFakeNode(binDir, '24');

    const { stdout, stderr, exitCode } = runWrapper({
      home,
      env: {
        WHATSOUP_NODE: path.join(binDir, 'node'),
      },
      wrapperOverride: fixtureWrapper,
    });

    expect(exitCode, 'non-dotted .nvmrc must fail fast (non-zero exit)').not.toBe(0);
    expect(exitCode, 'non-dotted .nvmrc must exit 1, not 9').toBe(1);
    // Stderr must surface the rejected value so the operator can see what's wrong.
    expect(stderr, 'stderr must echo the rejected .nvmrc value').toContain('lts/iron');
    // Stderr must contain the diagnostic phrase identifying the format violation.
    expect(stderr, 'stderr must explain the dotted-version requirement').toContain('dotted version');
    // Must not have reached exec.
    expect(stderr, 'gate must fire before exec — no exec flag in stderr').not.toContain('--experimental-strip-types');
    expect(stdout, 'must not have reached exec (no gate-passed in stdout)').not.toContain('gate-passed');
  });
});
