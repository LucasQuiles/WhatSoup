import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const INSTALLER = join(process.cwd(), 'deploy/scripts/install-bot-errors-release-proof.sh');
const SYNTH_HOST = 'rp-test-host';
const tmpDirs: string[] = [];

const BUNDLE_FILES = [
  'deploy/scripts/bot-errors-release-proof-run.sh',
  'deploy/scripts/bot-errors-tree-provenance.py',
  'deploy/scripts/bot-errors-runtime-staleness.py',
  'deploy/scripts/bot-errors-emit.py',
  'deploy/scripts/lib/__init__.py',
  'deploy/scripts/lib/bot_errors_redaction.py',
];
const UNIT_FILES = [
  'bot-errors-tree-provenance.service',
  'bot-errors-tree-provenance.timer',
  'bot-errors-runtime-staleness.service',
  'bot-errors-runtime-staleness.timer',
];

interface Fixture {
  home: string;
  source: string;
  systemd: string;
  bin: string;
  ledger: string;
  manifest: string;
  sha: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * TWO bounds, deliberately paired, because each alone was measured to be insufficient.
 *
 * Every test here drives the real installer through `spawnSync`, so the cost is subprocess
 * and filesystem work — essential, not something the suite could compute faster. Two
 * distinct things can go wrong: the child is SLOW (finite, but slower than a budget), or
 * the child HANGS (never returns). They need different mechanisms.
 *
 * Measurement 1 — a vitest timeout cannot PREEMPT a synchronous child. Same file, budget
 * on and off:
 *
 *   await setTimeout(12s)       -> fails at 10004ms; preempted by the test budget.
 *   spawnSync('sleep',['12'])   -> fails at 12009ms; ran to completion, judged afterwards.
 *
 * That is why a bare `vi.setConfig({ testTimeout: 60_000 })` was reverted as an
 * "ineffective timeout override". The mechanism objection was CORRECT: it does nothing
 * about a hang. It is not, however, useless — it is the only thing that stops a
 * slow-but-finite child from failing the suite, which was the original flake (11 tests at
 * 2.1–2.9s against a 10s default, on runners several times slower).
 *
 * Measurement 2 — a child bound only helps if it fires BEFORE the test budget:
 *
 *   child timeout 3s  (below the 10s default) -> PASSES; the hang is caught at the child
 *                                                with an explanatory message.
 *   child timeout 15s (above the 10s default) -> FAILS at 15003ms with vitest's generic
 *                                                "Test timed out in 10000ms"; the child-level
 *                                                message never surfaces.
 *
 * So a child bound set above the test budget is useless for diagnosis, and a test budget
 * without a child bound is useless against hangs. Set together, with the child bound
 * strictly inside the test budget, they cover both:
 *
 *   slow child (e.g. 20s under CI load) -> under both bounds; passes. Flake fixed.
 *   hung child                          -> killed at 45s, reported as a HANG by
 *                                          assertNotTimedOut, comfortably inside the 60s
 *                                          test budget. Hang fixed, and diagnosable.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Must stay strictly below the testTimeout above — see Measurement 2. */
const CHILD_TIMEOUT_MS = 45_000;

/**
 * A timed-out `spawnSync` returns `error` set and `status === null`, which is easy to
 * misread as an ordinary non-zero exit. Callers must be able to tell "the installer
 * rejected this" from "the installer never finished", so name it explicitly.
 */
function assertNotTimedOut(label: string, result: ReturnType<typeof spawnSync>): void {
  const err = result.error as (NodeJS.ErrnoException & { code?: string }) | undefined;
  if (err?.code === 'ETIMEDOUT' || (result.error && result.status === null)) {
    throw new Error(
      `${label} did not finish within ${CHILD_TIMEOUT_MS}ms and was killed (signal=${String(result.signal)}). ` +
        'This is a HANG, not a failing assertion — do not raise the budget without finding out why it hung.',
    );
  }
}

function fixtureGit(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  assertNotTimedOut(`fixture git ${args.join(' ')}`, result);
  if (result.status !== 0) {
    throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'rp-install-'));
  tmpDirs.push(root);
  const home = join(root, 'home');
  const source = join(root, 'source');
  const systemd = join(home, '.config/systemd/user');
  const bin = join(root, 'bin');
  const ledger = join(root, 'ledger.txt');
  mkdirSync(join(source, 'deploy/scripts/lib'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(systemd, { recursive: true });
  mkdirSync(bin, { recursive: true });

  const entries: Array<{ path: string; sha256: string; mustContain: string[] }> = [];
  for (const rel of BUNDLE_FILES) {
    const body = `# synthetic ${rel}\n`;
    writeFileSync(join(source, rel), body);
    entries.push({ path: rel, sha256: sha256(body), mustContain: [] });
  }
  for (const unit of UNIT_FILES) {
    const component = unit.startsWith('bot-errors-tree-provenance') ? 'tree' : 'runtime-staleness';
    const body = unit.endsWith('.service')
      ? `[Unit]\nDescription=${unit}\n[Service]\nExecStart=%h/.local/lib/whatsoup/release-proof/current/deploy/scripts/bot-errors-release-proof-run.sh ${component}\n`
      : `[Unit]\nDescription=${unit}\n`;
    writeFileSync(join(source, 'deploy', unit), body);
  }
  writeFileSync(
    join(source, 'deploy/scripts/install-bot-errors-release-proof.sh'),
    '# synthetic installer source\n',
  );
  const manifest = join(source, 'deploy/bot-errors-runtime-manifest.json');
  writeFileSync(manifest, JSON.stringify({
    schemaVersion: 1,
    scope: 'bot-errors-runtime-scripts',
    files: entries,
  }, null, 2));

  // The monitor units EnvironmentFile= this file; the installer preflights
  // its existence before taking the lock.
  mkdirSync(join(home, '.config/whatsoup'), { recursive: true });
  writeFileSync(join(home, '.config/whatsoup/bot-errors.env'), 'BOT_ERRORS_SYNTHETIC_FIXTURE=1\n');

  // fake systemctl / systemd-analyze / hostname write a command ledger;
  // `show -p FragmentPath --value <unit>` answers with the fixture systemd
  // path so the installer's loaded-fragment verification can pass.
  // `is-enabled` and `is-active` are stateful via the ledger, mirroring the
  // timer state transitions exercised by install and rollback.
  const fakeSystemctl = [
    '#!/usr/bin/env bash',
    `echo "systemctl $*" >> "${ledger}"`,
    'if [ "$2" = "is-enabled" ]; then',
    `  last="$(grep -E " (enable|disable) --now $3\\$" "${ledger}" | tail -n 1)"`,
    '  case "$last" in',
    '    *" enable --now $3") echo enabled ;;',
    '    *) echo disabled ;;',
    '  esac',
    'fi',
    'if [ "$2" = "is-active" ]; then',
    `  last="$(grep -E " ((enable|disable) --now|(start|stop)) $3\\$" "${ledger}" | tail -n 1)"`,
    '  case "$last" in',
    '    *" enable --now $3"|*" start $3") echo active ;;',
    '    *) echo inactive ;;',
    '  esac',
    'fi',
    'if [ "$2" = "show" ]; then',
    '  for a in "$@"; do :; done   # a = last arg = unit name',
    '  case "$*" in',
    `    *FragmentPath*) echo "${systemd}/$a" ;;`,
    '    *) echo "" ;;',
    '  esac',
    'fi',
    'exit 0',
  ].join('\n') + '\n';
  writeFileSync(join(bin, 'systemctl'), fakeSystemctl);
  writeFileSync(join(bin, 'systemd-analyze'), `#!/usr/bin/env bash\necho "systemd-analyze $*" >> "${ledger}"\nexit 0\n`);
  writeFileSync(join(bin, 'hostname'), `#!/usr/bin/env bash\necho "${SYNTH_HOST}"\n`);
  for (const f of ['systemctl', 'systemd-analyze', 'hostname']) chmodSync(join(bin, f), 0o755);

  fixtureGit(source, ['init', '--initial-branch=main']);
  fixtureGit(source, ['add', '.']);
  fixtureGit(source, [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@local',
    'commit', '-m', 'fixture source',
  ]);
  const sha = fixtureGit(source, ['rev-parse', 'HEAD']);

  return { home, source, systemd, bin, ledger, manifest, sha };
}

function runInstaller(fx: Fixture, args: string[], extraEnv: Record<string, string> = {}) {
  const result = spawnSync('bash', [INSTALLER, ...args], {
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    env: {
      ...process.env,
      HOME: fx.home,
      PATH: `${fx.bin}:${process.env.PATH}`,
      RELEASE_PROOF_HOME: fx.home,
      RELEASE_PROOF_SOURCE_ROOT: fx.source,
      RELEASE_PROOF_SYSTEMD_DIR: fx.systemd,
      RELEASE_PROOF_MANIFEST: fx.manifest,
      ...extraEnv,
    },
  });
  // Tests assert on `status`; a timed-out child reports status null, which would otherwise
  // read as an unexpected-but-plausible installer outcome rather than as a hang.
  assertNotTimedOut(`installer ${args.join(' ')}`, result);
  return result;
}

/** Recursive dir snapshot: sorted "relpath sha256(content)" lines; dirs as "relpath/ dir". */
function snapshotDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) {
        out.push(`${relative(dir, p)}/ dir`);
        walk(p);
      } else if (st.isSymbolicLink()) {
        out.push(`${relative(dir, p)} link`);
      } else {
        out.push(`${relative(dir, p)} ${sha256(readFileSync(p, 'utf8'))}`);
      }
    }
  };
  walk(dir);
  return out;
}

function ledgerLines(fx: Fixture): string[] {
  return existsSync(fx.ledger) ? readFileSync(fx.ledger, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function receiptRoot(fx: Fixture): string {
  return join(fx.home, '.local/state/whatsoup/release-proof-installer/receipts');
}

function installOk(fx: Fixture) {
  const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha]);
  expect(res.status, res.stderr).toBe(0);
  expect(res.stdout).toContain('INSTALL_OK');
  return res;
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('installer preflight and dry-run', () => {
  it('dry-run prints the plan and produces zero filesystem and command delta', () => {
    const fx = makeFixture();
    const before = { home: snapshotDir(fx.home), systemd: snapshotDir(fx.systemd) };
    const res = runInstaller(fx, ['dry-run', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('DRY_RUN_OK');
    expect(snapshotDir(fx.home)).toEqual(before.home);
    expect(snapshotDir(fx.systemd)).toEqual(before.systemd);
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('host gate fails closed with fingerprints only', () => {
    const fx = makeFixture();
    const res = runInstaller(fx, ['dry-run', '--host', 'wrong-host', '--mode', 'observe', '--bundle-sha', fx.sha]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('host gate failed');
    expect(res.stderr).not.toContain('wrong-host');
    expect(res.stderr).not.toContain(SYNTH_HOST);
  });

  it('host canonicalization: case and trailing dot are ignored', () => {
    const fx = makeFixture();
    const res = runInstaller(fx, ['dry-run', '--host', `${SYNTH_HOST.toUpperCase()}.`, '--mode', 'observe', '--bundle-sha', fx.sha]);
    expect(res.status).toBe(0);
  });

  it('source hash mismatch against the manifest aborts before any write', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.source, 'deploy/scripts/bot-errors-emit.py'), '# tampered\n');
    const before = snapshotDir(fx.home);
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('hash mismatch');
    expect(snapshotDir(fx.home)).toEqual(before);
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('bundle sha must equal the source repository HEAD', () => {
    const fx = makeFixture();
    const before = snapshotDir(fx.home);
    const res = runInstaller(fx, [
      'install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', 'c'.repeat(40),
    ]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('does not match source HEAD');
    expect(snapshotDir(fx.home)).toEqual(before);
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('dirty tracked unit bytes are rejected even though units are not manifest entries', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.source, 'deploy/bot-errors-tree-provenance.service'), '[Unit]\nDescription=dirty unit\n');
    const res = runInstaller(fx, [
      'install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha,
    ]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('selected source files differ from bundle commit');
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('symlinked source file is rejected', () => {
    const fx = makeFixture();
    const target = join(fx.source, 'deploy/scripts/bot-errors-emit.py');
    rmSync(target);
    symlinkSync('/etc/hostname', target);
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('symlink');
  });

  it('invalid bundle sha is rejected', () => {
    const fx = makeFixture();
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', 'nothex']);
    expect(res.status).toBe(2);
  });

  it('install --mode emit is rejected: emit is reached only via set-mode', () => {
    const fx = makeFixture();
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'emit', '--bundle-sha', fx.sha]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('install only supports --mode observe');
  });

  it('installer never references the daily-health tree integration (B3, structural)', () => {
    const text = readFileSync(INSTALLER, 'utf8');
    expect(text).not.toContain('expectTreeProvenance');
    expect(text).not.toContain('health-profile');
    expect(text).not.toContain('bot-errors-health-check');
  });
});

describe('installer mutation, set-mode, verify, rollback', () => {
  it('install materializes bundle, units, mode file, and enables only the two monitor timers', () => {
    const fx = makeFixture();
    installOk(fx);
    for (const rel of BUNDLE_FILES) {
      expect(existsSync(join(fx.home, '.local/lib/whatsoup/release-proof', fx.sha, rel))).toBe(true);
    }
    expect(readFileSync(join(fx.home, '.config/whatsoup/bot-errors-release-proof.env'), 'utf8'))
      .toBe('BOT_ERRORS_RELEASE_PROOF_MODE=observe\n');
    for (const unit of UNIT_FILES) {
      expect(readFileSync(join(fx.systemd, unit), 'utf8'))
        .toBe(readFileSync(join(fx.source, 'deploy', unit), 'utf8'));
    }
    const mutating = ledgerLines(fx).filter((l) =>
      l.startsWith('systemctl') && !/ (is-enabled|is-active|show) /.test(` ${l} `));
    expect(mutating).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable --now bot-errors-tree-provenance.timer',
      'systemctl --user enable --now bot-errors-runtime-staleness.timer',
    ]);
  });

  it('mutating systemctl calls never name an application or fleet unit', () => {
    const fx = makeFixture();
    installOk(fx);
    for (const line of ledgerLines(fx)) {
      for (const forbidden of ['whatsoup@', 'whatsoup-fleet', 'dispatcher', 'collector', 'q-loop']) {
        expect(line).not.toContain(forbidden);
      }
    }
  });

  it('backup precedes replacement: receipt preserves prior installed unit bytes', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.systemd, 'bot-errors-runtime-staleness.service'), '[Unit]\nDescription=old generation\n');
    const res = installOk(fx);
    const receipt = res.stdout.match(/RECEIPT=(\S+)/)?.[1];
    expect(receipt).toBeDefined();
    expect(receipt).toContain('/.local/state/whatsoup/release-proof-installer/receipts/');
    expect(receipt).not.toContain('/.local/state/bot-errors/');
    expect(readFileSync(join(receipt!, 'units-prior/bot-errors-runtime-staleness.service'), 'utf8'))
      .toContain('old generation');
    expect(existsSync(join(receipt!, 'units-prior/bot-errors-tree-provenance.service.was-absent'))).toBe(true);
  });

  it('set-mode touches only the mode file', () => {
    const fx = makeFixture();
    installOk(fx);
    const beforeSystemd = snapshotDir(fx.systemd);
    const beforeBundle = snapshotDir(join(fx.home, '.local/lib/whatsoup/release-proof', fx.sha));
    const res = runInstaller(fx, ['set-mode', '--host', SYNTH_HOST, '--mode', 'emit']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('SET_MODE_OK mode=emit');
    expect(readFileSync(join(fx.home, '.config/whatsoup/bot-errors-release-proof.env'), 'utf8'))
      .toBe('BOT_ERRORS_RELEASE_PROOF_MODE=emit\n');
    expect(snapshotDir(fx.systemd)).toEqual(beforeSystemd);
    expect(snapshotDir(join(fx.home, '.local/lib/whatsoup/release-proof', fx.sha))).toEqual(beforeBundle);
  });

  it('verify exits 1 on installed unit drift', () => {
    const fx = makeFixture();
    installOk(fx);
    writeFileSync(join(fx.systemd, 'bot-errors-tree-provenance.timer'), '[Unit]\nDescription=tampered\n');
    const res = runInstaller(fx, ['verify', '--host', SYNTH_HOST, '--bundle-sha', fx.sha]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unit drift or missing: bot-errors-tree-provenance.timer');
  });

  it('verify exits 1 when an enabled timer is inactive', () => {
    const fx = makeFixture();
    installOk(fx);
    const inactiveSystemctl = [
      '#!/usr/bin/env bash',
      `echo "systemctl $*" >> "${fx.ledger}"`,
      'if [ "$2" = "is-enabled" ]; then echo enabled; fi',
      'if [ "$2" = "is-active" ]; then echo inactive; fi',
      'if [ "$2" = "show" ]; then',
      '  for a in "$@"; do :; done',
      '  case "$*" in',
      `    *FragmentPath*) echo "${fx.systemd}/$a" ;;`,
      '    *) echo "" ;;',
      '  esac',
      'fi',
      'exit 0',
    ].join('\n') + '\n';
    writeFileSync(join(fx.bin, 'systemctl'), inactiveSystemctl);
    chmodSync(join(fx.bin, 'systemctl'), 0o755);

    const res = runInstaller(fx, ['verify', '--host', SYNTH_HOST, '--bundle-sha', fx.sha]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(
      "timer bot-errors-tree-provenance.timer is-active reports 'inactive', expected active",
    );
  });

  it('rollback restores prior unit bytes, symlink, mode, and enablement', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.systemd, 'bot-errors-runtime-staleness.service'), '[Unit]\nDescription=old generation\n');
    const res = installOk(fx);
    const receipt = res.stdout.match(/RECEIPT=(\S+)/)?.[1]!;
    const roll = runInstaller(fx, ['rollback', '--host', SYNTH_HOST, '--receipt', receipt]);
    expect(roll.status, roll.stderr).toBe(0);
    expect(roll.stdout).toContain('ROLLBACK_OK');
    expect(readFileSync(join(fx.systemd, 'bot-errors-runtime-staleness.service'), 'utf8'))
      .toContain('old generation');
    expect(existsSync(join(fx.systemd, 'bot-errors-tree-provenance.service'))).toBe(false);
    expect(existsSync(join(fx.home, '.config/whatsoup/bot-errors-release-proof.env'))).toBe(false);
    expect(existsSync(join(fx.home, '.local/lib/whatsoup/release-proof/current'))).toBe(false);
    const disables = ledgerLines(fx).filter((l) => l.includes('disable --now'));
    expect(disables).toEqual([
      'systemctl --user disable --now bot-errors-tree-provenance.timer',
      'systemctl --user disable --now bot-errors-runtime-staleness.timer',
    ]);
  });

  it('activation failure after backup triggers auto-rollback', () => {
    const fx = makeFixture();
    // fake systemctl that fails on `enable`
    writeFileSync(join(fx.bin, 'systemctl'),
      `#!/usr/bin/env bash\necho "systemctl $*" >> "${fx.ledger}"\nif [ "$2" = "enable" ]; then exit 1; fi\nif [ "$2" = "is-enabled" ]; then echo disabled; fi\nif [ "$2" = "is-active" ]; then echo inactive; fi\nexit 0\n`);
    chmodSync(join(fx.bin, 'systemctl'), 0o755);
    const before = snapshotDir(fx.systemd);
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('rolling back');
    expect(snapshotDir(fx.systemd)).toEqual(before);
    expect(existsSync(join(fx.home, '.local/lib/whatsoup/release-proof', fx.sha))).toBe(true);
    expect(existsSync(join(fx.home, '.local/lib/whatsoup/release-proof/current'))).toBe(false);
  });
});

describe('installer symlink and verify-bypass fixes (review findings)', () => {
  it('symlinked managed bundle root is rejected before external writes', () => {
    const fx = makeFixture();
    const bundleParent = join(fx.home, '.local/lib/whatsoup/release-proof');
    const external = join(fx.home, 'outside-bundle-root');
    mkdirSync(join(fx.home, '.local/lib/whatsoup'), { recursive: true });
    mkdirSync(external);
    symlinkSync(external, bundleParent);

    const res = runInstaller(fx, [
      'install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha,
    ]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('managed path roots must stay under a real home directory');
    expect(readdirSync(external)).toEqual([]);
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('dangling destination unit symlink is rejected, not silently replaced', () => {
    const fx = makeFixture();
    const target = join(fx.systemd, 'bot-errors-tree-provenance.service');
    symlinkSync(join(fx.systemd, 'ghost-target-does-not-exist'), target);
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('symlink');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    for (const unit of UNIT_FILES) {
      if (unit === 'bot-errors-tree-provenance.service') continue;
      expect(existsSync(join(fx.systemd, unit))).toBe(false);
    }
    expect(existsSync(join(fx.home, '.local/lib/whatsoup/release-proof', fx.sha))).toBe(false);
    // no systemctl invocation at all: the symlink check aborts backup before
    // daemon-reload/enable, and before the (read-only) is-enabled/is-active/show calls.
    expect(ledgerLines(fx).some((l) => l.startsWith('systemctl'))).toBe(false);
  });

  it('verify failure inside install (via return, not exit) triggers auto-rollback', () => {
    const fx = makeFixture();
    const before = snapshotDir(fx.systemd);
    // fake systemctl: normal enable/daemon-reload, but `show -p FragmentPath`
    // always answers a wrong path so do_verify's loaded-fragment check fails
    // for every unit after the mutating install steps have already run.
    const fakeSystemctl = [
      '#!/usr/bin/env bash',
      `echo "systemctl $*" >> "${fx.ledger}"`,
      'if [ "$2" = "is-enabled" ]; then echo disabled; fi',
      'if [ "$2" = "is-active" ]; then echo inactive; fi',
      'if [ "$2" = "show" ]; then',
      '  for a in "$@"; do :; done   # a = last arg = unit name',
      '  case "$*" in',
      '    *FragmentPath*) echo "/wrong/path/for/$a" ;;',
      '    *) echo "" ;;',
      '  esac',
      'fi',
      'exit 0',
    ].join('\n') + '\n';
    writeFileSync(join(fx.bin, 'systemctl'), fakeSystemctl);
    chmodSync(join(fx.bin, 'systemctl'), 0o755);
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('rolling back');
    expect(snapshotDir(fx.systemd)).toEqual(before);
  });

  it('predictable legacy temporary symlinks cannot clobber external files', () => {
    const fx = makeFixture();
    const externalUnit = join(fx.home, 'external-unit.txt');
    const externalMode = join(fx.home, 'external-mode.txt');
    writeFileSync(externalUnit, 'unit sentinel\n');
    writeFileSync(externalMode, 'mode sentinel\n');
    symlinkSync(externalUnit, join(fx.systemd, '.bot-errors-tree-provenance.service.tmp'));
    symlinkSync(
      externalMode,
      join(fx.home, '.config/whatsoup/bot-errors-release-proof.env.tmp'),
    );

    installOk(fx);

    expect(readFileSync(externalUnit, 'utf8')).toBe('unit sentinel\n');
    expect(readFileSync(externalMode, 'utf8')).toBe('mode sentinel\n');
    expect(lstatSync(join(fx.systemd, 'bot-errors-tree-provenance.service')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(fx.home, '.config/whatsoup/bot-errors-release-proof.env')).isSymbolicLink()).toBe(false);
  });

  it('verify rejects byte-identical unit and mode-file symlinks', () => {
    const fx = makeFixture();
    installOk(fx);
    const unit = join(fx.systemd, 'bot-errors-tree-provenance.service');
    const mode = join(fx.home, '.config/whatsoup/bot-errors-release-proof.env');
    const externalUnit = join(fx.home, 'external-verify-unit');
    const externalMode = join(fx.home, 'external-verify-mode');
    writeFileSync(externalUnit, readFileSync(unit));
    writeFileSync(externalMode, readFileSync(mode));
    rmSync(unit);
    rmSync(mode);
    symlinkSync(externalUnit, unit);
    symlinkSync(externalMode, mode);

    const result = runInstaller(fx, ['verify', '--host', SYNTH_HOST, '--bundle-sha', fx.sha]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('installed unit is a symlink');
    expect(result.stderr).toContain('mode file is a symlink');
  });
});

describe('rollback hardening and install ordering (final review findings)', () => {
  it('standalone rollback with failing daemon-reload exits 4 with ROLLBACK_FAILED and still byte-verifies and restores', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.systemd, 'bot-errors-runtime-staleness.service'), '[Unit]\nDescription=old generation\n');
    const res = installOk(fx);
    const receipt = res.stdout.match(/RECEIPT=(\S+)/)?.[1]!;
    // Tamper the installed unit so the rollback's restore + byte-verification
    // have observable work to do after the failed daemon-reload step.
    writeFileSync(join(fx.systemd, 'bot-errors-runtime-staleness.service'), '[Unit]\nDescription=tampered\n');
    // From here on daemon-reload fails: a broken user manager at rollback time.
    const failingSystemctl = [
      '#!/usr/bin/env bash',
      `echo "systemctl $*" >> "${fx.ledger}"`,
      'if [ "$2" = "daemon-reload" ]; then exit 1; fi',
      'if [ "$2" = "is-enabled" ]; then echo disabled; fi',
      'if [ "$2" = "is-active" ]; then echo inactive; fi',
      'if [ "$2" = "show" ]; then',
      '  for a in "$@"; do :; done',
      '  case "$*" in',
      `    *FragmentPath*) echo "${fx.systemd}/$a" ;;`,
      '    *) echo "" ;;',
      '  esac',
      'fi',
      'exit 0',
    ].join('\n') + '\n';
    writeFileSync(join(fx.bin, 'systemctl'), failingSystemctl);
    chmodSync(join(fx.bin, 'systemctl'), 0o755);
    const roll = runInstaller(fx, ['rollback', '--host', SYNTH_HOST, '--receipt', receipt]);
    expect(roll.status).toBe(4);
    expect(roll.stderr).toContain('daemon-reload');
    expect(roll.stderr).toContain(`ROLLBACK_FAILED steps=1 receipt=${receipt}`);
    expect(roll.stdout).not.toContain('ROLLBACK_OK');
    // The failed step must not abort the handler: the restore already
    // happened and the byte-verification loop still ran and reported.
    expect(readFileSync(join(fx.systemd, 'bot-errors-runtime-staleness.service'), 'utf8'))
      .toContain('old generation');
    expect(roll.stdout).toContain('rollback byte verification ok: bot-errors-runtime-staleness.service');
  });

  it('rollback reports failed timer disables and still completes restoration', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.systemd, 'bot-errors-runtime-staleness.service'), '[Unit]\nDescription=old generation\n');
    const res = installOk(fx);
    const receipt = res.stdout.match(/RECEIPT=(\S+)/)?.[1]!;
    const failingSystemctl = [
      '#!/usr/bin/env bash',
      `echo "systemctl $*" >> "${fx.ledger}"`,
      'if [ "$2" = "disable" ]; then exit 1; fi',
      'if [ "$2" = "is-enabled" ]; then echo enabled; fi',
      'if [ "$2" = "is-active" ]; then echo active; fi',
      'if [ "$2" = "show" ]; then',
      '  for a in "$@"; do :; done',
      '  case "$*" in',
      `    *FragmentPath*) echo "${fx.systemd}/$a" ;;`,
      '    *) echo "" ;;',
      '  esac',
      'fi',
      'exit 0',
    ].join('\n') + '\n';
    writeFileSync(join(fx.bin, 'systemctl'), failingSystemctl);
    chmodSync(join(fx.bin, 'systemctl'), 0o755);

    const roll = runInstaller(fx, ['rollback', '--host', SYNTH_HOST, '--receipt', receipt]);
    expect(roll.status).toBe(4);
    expect(roll.stderr).toContain('failed to disable bot-errors-tree-provenance.timer');
    expect(roll.stderr).toContain('failed to disable bot-errors-runtime-staleness.timer');
    expect(roll.stderr).toContain(`ROLLBACK_FAILED steps=2 receipt=${receipt}`);
    expect(readFileSync(join(fx.systemd, 'bot-errors-runtime-staleness.service'), 'utf8'))
      .toContain('old generation');
    expect(roll.stdout).toContain('rollback byte verification ok: bot-errors-runtime-staleness.service');
  });

  it('rollback rejects a receipt outside the isolated receipt root before systemctl', () => {
    const fx = makeFixture();
    const outside = join(fx.home, 'forged-receipt');
    mkdirSync(outside);
    const beforeLedger = ledgerLines(fx);

    const roll = runInstaller(fx, ['rollback', '--host', SYNTH_HOST, '--receipt', outside]);
    expect(roll.status).toBe(2);
    expect(roll.stderr).toContain('receipt is not a confined installer receipt');
    expect(ledgerLines(fx)).toEqual(beforeLedger);
  });

  it('rollback rejects a metadata-only receipt before disabling timers', () => {
    const fx = makeFixture();
    const root = receiptRoot(fx);
    const receipt = join(root, '20260712T000000Z-1');
    mkdirSync(receipt, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    chmodSync(receipt, 0o700);
    writeFileSync(
      join(receipt, 'receipt.meta'),
      `schemaVersion=1\nhostFingerprint=${sha256(SYNTH_HOST).slice(0, 12)}\n`,
      { mode: 0o600 },
    );

    const roll = runInstaller(fx, ['rollback', '--host', SYNTH_HOST, '--receipt', receipt]);
    expect(roll.status).toBe(2);
    expect(roll.stderr).toContain('receipt is not a confined installer receipt');
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('rollback rejects a receipt whose host fingerprint does not match the host gate', () => {
    const fx = makeFixture();
    const res = installOk(fx);
    const receipt = res.stdout.match(/RECEIPT=(\S+)/)?.[1]!;
    writeFileSync(
      join(receipt, 'receipt.meta'),
      'schemaVersion=1\nhostFingerprint=000000000000\n',
      { mode: 0o600 },
    );
    const beforeLedger = ledgerLines(fx);

    const roll = runInstaller(fx, ['rollback', '--host', SYNTH_HOST, '--receipt', receipt]);
    expect(roll.status).toBe(2);
    expect(roll.stderr).toContain('receipt is not a confined installer receipt');
    expect(ledgerLines(fx)).toEqual(beforeLedger);
  });

  it('rollback random temporary files do not follow predictable symlinks', () => {
    const fx = makeFixture();
    const priorUnit = join(fx.systemd, 'bot-errors-runtime-staleness.service');
    writeFileSync(priorUnit, '[Unit]\nDescription=old generation\n');
    const res = installOk(fx);
    const receipt = res.stdout.match(/RECEIPT=(\S+)/)?.[1]!;
    const external = join(fx.home, 'external-rollback-target.txt');
    writeFileSync(external, 'rollback sentinel\n');
    symlinkSync(external, join(fx.systemd, '.bot-errors-runtime-staleness.service.tmp'));

    const roll = runInstaller(fx, ['rollback', '--host', SYNTH_HOST, '--receipt', receipt]);
    expect(roll.status, roll.stderr).toBe(0);
    expect(readFileSync(external, 'utf8')).toBe('rollback sentinel\n');
    expect(lstatSync(priorUnit).isSymbolicLink()).toBe(false);
    expect(readFileSync(priorUnit, 'utf8')).toContain('old generation');
  });

  it('unknown timer-state probes abort before bundle, unit, or activation mutation', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.bin, 'systemctl'), [
      '#!/usr/bin/env bash',
      `echo "systemctl $*" >> "${fx.ledger}"`,
      'if [ "$2" = "is-enabled" ] || [ "$2" = "is-active" ]; then exit 1; fi',
      'exit 0',
    ].join('\n') + '\n');
    chmodSync(join(fx.bin, 'systemctl'), 0o755);

    const res = runInstaller(fx, [
      'install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha,
    ]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('timer state probe failed');
    expect(existsSync(join(fx.home, '.local/lib/whatsoup/release-proof/current'))).toBe(false);
    for (const unit of UNIT_FILES) expect(existsSync(join(fx.systemd, unit))).toBe(false);
    expect(ledgerLines(fx).some((line) => line.includes('daemon-reload'))).toBe(false);
    expect(ledgerLines(fx).some((line) => line.includes('enable --now'))).toBe(false);
  });

  it('systemd-analyze rejection fails preflight before bundle, symlink, units, or backup', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.bin, 'systemd-analyze'),
      `#!/usr/bin/env bash\necho "systemd-analyze $*" >> "${fx.ledger}"\nexit 1\n`);
    chmodSync(join(fx.bin, 'systemd-analyze'), 0o755);
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('systemd verify rejected');
    expect(res.stderr).not.toContain('rolling back');
    for (const unit of UNIT_FILES) {
      expect(existsSync(join(fx.systemd, unit))).toBe(false);
    }
    const parent = join(fx.home, '.local/lib/whatsoup/release-proof');
    const leftovers = existsSync(parent) ? readdirSync(parent) : [];
    expect(leftovers.filter((name) => name.startsWith('.stage-'))).toEqual([]);
    expect(leftovers).not.toContain('current');
    expect(leftovers).not.toContain(fx.sha);
  });

  it('failed same-sha reinstall validation preserves the prior immutable bundle and live current target', () => {
    const fx = makeFixture();
    installOk(fx);
    const bundle = join(fx.home, '.local/lib/whatsoup/release-proof', fx.sha);
    const current = join(fx.home, '.local/lib/whatsoup/release-proof/current');
    const priorBundle = snapshotDir(bundle);
    const priorTarget = readlinkSync(current);

    writeFileSync(join(fx.bin, 'systemd-analyze'),
      `#!/usr/bin/env bash\necho "systemd-analyze $*" >> "${fx.ledger}"\nexit 1\n`);
    chmodSync(join(fx.bin, 'systemd-analyze'), 0o755);

    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha]);
    expect(res.status).toBe(2);
    expect(res.stderr).not.toContain('rolling back');
    expect(snapshotDir(bundle)).toEqual(priorBundle);
    expect(lstatSync(current).isSymbolicLink()).toBe(true);
    expect(readlinkSync(current)).toBe(priorTarget);
    expect(existsSync(current)).toBe(true);
  });

  it('virgin host validates rewritten staged units before changing current', () => {
    const fx = makeFixture();
    const currentLink = join(fx.home, '.local/lib/whatsoup/release-proof/current');
    const orderingAnalyze = [
      '#!/usr/bin/env bash',
      `echo "systemd-analyze $*" >> "${fx.ledger}"`,
      `if [ -L "${currentLink}" ]; then`,
      '  echo "current changed before analyze completed" >&2',
      '  exit 1',
      'fi',
      'for a in "$@"; do :; done',
      'case "$a" in',
      '  *.service)',
      '    if grep -q "release-proof/current" "$a"; then exit 1; fi',
      '    grep -Eq "release-proof/\\.stage-[^/]+/bundle/deploy/scripts/bot-errors-release-proof-run.sh" "$a" || exit 1',
      '    ;;',
      'esac',
      'exit 0',
    ].join('\n') + '\n';
    writeFileSync(join(fx.bin, 'systemd-analyze'), orderingAnalyze);
    chmodSync(join(fx.bin, 'systemd-analyze'), 0o755);
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('INSTALL_OK');
    expect(ledgerLines(fx).filter((line) => line.startsWith('systemd-analyze'))).toHaveLength(UNIT_FILES.length);
  });

  it('missing bot-errors.env fails preflight with exit 2 before any mutation', () => {
    const fx = makeFixture();
    rmSync(join(fx.home, '.config/whatsoup/bot-errors.env'));
    const before = { home: snapshotDir(fx.home), systemd: snapshotDir(fx.systemd) };
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', fx.sha]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('bot-errors.env');
    expect(snapshotDir(fx.home)).toEqual(before.home);
    expect(snapshotDir(fx.systemd)).toEqual(before.systemd);
    expect(ledgerLines(fx)).toHaveLength(0);
  });
});
