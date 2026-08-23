import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const RUNNER = join(process.cwd(), 'deploy/scripts/bot-errors-release-proof-run.sh');
const tmp = trackTmpDirs('rp-');

interface Fixture {
  home: string;
  bin: string;
  bundle: string;
  ledger: string;
  modeFile: string;
  stateDir: string;
}

function makeFixture(mode: string | null, opts: { flockRc?: number; noDetectors?: boolean } = {}): Fixture {
  const home = tmp.make('run');
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

const USAGE_LINE = 'usage: bot-errors-release-proof-run.sh tree|runtime-staleness';

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

  it('propagates detector exit 1 (event-write failure)', () => {
    const fx = makeFixture('emit');
    writeFileSync(join(fx.bin, 'python3'), `#!/usr/bin/env bash\necho "python3 $*" >> "${fx.ledger}"\nexit 1\n`);
    chmodSync(join(fx.bin, 'python3'), 0o755);
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(1);
    expect(ledgerLines(fx)).toHaveLength(1);
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

  // Exact rejection contract, asserted per stream rather than on a concatenation.
  // A `toContain` over `stdout + stderr` cannot tell which stream carried the text,
  // and would still pass if the runner leaked diagnostics to stdout or dispatched a
  // detector before rejecting.
  function expectRejected(fx: Fixture, component: string): void {
    const res = runRunner(fx, [component]);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    // Byte-exact, not line-exact: `.trim()` would accept leading/trailing noise
    // (a stray banner line, an extra blank line) around the usage text.
    expect(res.stderr).toBe(`${USAGE_LINE}\n`);
    expect(ledgerLines(fx)).toEqual([]);
  }

  it('unknown component → exit 2', () => {
    expectRejected(makeFixture('observe'), 'everything');
  });

  // #2481 LOCKOUT: `health-invariants` was removed because it asserted a
  // `turnCapabilityEvidence` field no runtime in src/ emits, no service unit
  // invoked it, and its own fixture manufactured the only value that made it
  // pass. The generic unknown-component test above uses 'everything' and would
  // still pass if this component were reintroduced, so it is named explicitly
  // here. #2481 owns the real versioned release-capability admission contract.
  it('health-invariants stays removed → exit 2, never dispatches', () => {
    expectRejected(makeFixture('observe'), 'health-invariants');
  });

  // Structural companion to the behavioural lockout above. A behavioural fixture
  // only proves the DEFAULT path rejects the component; an environment-gated
  // reintroduction (a case arm guarded by an env var, say) can leave the default
  // rejecting while still exposing the component when that variable is set. This
  // asserts the string is absent from the runner source entirely, so no gated
  // arm can hide behind a green default.
  it('health-invariants appears nowhere in the runner source', () => {
    const source = readFileSync(RUNNER, 'utf8');
    expect(source).not.toContain('health-invariants');
    expect(source).not.toContain('turnCapabilityEvidence');
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
