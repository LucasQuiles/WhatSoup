/**
 * An incomplete shutdown must neither skip teardown nor exit 0.
 *
 * main.ts awaited runtime.shutdown() BEFORE connectionManager.shutdown() and
 * markCleanExit() inside one try block: a runtime-phase rejection (for
 * instance the bounded message-handler drain timing out) skipped transport
 * teardown and the clean-exit mark, the catch only logged, and
 * process.exit(shutdownExitCode('SIGTERM')) still returned 0.
 *
 * Round 3 hardening on the same seam:
 *  - auxiliaries are a list of NAMED stops, each isolated — one throwing stop
 *    no longer skips the rest;
 *  - markCleanExit reports whether the clean-exit mark actually PERSISTED
 *    (the restart-loop guard fails open on fs errors); an unpersisted mark is
 *    an incomplete shutdown (cause clean_exit_persist_failed, exit nonzero)
 *    and the completion log only follows persistence success.
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
      auxiliaries: [{ name: 'health-server', stop: vi.fn(() => {}) }],
      shutdownRuntime: vi.fn(async () => {}),
      shutdownTransport: vi.fn(() => {}),
      markCleanExit: vi.fn(() => ({ persisted: true as const })),
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

function completionLogs(log: { info: ReturnType<typeof vi.fn> }): number[] {
  return log.info.mock.calls
    .map((call, index) => (call[1] === 'shutdown complete' ? index : -1))
    .filter((index) => index >= 0);
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
    expect(completionLogs(log)).toHaveLength(0);
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

  it('CONTROL: every phase succeeds -> clean-exit persisted, THEN completion logged, exit 0 for operator signals', async () => {
    const { ports: p, log } = ports();
    const outcome = await runShutdownSequence(p);
    expect(p.auxiliaries[0]!.stop).toHaveBeenCalledTimes(1);
    expect(p.shutdownRuntime).toHaveBeenCalledTimes(1);
    expect(p.shutdownTransport).toHaveBeenCalledTimes(1);
    expect(p.markCleanExit).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual<ShutdownSequenceOutcome>({ complete: true, failedPhase: null, cause: null, blockers: null });
    expect(shutdownExitCode('SIGTERM', outcome)).toBe(0);
    expect(shutdownExitCode('SIGINT', outcome)).toBe(0);
    expect(shutdownExitCode('uncaughtException', outcome)).toBe(1);
    expect(incompleteReceipts(log)).toEqual([]);
    // completion is logged ONLY after the clean-exit mark persisted
    expect(completionLogs(log)).toHaveLength(1);
    const markOrder = vi.mocked(p.markCleanExit).mock.invocationCallOrder[0]!;
    const completionOrder = log.info.mock.invocationCallOrder[completionLogs(log)[0]!]!;
    expect(markOrder).toBeLessThan(completionOrder);
  });

  it('an unpersisted clean-exit mark is an INCOMPLETE shutdown: typed cause, exit nonzero, no completion log', async () => {
    const { ports: p, log } = ports({
      markCleanExit: vi.fn(() => ({ persisted: false as const, reason: 'write_failed' as const })),
    });
    const outcome = await runShutdownSequence(p);
    expect(outcome).toEqual<ShutdownSequenceOutcome>({
      complete: false,
      failedPhase: 'clean_exit',
      cause: 'clean_exit_persist_failed',
      blockers: null,
    });
    expect(shutdownExitCode('SIGTERM', outcome)).toBe(1);
    expect(completionLogs(log)).toHaveLength(0);
    expect(incompleteReceipts(log)[0]).toEqual({
      event: 'shutdown.incomplete',
      phase: 'clean_exit',
      cause: 'clean_exit_persist_failed',
      blockers: null,
      transportTeardown: 'continued',
      exit: 1,
    });
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

  it('AUX ISOLATION: one throwing auxiliary skips nothing — every later stop still runs, phase marked failed, sequence continues', async () => {
    const stops = {
      first: vi.fn(() => {}),
      second: vi.fn(() => { throw new Error('scheduler stop failed'); }),
      third: vi.fn(() => {}),
      fourth: vi.fn(async () => {}),
    };
    const { ports: p, log } = ports({
      auxiliaries: [
        { name: 'first', stop: stops.first },
        { name: 'second', stop: stops.second },
        { name: 'third', stop: stops.third },
        { name: 'fourth', stop: stops.fourth },
      ],
    });
    const outcome = await runShutdownSequence(p);
    expect(stops.first).toHaveBeenCalledTimes(1);
    expect(stops.second).toHaveBeenCalledTimes(1);
    expect(stops.third).toHaveBeenCalledTimes(1);
    expect(stops.fourth).toHaveBeenCalledTimes(1);
    expect(p.shutdownRuntime).toHaveBeenCalledTimes(1);
    expect(p.shutdownTransport).toHaveBeenCalledTimes(1);
    expect(p.markCleanExit).not.toHaveBeenCalled();
    expect(outcome.failedPhase).toBe('auxiliaries');
    expect(outcome.cause).toBe('auxiliaries_phase_failed');
    expect(shutdownExitCode('SIGTERM', outcome)).toBe(1);
    // the per-item failure names the auxiliary, content-free, exactly once
    const named = log.error.mock.calls.filter((call) =>
      (call[0] as Record<string, unknown> | undefined)?.auxiliary === 'second');
    expect(named.map((call) => ({ fields: call[0], msg: call[1] }))).toEqual([
      {
        fields: expect.objectContaining({ phase: 'auxiliaries', auxiliary: 'second', err: expect.any(Error) }),
        msg: 'error during shutdown',
      },
    ]);
  });

  it('the single-argument exit policy is unchanged for callers without an outcome', () => {
    expect(shutdownExitCode('SIGTERM')).toBe(0);
    expect(shutdownExitCode('startupError')).toBe(1);
  });

  it('main.ts drives its shutdown through the sequence with named auxiliaries and exits on the outcome', () => {
    const source = readFileSync('src/main.ts', 'utf8');
    expect(source).toContain('runShutdownSequence(');
    expect(source).toContain('auxiliaries: [');
    expect(source).toContain('process.exit(shutdownExitCode(signal, outcome));');
    expect(source).not.toContain('process.exit(shutdownExitCode(signal));');
  });
});
