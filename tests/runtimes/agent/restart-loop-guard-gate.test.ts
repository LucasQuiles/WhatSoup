/**
 * T5 — startup resume gate consults the restart-loop guard (C5 P3).
 *
 * Exercises the REAL `shouldSuppressProactiveResume` method on a prototype
 * stub of AgentRuntime (Object.create — no sockets/db needed; the method
 * only touches the guard journal + pendingStartupMessage). Companion to
 * restart-loop-guard.test.ts (module-level T2/T3/T4).
 *
 * LOCAL RUN NOTE: this file imports runtime.ts, whose module graph pulls the
 * config -> agent-config-validator -> 're2' chain. That package is absent on
 * the q-pi dev box — a PRE-EXISTING install gap proven identical on pristine
 * main (d8e1f307) by stash isolation 2026-07-19 — so every case here fails
 * at import locally. CI (full node_modules) is the green surface, same as
 * the pre-existing 131 machine/env failures documented fleet-wide.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('T5 — startup resume gate consults the restart-loop guard', () => {
  let dir: string;
  let savedInstanceConfig: string | undefined;
  // config.ts repoints process.env.TMPDIR into the instance data dir on import.
  // Capture it before load() mutates it so afterEach restores the isolated
  // TMPDIR — otherwise the next beforeEach's mkdtemp(tmpdir()) targets this
  // test's already-removed dir and fails ENOENT.
  let savedTmpdir: string | undefined;

  function instanceConfig(overrides: Record<string, unknown> = {}) {
    return {
      name: 'gate-bot',
      type: 'agent',
      adminPhones: ['15550000001'],
      paths: {
        configRoot: join(dir, 'config'),
        dataRoot: join(dir, 'data'),
        stateRoot: join(dir, 'state'),
        authDir: join(dir, 'config', 'auth_info'),
        dbPath: join(dir, 'data', 'bot.db'),
        logDir: join(dir, 'data', 'logs'),
        lockPath: join(dir, 'state', 'bot.lock'),
        mediaDir: join(dir, 'data', 'media', 'tmp'),
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    savedInstanceConfig = process.env.INSTANCE_CONFIG;
    savedTmpdir = process.env.TMPDIR;
    dir = mkdtempSync(join(tmpdir(), 'ws-rlg-gate-'));
    vi.resetModules();
  });

  afterEach(() => {
    if (savedInstanceConfig === undefined) delete process.env.INSTANCE_CONFIG;
    else process.env.INSTANCE_CONFIG = savedInstanceConfig;
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  async function load(overrides: Record<string, unknown> = {}) {
    process.env.INSTANCE_CONFIG = JSON.stringify(instanceConfig(overrides));
    vi.resetModules();
    const guard = await import('../../../src/runtimes/agent/restart-loop-guard.ts');
    const { AgentRuntime } = await import('../../../src/runtimes/agent/runtime.ts');
    const { config } = await import('../../../src/config.ts');
    const stub = Object.create(AgentRuntime.prototype) as {
      restartLoopInterruptedBoot: boolean;
      pendingStartupMessage: { chatJid: string; text: string } | null;
      shouldSuppressProactiveResume: (resumableCount: number) => boolean;
    };
    stub.restartLoopInterruptedBoot = false;
    stub.pendingStartupMessage = null;
    return { guard, config, stub };
  }

  /** Drive N crashy boots against the instance's real guard journal. */
  function driveCrashyBoots(guard: typeof import('../../../src/runtimes/agent/restart-loop-guard.ts'), stateRoot: string, n: number) {
    const path = guard.restartLoopGuardPath(stateRoot);
    for (let i = 0; i < n; i += 1) {
      guard.markBootInProgress(path);
      guard.checkAndRecordInterruptedBoot({ statePath: path });
    }
  }

  it('does not consult the journal when the boot was clean (not interrupted)', async () => {
    const { guard, config, stub } = await load();
    stub.restartLoopInterruptedBoot = false;
    expect(stub.shouldSuppressProactiveResume(3)).toBe(false);
    const h = guard.readRestartLoopGuardHealth(guard.restartLoopGuardPath(config.stateRoot));
    expect(h.bootsInWindow).toBe(0);
    expect(h.tripped).toBe(false); // a clean boot leaves the guard untripped
    expect(stub.pendingStartupMessage).toBe(null); // no admin notice queued on a clean boot
  });

  it('does not consult the journal when nothing is resumable', async () => {
    const { guard, config, stub } = await load();
    stub.restartLoopInterruptedBoot = true;
    expect(stub.shouldSuppressProactiveResume(0)).toBe(false);
    const h = guard.readRestartLoopGuardHealth(guard.restartLoopGuardPath(config.stateRoot));
    expect(h.bootsInWindow).toBe(0);
  });

  it('trips on the 3rd crashy boot, suppresses resume, and queues one admin notice', async () => {
    const { guard, config, stub } = await load();
    driveCrashyBoots(guard, config.stateRoot, 2); // journal = 2 crashy boots
    stub.restartLoopInterruptedBoot = true;       // this boot also follows a crash
    expect(stub.shouldSuppressProactiveResume(2)).toBe(true); // records the 3rd → trip
    const h = guard.readRestartLoopGuardHealth(guard.restartLoopGuardPath(config.stateRoot));
    expect(h.bootsInWindow).toBe(3);
    expect(h.tripped).toBe(true);
    expect(h.lastTripAt).not.toBeNull();
    expect(stub.pendingStartupMessage?.chatJid).toBe('15550000001@s.whatsapp.net');
    expect(stub.pendingStartupMessage?.text).toContain('Restart-loop guard tripped');
    expect(stub.pendingStartupMessage?.text).toContain('queued-input replay are suppressed');
  });

  it('does not trip below the threshold', async () => {
    const { guard, config, stub } = await load();
    driveCrashyBoots(guard, config.stateRoot, 1); // journal = 1
    stub.restartLoopInterruptedBoot = true;
    expect(stub.shouldSuppressProactiveResume(2)).toBe(false); // records the 2nd
    const h = guard.readRestartLoopGuardHealth(guard.restartLoopGuardPath(config.stateRoot));
    expect(h.bootsInWindow).toBe(2);
    expect(h.tripped).toBe(false);
    expect(h.lastTripAt).toBe(null); // below threshold ⇒ no trip timestamp recorded
    expect(stub.pendingStartupMessage).toBe(null); // no admin notice queued below threshold
  });

  it('guard disabled in instance.json ⇒ never suppresses, never records', async () => {
    const { guard, config, stub } = await load({ restartLoopGuard: { enabled: false } });
    driveCrashyBoots(guard, config.stateRoot, 2);
    stub.restartLoopInterruptedBoot = true;
    expect(stub.shouldSuppressProactiveResume(3)).toBe(false);
    const h = guard.readRestartLoopGuardHealth(guard.restartLoopGuardPath(config.stateRoot));
    expect(h.bootsInWindow).toBe(2); // unchanged — the method returned before recording
    expect(h.tripped).toBe(false); // a disabled guard never trips
    expect(stub.pendingStartupMessage).toBe(null); // no admin notice queued when disabled
  });
});
