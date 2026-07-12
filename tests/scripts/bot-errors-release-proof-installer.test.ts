import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
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
