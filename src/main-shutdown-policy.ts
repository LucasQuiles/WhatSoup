import type { MarkCleanExitResult } from './runtimes/agent/restart-loop-guard.ts';
import { MessageHandlerDrainTimeoutError } from './runtimes/agent/shutdown-message-handler-drain.ts';

export type ShutdownPhase = 'auxiliaries' | 'runtime' | 'transport' | 'clean_exit';

export type ShutdownFailureCause =
  | 'auxiliaries_phase_failed'
  | 'message_handlers_deadline'
  | 'runtime_phase_failed'
  | 'transport_phase_failed'
  | 'clean_exit_persist_failed';

export interface ShutdownSequenceOutcome {
  /** True only when every phase ran AND the clean-exit mark persisted. */
  readonly complete: boolean;
  /** The FIRST phase that failed (later phases still run). */
  readonly failedPhase: ShutdownPhase | null;
  readonly cause: ShutdownFailureCause | null;
  /** Message handlers still pending when the runtime drain timed out, if that was the cause. */
  readonly blockers: number | null;
}

/** One auxiliary teardown item — isolated so a throwing stop skips nothing. */
export interface NamedAuxiliaryStop {
  readonly name: string;
  stop(): Promise<void> | void;
}

export interface ShutdownSequencePorts {
  /** Timers, pollers, schedulers, the health server — each stop attempted in order, each isolated. */
  auxiliaries: ReadonlyArray<NamedAuxiliaryStop>;
  /** AgentRuntime/ChatRuntime shutdown — flushes queues before the transport closes. */
  shutdownRuntime(): Promise<void>;
  /** Transport (Baileys/Twilio) teardown. MUST run even when the runtime phase failed. */
  shutdownTransport(): Promise<void> | void;
  /** Restart-loop guard clean-exit mark; reports whether the mark PERSISTED. */
  markCleanExit(): MarkCleanExitResult;
  log: {
    info(fields: Record<string, unknown>, msg: string): void;
    error(fields: Record<string, unknown>, msg: string): void;
  };
}

/**
 * Exit code for the process after shutdown. Operator-requested signals exit 0
 * ONLY when the sequence completed; an incomplete shutdown (a phase failed,
 * e.g. message handlers still pending at the drain deadline, or a clean-exit
 * mark that never reached disk) exits nonzero so supervisors and the
 * restart-loop guard never read it as clean.
 */
export function shutdownExitCode(
  signal: string,
  outcome: Pick<ShutdownSequenceOutcome, 'complete'> = { complete: true },
): 0 | 1 {
  if (!outcome.complete) return 1;
  return signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1;
}

function findDrainTimeout(error: unknown): MessageHandlerDrainTimeoutError | null {
  if (error instanceof MessageHandlerDrainTimeoutError) return error;
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const found = findDrainTimeout(inner);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Run the shutdown phases in order, attempting EVERY phase regardless of
 * earlier failures: each auxiliary stop is individually isolated (one throwing
 * stop skips none of the rest), and the transport is still torn down (and the
 * caller's finally block still closes the DB and releases the lock) after a
 * runtime phase failure — which previously escaped the single try block and
 * skipped both the transport teardown and the clean-exit mark while the
 * process still exited 0 on SIGTERM/SIGINT.
 *
 * The clean-exit mark is its own final phase: the completion log follows ONLY
 * a persisted mark, and an unpersisted mark (guard journal unreadable or
 * unwritable) is an incomplete shutdown — the next boot will count as
 * crash-interrupted, so exiting 0 would misreport reality.
 *
 * On an incomplete sequence exactly one structured, content-free receipt is
 * logged ({ event: 'shutdown.incomplete', phase, cause, blockers,
 * transportTeardown, exit: 1 }); per-phase errors are logged where they occur.
 */
export async function runShutdownSequence(ports: ShutdownSequencePorts): Promise<ShutdownSequenceOutcome> {
  let failedPhase: ShutdownPhase | null = null;
  let cause: ShutdownFailureCause | null = null;
  let blockers: number | null = null;
  const fail = (phase: ShutdownPhase, phaseCause: ShutdownFailureCause): void => {
    if (failedPhase !== null) return;
    failedPhase = phase;
    cause = phaseCause;
  };

  for (const auxiliary of ports.auxiliaries) {
    try {
      await auxiliary.stop();
    } catch (err) {
      ports.log.error({ err, phase: 'auxiliaries', auxiliary: auxiliary.name }, 'error during shutdown');
      fail('auxiliaries', 'auxiliaries_phase_failed');
    }
  }

  try {
    await ports.shutdownRuntime();
  } catch (err) {
    ports.log.error({ err, phase: 'runtime' }, 'error during shutdown');
    const drainTimeout = findDrainTimeout(err);
    if (drainTimeout !== null && failedPhase === null) blockers = drainTimeout.blockers;
    fail('runtime', drainTimeout !== null ? 'message_handlers_deadline' : 'runtime_phase_failed');
  }

  let transportTeardown: 'continued' | 'failed' = 'continued';
  try {
    await ports.shutdownTransport();
  } catch (err) {
    transportTeardown = 'failed';
    ports.log.error({ err, phase: 'transport' }, 'error during shutdown');
    fail('transport', 'transport_phase_failed');
  }

  if (failedPhase === null) {
    const mark = ports.markCleanExit();
    if (mark.persisted) {
      // Completion is declared ONLY once the clean-exit mark is durable.
      ports.log.info({}, 'shutdown complete');
      return { complete: true, failedPhase: null, cause: null, blockers: null };
    }
    ports.log.error({ phase: 'clean_exit', reason: mark.reason }, 'error during shutdown');
    fail('clean_exit', 'clean_exit_persist_failed');
  }

  ports.log.error(
    { event: 'shutdown.incomplete', phase: failedPhase, cause, blockers, transportTeardown, exit: 1 },
    'shutdown incomplete',
  );
  return { complete: false, failedPhase, cause, blockers };
}
