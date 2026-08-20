/**
 * AgentRuntime.shutdown() must not hang on a message handler that never
 * settles (#3315, first slice of E20). The drain is raced against the same
 * absolute shutdown deadline the turn coordinator uses; on timeout exactly one
 * structured, content-free receipt is logged
 * ({ phase: 'message_handlers', blockers, timedOut: true }) and shutdown moves
 * on to the next phase instead of waiting for main.ts's hard kill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

import { Database } from '../../../src/core/database.ts';
import { createChildLogger } from '../../../src/logger.ts';
import { RUNTIME_TURN_SHUTDOWN_FINALIZATION_TIMEOUT_MS } from '../../../src/runtimes/agent/runtime-turn-coordinator.ts';
import { MessageHandlerDrainTimeoutError } from '../../../src/runtimes/agent/shutdown-message-handler-drain.ts';
import { makeRuntimeState, type RuntimeState } from './lib/runtime-terminal-coordinator-harness.ts';

const runtimeLogger = createChildLogger('test') as unknown as Record<'info' | 'warn' | 'error' | 'debug', ReturnType<typeof vi.fn>>;

type DrainState = RuntimeState & {
  activeMessageHandlers: Set<Promise<void>>;
};

const SLACK_MS = 250;

function settledFlag(promise: Promise<unknown>): { readonly settled: boolean } {
  const flag = { settled: false };
  void promise.then(() => { flag.settled = true; }, () => { flag.settled = true; });
  return flag;
}

function messageHandlerReceipts(): unknown[] {
  return runtimeLogger.warn.mock.calls
    .map((call) => call[0] as Record<string, unknown> | undefined)
    .filter((fields) => fields !== undefined && fields.phase === 'message_handlers');
}

describe('AgentRuntime.shutdown — bounded message-handler drain', () => {
  let db: Database;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-08-20T12:00:00.000Z') });
    for (const mock of Object.values(runtimeLogger)) mock.mockClear();
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('one never-resolving handler: shutdown settles within the deadline budget and logs ONE blockers=1 receipt', async () => {
    const { runtime, state } = makeRuntimeState<DrainState>(db);
    state.activeMessageHandlers.add(new Promise<void>(() => {}));

    const shutdown = runtime.shutdown().then(() => null, (error: unknown) => error);
    const flag = settledFlag(shutdown);

    await vi.advanceTimersByTimeAsync(RUNTIME_TURN_SHUTDOWN_FINALIZATION_TIMEOUT_MS + SLACK_MS);
    expect(flag.settled).toBe(true);

    // The rejection main.ts sees is typed so the exit policy can name the cause.
    const rejection = await shutdown;
    expect(rejection).toBeInstanceOf(MessageHandlerDrainTimeoutError);
    expect((rejection as MessageHandlerDrainTimeoutError).blockers).toBe(1);

    const receipts = messageHandlerReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toEqual({ phase: 'message_handlers', blockers: 1, timedOut: true });
    // Content-free: the receipt must never carry message bodies or JIDs.
    expect(JSON.stringify(receipts[0])).not.toMatch(/@s\.whatsapp\.net|@g\.us|@lid/);
  });

  it('control: every handler settled -> no message_handlers timeout receipt', async () => {
    const { runtime, state } = makeRuntimeState<DrainState>(db);
    state.activeMessageHandlers.add(Promise.resolve());

    const shutdown = runtime.shutdown().then(() => null, (error: unknown) => error);
    const flag = settledFlag(shutdown);

    await vi.advanceTimersByTimeAsync(RUNTIME_TURN_SHUTDOWN_FINALIZATION_TIMEOUT_MS + SLACK_MS);
    expect(flag.settled).toBe(true);
    expect(messageHandlerReceipts()).toEqual([]);
  });
});
