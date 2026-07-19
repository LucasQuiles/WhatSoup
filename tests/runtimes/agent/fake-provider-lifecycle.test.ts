// Lifecycle tests for the fake-provider fixture itself (B22): a fixture spawned
// with ignoreSigterm must still self-expire when it is orphaned (its spawning
// vitest worker died) or when it outlives the TTL backstop. Without self-expiry
// a crashed/recycled worker strands the fixture on PID 1 forever (observed on
// this machine: fixtures alive after 4+ days).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_PROVIDER, isAlive, killPid, waitUntil } from './lib/session-harness.ts';
import { isOrphaned } from './bin/orphan-predicate.ts';

// Intermediate parent: spawns the fixture detached, unrefs it, then STAYS
// ALIVE until the test kills it (B25 3e) — the parent-death moment is
// test-controlled, so the fixture-aliveness precondition below can never race
// the orphan watch on a loaded box. ESM source (repo rule: no CommonJS); the
// pinned node auto-detects module syntax in `-e` input (verified on
// v24.15.0). Reads [fixturePath, configJson] from its argv.
const INTERMEDIATE_PARENT_SOURCE = `
import { spawn } from 'node:child_process';
const [fixture, cfg] = process.argv.slice(1);
const child = spawn(process.execPath, [fixture, cfg], { detached: true, stdio: 'ignore' });
child.unref();
child.on('error', () => process.exit(97));
setInterval(() => {}, 1000);
`;

interface FixturePids {
  provider: number;
  g1: number | null;
  g2: number | null;
}

function readPidFile(pidFile: string): FixturePids {
  return JSON.parse(readFileSync(pidFile, 'utf8')) as FixturePids;
}

function envWithout(...keys: string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of keys) delete env[key];
  return env;
}

// B25 2a: the orphan signal must be PORTABLE. Under Linux child-subreapers
// (systemd --user — the fleet's Linux deploy-gate environment; docker-init;
// CI shims) an orphan reparents to the SUBREAPER, not init, so the old
// `process.ppid === 1` watch never fired there. The portable signal is "ppid
// CHANGED from its startup value". macOS always reparents to pid 1, so an
// integration test on this host cannot distinguish the two predicates —
// these unit cases pin the subreaper behavior directly against the shared
// predicate module the fixture executes.
describe('orphan predicate (portable reparent signal)', () => {
  it('fires when ppid changes to init (macOS / plain-Linux reparent)', () => {
    expect(isOrphaned(4242, 1)).toBe(true);
  });

  it('fires when ppid changes to a NON-init subreaper (systemd --user / docker-init) — the old ppid===1 check missed this', () => {
    expect(isOrphaned(4242, 777)).toBe(true);
  });

  it('does not fire while the startup parent is still the parent', () => {
    expect(isOrphaned(4242, 4242)).toBe(false);
  });

  it('fires when the fixture started already orphaned (startup race: parent died before the record)', () => {
    expect(isOrphaned(1, 1)).toBe(true);
  });
});

describe('fake-provider fixture self-expiry', () => {
  it('exits within the orphan watch window after its parent dies, despite ignoreSigterm', async () => {
    const runId = `b22orphan${Date.now().toString(36)}${process.pid}`;
    const pidFile = join(tmpdir(), `${runId}.json`);
    const config = JSON.stringify({ runId, pidFile, sessionId: runId, ignoreSigterm: true });
    let providerPid = 0;

    const intermediate = spawn(
      process.execPath,
      ['-e', INTERMEDIATE_PARENT_SOURCE, FAKE_PROVIDER, config],
      // Default TTL / poll cadence: this test must prove the production
      // defaults orphan-exit within a few seconds, not a test-tuned fast path.
      { stdio: 'ignore', env: envWithout('FAKE_PROVIDER_MAX_LIFETIME_MS', 'FAKE_PROVIDER_ORPHAN_POLL_MS') },
    );

    try {
      // The fixture writes its pid file at startup regardless of parent state.
      expect(await waitUntil(() => existsSync(pidFile), 8_000)).toBe(true);
      providerPid = readPidFile(pidFile).provider;
      // Deterministic aliveness precondition (B25 3e): the intermediate
      // parent is still alive here — we have not killed it yet — so
      // self-expiry CANNOT have fired (ppid unchanged, TTL is the 30-minute
      // default). The old design let the intermediate exit on its own
      // schedule, so on a loaded box a correctly-working fixture could
      // self-expire before this probe and fail the precondition.
      expect(intermediate.exitCode).toBeNull();
      expect(isAlive(providerPid)).toBe(true);

      // Test-controlled parent death: reparents the fixture exactly like a
      // dead vitest worker would (to pid 1 here; to the nearest subreaper on
      // systemd --user / docker — the watch must not care which).
      intermediate.kill('SIGKILL');
      expect(await waitUntil(
        () => intermediate.exitCode !== null || intermediate.signalCode !== null,
        6_000,
      )).toBe(true);

      // Core B22 assertion: the orphaned fixture self-exits within a few
      // seconds even though it was configured to ignore SIGTERM. On the
      // unfixed fixture this times out — the orphan runs forever.
      const orphanExited = await waitUntil(() => !isAlive(providerPid), 6_000);
      expect(
        orphanExited,
        `orphaned fake-provider pid ${providerPid} still alive 6s after its parent died (ignoreSigterm must not defeat orphan self-exit)`,
      ).toBe(true);
    } finally {
      intermediate.kill('SIGKILL');
      killPid(providerPid);
      rmSync(pidFile, { force: true });
    }
  }, 25_000);

  it('B25 2b: grandchildren get a TTL backstop when the fixture dies WITHOUT selfExpire (external SIGKILL)', async () => {
    // The exact orphan class the fixture-self-expiry fix closes, one level
    // down: SIGTERM-ignoring grandchildren whose fixture parent died without
    // running selfExpire (crashAfterMs / external SIGKILL) while the vitest
    // worker also died. TTL-only — a grandchild ppid watch would fake the
    // process-tree-reaping suite's reaper assertions (constraint documented
    // in the fixture).
    const runId = `b25gcttl${Date.now().toString(36)}${process.pid}`;
    const pidFile = join(tmpdir(), `${runId}.json`);
    const config = JSON.stringify({
      runId,
      pidFile,
      sessionId: runId,
      spawnGrandchildren: true,
      grandchildrenIgnoreSigterm: true,
    });

    const child = spawn(process.execPath, [FAKE_PROVIDER, config], {
      stdio: 'ignore',
      // Short grandchild TTL for observability; the fixture's own TTL and
      // orphan poll stay at production defaults.
      env: {
        ...envWithout('FAKE_PROVIDER_MAX_LIFETIME_MS', 'FAKE_PROVIDER_ORPHAN_POLL_MS'),
        FAKE_PROVIDER_GRANDCHILD_TTL_MS: '750',
      },
    });
    let pids: FixturePids | null = null;

    try {
      expect(await waitUntil(() => existsSync(pidFile), 8_000)).toBe(true);
      pids = readPidFile(pidFile);
      expect(pids.g1).not.toBeNull();
      expect(pids.g2).not.toBeNull();
      expect(await waitUntil(() => isAlive(pids?.g1) && isAlive(pids?.g2), 4_000)).toBe(true);

      // Fixture dies WITHOUT selfExpire: external SIGKILL, so the fixture's
      // own grandchild reaping never runs.
      child.kill('SIGKILL');
      expect(await waitUntil(() => !isAlive(pids?.provider), 4_000)).toBe(true);

      // Unfixed grandchild programs run setInterval forever — this times out.
      const grandchildrenExited = await waitUntil(
        () => !isAlive(pids?.g1) && !isAlive(pids?.g2),
        6_000,
      );
      expect(
        grandchildrenExited,
        `grandchildren ${pids.g1}/${pids.g2} outlived their 750ms TTL backstop by >6s after the fixture was SIGKILLed`,
      ).toBe(true);
    } finally {
      killPid(pids?.g1);
      killPid(pids?.g2);
      killPid(child.pid);
      rmSync(pidFile, { force: true });
    }
  }, 25_000);

  it('exits when FAKE_PROVIDER_MAX_LIFETIME_MS elapses even with a live parent and ignoreSigterm', async () => {
    const runId = `b22ttl${Date.now().toString(36)}${process.pid}`;
    const pidFile = join(tmpdir(), `${runId}.json`);
    const config = JSON.stringify({ runId, pidFile, sessionId: runId, ignoreSigterm: true });

    // Parent (this vitest worker) stays alive, so only the TTL can end the
    // fixture: ppid never becomes 1 during this test.
    const child = spawn(process.execPath, [FAKE_PROVIDER, config], {
      stdio: 'ignore',
      env: { ...envWithout('FAKE_PROVIDER_ORPHAN_POLL_MS'), FAKE_PROVIDER_MAX_LIFETIME_MS: '750' },
    });

    try {
      expect(await waitUntil(() => existsSync(pidFile), 8_000)).toBe(true);
      const providerPid = readPidFile(pidFile).provider;
      expect(providerPid).toBe(child.pid);

      const ttlExited = await waitUntil(() => !isAlive(providerPid), 6_000);
      expect(
        ttlExited,
        `fake-provider pid ${providerPid} outlived its 750ms TTL backstop by >6s`,
      ).toBe(true);
    } finally {
      killPid(child.pid);
      rmSync(pidFile, { force: true });
    }
  }, 25_000);

  it('stays alive under a living parent with default TTL (self-expiry must not fire early)', async () => {
    const runId = `b22live${Date.now().toString(36)}${process.pid}`;
    const pidFile = join(tmpdir(), `${runId}.json`);
    const config = JSON.stringify({ runId, pidFile, sessionId: runId });

    const child = spawn(process.execPath, [FAKE_PROVIDER, config], {
      stdio: 'ignore',
      env: envWithout('FAKE_PROVIDER_MAX_LIFETIME_MS', 'FAKE_PROVIDER_ORPHAN_POLL_MS'),
    });

    try {
      expect(await waitUntil(() => existsSync(pidFile), 8_000)).toBe(true);
      const providerPid = readPidFile(pidFile).provider;
      // Bounded observation window covering multiple orphan-poll ticks: a
      // healthy parented fixture must NOT self-expire.
      const exitedEarly = await waitUntil(() => !isAlive(providerPid), 2_500);
      expect(
        exitedEarly,
        `fake-provider pid ${providerPid} self-expired while its parent was alive`,
      ).toBe(false);
    } finally {
      killPid(child.pid);
      rmSync(pidFile, { force: true });
    }
  }, 25_000);
});
