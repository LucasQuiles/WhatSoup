/**
 * deploy/setup.sh on a release host.
 *
 * Step 3 links ~/.local/bin/whatsoup to the tree setup runs from, and on macOS
 * step 4 bakes that tree into the timer plists. On a host whose bot runs a
 * release export, either change moves the bot or its timers to another tree at
 * their next start, outside release:activate and its backup, verification and
 * rollback. These tests pin the refusal, the atomic link swap, and the step
 * selection flags that let a release host run only the steps that select no
 * release.
 *
 * The tree classification runs setup.sh's own guard helpers, sliced from the
 * script between their marker comments, with BIN_DIR, REPO_ROOT and PLATFORM
 * set as setup.sh sets them. A smaller set of full runs copies deploy/setup.sh
 * into fake trees (a git checkout, a release export with its manifest, or an
 * older export with neither) under a temp HOME, so setup.sh computes REPO_ROOT
 * itself; every refusal there compares a snapshot of the whole temp root before
 * and after the run. PATH shims stand in for launchctl, systemctl, crontab and
 * security, so no run reaches the host's service manager or keychain.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RELEASE_MANIFEST_FILE } from '../../scripts/release-snapshot-plan.ts';
import { cleanGitEnv } from '../../src/lib/git-env.ts';
import { gitFixture } from './preflight-git-fixture-helper.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const setupSource = fs.readFileSync(path.join(repoRoot, 'deploy', 'setup.sh'), 'utf8');
const tempRoots: string[] = [];

/** The eight links step 3 installs in ~/.local/bin, and the file each names inside a tree. */
const LINKS: Record<string, string> = {
  whatsoup: 'deploy/whatsoup',
  'whatsoup-fleet': 'deploy/whatsoup-fleet',
  'whatsoup-auth': 'deploy/whatsoup-auth',
  'whatsoup-ensure-node': 'deploy/scripts/ensure-node-installed.sh',
  'whatsoup-harness-maintenance': 'deploy/scripts/harness-maintenance.sh',
  'whatsoup-reply-guarantee-drain': 'deploy/scripts/reply-guarantee-drain.sh',
  'whatsoup-heal-notify': 'deploy/scripts/heal-notify.sh',
  'whatsoup-release-drift-linux.sh': 'deploy/scripts/whatsoup-release-drift-linux.sh',
};
const HELPERS = Object.keys(LINKS).filter((name) => name !== 'whatsoup');
const PREFLIGHT_EVENTS = ['host-plan', 'ensure-node', 'doctor'];
const WRAPPERS = 'repoint the wrappers';
const TIMERS = 'render the launchd timer plists';
const FRESH_INSTALL_HINT = 'remove ~/.local/bin/whatsoup first if this is a fresh install';
const SAME_TREE_OTHER_PATH = 'run setup through the path the wrapper names';
const NOT_BOTH_CHECKOUTS = 'the two are not both git checkouts';
const SWITCH_FLAG = '--switch-release-tree';
const LINUX_NOTE = `On Linux, where release:activate refuses, re-run with ${SWITCH_FLAG}`;
const ONLY_OPTIONS = ['--wrappers-only', '--timers-only', '--npmrc-only', '--skip-wrappers'];
const GUARD_START = '# --- release guard helpers start ---';
const GUARD_END = '# --- release guard helpers end ---';

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), prefix)));
  tempRoots.push(root);
  return root;
}

function writeExecutable(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o755 });
}

/**
 * A tree setup.sh can run from: its own copy of setup.sh and bounded-exec.sh,
 * stub preflight scripts, and the eight link targets. A checkout is a git work
 * tree. A release carries the manifest at its root. An unmarked export is an
 * older release with neither, which release:activate still accepts.
 */
type TreeKind = 'checkout' | 'release' | 'unmarked-export';

/**
 * The files Linux step 4 copies from deploy/ (units, timers, env templates),
 * for a tree a full default run must get through.
 */
function copyDeployUnits(dir: string): void {
  for (const name of fs.readdirSync(path.join(repoRoot, 'deploy'))) {
    if (/\.(service|timer)$|\.env\.example$|^npmrc\.hardened$/.test(name)) {
      fs.copyFileSync(path.join(repoRoot, 'deploy', name), path.join(dir, 'deploy', name));
    }
  }
}

function makeTree(dir: string, kind: TreeKind, opts: { units?: boolean } = {}): string {
  fs.mkdirSync(path.join(dir, 'deploy', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'deploy', 'setup.sh'), path.join(dir, 'deploy', 'setup.sh'));
  fs.copyFileSync(
    path.join(repoRoot, 'deploy', 'lib', 'bounded-exec.sh'),
    path.join(dir, 'deploy', 'lib', 'bounded-exec.sh'),
  );
  fs.copyFileSync(path.join(repoRoot, '.nvmrc'), path.join(dir, '.nvmrc'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
  for (const stub of ['install-host-dependencies.sh', 'ensure-node-installed.sh', 'whatsoup-host-doctor.sh']) {
    writeExecutable(path.join(dir, 'deploy', 'scripts', stub), '#!/bin/bash\nexit 0\n');
  }
  for (const target of Object.values(LINKS)) {
    if (!fs.existsSync(path.join(dir, target))) writeExecutable(path.join(dir, target), '#!/bin/bash\nexit 0\n');
  }
  if (kind === 'release') fs.writeFileSync(path.join(dir, RELEASE_MANIFEST_FILE), '{}\n');
  if (kind === 'checkout') gitFixture(dir, ['init', '-q']);
  if (opts.units) copyDeployUnits(dir);
  return dir;
}

const wrapperOf = (tree: string): string => path.join(tree, 'deploy', 'whatsoup');

/**
 * Every entry under ROOT (not following links, skipping .git): its type, mode,
 * inode and mtime, plus a content hash for a file or the target for a link.
 */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (p: string): void => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      out[p] = 'absent';
      return;
    }
    const id = `mode=${st.mode.toString(8)} ino=${st.ino} mtime=${st.mtimeMs}`;
    if (st.isSymbolicLink()) {
      out[p] = `link -> ${fs.readlinkSync(p)} ${id}`;
    } else if (st.isDirectory()) {
      out[p] = `dir ${id}`;
      for (const name of fs.readdirSync(p).sort()) if (name !== '.git') visit(path.join(p, name));
    } else {
      out[p] = `file sha256=${createHash('sha256').update(fs.readFileSync(p)).digest('hex')} ${id}`;
    }
  };
  visit(root);
  return out;
}

/**
 * PATH shims for a full run; FAKE_UNAME_S picks the platform setup sees. The
 * service managers, crontab and the keychain tool only record or fail, so even
 * a run that wrongly passes the guard on macOS stays inside the temp root.
 */
function writeShims(dir: string): void {
  writeExecutable(path.join(dir, 'bash'), [
    '#!/bin/bash',
    'case "${1:-}" in',
    '  */install-host-dependencies.sh) printf "%s\\n" host-plan >> "$WHATSOUP_SETUP_EVENTS" ;;',
    '  */ensure-node-installed.sh) printf "%s\\n" ensure-node >> "$WHATSOUP_SETUP_EVENTS" ;;',
    '  */whatsoup-host-doctor.sh) printf "%s\\n" doctor >> "$WHATSOUP_SETUP_EVENTS" ;;',
    'esac',
    'exec /bin/bash "$@"',
    '',
  ].join('\n'));
  writeExecutable(path.join(dir, 'uname'), [
    '#!/usr/bin/env bash',
    'if [[ "${1:-}" == "-m" ]]; then printf "x86_64\\n"; exit 0; fi',
    'printf "%s\\n" "${FAKE_UNAME_S:-Linux}"',
    '',
  ].join('\n'));
  writeExecutable(path.join(dir, 'node'), [
    '#!/usr/bin/env bash',
    'if [[ "${1:-}" == "-v" || "${1:-}" == "--version" ]]; then printf "v24.15.0\\n"; exit 0; fi',
    'if [[ "${1:-}" == "-p" ]]; then printf "x64\\n"; exit 0; fi',
    'if [[ "${1:-}" == "-e" ]]; then printf "26"; exit 0; fi',
    'if [[ "${1:-}" == "--experimental-strip-types" ]]; then printf "%s\\n" npmrc-merge >> "$WHATSOUP_SETUP_EVENTS"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n'));
  writeExecutable(path.join(dir, 'npm'), [
    '#!/usr/bin/env bash',
    'if [[ "${1:-}" == "--version" ]]; then printf "11.12.1\\n"; exit 0; fi',
    'printf "npm:%s\\n" "${1:-}" >> "$WHATSOUP_SETUP_EVENTS"',
    // Which tree the bot wrapper names while step 2 installs dependencies.
    'if [[ "${1:-}" == "ci" ]]; then printf "wrapper-at-ci:%s\\n" "$(readlink "$HOME/.local/bin/whatsoup" 2>/dev/null)" >> "$WHATSOUP_SETUP_EVENTS"; fi',
    'exit 0',
    '',
  ].join('\n'));
  // No test expects a call to these three; one shows up as an event.
  for (const tool of ['launchctl', 'crontab', 'security']) {
    writeExecutable(path.join(dir, tool), `#!/usr/bin/env bash\nprintf "${tool}:%s\\n" "\${1:-}" >> "$WHATSOUP_SETUP_EVENTS"\nexit 1\n`);
  }
  writeExecutable(path.join(dir, 'systemctl'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(path.join(dir, 'apt-get'), '#!/usr/bin/env bash\nexit 0\n');
  writeExecutable(path.join(dir, 'secret-tool'), '#!/usr/bin/env bash\nexit 1\n');
}

interface Host {
  base: string;
  home: string;
  bin: string;
  shims: string;
  events: string;
  profile: string;
}

function makeHost(): Host {
  const base = makeTempRoot('whatsoup-setup-guard-');
  const home = path.join(base, 'home');
  const bin = path.join(home, '.local', 'bin');
  const shims = path.join(base, 'shims');
  fs.mkdirSync(bin, { recursive: true });
  writeShims(shims);
  const profile = path.join(base, 'profile.json');
  fs.writeFileSync(profile, '{}\n');
  return { base, home, bin, shims, events: path.join(base, 'events.log'), profile };
}

function linkWrapper(host: Host, target: string): void {
  fs.symlinkSync(target, path.join(host.bin, 'whatsoup'));
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  events: string[];
}

interface RunOptions {
  platform?: 'Linux' | 'Darwin';
  env?: NodeJS.ProcessEnv;
  /** Function-level only: the value setup.sh's parser gives switch_release_tree. */
  switchTree?: boolean;
}

function readEvents(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
}

/**
 * Run setup.sh's guard helpers alone: the block between the marker comments,
 * then refuse_release_bound_change, as step 3 calls it. REPO_ROOT is the path
 * setup would compute for a run of REPO/deploy/setup.sh (it keeps a linked path).
 */
function runGuard(host: Host, repo: string, opts: RunOptions = {}): Run & { passed: boolean } {
  const start = setupSource.indexOf(GUARD_START);
  const end = setupSource.indexOf(GUARD_END, start);
  if (start === -1 || end === -1) throw new Error('release guard helper markers not found in deploy/setup.sh');
  const harness = [
    'set -euo pipefail',
    `BIN_DIR=${JSON.stringify(host.bin)}`,
    `REPO_ROOT=${JSON.stringify(repo)}`,
    `PLATFORM=${JSON.stringify(opts.platform ?? 'Linux')}`,
    `switch_release_tree=${opts.switchTree ? 1 : 0}`,
    setupSource.slice(start, end),
    'refuse_release_bound_change "repoint the wrappers in $BIN_DIR"',
    'echo guard-passed',
    '',
  ].join('\n');
  const result = spawnSync('bash', ['-c', harness], {
    cwd: host.base,
    env: { ...cleanGitEnv(), ...opts.env, HOME: host.home },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    events: [],
    passed: result.status === 0 && result.stdout.includes('guard-passed'),
  };
}

/** Require the guard to refuse with exit 2, name release:activate, and change nothing. */
function expectGuardRefusal(host: Host, repo: string, opts: RunOptions = {}): Run {
  const before = snapshot(host.base);
  const run = runGuard(host, repo, opts);
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(2);
  expect(run.stdout).not.toContain('guard-passed');
  expect(run.stderr).toContain(`Refusing to ${WRAPPERS}`);
  expect(run.stderr).toContain('release:activate');
  expect(snapshot(host.base)).toEqual(before);
  return run;
}

function expectGuardPass(host: Host, repo: string, opts: RunOptions = {}): void {
  const run = runGuard(host, repo, opts);
  expect(run.passed, `${run.stdout}\n${run.stderr}`).toBe(true);
  expect(run.stderr).toBe('');
}

/** Run TREE/deploy/setup.sh under the host's temp HOME, with no inherited GIT_* variables. */
function runSetup(host: Host, tree: string, args: string[], opts: RunOptions = {}): Run {
  const result = spawnSync('bash', [path.join(tree, 'deploy', 'setup.sh'), ...args], {
    cwd: host.base,
    env: {
      ...cleanGitEnv(),
      ...opts.env,
      HOME: host.home,
      NVM_DIR: path.join(host.home, '.nvm'),
      PATH: `${host.shims}:${process.env.PATH ?? ''}`,
      USER: 'setup-test',
      FAKE_UNAME_S: opts.platform ?? 'Linux',
      BOT_ERRORS_HEALTH_PROFILE: host.profile,
      WHATSOUP_SETUP_EVENTS: host.events,
    },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, events: readEvents(host.events) };
}

/** Run setup and require a refusal that ran no step and changed nothing under the host's temp root. */
function expectRefusal(host: Host, tree: string, args: string[], action: string, opts: RunOptions = {}): Run {
  const before = snapshot(host.base);
  const run = runSetup(host, tree, args, opts);
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(2);
  expect(run.stderr).toContain(`Refusing to ${action}`);
  expect(run.stderr).toContain('release:activate');
  expect(run.events).toEqual([]);
  expect(snapshot(host.base)).toEqual(before);
  return run;
}

function expectLinksInto(host: Host, tree: string, names: string[]): void {
  for (const name of names) {
    expect(fs.readlinkSync(path.join(host.bin, name)), name).toBe(path.join(tree, LINKS[name]));
  }
}

describe('deploy/setup.sh release guard helpers: which wrapper switch passes', () => {
  it('passes a first install: no wrapper exists yet', () => {
    const host = makeHost();
    expectGuardPass(host, makeTree(path.join(host.base, 'releases', 'r1'), 'release'));
  });

  it('passes a re-run of the active release through the path the wrapper names', () => {
    const host = makeHost();
    const release = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    linkWrapper(host, wrapperOf(release));
    expectGuardPass(host, release);
  });

  it('passes a switch between two git checkouts, and a checkout reached through a linked path', () => {
    const host = makeHost();
    const previous = makeTree(path.join(host.base, 'checkout-a'), 'checkout');
    const next = makeTree(path.join(host.base, 'checkout-b'), 'checkout');
    linkWrapper(host, wrapperOf(previous));
    expectGuardPass(host, next);
    const alias = path.join(host.base, 'checkout-link');
    fs.symlinkSync(previous, alias);
    expectGuardPass(host, alias);
  });

  it('refuses to move the wrapper from a checkout onto a release', () => {
    const host = makeHost();
    const checkout = makeTree(path.join(host.base, 'checkout'), 'checkout');
    const release = makeTree(path.join(host.base, 'releases', 'r2'), 'release');
    linkWrapper(host, wrapperOf(checkout));
    expect(expectGuardRefusal(host, release).stderr).toContain(NOT_BOTH_CHECKOUTS);
  });

  it('refuses a switch between two releases when the wrapper is a relative link, and prints the resolved target', () => {
    const host = makeHost();
    const current = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    const next = makeTree(path.join(host.base, 'releases', 'r2'), 'release');
    fs.symlinkSync(path.relative(host.bin, wrapperOf(current)), path.join(host.bin, 'whatsoup'));
    expect(expectGuardRefusal(host, next).stderr).toContain(`-> ${wrapperOf(current)}`);
  });

  it('refuses a re-run of the active release through another path than the wrapper names', () => {
    const host = makeHost();
    const release = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    const alias = path.join(host.base, 'current');
    fs.symlinkSync(release, alias);
    linkWrapper(host, wrapperOf(release));
    expect(expectGuardRefusal(host, alias).stderr).toContain(SAME_TREE_OTHER_PATH);
  });

  it('refuses a move off an older release that has no manifest, and onto one', () => {
    const host = makeHost();
    const old = makeTree(path.join(host.base, 'releases', 'r0'), 'unmarked-export');
    const checkout = makeTree(path.join(host.base, 'checkout'), 'checkout');
    linkWrapper(host, wrapperOf(old));
    expectGuardRefusal(host, checkout);
    fs.unlinkSync(path.join(host.bin, 'whatsoup'));
    linkWrapper(host, wrapperOf(checkout));
    expectGuardRefusal(host, old);
  });

  it('counts a checkout that carries a release manifest as a release', () => {
    const host = makeHost();
    const marked = makeTree(path.join(host.base, 'checkout-a'), 'checkout');
    fs.writeFileSync(path.join(marked, RELEASE_MANIFEST_FILE), '{}\n');
    const checkout = makeTree(path.join(host.base, 'checkout-b'), 'checkout');
    linkWrapper(host, wrapperOf(marked));
    expectGuardRefusal(host, checkout);
  });

  it('does not count a release inside an unrelated git work tree as a checkout', () => {
    const host = makeHost();
    const outer = path.join(host.base, 'outer');
    fs.mkdirSync(outer);
    gitFixture(outer, ['init', '-q']);
    const old = makeTree(path.join(outer, 'releases', 'r0'), 'unmarked-export');
    const checkout = makeTree(path.join(host.base, 'checkout'), 'checkout');
    linkWrapper(host, wrapperOf(old));
    expectGuardRefusal(host, checkout);
  });

  it('does not let an inherited GIT_DIR make a release look like a checkout', () => {
    const host = makeHost();
    const old = makeTree(path.join(host.base, 'releases', 'r0'), 'unmarked-export');
    const checkout = makeTree(path.join(host.base, 'checkout'), 'checkout');
    linkWrapper(host, wrapperOf(old));
    expectGuardRefusal(host, checkout, { env: { GIT_DIR: path.join(checkout, '.git') } });
  });

  describe('refuses a wrapper that does not resolve to an existing deploy/whatsoup, and says how to proceed on a fresh install', () => {
    function hostWithCheckout(): { host: Host; previous: string; checkout: string } {
      const host = makeHost();
      const previous = makeTree(path.join(host.base, 'checkout-a'), 'checkout');
      const checkout = makeTree(path.join(host.base, 'checkout-b'), 'checkout');
      return { host, previous, checkout };
    }

    it('its target directory is gone', () => {
      const { host, checkout } = hostWithCheckout();
      linkWrapper(host, wrapperOf(path.join(host.base, 'gone')));
      expect(expectGuardRefusal(host, checkout).stderr).toContain(FRESH_INSTALL_HINT);
    });

    it('its target file is gone but the directory remains', () => {
      const { host, previous, checkout } = hostWithCheckout();
      linkWrapper(host, wrapperOf(previous));
      fs.unlinkSync(wrapperOf(previous));
      expect(expectGuardRefusal(host, checkout).stderr).toContain(FRESH_INSTALL_HINT);
    });

    it('its link chain is longer than 40 links', () => {
      const { host, previous, checkout } = hostWithCheckout();
      const chain = path.join(host.base, 'chain');
      fs.mkdirSync(chain);
      let next = wrapperOf(previous);
      for (let hop = 41; hop >= 0; hop -= 1) {
        const link = path.join(chain, `hop-${hop}`);
        fs.symlinkSync(next, link);
        next = link;
      }
      linkWrapper(host, next);
      expect(expectGuardRefusal(host, checkout).stderr).toContain(FRESH_INSTALL_HINT);
    });

    it('it resolves to a file that is not a deploy/whatsoup', () => {
      const { host, previous, checkout } = hostWithCheckout();
      writeExecutable(path.join(previous, 'bin', 'other'), '#!/bin/bash\n');
      linkWrapper(host, path.join(previous, 'bin', 'other'));
      expect(expectGuardRefusal(host, checkout).stderr).toContain(FRESH_INSTALL_HINT);
    });

    it('it is a regular file rather than a link', () => {
      const { host, checkout } = hostWithCheckout();
      writeExecutable(path.join(host.bin, 'whatsoup'), '#!/bin/bash\n');
      expect(expectGuardRefusal(host, checkout).stderr).toContain(FRESH_INSTALL_HINT);
    });
  });

  it('names the switch flag on Linux, and the activation command only on macOS', () => {
    const host = makeHost();
    const release = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    const checkout = makeTree(path.join(host.base, 'checkout'), 'checkout');
    linkWrapper(host, wrapperOf(release));
    const linux = expectGuardRefusal(host, checkout, { platform: 'Linux' });
    expect(linux.stderr).toContain(LINUX_NOTE);
    expect(linux.stderr).not.toContain('--aux-label');
    expect(linux.stderr).not.toContain('by hand to the other tree');
    const darwin = expectGuardRefusal(host, checkout, { platform: 'Darwin' });
    expect(darwin.stderr).not.toContain(SWITCH_FLAG);
    expect(darwin.stderr).toContain('--aux-label com.whatsoup.harness-maintenance=setup-timer');
    expect(darwin.stderr).toContain('--aux-label com.whatsoup.reply-guarantee=setup-timer');
  });
});

describe(`deploy/setup.sh release guard helpers with ${SWITCH_FLAG} (Linux)`, () => {
  /** Pass with the flag, and print the old and the new wrapper target. */
  function expectSwitch(host: Host, from: string, to: string): void {
    const run = runGuard(host, to, { switchTree: true });
    expect(run.passed, `${run.stdout}\n${run.stderr}`).toBe(true);
    expect(run.stdout).toContain(`Old wrapper target: ${wrapperOf(from)}`);
    expect(run.stdout).toContain(`New wrapper target: ${wrapperOf(to)}`);
    expect(run.stdout).toContain(`bash ${path.join(from, 'deploy', 'setup.sh')} ${SWITCH_FLAG}`);
  }

  it('switches a checkout to a release, a release to the next, and back', () => {
    const host = makeHost();
    const checkout = makeTree(path.join(host.base, 'checkout'), 'checkout');
    const r1 = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    const r2 = makeTree(path.join(host.base, 'releases', 'r2'), 'release');
    linkWrapper(host, wrapperOf(checkout));
    expectSwitch(host, checkout, r1);
    fs.unlinkSync(path.join(host.bin, 'whatsoup'));
    linkWrapper(host, wrapperOf(r1));
    expectSwitch(host, r1, r2);
    fs.unlinkSync(path.join(host.bin, 'whatsoup'));
    linkWrapper(host, wrapperOf(r2));
    expectSwitch(host, r2, r1);
  });

  it('still refuses a wrapper that does not resolve: the old tree is unknown', () => {
    const host = makeHost();
    const release = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    linkWrapper(host, wrapperOf(path.join(host.base, 'gone')));
    const run = runGuard(host, release, { switchTree: true });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(2);
    expect(run.stderr).toContain(FRESH_INSTALL_HINT);
    expect(run.stdout).not.toContain('Old wrapper target');
  });
});

describe('deploy/setup.sh release guard: each refusal runs no step and changes nothing', () => {
  it('refuses a default run from a checkout when the wrapper runs a release (Linux), and names the switch flag', () => {
    const host = makeHost();
    const release = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    const checkout = makeTree(path.join(host.base, 'checkout'), 'checkout');
    linkWrapper(host, wrapperOf(release));

    const run = expectRefusal(host, checkout, [], WRAPPERS);
    expect(run.stderr).toContain('--npmrc-only');
    expect(run.stderr).toContain(LINUX_NOTE);
  });

  it('refuses --wrappers-only from a checkout when the wrapper runs a release (macOS), and names the full activation command', () => {
    const host = makeHost();
    const release = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    const checkout = makeTree(path.join(host.base, 'checkout'), 'checkout');
    linkWrapper(host, wrapperOf(release));

    const run = expectRefusal(host, checkout, ['--wrappers-only'], WRAPPERS, { platform: 'Darwin' });
    expect(run.stderr).toContain('--aux-label com.whatsoup.harness-maintenance=setup-timer');
    expect(run.stderr).toContain('--aux-label com.whatsoup.reply-guarantee=setup-timer');
  });

  it('refuses --skip-wrappers from another tree on macOS: step 4 still renders the timers', () => {
    const host = makeHost();
    const release = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    const checkout = makeTree(path.join(host.base, 'checkout'), 'checkout');
    linkWrapper(host, wrapperOf(release));

    expectRefusal(host, checkout, ['--skip-wrappers'], TIMERS, { platform: 'Darwin' });
  });

  it('refuses --timers-only from another release on macOS', () => {
    const host = makeHost();
    const current = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    const next = makeTree(path.join(host.base, 'releases', 'r2'), 'release');
    linkWrapper(host, wrapperOf(current));

    expectRefusal(host, next, ['--timers-only'], TIMERS, { platform: 'Darwin' });
  });

  it('refuses --wrappers-only combined with --skip-wrappers', () => {
    const host = makeHost();
    const release = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    linkWrapper(host, wrapperOf(release));
    const before = snapshot(host.base);

    const run = runSetup(host, release, ['--wrappers-only', '--skip-wrappers']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--wrappers-only and --skip-wrappers cannot be combined');
    expect(run.events).toEqual([]);
    expect(snapshot(host.base)).toEqual(before);
  });
});

describe(`deploy/setup.sh ${SWITCH_FLAG}: a deliberate Linux tree switch`, () => {
  it('moves a Linux host from release N to N+1: dependencies first, then every link, then the units', () => {
    const host = makeHost();
    const current = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    const next = makeTree(path.join(host.base, 'releases', 'r2'), 'release', { units: true });
    linkWrapper(host, wrapperOf(current));
    for (const name of HELPERS) fs.symlinkSync(path.join(current, LINKS[name]), path.join(host.bin, name));

    const run = runSetup(host, next, [SWITCH_FLAG]);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    const announced = run.stdout.indexOf(`Old wrapper target: ${wrapperOf(current)}`);
    expect(announced).toBeGreaterThan(-1);
    expect(announced).toBeLessThan(run.stdout.indexOf('[1/7]'));
    expect(run.stdout).toContain(`New wrapper target: ${wrapperOf(next)}`);
    expect(run.events.slice(0, 5)).toEqual([...PREFLIGHT_EVENTS, 'npm:ci', `wrapper-at-ci:${wrapperOf(current)}`]);
    expectLinksInto(host, next, Object.keys(LINKS));
    expect(fs.existsSync(path.join(host.home, '.config', 'systemd', 'user', 'whatsoup@.service'))).toBe(true);
    expect(run.stdout).toContain('Setup complete. Next steps:');
  });

  it('is refused on macOS, where release:activate moves a release host', () => {
    const host = makeHost();
    const current = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    const next = makeTree(path.join(host.base, 'releases', 'r2'), 'release');
    linkWrapper(host, wrapperOf(current));
    const before = snapshot(host.base);

    const run = runSetup(host, next, [SWITCH_FLAG], { platform: 'Darwin' });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`${SWITCH_FLAG} is Linux only`);
    expect(run.stderr).toContain('release:activate');
    expect(run.events).toEqual([]);
    expect(snapshot(host.base)).toEqual(before);
  });

  it.each(ONLY_OPTIONS)('is refused with %s: a tree switch runs every step', (option) => {
    const host = makeHost();
    const current = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    const next = makeTree(path.join(host.base, 'releases', 'r2'), 'release');
    linkWrapper(host, wrapperOf(current));
    const before = snapshot(host.base);

    const run = runSetup(host, next, [SWITCH_FLAG, option]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`${SWITCH_FLAG} cannot be combined with ${option}`);
    expect(run.events).toEqual([]);
    expect(snapshot(host.base)).toEqual(before);
  });

  it('fails when the wrapper does not name this tree after step 3', () => {
    const host = makeHost();
    const current = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    const next = makeTree(path.join(host.base, 'releases', 'r2'), 'release');
    linkWrapper(host, wrapperOf(current));
    // A rename that reports success but moves nothing.
    writeExecutable(path.join(host.shims, 'mv'), '#!/bin/sh\nexit 0\n');

    const run = runSetup(host, next, [SWITCH_FLAG]);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(1);
    expect(run.stderr).toContain(`not ${wrapperOf(next)}`);
    expect(fs.readlinkSync(path.join(host.bin, 'whatsoup'))).toBe(wrapperOf(current));
    expect(run.stdout).not.toContain('[4/7]');
  });
});

describe('deploy/setup.sh --wrappers-only: step 3 and nothing else', () => {
  it.each(['Darwin', 'Linux'] as const)(
    'from the active release, through the path the wrapper names, moves the seven helper links and writes nothing in a release (%s)',
    (platform) => {
      const host = makeHost();
      const previous = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
      const active = makeTree(path.join(host.base, 'releases', 'r2'), 'release');
      linkWrapper(host, wrapperOf(active));
      for (const name of HELPERS) fs.symlinkSync(path.join(previous, LINKS[name]), path.join(host.bin, name));
      const wrapperInode = fs.lstatSync(path.join(host.bin, 'whatsoup')).ino;
      const activeBefore = snapshot(active);
      const previousBefore = snapshot(previous);

      const run = runSetup(host, active, ['--wrappers-only'], { platform });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.events).toEqual(PREFLIGHT_EVENTS);
      expect(run.stdout).toContain(`whatsoup → ${wrapperOf(active)} (unchanged)`);
      expect(fs.lstatSync(path.join(host.bin, 'whatsoup')).ino).toBe(wrapperInode);
      expectLinksInto(host, active, Object.keys(LINKS));
      expect(fs.readdirSync(host.bin).sort()).toEqual(Object.keys(LINKS).sort());
      expect(snapshot(active)).toEqual(activeBefore);
      expect(snapshot(previous)).toEqual(previousBefore);
      expect(fs.readdirSync(host.home)).toEqual(['.local']);
      expect(run.stdout).toContain('[2/7] Installing dependencies...\n  - Skipped (not selected)');
      expect(run.stdout).toContain('[4/7] Skipped: service units and timers (not selected)');
      expect(run.stdout).toContain('Selected setup steps complete');
    },
  );

  it('from the active release reached through a linked path, when the wrapper names that path', () => {
    const host = makeHost();
    const release = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
    const alias = path.join(host.base, 'current');
    fs.symlinkSync(release, alias);
    linkWrapper(host, wrapperOf(alias));

    const run = runSetup(host, alias, ['--wrappers-only'], { platform: 'Darwin' });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expectLinksInto(host, alias, Object.keys(LINKS));
  });

  it('moves every link between two git checkouts', () => {
    const host = makeHost();
    const previous = makeTree(path.join(host.base, 'checkout-a'), 'checkout');
    const next = makeTree(path.join(host.base, 'checkout-b'), 'checkout');
    linkWrapper(host, wrapperOf(previous));

    const run = runSetup(host, next, ['--wrappers-only'], { platform: 'Darwin' });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.events).toEqual(PREFLIGHT_EVENTS);
    expectLinksInto(host, next, Object.keys(LINKS));
  });

  it('links all eight on a first install from a release: no wrapper is running yet', () => {
    const host = makeHost();
    const release = makeTree(path.join(host.base, 'releases', 'r1'), 'release');

    const run = runSetup(host, release, ['--wrappers-only']);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expectLinksInto(host, release, Object.keys(LINKS));
    expect(fs.readdirSync(host.bin).sort()).toEqual(Object.keys(LINKS).sort());
  });
});

function extractShellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  if (start === -1) throw new Error(`helper ${name}() not found in deploy/setup.sh`);
  const end = source.indexOf('\n}\n', start);
  if (end === -1) throw new Error(`helper ${name}() has no terminating brace`);
  return source.slice(start + 1, end + 3);
}

/** Run setup.sh's own install_wrapper_link (extracted verbatim) with a chosen BIN_DIR; SHIMS go first on PATH. */
function runLinkHelper(bin: string, call: string[], shims?: string) {
  const harness = [
    'set -euo pipefail',
    `BIN_DIR=${JSON.stringify(bin)}`,
    extractShellFunction(setupSource, 'install_wrapper_link'),
    '"$@"',
    'echo "helper-returned"',
    '',
  ].join('\n');
  const env = shims ? { ...process.env, PATH: `${shims}:${process.env.PATH ?? ''}` } : process.env;
  return spawnSync('bash', ['-c', harness, 'harness', ...call], { encoding: 'utf8', env });
}

describe('deploy/setup.sh install_wrapper_link', () => {
  function linkFixture() {
    const base = makeTempRoot('whatsoup-link-');
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    const current = makeTree(path.join(base, 'checkout-a'), 'unmarked-export');
    const next = makeTree(path.join(base, 'checkout-b'), 'unmarked-export');
    const link = path.join(bin, 'whatsoup');
    fs.symlinkSync(wrapperOf(current), link);
    return { base, bin, current, next, link };
  }

  it('swaps the link by renaming a new link over the old one, and leaves no temporary link', () => {
    const { bin, next, link } = linkFixture();
    const before = fs.lstatSync(link).ino;

    const result = runLinkHelper(bin, ['install_wrapper_link', 'whatsoup', wrapperOf(next)]);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readlinkSync(link)).toBe(wrapperOf(next));
    expect(fs.lstatSync(link).ino).not.toBe(before);
    expect(fs.readdirSync(bin)).toEqual(['whatsoup']);
  });

  it('leaves an unchanged link in place', () => {
    const { bin, current, link } = linkFixture();
    const before = fs.lstatSync(link).ino;

    const result = runLinkHelper(bin, ['install_wrapper_link', 'whatsoup', wrapperOf(current)]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('(unchanged)');
    expect(fs.lstatSync(link).ino).toBe(before);
  });

  it('keeps the old link and removes the temporary one when the rename fails', () => {
    const { base, bin, current, next, link } = linkFixture();
    const shims = path.join(base, 'shims');
    writeExecutable(path.join(shims, 'mv'), '#!/bin/sh\nexit 1\n');
    const linkBefore = snapshot(link);
    const treesBefore = [snapshot(current), snapshot(next)];

    const result = runLinkHelper(bin, ['install_wrapper_link', 'whatsoup', wrapperOf(next)], shims);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('helper-returned');
    expect(result.stderr).toContain(`could not replace ${link}`);
    // The temporary link came and went, so only bin's own mtime may differ.
    expect(snapshot(link)).toEqual(linkBefore);
    expect(fs.readdirSync(bin)).toEqual(['whatsoup']);
    expect([snapshot(current), snapshot(next)]).toEqual(treesBefore);
  });

  it('keeps the old link when the new link cannot be made', () => {
    const { base, bin, next } = linkFixture();
    const shims = path.join(base, 'shims');
    writeExecutable(path.join(shims, 'ln'), '#!/bin/sh\nexit 1\n');
    const before = snapshot(base);

    const result = runLinkHelper(bin, ['install_wrapper_link', 'whatsoup', wrapperOf(next)], shims);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('helper-returned');
    expect(result.stderr).toContain('could not create the new link');
    expect(snapshot(base)).toEqual(before);
  });

  it('refuses a directory, or a link to one, at the wrapper path', () => {
    const base = makeTempRoot('whatsoup-link-');
    const bin = path.join(base, 'bin');
    fs.mkdirSync(bin);
    const checkout = makeTree(path.join(base, 'checkout'), 'unmarked-export');
    fs.mkdirSync(path.join(bin, 'whatsoup'));
    fs.symlinkSync(path.join(checkout, 'deploy'), path.join(bin, 'whatsoup-fleet'));
    const before = snapshot(base);

    for (const name of ['whatsoup', 'whatsoup-fleet']) {
      const result = runLinkHelper(bin, ['install_wrapper_link', name, wrapperOf(checkout)]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('not replacing it');
    }
    expect(snapshot(base)).toEqual(before);
  });

  // Source check, kept on purpose: no behavioural test can observe the instant
  // between `ln -sf` unlinking the old name and creating the new one. The
  // rename-failure test above proves the old link survives a failed swap.
  it('never uses ln -sf, which unlinks the old link before making the new one', () => {
    expect(setupSource).not.toContain('ln -sf');
    const install = extractShellFunction(setupSource, 'install_wrapper_link');
    expect(install).toContain('ln -s "$target" "$tmp"');
    expect(install).toContain('mv -f "$tmp" "$link"');
  });
});

interface Replay extends Run {
  home: string;
  bin: string;
  release: string;
}

/** Full setup.sh run from this repository, under a fake HOME whose bot wrapper points into a release export. */
function replay(args: string[]): Replay {
  const host = makeHost();
  const release = makeTree(path.join(host.base, 'releases', 'r1'), 'release');
  linkWrapper(host, wrapperOf(release));
  const result = spawnSync('bash', ['deploy/setup.sh', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: host.home,
      NVM_DIR: path.join(host.home, '.nvm'),
      PATH: `${host.shims}:${process.env.PATH ?? ''}`,
      USER: 'setup-test',
      FAKE_UNAME_S: 'Linux',
      BOT_ERRORS_HEALTH_PROFILE: host.profile,
      WHATSOUP_SETUP_EVENTS: host.events,
    },
    encoding: 'utf8',
  });
  return {
    home: host.home,
    bin: host.bin,
    release,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    events: readEvents(host.events),
  };
}

describe('deploy/setup.sh from this repository on a Linux host whose bot runs a release export', () => {
  it('--skip-wrappers runs the other steps and leaves every link alone', () => {
    const run = replay(['--skip-wrappers']);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.events).toContain('npm:ci');
    expect(run.events).toContain('npmrc-merge');
    expect(fs.readlinkSync(path.join(run.bin, 'whatsoup'))).toBe(wrapperOf(run.release));
    expect(fs.readdirSync(run.bin)).toEqual(['whatsoup']);
    expect(run.stdout).toContain('[3/7] Skipped: wrapper scripts');
  });

  it('--npmrc-only runs the checks and step 5, and nothing else', () => {
    const run = replay(['--npmrc-only']);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.events).toEqual([...PREFLIGHT_EVENTS, 'npmrc-merge']);
    expect(fs.readdirSync(run.bin)).toEqual(['whatsoup']);
    expect(fs.existsSync(path.join(run.home, '.config', 'systemd'))).toBe(false);
    expect(fs.existsSync(path.join(run.home, '.config', 'whatsoup'))).toBe(false);
    expect(run.stdout).toContain('[5/7] Installing hardened npm defaults');
    expect(run.stdout).not.toContain('Setup complete. Next steps:');
    expect(run.stdout).toContain('Selected setup steps complete');
  });

  it('--timers-only installs the service units and env templates, and nothing else', () => {
    const run = replay(['--timers-only']);
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.events).toEqual(PREFLIGHT_EVENTS);
    expect(fs.existsSync(path.join(run.home, '.config', 'systemd', 'user', 'whatsoup@.service'))).toBe(true);
    expect(fs.existsSync(path.join(run.home, '.config', 'systemd', 'user', 'whatsoup-release-drift.timer'))).toBe(true);
    expect(fs.existsSync(path.join(run.home, '.config', 'whatsoup', 'bot-errors.env'))).toBe(true);
    expect(fs.readdirSync(run.bin)).toEqual(['whatsoup']);
  });
});

describe('deploy/setup.sh --help', () => {
  it('documents the selection flags and the release-host refusal', () => {
    const help = spawnSync('bash', ['deploy/setup.sh', '--help'], { cwd: repoRoot, encoding: 'utf8' });
    expect(help.status).toBe(0);
    for (const flag of ['--skip-wrappers', '--wrappers-only', '--timers-only', '--npmrc-only', 'release:activate']) {
      expect(help.stdout, `--help missing ${flag}`).toContain(flag);
    }
    expect(help.stdout).toContain('through the path it names');
  });
});
