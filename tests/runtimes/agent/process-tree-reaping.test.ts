import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { killSessionTree } from '../../../src/runtimes/agent/process-tree.ts';
import {
  FAKE_PROVIDER,
  buildManager,
  isAlive,
  killPid,
  makeMemoryDb,
  makeMessenger,
  waitUntil,
} from './lib/session-harness.ts';

interface ProviderTreePids {
  provider: number;
  g1: number;
  g2: number;
}

async function assertManagerPathReapsTree(
  pathName: string,
  exercise: (manager: unknown) => Promise<void> | void,
): Promise<void> {
  const runId = `l7-${pathName}-${process.pid}-${Date.now()}`;
  const pidFile = join(tmpdir(), `${runId}.json`);
  const db = makeMemoryDb();
  const { messenger } = makeMessenger();
  const { mgr } = buildManager({
    db,
    messenger,
    chatJid: `${runId}@s.whatsapp.net`,
    fakeConfig: {
      runId,
      pidFile,
      sessionId: runId,
      graceMs: 100,
      spawnGrandchildren: true,
    },
  });
  let pids: ProviderTreePids | null = null;

  try {
    await mgr.spawnSession();
    expect(await waitUntil(() => existsSync(pidFile), 8_000)).toBe(true);
    pids = JSON.parse(readFileSync(pidFile, 'utf8')) as ProviderTreePids;
    expect(await waitUntil(() => isAlive(pids?.g1) && isAlive(pids?.g2), 4_000)).toBe(true);
    expect(isAlive(process.pid)).toBe(true);

    await exercise(mgr);
    expect(await waitUntil(
      () => !isAlive(pids?.provider) && !isAlive(pids?.g1) && !isAlive(pids?.g2),
      8_000,
    )).toBe(true);

    const survivors = [
      ...(isAlive(pids.provider) ? ['provider'] : []),
      ...(isAlive(pids.g1) ? ['g1'] : []),
      ...(isAlive(pids.g2) ? ['g2'] : []),
    ];
    expect(isAlive(process.pid)).toBe(true);
    expect(survivors).toEqual([]);
  } finally {
    killPid(pids?.g1);
    killPid(pids?.g2);
    killPid(pids?.provider);
    db.close();
    rmSync(pidFile, { force: true });
  }
}

describe('provider process-tree reaping', () => {
  it('reaps normal and detached grandchildren on shutdown(false) without killing the parent', async () => {
    await assertManagerPathReapsTree('shutdown', async (manager) => {
      await (manager as { shutdown(suspend: boolean): Promise<void> }).shutdown(false);
    });
  }, 20_000);

  it('reaps normal and detached grandchildren on the hard watchdog path', async () => {
    await assertManagerPathReapsTree('watchdog', (manager) => {
      (manager as { handleWatchdogHard(): void }).handleWatchdogHard();
    });
  }, 20_000);

  it('reaps a numeric stale-session root without killing the parent', async () => {
    const runId = `l7-numeric-${process.pid}-${Date.now()}`;
    const pidFile = join(tmpdir(), `${runId}.json`);
    const child = spawn(
      process.execPath,
      [FAKE_PROVIDER, JSON.stringify({
        runId,
        pidFile,
        sessionId: runId,
        graceMs: 100,
        spawnGrandchildren: true,
        grandchildrenIgnoreSigterm: true,
      })],
      { detached: true, stdio: 'ignore' },
    );
    let pids: ProviderTreePids | null = null;

    try {
      expect(await waitUntil(() => existsSync(pidFile), 8_000)).toBe(true);
      pids = JSON.parse(readFileSync(pidFile, 'utf8')) as ProviderTreePids;
      expect(await waitUntil(() => isAlive(pids?.g1) && isAlive(pids?.g2), 4_000)).toBe(true);

      await killSessionTree(pids.provider, 'SIGTERM', {
        generationMarker: `stale-test:${runId}`,
        termGraceMs: 1_000,
        killGraceMs: 1_000,
      });

      expect(isAlive(process.pid)).toBe(true);
      expect([isAlive(pids.provider), isAlive(pids.g1), isAlive(pids.g2)]).toEqual([
        false,
        false,
        false,
      ]);
    } finally {
      killPid(pids?.g1);
      killPid(pids?.g2);
      killPid(pids?.provider ?? child.pid);
      rmSync(pidFile, { force: true });
    }
  }, 20_000);
});
