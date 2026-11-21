// #3829: restart_self sends the turn's held answer before it asks the service
// manager for the restart, and the restart then runs the graceful shutdown. The
// shutdown finalizes the still-active turn as a crash
// (finalizeActiveRuntimeTurnsForShutdown in runtime-turn-coordinator.ts). That
// must end the turn failed_terminal with no recovery job, whether the held answer
// is only submitted or already echoed: outside per_chat scope, a recovery job
// blocks every new turn of the scope after the restart. The queue, the durability
// store and the shutdown finalization are real; the restart trigger is a double.
//
//   submitted - expected-red while restart_self records the held answer as the
//               turn's answer evidence: the crash then transfers the inbound to a
//               recovery owner.
//   echoed    - guard: the crash rule already discards an echoed answer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import { OutboundQueue, type IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import {
  buildRestartSelfTool,
  deliverOwedReplyBeforeRestart,
  type TriggerSelfRestartOptions,
} from '../../../src/runtimes/agent/self-restart.ts';
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
  emitAlert,
  emitAlertChecked: emitAlert,
}));

const OWED = 'On it, restarting.';
const SESSION: SessionContext = { tier: 'global' };
/** Covers MIN_SEND_GAP_MS pacing and flush spins; well under the 10 s grace. */
const SETTLE_MS = 1_000;

type ShutdownState = RuntimeState & {
  queue: IOutboundQueue | null;
  session: ReturnType<typeof sessionStub> | null;
  runtimeTurnCoordinator: {
    finalizeActiveRuntimeTurnsForShutdown(deadlineAt?: number): Promise<void>;
  };
};

/** The owed send's state when the shutdown reads it; the echo is recorded the way matchEcho records it. */
const OWED_SEND_STATES = [
  { owedSend: 'submitted', afterSubmission: (_durability: DurabilityEngine, _opId: number): void => {} },
  { owedSend: 'echoed', afterSubmission: (durability: DurabilityEngine, opId: number): void => durability.markEchoed(opId) },
] as const;

describe('restart_self, then the shutdown finalization of the restarted turn (#3829)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-07-16T02:00:00.000Z') });
    emitAlert.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  for (const { owedSend, afterSubmission } of OWED_SEND_STATES) {
    it(`ends the turn failed_terminal with no recovery job when the owed answer is ${owedSend}`, async () => {
      const db = new Database(':memory:');
      db.open();
      try {
        const durability = new DurabilityEngine(db);
        const logicalTurnId = `turn-restart-${owedSend}`;
        const conversationKey = '15550190152';
        const deliveryJid = `${conversationKey}@s.whatsapp.net`;
        const inboundSeq = durability.journalInbound(
          `wamid-${logicalTurnId}`,
          conversationKey,
          deliveryJid,
          'agent',
        );
        const sent: Array<{ jid: string; text: string }> = [];
        const messenger: Messenger = {
          sendMessage: vi.fn(async (jid: string, text: string) => {
            sent.push({ jid, text });
            return { waMessageId: `wa-owed-${owedSend}` };
          }),
          sendMedia: vi.fn(async () => ({ waMessageId: null })),
          setTyping: vi.fn(async () => {}),
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
        state.currentRuntimeTurnContext = context('singleton', conversationKey, inboundSeq, logicalTurnId);
        state.currentInboundSeq = inboundSeq;
        state.currentTurnChatJid = deliveryJid;

        // The turn's streamed answer, which turn evidence holds until the turn ends.
        queue.enqueueStreamingText(OWED, 'answer');
        const trigger = vi.fn(async (_opts: TriggerSelfRestartOptions) => ({ ok: true, markerPath: '/data/bot-a/m' }));
        const tool = buildRestartSelfTool({
          instanceName: 'bot-a',
          dataRoot: '/data/bot-a',
          resolveChatJid: () => queue.targetChatJid,
          deliverOwedReply: () => deliverOwedReplyBeforeRestart(queue),
          sendAck: vi.fn(async (_chatJid: string, _text: string) => {}),
          serviceManager: { restartSelf: vi.fn(async () => {}) },
          trigger,
          assertAdmin: () => {},
        });
        const restart = tool.handler({ reason: 'load merged main' }, SESSION);
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(await restart).toMatchObject({ ok: true, restarting: true });
        expect(trigger).toHaveBeenCalledTimes(1);
        expect(sent).toEqual([{ jid: deliveryJid, text: OWED }]);

        const owedOp = (): { id: number; status: string } => db.raw.prepare(`
          SELECT id, status FROM outbound_ops WHERE source_inbound_seq = ?
        `).get(inboundSeq) as { id: number; status: string };
        afterSubmission(durability, owedOp().id);
        expect(owedOp().status).toBe(owedSend);

        // runtime.shutdown() runs this before the transport closes. Its outcome is
        // not asserted: this harness does not prove every post-effect, and the
        // durable rows below are the contract.
        const shutdown = state.runtimeTurnCoordinator
          .finalizeActiveRuntimeTurnsForShutdown(Date.now() + 30_000)
          .then(() => null, (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        await shutdown;

        expect(db.raw.prepare(`
          SELECT inbound_disposition, delivery_kind FROM turn_terminal_records WHERE inbound_seq = ?
        `).get(inboundSeq)).toEqual({ inbound_disposition: 'failed_terminal', delivery_kind: 'none' });
        expect(db.raw.prepare(`
          SELECT COUNT(*) AS count FROM turn_recovery_jobs WHERE source_inbound_seq = ?
        `).get(inboundSeq)).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    });
  }
});
