import { MessageHandlerDrainTimeoutError } from './runtimes/agent/shutdown-message-handler-drain.ts';

export type ShutdownPhase = 'auxiliaries' | 'runtime' | 'transport';

export type ShutdownFailureCause =
  | 'auxiliaries_phase_failed'
  | 'message_handlers_deadline'
  | 'runtime_phase_failed'
  | 'transport_phase_failed';

export interface ShutdownSequenceOutcome {
  /** True only when every phase ran without failure; the clean-exit mark requires it. */
  readonly complete: boolean;
  /** The FIRST phase that failed (later phases still run). */
  readonly failedPhase: ShutdownPhase | null;
  readonly cause: ShutdownFailureCause | null;
  /** Message handlers still pending when the runtime drain timed out, if that was the cause. */
  readonly blockers: number | null;
}

export interface ShutdownSequencePorts {
  /** Stop timers, pollers, schedulers, and the health server. */
  stopAuxiliaries(): Promise<void> | void;
  /** AgentRuntime/ChatRuntime shutdown — flushes queues before the transport closes. */
  shutdownRuntime(): Promise<void>;
  /** Transport (Baileys/Twilio) teardown. MUST run even when the runtime phase failed. */
  shutdownTransport(): Promise<void> | void;
  /** Restart-loop guard clean-exit mark. Only when the whole sequence completed. */
  markCleanExit(): void;
  log: {
    info(fields: Record<string, unknown>, msg: string): void;
    error(fields: Record<string, unknown>, msg: string): void;
  };
}

/**
 * Exit code for the process after shutdown. Operator-requested signals exit 0
 * ONLY when the sequence completed; an incomplete shutdown (a phase failed,
 * e.g. message handlers still pending at the drain deadline) exits nonzero so
 * supervisors and the restart-loop guard never read it as clean.
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
 * earlier failures: the transport must still be torn down (and the caller's
 * finally block still closes the DB and releases the lock) after a runtime
 * phase failure, which previously escaped the single try block and skipped
 * both the transport teardown and the clean-exit mark while the process still
 * exited 0 on SIGTERM/SIGINT.
 *
 * On an incomplete sequence exactly one structured, content-free receipt is
 * logged ({ event: 'shutdown.incomplete', phase, cause, blockers,
 * transportTeardown, exit: 1 }); per-phase errors are logged where they occur.
 */
export async function runShutdownSequence(ports: ShutdownSequencePorts): Promise<ShutdownSequenceOutcome> {
  let failedPhase: ShutdownPhase | null = null;
  let cause: ShutdownFailureCause | null = null;
  let blockers: number | null = null;
  const fail = (phase: ShutdownPhase, phaseCause: ShutdownFailureCause, err: unknown): void => {
    ports.log.error({ err, phase }, 'error during shutdown');
    if (failedPhase !== null) return;
    failedPhase = phase;
    cause = phaseCause;
  };

  try {
    await ports.stopAuxiliaries();
  } catch (err) {
    fail('auxiliaries', 'auxiliaries_phase_failed', err);
  }

  try {
    await ports.shutdownRuntime();
  } catch (err) {
    const drainTimeout = findDrainTimeout(err);
    if (drainTimeout !== null && failedPhase === null) blockers = drainTimeout.blockers;
    fail('runtime', drainTimeout !== null ? 'message_handlers_deadline' : 'runtime_phase_failed', err);
  }

  let transportTeardown: 'continued' | 'failed' = 'continued';
  try {
    await ports.shutdownTransport();
  } catch (err) {
    transportTeardown = 'failed';
    fail('transport', 'transport_phase_failed', err);
  }

  if (failedPhase === null) {
    ports.log.info({}, 'shutdown complete');
    ports.markCleanExit();
    return { complete: true, failedPhase: null, cause: null, blockers: null };
  }

  ports.log.error(
    { event: 'shutdown.incomplete', phase: failedPhase, cause, blockers, transportTeardown, exit: 1 },
    'shutdown incomplete',
  );
  return { complete: false, failedPhase, cause, blockers };
}
