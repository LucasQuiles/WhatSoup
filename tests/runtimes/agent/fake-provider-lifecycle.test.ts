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

// Intermediate parent: spawns the fixture detached, unrefs it, and exits as
// soon as the spawn succeeds — reparenting the fixture to PID 1 exactly like a
// dead vitest worker would. Reads [fixturePath, configJson] from its argv.
const INTERMEDIATE_PARENT_SOURCE = `
const { spawn } = require('node:child_process');
const [fixture, cfg] = process.argv.slice(1);
const child = spawn(process.execPath, [fixture, cfg], { detached: true, stdio: 'ignore' });
child.unref();
child.on('spawn', () => process.exit(0));
child.on('error', () => process.exit(97));
`;

interface FixturePids {
  provider: number;
}

function readPidFile(pidFile: string): FixturePids {
  return JSON.parse(readFileSync(pidFile, 'utf8')) as FixturePids;
}

function envWithout(...keys: string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of keys) delete env[key];
  return env;
}

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
      // Guard against a vacuous pass: the fixture must be alive at observation
      // start (orphan detection lags reparenting by up to one ~1s poll tick).
      expect(isAlive(providerPid)).toBe(true);

      // The intermediate parent exits on the fixture's spawn event.
      expect(await waitUntil(() => intermediate.exitCode !== null, 6_000)).toBe(true);
      expect(intermediate.exitCode).toBe(0);

      // Core B22 assertion: the orphaned fixture self-exits within a few
      // seconds even though it was configured to ignore SIGTERM. On the
      // unfixed fixture this times out — the orphan runs forever.
      const orphanExited = await waitUntil(() => !isAlive(providerPid), 6_000);
      expect(
        orphanExited,
        `orphaned fake-provider pid ${providerPid} still alive 6s after its parent died (ignoreSigterm must not defeat orphan self-exit)`,
      ).toBe(true);
    } finally {
      killPid(providerPid);
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
