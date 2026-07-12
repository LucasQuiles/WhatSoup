import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const RUNNER = join(process.cwd(), 'deploy/scripts/bot-errors-release-proof-run.sh');
const tmpDirs: string[] = [];

interface Fixture {
  home: string;
  bin: string;
  bundle: string;
  ledger: string;
  modeFile: string;
  stateDir: string;
}

function makeFixture(mode: string | null, opts: { flockRc?: number; noDetectors?: boolean } = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'rp-run-'));
  tmpDirs.push(home);
  const bin = join(home, 'bin');
  const bundle = join(home, 'bundle');
  const stateDir = join(home, 'state');
  const ledger = join(home, 'ledger.txt');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(bundle, 'deploy/scripts'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  if (!opts.noDetectors) {
    for (const script of ['bot-errors-tree-provenance.py', 'bot-errors-runtime-staleness.py']) {
      writeFileSync(join(bundle, 'deploy/scripts', script), '# detector placeholder\n');
    }
  }
  // fake python3 records its argv, one line per invocation
  writeFileSync(join(bin, 'python3'), `#!/usr/bin/env bash\necho "python3 $*" >> "${ledger}"\nexit 0\n`);
  chmodSync(join(bin, 'python3'), 0o755);
  // fake flock: rc 0 grants the lock, 1 denies it
  const flockRc = opts.flockRc ?? 0;
  writeFileSync(join(bin, 'flock'), `#!/usr/bin/env bash\nexit ${flockRc}\n`);
  chmodSync(join(bin, 'flock'), 0o755);
  const modeFile = join(home, 'release-proof.env');
  if (mode !== null) writeFileSync(modeFile, `BOT_ERRORS_RELEASE_PROOF_MODE=${mode}\n`);
  return { home, bin, bundle, ledger, modeFile, stateDir };
}

function runRunner(fx: Fixture, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [RUNNER, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fx.home,
      PATH: `${fx.bin}:${process.env.PATH}`,
      BOT_ERRORS_RELEASE_PROOF_ENV: fx.modeFile,
      BOT_ERRORS_RELEASE_PROOF_BUNDLE: fx.bundle,
      BOT_ERRORS_RELEASE_PROOF_APP_REPO: join(fx.home, 'app-repo'),
      BOT_ERRORS_STATE_DIR: fx.stateDir,
      ...extraEnv,
    },
  });
}

function ledgerLines(fx: Fixture): string[] {
  return existsSync(fx.ledger) ? readFileSync(fx.ledger, 'utf8').trim().split('\n') : [];
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('bot-errors-release-proof-run.sh', () => {
  it('observe + tree → --reporter --print --repo <app repo>, exit 0', () => {
    const fx = makeFixture('observe');
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(0);
    const lines = ledgerLines(fx);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('bot-errors-tree-provenance.py');
    expect(lines[0]).toContain('--reporter --print');
    expect(lines[0]).toContain(`--repo ${join(fx.home, 'app-repo')}`);
    expect(lines[0]).not.toContain('--once');
  });

  it('emit + tree → --reporter --once', () => {
    const fx = makeFixture('emit');
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(0);
    expect(ledgerLines(fx)[0]).toContain('--reporter --once');
  });

  it('observe + runtime-staleness → --dry-run --once', () => {
    const fx = makeFixture('observe');
    const res = runRunner(fx, ['runtime-staleness']);
    expect(res.status).toBe(0);
    const line = ledgerLines(fx)[0];
    expect(line).toContain('bot-errors-runtime-staleness.py');
    expect(line).toContain('--dry-run');
    expect(line).toContain('--once');
  });

  it('emit + runtime-staleness → --once without --dry-run', () => {
    const fx = makeFixture('emit');
    const res = runRunner(fx, ['runtime-staleness']);
    expect(res.status).toBe(0);
    const line = ledgerLines(fx)[0];
    expect(line).toContain('--once');
    expect(line).not.toContain('--dry-run');
  });

  it('invalid mode → exit 2 before any detector runs', () => {
    const fx = makeFixture('yolo');
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('invalid BOT_ERRORS_RELEASE_PROOF_MODE');
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('missing mode file → exit 2', () => {
    const fx = makeFixture(null);
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('missing mode file');
  });

  it('unknown component → exit 2', () => {
    const fx = makeFixture('observe');
    expect(runRunner(fx, ['everything']).status).toBe(2);
  });

  it('zero or two components → exit 2', () => {
    const fx = makeFixture('observe');
    expect(runRunner(fx, []).status).toBe(2);
    expect(runRunner(fx, ['tree', 'runtime-staleness']).status).toBe(2);
  });

  it('missing detector in bundle → exit 2', () => {
    const fx = makeFixture('observe', { noDetectors: true });
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('missing detector');
  });

  it('lock contention → exit 75 and a recorded skip', () => {
    const fx = makeFixture('observe', { flockRc: 1 });
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(75);
    expect(res.stderr).toContain('skipping cycle');
    expect(ledgerLines(fx)).toHaveLength(0);
  });

  it('contains no application service commands (structural)', () => {
    const text = readFileSync(RUNNER, 'utf8');
    for (const forbidden of ['systemctl', 'launchctl', 'whatsoup@', 'whatsoup-fleet']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
