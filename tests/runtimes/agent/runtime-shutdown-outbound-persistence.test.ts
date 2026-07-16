import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';
import {
  OutboundQueue,
  type IOutboundQueue,
} from '../../../src/runtimes/agent/outbound-queue.ts';
import type { RuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import {
  type RuntimeState,
  context,
  makeRuntimeState,
  replyGuaranteeMock,
  sessionStub,
} from './lib/runtime-terminal-coordinator-harness.ts';

const emitAlert = vi.hoisted(() => vi.fn(() => ({
  ok: true,
  channel: 'outbox',
  status: 'durably_queued',
})));
const runtimeLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../src/logger.ts', () => ({
  default: { ...runtimeLogger, child: () => runtimeLogger },
  createChildLogger: () => runtimeLogger,
  flushLogger: () => Promise.resolve(),
}));

vi.mock('../../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/emit-alert.ts')>(),
  emitAlert,
  emitAlertChecked: emitAlert,
}));

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type ShutdownState = RuntimeState & {
  queue: IOutboundQueue | null;
  session: ReturnType<typeof sessionStub> | null;
  runtimeTurnCoordinator: {
    finalizeActiveRuntimeTurnsForShutdown(deadlineAt?: number): Promise<void>;
  };
};

describe('runtime shutdown outbound persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-07-16T02:00:00.000Z') });
    emitAlert.mockClear();
    for (const mock of Object.values(runtimeLogger)) mock.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('persists a recovery-owned terminal before one absolute deadline when the outbound send never settles', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const logicalTurnId = 'turn-shutdown-hanging-send';
      const conversationKey = '15550190152';
      const deliveryJid = `${conversationKey}@s.whatsapp.net`;
      const inboundSeq = durability.journalInbound(
        `wamid-${logicalTurnId}`,
        conversationKey,
        deliveryJid,
        'agent',
      );
      const runtimeContext: RuntimeTurnContext = context(
        'singleton',
        conversationKey,
        inboundSeq,
        logicalTurnId,
      );
      const lateReceipt = deferred<{ waMessageId: string | null }>();
      const messenger: Messenger = {
        sendMessage: vi.fn(() => lateReceipt.promise),
        sendMedia: vi.fn(async () => ({ waMessageId: null })),
      };
      const queue = new OutboundQueue(messenger, deliveryJid, { conversationKey });
      queue.setDurability(durability);
      queue.setInboundSeq(inboundSeq);
      queue.beginTurnEvidence(logicalTurnId);

      const { runtime, state } = makeRuntimeState<ShutdownState>(db);
      runtime.setDurability(durability);
      state.replyGuarantee = replyGuaranteeMock();
      state.queue = queue;
      state.session = sessionStub();
      state.currentRuntimeTurnContext = runtimeContext;
      state.currentInboundSeq = inboundSeq;
      state.currentTurnChatJid = deliveryJid;

      queue.enqueueText('answer whose socket send never settles');
      await vi.advanceTimersByTimeAsync(0);
      expect(messenger.sendMessage).toHaveBeenCalledTimes(1);
      expect(db.raw.prepare('SELECT COUNT(*) AS count FROM turn_terminal_records').get())
        .toEqual({ count: 0 });

      const deadlineAt = Date.now() + 1_000;
      const shutdownOutcome = state.runtimeTurnCoordinator
        .finalizeActiveRuntimeTurnsForShutdown(deadlineAt)
        .then(() => null, (error: unknown) => error);
      let shutdownSettled = false;
      void shutdownOutcome.then(() => { shutdownSettled = true; });

      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(shutdownSettled).toBe(true);
      expect(await shutdownOutcome).toBeInstanceOf(AggregateError);

      const outbound = db.raw.prepare(`
        SELECT status, wa_message_id, is_terminal
        FROM outbound_ops
        WHERE source_inbound_seq = ?
      `).get(inboundSeq) as {
        status: string;
        wa_message_id: string | null;
        is_terminal: number;
      };
      const terminal = db.raw.prepare(`
        SELECT inbound_disposition, delivery_kind, recovery_owner_logical_turn_id
        FROM turn_terminal_records
        WHERE inbound_seq = ?
      `).get(inboundSeq);
      const recovery = db.raw.prepare(`
        SELECT source_inbound_seq, owner_logical_turn_id, state
        FROM turn_recovery_jobs
        WHERE source_inbound_seq = ?
      `).get(inboundSeq);

      expect(outbound).toEqual({
        status: 'maybe_sent',
        wa_message_id: expect.any(String),
        is_terminal: 1,
      });
      expect(terminal).toEqual({
        inbound_disposition: 'transferred_to_recovery_owner',
        delivery_kind: 'delivery_unknown',
        recovery_owner_logical_turn_id: `${logicalTurnId}:recovery`,
      });
      expect(recovery).toEqual({
        source_inbound_seq: inboundSeq,
        owner_logical_turn_id: `${logicalTurnId}:recovery`,
        state: 'pending',
      });

      const stableMessageId = outbound.wa_message_id;
      lateReceipt.resolve({ waMessageId: 'late-overwrite-must-not-win' });
      await Promise.resolve();
      await Promise.resolve();
      expect(db.raw.prepare(`
        SELECT status, wa_message_id FROM outbound_ops WHERE source_inbound_seq = ?
      `).get(inboundSeq)).toEqual({
        status: 'maybe_sent',
        wa_message_id: stableMessageId,
      });
      expect(messenger.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});
