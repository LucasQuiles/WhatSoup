// src/runtimes/agent/providers/probe-lifecycle-log.ts
//
// One info line when a non-turn CLI child spawns and one when it exits, so a
// child killed mid-refresh can be lined up against a credential change: the
// claude CLI serializes token refresh per config dir, and a child killed
// between the server's token rotation and the local save loses the rotated
// token. Callers pass only content-free fields (purpose, trigger, provider,
// keychain item name); the lines never carry a directory, any other
// environment value, or the child's output.

import { systemClock } from '../../../lib/clock.ts';
import type { BinaryCommandProbeExit, BinaryCommandProbeOptions } from './binary-preflight.ts';

/** Sink for the lifecycle lines (a pino logger in production). */
export interface ProbeLifecycleLog {
  info: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ProbeLifecycleEvents {
  spawnEvent: string;
  spawnMessage: string;
  exitEvent: string;
  exitMessage: string;
}

/** The shared event names of every non-turn `claude` child except the primary-model probe. */
export const CLAUDE_PROBE_EVENTS: ProbeLifecycleEvents = {
  spawnEvent: 'claude_probe_spawn',
  spawnMessage: 'claude probe child spawned',
  exitEvent: 'claude_probe_exit',
  exitMessage: 'claude probe child exited',
};

/** An abort reason that marks a deadline (AbortSignal.timeout and the usability deadline use TimeoutError). */
function isTimeoutReason(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && (reason as { name?: unknown }).name === 'TimeoutError';
}

/**
 * The onSpawned/onExited observers of {@link BinaryCommandProbeOptions} that
 * write the two lifecycle lines. `signal` is the abort signal handed to the
 * probe, used only to tell a deadline from a caller's cancellation.
 */
export function probeLifecycleObservers(
  log: ProbeLifecycleLog,
  events: ProbeLifecycleEvents,
  base: Record<string, unknown>,
  signal?: AbortSignal,
): Required<Pick<BinaryCommandProbeOptions, 'onSpawned' | 'onExited'>> {
  let startedAtMs: number | null = null;
  let startedMonotonicMs: number | null = null;
  return {
    onSpawned: (pid) => {
      startedAtMs = systemClock.now();
      startedMonotonicMs = performance.now();
      log.info(
        { event: events.spawnEvent, ...base, pid: pid ?? null, startedAt: new Date(startedAtMs).toISOString() },
        events.spawnMessage,
      );
    },
    onExited: (exit: BinaryCommandProbeExit) => {
      const endedAtMs = systemClock.now();
      const endedMonotonicMs = performance.now();
      const start = startedAtMs ?? endedAtMs;
      const termination = exit.killedByTimeout
        ? 'cli-timeout'
        : exit.killedByAbort
          ? (isTimeoutReason(signal?.reason) ? 'deadline' : 'caller-abort')
          : null;
      log.info(
        {
          event: events.exitEvent,
          ...base,
          pid: exit.pid ?? null,
          startedAt: new Date(start).toISOString(),
          endedAt: new Date(endedAtMs).toISOString(),
          durationMs: endedMonotonicMs - (startedMonotonicMs ?? endedMonotonicMs),
          exitCode: exit.exitCode,
          signal: exit.signal,
          killedByProbeTimeout: termination === 'cli-timeout' || termination === 'deadline',
          termination,
          spawnFailed: exit.spawnFailed,
          ...(exit.outputLimitExceeded ? { outputLimitExceeded: true } : {}),
        },
        events.exitMessage,
      );
    },
  };
}
