// Regression: after refresh-ahead reaches its hard cap, the ordinary periodic
// primary probe must turn the held owner into the normal primary_model_unusable
// alert. The initial refresh defer remains non-alertable.
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refreshControl = vi.hoisted(() => ({ deps: undefined as unknown }));

vi.mock('../../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../../helpers/logger-mock.ts');
  const runtimeLogger = singletonLoggerMock();
  return {
    default: { ...runtimeLogger, child: () => runtimeLogger },
    createChildLogger: () => runtimeLogger,
    flushLogger: () => Promise.resolve(),
  };
});

vi.mock('../../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/emit-alert.ts')>(),
  emitAlert: vi.fn(() => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  emitAlertChecked: vi.fn(() => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  clearAlertSourceChecked: vi.fn(() => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
}));

// Keep the production refresh state machine. Only terminal process ownership
// is supplied through its existing dependency seam, so the periodic runtime
// path observes the real hard-cap -> hung transition.
vi.mock('../../../src/runtimes/agent/providers/claude-refresh-ahead.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtimes/agent/providers/claude-refresh-ahead.ts')>();
  return {
    ...actual,
    refreshClaudeLoginAhead: (binary: string, env: NodeJS.ProcessEnv) =>
      actual.refreshClaudeLoginAhead(
        binary,
        env,
        refreshControl.deps as Parameters<typeof actual.refreshClaudeLoginAhead>[2],
      ),
  };
});

import { Database } from '../../../src/core/database.ts';
import { emitAlertChecked } from '../../../src/lib/emit-alert.ts';
import {
  REFRESH_AHEAD_HARD_CAP_MS,
  REFRESH_AHEAD_WAIT_MS,
  type ClaudeRefreshAheadDeps,
} from '../../../src/runtimes/agent/providers/claude-refresh-ahead.ts';
import { makeRuntimeState, type RuntimeState } from './lib/runtime-terminal-coordinator-harness.ts';

const MINUTE = 60_000;
const START = new Date('2026-10-29T12:00:00.000Z');

type FakeChild = EventEmitter & {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

type ProbeState = RuntimeState & {
  primaryModelUsability: { reason?: string; probeInFlight: boolean } | null;
  periodicUsabilityProbeBackoff: number;
  periodicUsabilityProbeDueAt: number | null;
  capturePrimaryProbeServiceContext(): void;
  fallback: {
    schedulePrimaryModelUsabilityProbe(trigger: 'startup' | 'manual' | 'periodic'): void;
    scheduleNextPeriodicUsabilityProbe(): void;
  };
};

function fakeChild(pid: number): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  return child;
}

describe('refresh-ahead hard cap reaches periodic primary alert', () => {
  let db: Database;
  let fixtureRoot: string;
  let refreshChild: FakeChild;
  let refreshSpawn: ReturnType<typeof vi.fn>;
  let savedPath: string | undefined;
  let savedConfigDir: string | undefined;
  let savedSecureStorageDir: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    vi.spyOn(Math, 'random').mockReturnValue(1); // deterministic +10% jitter: 33m then 66m
    db = new Database(':memory:');
    db.open();

    fixtureRoot = mkdtempSync(join(tmpdir(), 'refresh-ahead-periodic-alert-'));
    const configDir = join(fixtureRoot, '.claude');
    const binDir = join(fixtureRoot, 'bin');
    mkdirSync(configDir, { mode: 0o700 });
    mkdirSync(binDir, { mode: 0o700 });
    const binary = join(binDir, 'claude');
    writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    chmodSync(binary, 0o700);

    savedPath = process.env.PATH;
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    savedSecureStorageDir = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    process.env.PATH = `${binDir}:${savedPath ?? ''}`;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = configDir;

    refreshChild = fakeChild(9100);
    refreshSpawn = vi.fn(() => refreshChild);
    refreshControl.deps = {
      platform: 'linux',
      readFileStore: () => null, // unknown expiry deliberately enters refresh-ahead
      spawnImpl: refreshSpawn as unknown as typeof import('node:child_process').spawn,
      hostId: 'periodic-alert-fixture-host',
      inspectProcess: (pid: number) => ({
        state: 'alive' as const,
        birthToken: `refresh-owner-v1:fixture-boot:fixture-birth:${pid}`,
      }),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    } satisfies ClaudeRefreshAheadDeps;
    vi.mocked(emitAlertChecked).mockClear();
  });

  afterEach(async () => {
    refreshChild?.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(0);
    refreshControl.deps = undefined;
    db.close();
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedSecureStorageDir === undefined) delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    else process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = savedSecureStorageDir;
    rmSync(fixtureRoot, { recursive: true, force: true });
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the initial defer non-alertable, then emits primary_model_unusable from the real periodic retry after hard cap', async () => {
    const { state } = makeRuntimeState<ProbeState>(db);

    // Match runtime.start(): capture the immutable service context before
    // manually exercising the startup and periodic probe schedulers.
    state.capturePrimaryProbeServiceContext();

    // Runtime startup arms its cadence before launching the startup probe.
    state.fallback.scheduleNextPeriodicUsabilityProbe();
    state.fallback.schedulePrimaryModelUsabilityProbe('startup');
    await vi.advanceTimersByTimeAsync(REFRESH_AHEAD_WAIT_MS);

    expect(refreshSpawn).toHaveBeenCalledTimes(1);
    expect(state.primaryModelUsability).toMatchObject({
      reason: 'deferred-refresh-in-flight',
      probeInFlight: false,
    });
    expect(state.periodicUsabilityProbeBackoff).toBe(1);
    // The deferred startup result backs off the already-armed periodic timer.
    expect(state.periodicUsabilityProbeDueAt).toBe(
      START.getTime() + REFRESH_AHEAD_WAIT_MS + 66 * MINUTE,
    );
    expect(emitAlertChecked).not.toHaveBeenCalled();

    // The hard cap does not kill the OAuth child or send a direct alert.
    await vi.advanceTimersByTimeAsync(REFRESH_AHEAD_HARD_CAP_MS - REFRESH_AHEAD_WAIT_MS);
    expect(emitAlertChecked).not.toHaveBeenCalled();

    // Advance the visible, production-derived retry delay; do not invoke the
    // classifier or alert recorder directly.
    await vi.advanceTimersByTimeAsync(57 * MINUTE);

    expect(refreshSpawn).toHaveBeenCalledTimes(1);
    expect(state.primaryModelUsability).toMatchObject({
      reason: 'refresh-failed',
      probeInFlight: false,
    });
    const alert = vi.mocked(emitAlertChecked).mock.calls.find((call) => call[1] === 'primary_model_unusable');
    expect(alert).toBeDefined();
    expect(alert?.[0]).toBe('terminal-integration');
    expect(alert?.[2]).toBe('Primary model usability probe failed');
    expect(String(alert?.[3])).toContain('trigger=periodic');
    expect(String(alert?.[3])).toContain('reason=refresh-failed');
    expect(alert?.[4]).toBe('warning');
  });
});
