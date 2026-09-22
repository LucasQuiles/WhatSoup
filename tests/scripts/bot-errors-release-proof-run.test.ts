import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const RUNNER = join(process.cwd(), 'deploy/scripts/bot-errors-release-proof-run.sh');
const REPO_SCRIPTS = join(process.cwd(), 'deploy/scripts');
const tmp = trackTmpDirs('rp-');

interface Fixture {
  home: string;
  bin: string;
  bundle: string;
  ledger: string;
  modeFile: string;
  stateDir: string;
}

interface FixtureOpts {
  flockRc?: number;
  noDetectors?: boolean;
  // Stage the repository's own deploy/scripts/lib into the bundle and let the
  // recorded python3 hand off to the real interpreter, so a receipt the runner
  // asks for is actually written by the shipped writer rather than mimed.
  realWriter?: boolean;
}

/** Absolute path of the interpreter the runner would find without the fixture's shim. */
function realPython3(): string {
  return execFileSync('bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();
}

function makeFixture(mode: string | null, opts: FixtureOpts = {}): Fixture {
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
  if (opts.realWriter) {
    cpSync(join(REPO_SCRIPTS, 'lib'), join(bundle, 'deploy/scripts/lib'), { recursive: true });
  }
  // fake python3 records its argv, one line per invocation. With realWriter the
  // recorded invocation is then handed to the real interpreter by absolute path
  // (the shim owns the name `python3` on PATH, so a bare exec would recurse).
  const handOff = opts.realWriter ? `exec ${realPython3()} "$@"\n` : 'exit 0\n';
  writeFileSync(join(bin, 'python3'), `#!/usr/bin/env bash\necho "python3 $*" >> "${ledger}"\n${handOff}`);
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

// A fixed instant older than any stamp the runner can produce. The writer
// stamps at second resolution, so a seed taken from the real clock could equal
// the runner's own stamp and an assertion that a clock did NOT move would then
// compare two equal values and hold whether or not the rule does.
const SEED_STAMP = '2020-01-01T00:00:00Z';

/**
 * Give a producer's receipt both cadence clocks at SEED_STAMP.
 *
 * Runs the shipped writer directly by absolute interpreter path, so the seed
 * never passes through the fixture's PATH shim and leaves the invocation ledger
 * untouched. Returns the receipt path the writer itself resolved: the filenames
 * belong to the writer module and are never restated here.
 */
function seedReceipt(fx: Fixture, unit: string): string {
  const scripts = join(fx.bundle, 'deploy/scripts');
  const seed = join(fx.home, 'seed.py');
  const pathFile = join(fx.home, 'receipt-path.txt');
  writeFileSync(
    seed,
    [
      'import importlib, pathlib, sys',
      `sys.path.insert(0, ${JSON.stringify(scripts)})`,
      'pcr = importlib.import_module("lib.producer_cadence_receipt")',
      `pcr.receipt_clock = lambda: ${JSON.stringify(SEED_STAMP)}`,
      'producer = pcr.ProducerIdentity(sys.argv[1])',
      'pcr.record_cycle_attempt(producer, mode=pcr.CadenceMode.OBSERVE)',
      'pcr.record_cycle_success(producer, mode=pcr.CadenceMode.OBSERVE, durable_write=pcr.DurableWrite.NOT_OWED)',
      `pathlib.Path(${JSON.stringify(pathFile)}).write_text(str(pcr.receipt_path(producer)))`,
      '',
    ].join('\n'),
  );
  const res = spawnSync(realPython3(), [seed, unit], {
    encoding: 'utf8',
    env: { ...process.env, BOT_ERRORS_STATE_DIR: fx.stateDir },
  });
  // The seed is scaffolding for the assertions below; a silent failure here
  // would leave a receipt with null clocks and make "unchanged" trivially true.
  expect(`${res.status} ${res.stderr}`).toBe('0 ');
  return readFileSync(pathFile, 'utf8');
}

function readReceipt(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
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

  // Upgraded from "the ledger is empty" (#2341 leaf 2). An empty ledger proved
  // no detector ran, but it also passed while the refused cycle left no trace at
  // all — the state the receipt exists to end. This asserts the stronger pair:
  // the runner routes a pre-exec lock-skip receipt, and it launches no detector.
  it('lock contention → exit 75, a routed lock-skip receipt and no detector launch', () => {
    const fx = makeFixture('observe', { flockRc: 1 });
    const res = runRunner(fx, ['tree']);
    expect(res.status).toBe(75);
    expect(res.stderr).toContain('skipping cycle');
    const lines = ledgerLines(fx);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('lock-skip tree observe');
    expect(lines[0]).not.toContain('bot-errors-tree-provenance.py');
  });

  // Both producers reach the lock through the one wrapper path, so both are
  // named rather than one standing in for the other (contract item 4). The
  // expectations differ in fetchStatus: the tree producer has a refresh step it
  // did not use, the runtime-staleness producer has none at all.
  const LOCK_SKIP_CASES = [
    { component: 'tree', unit: 'bot-errors-tree-provenance', fetchStatus: 'not_attempted' },
    { component: 'runtime-staleness', unit: 'bot-errors-runtime-staleness', fetchStatus: 'not_applicable' },
  ];

  for (const producer of LOCK_SKIP_CASES) {
    it(`lock contention writes ${producer.unit} a lock_skip receipt that moves neither cadence clock`, () => {
      const fx = makeFixture('observe', { flockRc: 1, realWriter: true });
      const receiptPath = seedReceipt(fx, producer.unit);
      const before = readReceipt(receiptPath);
      expect(before.lastAttemptAt).toBe(SEED_STAMP);
      expect(before.lastSuccessfulObservationAt).toBe(SEED_STAMP);

      const res = runRunner(fx, [producer.component]);

      expect(res.status).toBe(75);
      const after = readReceipt(receiptPath);
      expect(after.producer).toBe(producer.unit);
      expect(after.outcome).toBe('lock_skip');
      expect(after.stage).toBe('pre_exec');
      expect(after.mode).toBe('observe');
      expect(after.fetchStatus).toBe(producer.fetchStatus);
      // The refused cycle never started and observed nothing, so both cadence
      // clocks keep the values the seeded cycle left.
      expect(after.lastAttemptAt).toBe(SEED_STAMP);
      expect(after.lastSuccessfulObservationAt).toBe(SEED_STAMP);
      // The invocation clock is what separates a contended lock from a stopped
      // timer, so it is the one field that must move.
      expect(after.lastInvocationAt).not.toBe(SEED_STAMP);
      expect(String(after.lastInvocationAt) > SEED_STAMP).toBe(true);
      // Pre-exec means pre-exec: the detector is never launched.
      expect(ledgerLines(fx).join('\n')).not.toContain(`${producer.unit}.py`);
    });
  }

  it('contains no application service commands (structural)', () => {
    const text = readFileSync(RUNNER, 'utf8');
    for (const forbidden of ['systemctl', 'launchctl', 'whatsoup@', 'whatsoup-fleet']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
