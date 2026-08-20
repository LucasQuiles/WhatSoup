/**
 * An incomplete shutdown must neither skip teardown nor exit 0.
 *
 * main.ts awaited runtime.shutdown() BEFORE connectionManager.shutdown() and
 * markCleanExit() inside one try block: a runtime-phase rejection (for
 * instance the bounded message-handler drain timing out) skipped transport
 * teardown and the clean-exit mark, the catch only logged, and
 * process.exit(shutdownExitCode('SIGTERM')) still returned 0.
 *
 * The orchestration is extracted into runShutdownSequence so the seam is
 * testable without booting main.ts: every phase is attempted, the outcome
 * says whether the sequence completed, the exit code goes nonzero when it did
 * not, and one typed content-free receipt names the cause.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  runShutdownSequence,
  shutdownExitCode,
  type ShutdownSequenceOutcome,
} from '../src/main-shutdown-policy.ts';
import { MessageHandlerDrainTimeoutError } from '../src/runtimes/agent/shutdown-message-handler-drain.ts';

function ports(overrides: Partial<Parameters<typeof runShutdownSequence>[0]> = {}) {
  const log = { info: vi.fn(), error: vi.fn() };
  return {
    log,
    ports: {
      stopAuxiliaries: vi.fn(async () => {}),
      shutdownRuntime: vi.fn(async () => {}),
      shutdownTransport: vi.fn(() => {}),
      markCleanExit: vi.fn(() => {}),
      log,
      ...overrides,
    },
  };
}

function incompleteReceipts(log: { error: ReturnType<typeof vi.fn> }): unknown[] {
  return log.error.mock.calls
    .map((call) => call[0] as Record<string, unknown> | undefined)
    .filter((fields) => fields !== undefined && fields.event === 'shutdown.incomplete');
}

describe('runShutdownSequence', () => {
  it('runtime phase rejects with the drain deadline: transport still torn down, no clean-exit mark, nonzero exit, one receipt', async () => {
    const { ports: p, log } = ports({
      shutdownRuntime: vi.fn(async () => { throw new MessageHandlerDrainTimeoutError(1); }),
    });
    const outcome = await runShutdownSequence(p);

    expect(p.shutdownTransport).toHaveBeenCalledTimes(1);
    expect(p.markCleanExit).not.toHaveBeenCalled();
    expect(outcome).toEqual<ShutdownSequenceOutcome>({
      complete: false,
      failedPhase: 'runtime',
      cause: 'message_handlers_deadline',
      blockers: 1,
    });
    expect(shutdownExitCode('SIGTERM', outcome)).toBe(1);
    expect(shutdownExitCode('SIGINT', outcome)).toBe(1);

    const receipts = incompleteReceipts(log);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual({
      event: 'shutdown.incomplete',
      phase: 'runtime',
      cause: 'message_handlers_deadline',
      blockers: 1,
      transportTeardown: 'continued',
      exit: 1,
    });
  });

  it('classifies the drain deadline inside an AggregateError of runtime failures', async () => {
    const { ports: p } = ports({
      shutdownRuntime: vi.fn(async () => {
        throw new AggregateError([new Error('other'), new MessageHandlerDrainTimeoutError(3)], 'shutdown failures');
      }),
    });
    const outcome = await runShutdownSequence(p);
    expect(outcome.cause).toBe('message_handlers_deadline');
    expect(outcome.blockers).toBe(3);
    expect(p.shutdownTransport).toHaveBeenCalledTimes(1);
  });

  it('a generic runtime failure is still incomplete and nonzero, with a generic cause and no blockers count', async () => {
    const { ports: p, log } = ports({
      shutdownRuntime: vi.fn(async () => { throw new Error('something else'); }),
    });
    const outcome = await runShutdownSequence(p);
    expect(outcome).toEqual<ShutdownSequenceOutcome>({
      complete: false,
      failedPhase: 'runtime',
      cause: 'runtime_phase_failed',
      blockers: null,
    });
    expect(shutdownExitCode('SIGTERM', outcome)).toBe(1);
    expect(p.markCleanExit).not.toHaveBeenCalled();
    // content-free: the receipt never carries the error text
    expect(JSON.stringify(incompleteReceipts(log)[0])).not.toContain('something else');
  });

  it('CONTROL: every phase succeeds -> clean-exit marked, complete, operator signals exit 0, no receipt', async () => {
    const { ports: p, log } = ports();
    const outcome = await runShutdownSequence(p);
    expect(p.stopAuxiliaries).toHaveBeenCalledTimes(1);
    expect(p.shutdownRuntime).toHaveBeenCalledTimes(1);
    expect(p.shutdownTransport).toHaveBeenCalledTimes(1);
    expect(p.markCleanExit).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual<ShutdownSequenceOutcome>({ complete: true, failedPhase: null, cause: null, blockers: null });
    expect(shutdownExitCode('SIGTERM', outcome)).toBe(0);
    expect(shutdownExitCode('SIGINT', outcome)).toBe(0);
    expect(shutdownExitCode('uncaughtException', outcome)).toBe(1);
    expect(incompleteReceipts(log)).toEqual([]);
  });

  it('transport teardown throws after a healthy runtime phase: no clean-exit mark, nonzero exit', async () => {
    const { ports: p, log } = ports({
      shutdownTransport: vi.fn(() => { throw new Error('socket already closed'); }),
    });
    const outcome = await runShutdownSequence(p);
    expect(p.markCleanExit).not.toHaveBeenCalled();
    expect(outcome.complete).toBe(false);
    expect(outcome.failedPhase).toBe('transport');
    expect(outcome.cause).toBe('transport_phase_failed');
    expect(shutdownExitCode('SIGTERM', outcome)).toBe(1);
    expect(incompleteReceipts(log)[0]).toMatchObject({ phase: 'transport', transportTeardown: 'failed', exit: 1 });
  });

  it('an auxiliary stop throwing does not skip the runtime or transport phases', async () => {
    const { ports: p } = ports({
      stopAuxiliaries: vi.fn(async () => { throw new Error('scheduler stop failed'); }),
    });
    const outcome = await runShutdownSequence(p);
    expect(p.shutdownRuntime).toHaveBeenCalledTimes(1);
    expect(p.shutdownTransport).toHaveBeenCalledTimes(1);
    expect(p.markCleanExit).not.toHaveBeenCalled();
    expect(outcome.failedPhase).toBe('auxiliaries');
    expect(shutdownExitCode('SIGTERM', outcome)).toBe(1);
  });

  it('the single-argument exit policy is unchanged for callers without an outcome', () => {
    expect(shutdownExitCode('SIGTERM')).toBe(0);
    expect(shutdownExitCode('startupError')).toBe(1);
  });

  it('main.ts drives its shutdown through the sequence and exits on the outcome', () => {
    const source = readFileSync('src/main.ts', 'utf8');
    expect(source).toContain('runShutdownSequence(');
    expect(source).toContain('process.exit(shutdownExitCode(signal, outcome));');
    expect(source).not.toContain('process.exit(shutdownExitCode(signal));');
  });
});
