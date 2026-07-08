// tests/scripts/ensure-node-installed.test.ts
//
// Black-box tests for deploy/scripts/ensure-node-installed.sh.
// Spawns the script directly with controlled HOME / NVM_DIR / REPO_ROOT
// fixtures so we can exercise every branch deterministically.
//
// No setTimeout/sleep — purely synchronous process spawn + result inspection.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'deploy/scripts/ensure-node-installed.sh');

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
  const dir = mkdtempSync(join(tmpdir(), 'ensure-node-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Creates a minimal REPO_ROOT fixture with an optional .nvmrc file.
 * When nvmrcContent is undefined, no .nvmrc file is written (missing case).
 */
function makeRepoFixture(nvmrcContent?: string): string {
  const dir = makeTmpDir();
  if (nvmrcContent !== undefined) {
    writeFileSync(join(dir, '.nvmrc'), nvmrcContent, 'utf8');
  }
  return dir;
}

/**
 * Creates a HOME fixture with a fake ~/.nvm/nvm.sh script.
 * The fake nvm() function handles the `install` subcommand according to
 * the provided installBody shell snippet.
 *
 * The fake script references an unbound variable ($NVM_CD_FLAGS) during init,
 * mimicking real nvm.sh (v0.39+) which references several unset variables on
 * source.  Under `set -u`, sourcing real nvm aborts the calling script; this
 * fixture catches that regression in our pre-install wrapper.
 */
function makeHomeWithFakeNvm(installBody: string): { home: string; nvmDir: string } {
  const home = makeTmpDir();
  const nvmDir = join(home, '.nvm');
  mkdirSync(nvmDir, { recursive: true });

  const nvmSh = [
    '#!/usr/bin/env bash',
    '# Mimic real nvm.sh: reference an unbound variable during init.',
    '# Under `set -u`, expanding $NVM_CD_FLAGS aborts the sourcing script.',
    'echo "$NVM_CD_FLAGS" > /dev/null',
    'nvm() {',
    '  local subcmd="$1"',
    '  shift',
    '  case "$subcmd" in',
    '    install)',
    `      ${installBody}`,
    '      ;;',
    '    *)',
    '      echo "nvm: unknown subcommand: $subcmd" >&2',
    '      return 1',
    '      ;;',
    '  esac',
    '}',
    'export -f nvm',
    '',
  ].join('\n');

  writeFileSync(join(nvmDir, 'nvm.sh'), nvmSh, 'utf8');
  return { home, nvmDir };
}

/** Spawn the script and return exit code, stdout, stderr. */
function runScript(env: Record<string, string | undefined>): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('ensure-node-installed.sh', () => {
  // ── Test 1 ─────────────────────────────────────────────────────────────────
  it('exits 0 with a warning to stderr when nvm is absent', () => {
    const home = makeTmpDir(); // no .nvm directory
    const repo = makeRepoFixture('24.15.0\n');

    const { exitCode, stderr } = runScript({
      HOME: home,
      NVM_DIR: join(home, '.nvm-nonexistent'),
      REPO_ROOT: repo,
    });

    expect(exitCode, 'should exit 0 when nvm is not present').toBe(0);
    expect(stderr).toMatch(/nvm not found/i);
  });

  // ── Test 2 ─────────────────────────────────────────────────────────────────
  it('exits 0 idempotently when nvm is present and the version is already installed', () => {
    const { home, nvmDir } = makeHomeWithFakeNvm(
      'echo "already installed" >&2; return 0',
    );
    const repo = makeRepoFixture('24.15.0\n');

    const { exitCode, stderr } = runScript({
      HOME: home,
      NVM_DIR: nvmDir,
      REPO_ROOT: repo,
    });

    expect(exitCode, 'should exit 0 on idempotent install').toBe(0);
    expect(stderr).toMatch(/already installed/i);
  });

  it('skips nvm install when the pinned local node binary already exists', () => {
    const { home, nvmDir } = makeHomeWithFakeNvm(
      'echo "nvm install should not run" >&2; return 42',
    );
    const repo = makeRepoFixture('24.15.0\n');
    const localNode = join(nvmDir, 'versions/node/v24.15.0/bin/node');
    mkdirSync(dirname(localNode), { recursive: true });
    writeFileSync(localNode, '#!/usr/bin/env sh\nexit 0\n', 'utf8');
    chmodSync(localNode, 0o755);

    const { exitCode, stderr } = runScript({
      HOME: home,
      NVM_DIR: nvmDir,
      REPO_ROOT: repo,
    });

    expect(exitCode, 'should exit 0 without calling nvm install').toBe(0);
    expect(stderr).toMatch(/already present/i);
    expect(stderr).not.toContain('nvm install should not run');
  });

  // ── Test 3 ─────────────────────────────────────────────────────────────────
  it('exits 0 and creates a marker file when nvm install succeeds for a new version', () => {
    const home = makeTmpDir();
    const nvmDir = join(home, '.nvm');
    mkdirSync(nvmDir, { recursive: true });
    const markerPath = join(home, 'nvm-install-called.marker');

    // Inline fixture — marker path must be embedded in the shell heredoc
    const nvmSh = [
      '#!/usr/bin/env bash',
      'nvm() {',
      '  local subcmd="$1"',
      '  shift',
      '  case "$subcmd" in',
      '    install)',
      `      echo "install:$*" > "${markerPath}"`,
      '      return 0',
      '      ;;',
      '    *)',
      '      echo "nvm: unknown subcommand: $subcmd" >&2',
      '      return 1',
      '      ;;',
      '  esac',
      '}',
      'export -f nvm',
      '',
    ].join('\n');
    writeFileSync(join(nvmDir, 'nvm.sh'), nvmSh, 'utf8');

    const repo = makeRepoFixture('24.15.0\n');

    const { exitCode } = runScript({
      HOME: home,
      NVM_DIR: nvmDir,
      REPO_ROOT: repo,
    });

    expect(exitCode, 'should exit 0 after successful install').toBe(0);
    expect(existsSync(markerPath), 'marker file should have been created by fake nvm').toBe(true);

    const markerContent = readFileSync(markerPath, 'utf8').trim();
    expect(markerContent).toContain('24.15.0');
  });

  // ── Test 4 ─────────────────────────────────────────────────────────────────
  it('propagates the exact non-zero exit code from nvm install', () => {
    // Use a distinctive code (42) — not 1 — so the assertion proves
    // propagation fidelity, not just "non-zero in / non-zero out".
    const { home, nvmDir } = makeHomeWithFakeNvm(
      'echo "network error: cannot download node" >&2; return 42',
    );
    const repo = makeRepoFixture('24.15.0\n');

    const { exitCode, stderr } = runScript({
      HOME: home,
      NVM_DIR: nvmDir,
      REPO_ROOT: repo,
    });

    expect(exitCode, 'should propagate the exact exit code from nvm install').toBe(42);
    expect(stderr).toMatch(/network error|cannot download/i);
  });

  // ── Test 5a ────────────────────────────────────────────────────────────────
  it('exits non-zero with a diagnostic when .nvmrc is missing', () => {
    const home = makeTmpDir();
    const repo = makeRepoFixture(); // intentionally no .nvmrc written

    const { exitCode, stderr } = runScript({
      HOME: home,
      NVM_DIR: join(home, '.nvm-absent'),
      REPO_ROOT: repo,
    });

    expect(exitCode, 'should exit non-zero when .nvmrc is absent').not.toBe(0);
    expect(stderr).toMatch(/\.nvmrc/i);
  });

  // ── Test 5b ────────────────────────────────────────────────────────────────
  it('exits non-zero with a format diagnostic when .nvmrc holds an alias like lts/iron', () => {
    // The wrapper's version gate (PR #663) rejects alias forms, so the
    // pre-install must surface them as fail-fast diagnostics rather than
    // letting nvm resolve them.
    const home = makeTmpDir();
    const repo = makeRepoFixture('lts/iron\n');

    const { exitCode, stderr } = runScript({
      HOME: home,
      NVM_DIR: join(home, '.nvm-absent'),
      REPO_ROOT: repo,
    });

    expect(exitCode, 'should exit non-zero when .nvmrc holds an alias').not.toBe(0);
    expect(stderr).toContain('lts/iron');
    expect(stderr).toMatch(/dotted version/i);
  });
});
