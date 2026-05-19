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
function writeFakeNode(binDir: string, majorStr: string): string {
  const nodePath = path.join(binDir, 'node');
  // Detect -p 'process.versions.node...' by the presence of "process.versions.node"
  // in the arguments list.  Detect --version by checking $1.
  writeExecutable(
    nodePath,
    [
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
      '# Any other invocation (i.e., the guarded exec reached through)',
      "printf 'gate-passed\\n'",
      'exit 0',
      '',
    ].join('\n'),
  );
  return nodePath;
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
function makeFixtureRepoWithNvmrc(nvmrcContents: string): string {
  const fixtureRoot = makeTmpDir('whatsoup-gate-fixture-repo-');
  fs.mkdirSync(path.join(fixtureRoot, 'deploy'), { recursive: true });
  const wrapperContents = fs.readFileSync(wrapperPath, 'utf8');
  const fixtureWrapper = path.join(fixtureRoot, 'deploy', 'whatsoup');
  fs.writeFileSync(fixtureWrapper, wrapperContents, 'utf8');
  fs.chmodSync(fixtureWrapper, 0o755);
  fs.writeFileSync(path.join(fixtureRoot, '.nvmrc'), `${nvmrcContents}\n`, 'utf8');
  return fixtureWrapper;
}

describe('deploy/whatsoup — Node major-version gate', () => {
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

  it('Test 3: command -v fallback path is also gated (old system node fails)', () => {
    // Simulate: HOME has no nvm dir → DEFAULT_NODE missing → wrapper falls
    // through to `command -v node`. But the `node` on PATH is too old (major 20).
    const binDir = makeTmpDir('whatsoup-gate-fallback-bin-');
    const home = makeBareHome(); // no ~/.nvm/versions/…

    // Write an old fake `node` into binDir — wrapper's `command -v node` will find it
    writeFakeNode(binDir, '20');

    // Build a controlled PATH that puts our fake node first.
    // Do NOT set WHATSOUP_NODE so the wrapper uses the DEFAULT_NODE → fallback path.
    const controlledPath = `${binDir}:${process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin'}`;

    const { stdout, stderr, exitCode } = runWrapper({
      home,
      env: {
        PATH: controlledPath,
        // Explicitly unset WHATSOUP_NODE to trigger the fallback path
      },
    });

    // Gate must fire on the fallback path too
    expect(exitCode, 'fallback-path gate must prevent execution').not.toBe(0);
    expect(exitCode, 'fallback-path gate must exit 1, not 9').toBe(1);
    expect(stderr, 'stderr must contain pinned major in fallback case').toContain('24');
    expect(stderr, 'stderr must contain resolved major in fallback case').toContain('20');
    // Must not have hit exec — fake node prints "gate-passed" only when exec succeeds
    expect(stdout, 'must not have reached exec via fallback path (no gate-passed in stdout)').not.toContain(
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
