import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const INSTALLER = join(process.cwd(), 'deploy/scripts/install-bot-errors-release-proof.sh');
const SYNTH_HOST = 'rp-test-host';
const SHA = 'a'.repeat(40);
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
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'rp-install-'));
  tmpDirs.push(root);
  const home = join(root, 'home');
  const source = join(root, 'source');
  const systemd = join(root, 'systemd');
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
    writeFileSync(join(source, 'deploy', unit), `[Unit]\nDescription=${unit}\n`);
  }
  const manifest = join(source, 'deploy/bot-errors-runtime-manifest.json');
  writeFileSync(manifest, JSON.stringify({
    schemaVersion: 1,
    scope: 'bot-errors-runtime-scripts',
    files: entries,
  }, null, 2));

  // fake systemctl / systemd-analyze / hostname write a command ledger;
  // `show -p FragmentPath --value <unit>` answers with the fixture systemd
  // path so the installer's loaded-fragment verification can pass.
  const fakeSystemctl = [
    '#!/usr/bin/env bash',
    `echo "systemctl $*" >> "${ledger}"`,
    'if [ "$2" = "is-enabled" ]; then echo disabled; fi',
    'if [ "$2" = "is-active" ]; then echo inactive; fi',
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

  return { home, source, systemd, bin, ledger, manifest };
}

function runInstaller(fx: Fixture, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [INSTALLER, ...args], {
    encoding: 'utf8',
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

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('installer preflight and dry-run', () => {
  it('dry-run prints the plan and produces zero filesystem and command delta', () => {
    const fx = makeFixture();
    const before = { home: snapshotDir(fx.home), systemd: snapshotDir(fx.systemd) };
    const res = runInstaller(fx, ['dry-run', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('DRY_RUN_OK');
    expect(snapshotDir(fx.home)).toEqual(before.home);
    expect(snapshotDir(fx.systemd)).toEqual(before.systemd);
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('host gate fails closed with fingerprints only', () => {
    const fx = makeFixture();
    const res = runInstaller(fx, ['dry-run', '--host', 'wrong-host', '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('host gate failed');
    expect(res.stderr).not.toContain('wrong-host');
    expect(res.stderr).not.toContain(SYNTH_HOST);
  });

  it('host canonicalization: case and trailing dot are ignored', () => {
    const fx = makeFixture();
    const res = runInstaller(fx, ['dry-run', '--host', `${SYNTH_HOST.toUpperCase()}.`, '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status).toBe(0);
  });

  it('source hash mismatch against the manifest aborts before any write', () => {
    const fx = makeFixture();
    writeFileSync(join(fx.source, 'deploy/scripts/bot-errors-emit.py'), '# tampered\n');
    const before = snapshotDir(fx.home);
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('hash mismatch');
    expect(snapshotDir(fx.home)).toEqual(before);
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('symlinked source file is rejected', () => {
    const fx = makeFixture();
    const target = join(fx.source, 'deploy/scripts/bot-errors-emit.py');
    rmSync(target);
    symlinkSync('/etc/hostname', target);
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', SHA]);
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
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'emit', '--bundle-sha', SHA]);
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
  function installOk(fx: Fixture) {
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('INSTALL_OK');
    return res;
  }

  it('install materializes bundle, units, mode file, and enables only the two monitor timers', () => {
    const fx = makeFixture();
    installOk(fx);
    for (const rel of BUNDLE_FILES) {
      expect(existsSync(join(fx.home, '.local/lib/whatsoup/release-proof', SHA, rel))).toBe(true);
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
    expect(readFileSync(join(receipt!, 'units-prior/bot-errors-runtime-staleness.service'), 'utf8'))
      .toContain('old generation');
    expect(existsSync(join(receipt!, 'units-prior/bot-errors-tree-provenance.service.was-absent'))).toBe(true);
  });

  it('set-mode touches only the mode file', () => {
    const fx = makeFixture();
    installOk(fx);
    const beforeSystemd = snapshotDir(fx.systemd);
    const beforeBundle = snapshotDir(join(fx.home, '.local/lib/whatsoup/release-proof', SHA));
    const res = runInstaller(fx, ['set-mode', '--host', SYNTH_HOST, '--mode', 'emit']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('SET_MODE_OK mode=emit');
    expect(readFileSync(join(fx.home, '.config/whatsoup/bot-errors-release-proof.env'), 'utf8'))
      .toBe('BOT_ERRORS_RELEASE_PROOF_MODE=emit\n');
    expect(snapshotDir(fx.systemd)).toEqual(beforeSystemd);
    expect(snapshotDir(join(fx.home, '.local/lib/whatsoup/release-proof', SHA))).toEqual(beforeBundle);
  });

  it('verify exits 1 on installed unit drift', () => {
    const fx = makeFixture();
    installOk(fx);
    writeFileSync(join(fx.systemd, 'bot-errors-tree-provenance.timer'), '[Unit]\nDescription=tampered\n');
    const res = runInstaller(fx, ['verify', '--host', SYNTH_HOST, '--bundle-sha', SHA]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unit drift or missing: bot-errors-tree-provenance.timer');
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
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('rolling back');
    expect(snapshotDir(fx.systemd)).toEqual(before);
  });
});

describe('installer symlink and verify-bypass fixes (review findings)', () => {
  it('dangling destination unit symlink is rejected, not silently replaced', () => {
    const fx = makeFixture();
    const target = join(fx.systemd, 'bot-errors-tree-provenance.service');
    symlinkSync(join(fx.systemd, 'ghost-target-does-not-exist'), target);
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('symlink');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    for (const unit of UNIT_FILES) {
      if (unit === 'bot-errors-tree-provenance.service') continue;
      expect(existsSync(join(fx.systemd, unit))).toBe(false);
    }
    expect(existsSync(join(fx.home, '.local/lib/whatsoup/release-proof', SHA))).toBe(false);
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
    const res = runInstaller(fx, ['install', '--host', SYNTH_HOST, '--mode', 'observe', '--bundle-sha', SHA]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('rolling back');
    expect(snapshotDir(fx.systemd)).toEqual(before);
  });
});
