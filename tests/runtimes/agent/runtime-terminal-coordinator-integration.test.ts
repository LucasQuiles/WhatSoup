import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import {
  markRuntimeTurnReplayUnsafe,
  type RuntimeTurnContext,
} from '../../../src/runtimes/agent/runtime-turn-context.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { QueuedTurn } from '../../../src/runtimes/agent/turn-queue.ts';
import {
  ensureStandbyNoticeSchema,
  peekStandbyNotice,
} from '../../../src/runtimes/agent/standby-notice.ts';
import { GLOBAL_CONVERSATION_KEY, toConversationKey } from '../../../src/core/conversation-key.ts';
import {
  type RuntimeState,
  context,
  durabilityMock,
  makeRuntimeState,
  queueStub,
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


beforeEach(() => {
  emitAlert.mockClear();
  for (const mock of Object.values(runtimeLogger)) mock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runtime terminal coordinator integration', () => {
  const fallbackActivation = () => ({
    primaryProvider: 'claude-cli',
    fallbackProvider: 'codex-cli',
    fallbackModel: undefined,
    reason: 'usage-limit' as const,
    resetAt: null,
    activeUntil: Date.now() + 60_000,
    extended: false,
    keyPresent: true,
    recoveryProbeRequired: true,
  });

  it('blocks turn evidence only for a per-chat scope with outstanding durable recovery', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const durability = durabilityMock();
      durability.hasOutstandingTurnRecoveryForScope.mockImplementation(
        (scope, conversationKey) => scope === 'per_chat' && conversationKey === 'blocked-chat',
      );
      state.durability = durability;
      const blocked = context('per_chat', 'blocked-chat', 47, 'turn-blocked-recovery');
      const allowed = context('per_chat', 'other-chat', 48, 'turn-other-chat');
      const queue = queueStub(blocked.identity.deliveryJid);

      expect(() => state.runtimeTurnCoordinator.beginRuntimeTurnEvidence(queue, blocked))
        .toThrow(/durable recovery/i);
      expect(queue.beginTurnEvidence).not.toHaveBeenCalled();

      state.runtimeTurnCoordinator.beginRuntimeTurnEvidence(queue, allowed);
      expect(queue.beginTurnEvidence).toHaveBeenCalledWith('turn-other-chat');
    } finally {
      db.close();
    }
  });

  it.each(['shared', 'singleton'] as const)(
    'blocks the whole %s lane while durable recovery is outstanding',
    (scope) => {
      const db = new Database(':memory:');
      db.open();
      try {
        const { runtime, state } = makeRuntimeState(db, {
          ...(scope === 'shared' ? { shared: true } : {}),
        });
        const durability = durabilityMock();
        durability.hasOutstandingTurnRecoveryForScope.mockImplementation(
          (candidateScope) => candidateScope === scope,
        );
        state.durability = durability;
        const blocked = context(scope, `global-${scope}`, 49, `turn-${scope}-recovery`);
        const queue = queueStub(blocked.identity.deliveryJid);

        expect(() => state.runtimeTurnCoordinator.beginRuntimeTurnEvidence(queue, blocked))
          .toThrow(/durable recovery/i);
        expect(queue.beginTurnEvidence).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    },
  );

  it('tracks asynchronous finalization until the active-finalization barrier drains', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db);
      const runtimeContext = context('singleton', '15550190001', 7, 'turn-barrier');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      let releaseEvidence!: () => void;
      vi.mocked(queue.flushTurnEvidence).mockImplementation(async (turnId) => {
        await new Promise<void>((resolve) => { releaseEvidence = resolve; });
        return { turnId, answerOpIds: [], lifecycleOpIds: [], statusOpIds: [] };
      });
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.currentRuntimeTurnContext = runtimeContext;
      state.currentInboundSeq = 7;

      const finalization = state.runtimeTurnCoordinator.finalizeRuntimeTurnContext({
        context: runtimeContext,
        queue,
        attemptOutcome: { kind: 'completed' },
        session: sessionStub(),
      });
      let barrierSettled = false;
      const barrier = state.runtimeTurnCoordinator.awaitActiveFinalizations()
        .then(() => { barrierSettled = true; });
      await Promise.resolve();
      expect(barrierSettled).toBe(false);

      releaseEvidence();
      await finalization;
      await barrier;
      expect(barrierSettled).toBe(true);
      expect(state.currentRuntimeTurnContext).toBeNull();
    } finally {
      db.close();
    }
  });

  it('holds FIFO when a transferred terminal lacks a proven durable handoff receipt', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState<RuntimeState & {
        runtimeTurnSupervisor: { health(): { degradedScopes: number } };
      }>(db);
      const runtimeContext = context('singleton', '15550190041', 51, 'turn-unproven-handoff');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      vi.mocked(queue.flushTurnEvidence).mockResolvedValue({
        turnId: runtimeContext.identity.logicalTurnId,
        answerOpIds: [51],
        lifecycleOpIds: [],
        statusOpIds: [],
      });
      const durability = durabilityMock();
      durability.getOutboundDeliverySnapshot.mockReturnValue({
        opId: 51,
        conversationKey: runtimeContext.identity.conversationKey,
        deliveryJid: runtimeContext.identity.deliveryJid,
        sourceInboundSeq: 51,
        status: 'pending',
      });
      durability.finalizeTurnTerminal.mockReturnValue({
        applied: false,
        winnerMatchesRequest: true,
        recordId: 1,
        duplicateFinalizeCount: 1,
        replyGuaranteeDisarmed: false,
        effectiveReplyGuaranteeDisarmed: false,
      });
      const guarantee = replyGuaranteeMock();
      state.durability = durability;
      state.replyGuarantee = guarantee;
      state.currentRuntimeTurnContext = runtimeContext;
      state.currentInboundSeq = 51;

      const result = await state.runtimeTurnCoordinator.finalizeRuntimeTurnContext({
        context: runtimeContext,
        queue,
        attemptOutcome: { kind: 'completed' },
        session: sessionStub(),
      });

      expect(result).toMatchObject({
        kind: 'terminal',
        terminal: { inboundDisposition: 'transferred_to_recovery_owner' },
      });
      expect(state.currentRuntimeTurnContext).toBe(runtimeContext);
      expect(state.currentInboundSeq).toBe(51);
      expect(queue.clearLastOpId).not.toHaveBeenCalled();
      expect(guarantee.disarm).not.toHaveBeenCalled();
      expect(state.runtimeTurnSupervisor.health().degradedScopes).toBe(1);
    } finally {
      db.close();
    }
  });

  it('advances FIFO after an exact transferred terminal and linked-job handoff', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db);
      const runtimeContext = context('singleton', '15550190042', 52, 'turn-proven-handoff');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      vi.mocked(queue.flushTurnEvidence).mockResolvedValue({
        turnId: runtimeContext.identity.logicalTurnId,
        answerOpIds: [52],
        lifecycleOpIds: [],
        statusOpIds: [],
      });
      const durability = durabilityMock();
      durability.getOutboundDeliverySnapshot.mockReturnValue({
        opId: 52,
        conversationKey: runtimeContext.identity.conversationKey,
        deliveryJid: runtimeContext.identity.deliveryJid,
        sourceInboundSeq: 52,
        status: 'pending',
      });
      durability.finalizeTurnTerminal.mockReturnValue({
        applied: true,
        winnerMatchesRequest: true,
        recordId: 2,
        duplicateFinalizeCount: 0,
        replyGuaranteeDisarmed: false,
        effectiveReplyGuaranteeDisarmed: true,
        recoveryJob: {
          status: 'durably_queued',
          applied: true,
          jobId: 9,
          state: 'pending',
          duplicateEnqueueCount: 0,
        },
      });
      const guarantee = replyGuaranteeMock();
      state.durability = durability;
      state.replyGuarantee = guarantee;
      state.currentRuntimeTurnContext = runtimeContext;
      state.currentInboundSeq = 52;

      await state.runtimeTurnCoordinator.finalizeRuntimeTurnContext({
        context: runtimeContext,
        queue,
        attemptOutcome: { kind: 'completed' },
        session: sessionStub(),
      });

      expect(state.currentRuntimeTurnContext).toBeNull();
      expect(state.currentInboundSeq).toBeUndefined();
      expect(queue.clearLastOpId).toHaveBeenCalledOnce();
      expect(guarantee.disarm).toHaveBeenCalledWith(52);
    } finally {
      db.close();
    }
  });

  it('advances FIFO for an exact replay-unsafe blocked handoff while leaving its reply guarantee armed', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makeRuntimeState(db, { sessionScope: 'per_chat' });
      const mapKey = '15550190043';
      const session = sessionStub();
      const runtimeContext = markRuntimeTurnReplayUnsafe(
        context('per_chat', mapKey, 53, 'turn-blocked-handoff'),
      );
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      vi.mocked(queue.flushTurnEvidence).mockResolvedValue({
        turnId: runtimeContext.identity.logicalTurnId,
        answerOpIds: [53],
        lifecycleOpIds: [],
        statusOpIds: [],
      });
      const durability = durabilityMock();
      durability.getOutboundDeliverySnapshot.mockReturnValue({
        opId: 53,
        conversationKey: runtimeContext.identity.conversationKey,
        deliveryJid: runtimeContext.identity.deliveryJid,
        sourceInboundSeq: 53,
        status: 'maybe_sent',
      });
      durability.finalizeTurnTerminal.mockReturnValue({
        applied: false,
        winnerMatchesRequest: true,
        recordId: 3,
        duplicateFinalizeCount: 1,
        replyGuaranteeDisarmed: false,
        effectiveReplyGuaranteeDisarmed: false,
        recoveryJob: {
          status: 'durably_blocked',
          applied: false,
          jobId: 10,
          state: 'blocked_unsafe',
          duplicateEnqueueCount: 1,
        },
      });
      const guarantee = replyGuaranteeMock();
      state.durability = durability;
      state.replyGuarantee = guarantee;
      state.chatQueues.set(mapKey, queue);
      state.sessionOwnership.claim(mapKey, state.managerIdFor(session));
      const completion = state.beginPerChatRuntimeTurn(
        session,
        runtimeContext.identity.deliveryJid,
        mapKey,
        runtimeContext,
      );
      expect(completion).not.toBeNull();
      state.perChatInboundSeqQueue.set(mapKey, [53]);

      await state.runtimeTurnCoordinator.finalizeRuntimeTurnContext({
        context: completion!.context,
        queue,
        attemptOutcome: { kind: 'completed' },
        session,
        mapKey,
      });
      await completion!.promise;

      expect(state.perChatRuntimeTurnContexts.has(mapKey)).toBe(false);
      expect(state.perChatInboundSeqQueue.has(mapKey)).toBe(false);
      expect(queue.clearLastOpId).toHaveBeenCalledOnce();
      expect(guarantee.disarm).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('holds FIFO for an exact replay-safe queued handoff while delivery remains unknown', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { state } = makeRuntimeState<RuntimeState & {
        runtimeTurnSupervisor: { health(): { degradedScopes: number } };
      }>(db);
      const runtimeContext = context('singleton', '15550190044', 54, 'turn-pending-handoff');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      vi.mocked(queue.flushTurnEvidence).mockResolvedValue({
        turnId: runtimeContext.identity.logicalTurnId,
        answerOpIds: [54],
        lifecycleOpIds: [],
        statusOpIds: [],
      });
      const durability = durabilityMock();
      durability.getOutboundDeliverySnapshot.mockReturnValue({
        opId: 54,
        conversationKey: runtimeContext.identity.conversationKey,
        deliveryJid: runtimeContext.identity.deliveryJid,
        sourceInboundSeq: 54,
        status: 'maybe_sent',
      });
      durability.finalizeTurnTerminal.mockReturnValue({
        applied: true,
        winnerMatchesRequest: true,
        recordId: 4,
        duplicateFinalizeCount: 0,
        replyGuaranteeDisarmed: false,
        effectiveReplyGuaranteeDisarmed: false,
        recoveryJob: {
          status: 'durably_queued',
          applied: true,
          jobId: 11,
          state: 'pending',
          duplicateEnqueueCount: 0,
        },
      });
      const guarantee = replyGuaranteeMock();
      state.durability = durability;
      state.replyGuarantee = guarantee;
      state.currentRuntimeTurnContext = runtimeContext;
      state.currentInboundSeq = 54;

      await state.runtimeTurnCoordinator.finalizeRuntimeTurnContext({
        context: runtimeContext,
        queue,
        attemptOutcome: { kind: 'completed' },
        session: sessionStub(),
      });

      expect(state.currentRuntimeTurnContext).toBe(runtimeContext);
      expect(state.currentInboundSeq).toBe(54);
      expect(queue.clearLastOpId).not.toHaveBeenCalled();
      expect(guarantee.disarm).not.toHaveBeenCalled();
      expect(state.runtimeTurnSupervisor.health().degradedScopes).toBe(1);
    } finally {
      db.close();
    }
  });

  it('awaits an after-terminal action before releasing the FIFO completion', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState<RuntimeState & {
        currentRuntimeTurnCompletion: {
          context: RuntimeTurnContext;
          promise: Promise<void>;
          resolve(): void;
          reject(error: unknown): void;
        } | null;
      }>(db);
      const runtimeContext = context('singleton', '15550190008', 14, 'turn-action-barrier');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.currentRuntimeTurnContext = runtimeContext;
      state.currentInboundSeq = 14;
      let resolveCompletion!: () => void;
      const completionPromise = new Promise<void>((resolve) => { resolveCompletion = resolve; });
      state.currentRuntimeTurnCompletion = {
        context: runtimeContext,
        promise: completionPromise,
        resolve: resolveCompletion,
        reject: vi.fn(),
      };
      let releaseAction!: () => void;
      state.runtimeTurnAfterTerminal.set(runtimeContext.identity.logicalTurnId, async () => {
        await new Promise<void>((resolve) => { releaseAction = resolve; });
      });

      const finalization = state.runtimeTurnCoordinator.finalizeRuntimeTurnContext({
        context: runtimeContext,
        queue,
        attemptOutcome: { kind: 'failed', class: 'crash' },
        session: sessionStub(),
      });
      await vi.waitFor(() => expect(releaseAction).toBeTypeOf('function'));
      let completionSettled = false;
      void completionPromise.then(() => { completionSettled = true; });
      await Promise.resolve();
      expect(completionSettled).toBe(false);
      expect(state.currentRuntimeTurnContext).toBeNull();

      releaseAction();
      await finalization;
      await completionPromise;
      expect(state.currentRuntimeTurnContext).toBeNull();
      expect(completionSettled).toBe(true);
    } finally {
      db.close();
    }
  });

  it('contains an after-terminal exception and still releases the owned lane', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db);
      const runtimeContext = context('singleton', '15550190009', 15, 'turn-action-failure');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.currentRuntimeTurnContext = runtimeContext;
      state.currentInboundSeq = 15;
      state.runtimeTurnAfterTerminal.set(runtimeContext.identity.logicalTurnId, () => {
        throw new Error('post-terminal migration failed');
      });

      await expect(state.runtimeTurnCoordinator.finalizeRuntimeTurnContext({
        context: runtimeContext,
        queue,
        attemptOutcome: { kind: 'failed', class: 'crash' },
        session: sessionStub(),
      })).resolves.toMatchObject({ kind: 'terminal' });

      expect(state.currentRuntimeTurnContext).toBeNull();
      expect(state.runtimeTurnAfterTerminal.has(runtimeContext.identity.logicalTurnId)).toBe(false);
      expect(runtimeLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ logicalTurnId: runtimeContext.identity.logicalTurnId }),
        'runtime after-terminal action failed',
      );
    } finally {
      db.close();
    }
  });

  it('continues a silent provider failure on fallback under the same context and held FIFO', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const mapKey = '15550190014';
      const runtimeContext = context('per_chat', mapKey, 44, 'turn-fallback-continuation');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      vi.mocked(queue.flushTurnEvidence).mockResolvedValue({
        turnId: runtimeContext.identity.logicalTurnId,
        answerOpIds: [44],
        lifecycleOpIds: [],
        statusOpIds: [],
      });
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.chatQueues.set(mapKey, queue);
      state.perChatRuntimeTurnContexts.set(mapKey, [runtimeContext]);
      state.perChatInboundSeqQueue.set(mapKey, [44]);
      state.pendingTurnText.set(mapKey, runtimeContext.replay.text);
      const replay = vi.spyOn(state, 'replayTurnOnFallback').mockResolvedValue(undefined);

      expect(state.scheduleFallbackReplay({
        activation: fallbackActivation(),
        chatJid: runtimeContext.identity.deliveryJid,
        mapKey,
        oldSession: null,
        hadToolActivity: false,
      })).toBe(true);
      expect(replay).toHaveBeenCalledOnce();

      state.handleEventWithContext(
        { type: 'result', text: 'primary terminal failure', isError: true },
        queue,
        sessionStub(),
        mapKey,
        44,
        mapKey,
        `${mapKey}#session`,
      );
      await Promise.resolve();
      expect(state.durability.finalizeTurnTerminal).not.toHaveBeenCalled();
      expect(state.perChatRuntimeTurnContexts.get(mapKey)?.[0]).toBe(runtimeContext);
      expect(state.perChatInboundSeqQueue.get(mapKey)).toEqual([44]);
      expect(emitAlert).not.toHaveBeenCalledWith(
        expect.anything(),
        'provider_fallback_replayed',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );

      state.handleEventWithContext(
        { type: 'result', text: 'backup answer' },
        queue,
        sessionStub(),
        mapKey,
        44,
        mapKey,
        `${mapKey}#session`,
      );
      await state.runtimeTurnCoordinator.awaitActiveFinalizations();

      expect(state.durability.finalizeTurnTerminal).toHaveBeenCalledOnce();
      expect(state.durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: runtimeContext.identity.logicalTurnId,
          attemptKind: 'completed',
        }),
      }));
      expect(state.perChatRuntimeTurnContexts.has(mapKey)).toBe(false);
      expect(state.perChatInboundSeqQueue.has(mapKey)).toBe(false);
      expect(emitAlert).toHaveBeenCalledWith(
        'terminal-integration',
        'provider_fallback_replayed',
        'Interrupted turn replayed on fallback provider',
        expect.stringContaining('provider=codex-cli'),
        'info',
      );
    } finally {
      db.close();
    }
  });

  it('terminalizes the same context with tracked notice evidence when fallback continuation send fails', async () => {
    const db = new Database(':memory:');
    db.open();
    const priorOneMessage = process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'];
    try {
      process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'] = '1';
      ensureStandbyNoticeSchema(db);
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const mapKey = '15550190015';
      const runtimeContext = context('per_chat', mapKey, 45, 'turn-fallback-send-failure');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      vi.mocked(queue.flushTurnEvidence).mockResolvedValue({
        turnId: runtimeContext.identity.logicalTurnId,
        answerOpIds: [45],
        lifecycleOpIds: [],
        statusOpIds: [],
      });
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.chatQueues.set(mapKey, queue);
      state.perChatRuntimeTurnContexts.set(mapKey, [runtimeContext]);
      state.perChatInboundSeqQueue.set(mapKey, [45]);
      state.pendingTurnText.set(mapKey, runtimeContext.replay.text);
      const replay = vi.spyOn(state, 'replayTurnOnFallback')
        .mockRejectedValue(new Error('fallback spawn failed'));
      const consumeDeferral = vi.spyOn(
        state.runtimeTurnCoordinator,
        'consumeRuntimeTurnContinuationDeferral',
      );

      expect(state.scheduleFallbackReplay({
        activation: fallbackActivation(),
        chatJid: runtimeContext.identity.deliveryJid,
        mapKey,
        oldSession: null,
        hadToolActivity: false,
      })).toBe(true);
      expect(replay).toHaveBeenCalledOnce();
      state.notifyProviderFallbackActivated(queue, fallbackActivation(), {
        replayScheduled: true,
      });
      expect(peekStandbyNotice(db, toConversationKey(runtimeContext.identity.deliveryJid)))
        .toContain("I'll continue here");
      state.handleEventWithContext(
        { type: 'result', text: 'primary terminal failure', isError: true },
        queue,
        sessionStub(),
        mapKey,
        45,
        mapKey,
        `${mapKey}#session`,
      );
      expect(consumeDeferral).toHaveReturnedWith(true);
      await vi.waitFor(() => expect(queue.enqueueText).toHaveBeenCalledWith(
        expect.stringContaining('backup model could not continue'),
      ));
      await vi.waitFor(() => expect(state.durability.finalizeTurnTerminal).toHaveBeenCalledOnce());
      await state.runtimeTurnCoordinator.awaitActiveFinalizations();

      expect(queue.enqueueText).toHaveBeenCalledWith(expect.stringContaining('backup model could not continue'));
      expect(state.durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: runtimeContext.identity.logicalTurnId,
          attemptKind: 'failed',
          attemptFailureClass: 'processor_throw',
        }),
      }));
      expect(state.perChatRuntimeTurnContexts.has(mapKey)).toBe(false);
      expect(peekStandbyNotice(db, toConversationKey(runtimeContext.identity.deliveryJid))).toBeNull();
      expect(emitAlert).not.toHaveBeenCalledWith(
        expect.anything(),
        'provider_fallback_replayed',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      if (priorOneMessage === undefined) delete process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'];
      else process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'] = priorOneMessage;
      db.close();
    }
  });

  it('classifies a standalone continuation handoff as lifecycle evidence', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db);
      const queue = queueStub('15550190016@s.whatsapp.net');

      state.notifyProviderFallbackActivated(queue, fallbackActivation(), {
        replayScheduled: true,
        blockedByToolActivity: false,
      });

      expect(queue.enqueueText).toHaveBeenCalledWith(expect.any(String), 'lifecycle');
    } finally {
      db.close();
    }
  });

  it('clears a stashed continuation handoff when the fallback child crashes', async () => {
    const db = new Database(':memory:');
    db.open();
    const priorOneMessage = process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'];
    try {
      process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'] = '1';
      ensureStandbyNoticeSchema(db);
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const mapKey = '15550190017';
      const runtimeContext = context('per_chat', mapKey, 46, 'turn-fallback-crash');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.chatQueues.set(mapKey, queue);
      state.perChatRuntimeTurnContexts.set(mapKey, [runtimeContext]);
      state.perChatInboundSeqQueue.set(mapKey, [46]);
      state.pendingTurnText.set(mapKey, runtimeContext.replay.text);
      vi.spyOn(state, 'replayTurnOnFallback').mockImplementation(() => new Promise(() => {}));

      expect(state.scheduleFallbackReplay({
        activation: fallbackActivation(),
        chatJid: runtimeContext.identity.deliveryJid,
        mapKey,
        oldSession: null,
        hadToolActivity: false,
      })).toBe(true);
      state.notifyProviderFallbackActivated(queue, fallbackActivation(), {
        replayScheduled: true,
      });
      expect(peekStandbyNotice(db, toConversationKey(runtimeContext.identity.deliveryJid)))
        .toContain("I'll continue here");

      state.finalizeRuntimeCrash(runtimeContext, queue, sessionStub(), mapKey);
      await state.runtimeTurnCoordinator.awaitActiveFinalizations();

      expect(peekStandbyNotice(db, toConversationKey(runtimeContext.identity.deliveryJid))).toBeNull();
    } finally {
      if (priorOneMessage === undefined) delete process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'];
      else process.env['WHATSOUP_ONE_MESSAGE_HANDOFF'] = priorOneMessage;
      db.close();
    }
  });

  it('crash finalization cancels presentation while preserving the evidence epoch', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db);
      const runtimeContext = context('singleton', '15550190002', 8, 'turn-crash-evidence');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.currentRuntimeTurnContext = runtimeContext;
      state.currentInboundSeq = 8;

      state.runtimeTurnCoordinator.finalizeRuntimeCrash(runtimeContext, queue, sessionStub());
      await state.runtimeTurnCoordinator.awaitActiveFinalizations();

      expect(queue.abortTurn).toHaveBeenCalledWith({ preserveEvidence: true });
      expect(queue.flushTurnEvidence).toHaveBeenCalledWith('turn-crash-evidence');
      expect(state.durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: 'turn-crash-evidence',
          attemptKind: 'failed',
          attemptFailureClass: 'crash',
        }),
      }));
    } finally {
      db.close();
    }
  });

  it('defers exhausted-session cleanup until crash evidence is terminal and keeps health degraded', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState<RuntimeState & {
        crashes: { record(scopeKey: string): number };
        handlePerChatCrash(
          mapKey: string,
          chatJid: string,
          info: {
            exitCode: number;
            signal: null;
            sessionId: string;
            dbRowId: number;
            generationIdentity: { managerId: string; generation: number };
          },
          expectedSession: ReturnType<typeof sessionStub>,
        ): void;
      }>(db, {
        sessionScope: 'per_chat',
      });
      const mapKey = '15550190018';
      const session = sessionStub();
      session.getStatus.mockReturnValue({
        active: false,
        sessionId: 'session-crash-exhausted',
        pid: null,
      });
      const managerId = state.managerIdFor(session);
      const owner = state.sessionOwnership.claim(mapKey, managerId);
      const baseContext = context('per_chat', mapKey, 19, 'turn-crash-exhausted');
      const runtimeContext: RuntimeTurnContext = {
        ...baseContext,
        identity: {
          ...baseContext.identity,
          managerId,
          generation: owner.generation,
        },
      };
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      let releaseEvidence!: () => void;
      vi.mocked(queue.flushTurnEvidence).mockImplementation(async (turnId) => {
        await new Promise<void>((resolve) => { releaseEvidence = resolve; });
        return { turnId, answerOpIds: [], lifecycleOpIds: [], statusOpIds: [] };
      });
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.chatSessions.set(mapKey, session);
      state.chatQueues.set(mapKey, queue);
      state.perChatRuntimeTurnContexts.set(mapKey, [runtimeContext]);
      state.perChatInboundSeqQueue.set(mapKey, [19]);
      for (let prior = 0; prior < 3; prior += 1) state.crashes.record(mapKey);

      state.handlePerChatCrash(mapKey, runtimeContext.identity.deliveryJid, {
        exitCode: 1,
        signal: null,
        sessionId: 'session-crash-exhausted',
        dbRowId: 41,
        generationIdentity: { managerId, generation: owner.generation },
      }, session);
      await vi.waitFor(() => expect(releaseEvidence).toBeTypeOf('function'));

      expect(state.chatSessions.get(mapKey)).toBe(session);
      expect(state.chatQueues.get(mapKey)).toBe(queue);
      expect(queue.abortTurn).toHaveBeenCalledTimes(1);
      expect(queue.abortTurn).toHaveBeenCalledWith({ preserveEvidence: true });
      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'degraded',
        details: { recentCrashes: 4 },
      });

      releaseEvidence();
      await state.runtimeTurnCoordinator.awaitActiveFinalizations();

      expect(state.chatSessions.has(mapKey)).toBe(false);
      expect(state.chatQueues.has(mapKey)).toBe(false);
      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'degraded',
        details: { recentCrashes: 4 },
      });
    } finally {
      db.close();
    }
  });

  it('terminalizes and cancels an exhausted per-chat turn that crashes before evidence begins', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const mapKey = '15550190024';
      const session = sessionStub();
      const managerId = state.managerIdFor(session);
      const owner = state.sessionOwnership.claim(mapKey, managerId);
      const baseContext = context('per_chat', mapKey, 24, 'turn-crash-before-evidence');
      const runtimeContext: RuntimeTurnContext = {
        ...baseContext,
        identity: {
          ...baseContext.identity,
          managerId,
          generation: owner.generation,
        },
      };
      const turn: QueuedTurn = {
        sourceMessageId: runtimeContext.replay.sourceMessageId,
        receivedAtUnixSeconds: runtimeContext.replay.receivedAtUnixSeconds,
        conversationKey: runtimeContext.identity.conversationKey,
        chatJid: runtimeContext.identity.deliveryJid,
        senderJid: runtimeContext.replay.senderJid,
        senderName: runtimeContext.replay.senderName,
        text: runtimeContext.replay.text,
        isGroup: false,
        contentType: 'text',
        runtimeContext,
        inboundSeq: runtimeContext.identity.inboundSeq ?? undefined,
      };
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      const durability = durabilityMock();
      let observeFirstFinalize!: () => void;
      const firstFinalize = new Promise<void>((resolve) => {
        observeFirstFinalize = resolve;
      });
      durability.finalizeTurnTerminal.mockImplementationOnce(() => {
        observeFirstFinalize();
        throw new Error('terminal sink unavailable once');
      });
      state.durability = durability;
      state.replyGuarantee = replyGuaranteeMock();
      state.chatSessions.set(mapKey, session);
      state.chatQueues.set(mapKey, queue);
      state.pendingSystemResults.mark(mapKey);
      for (let prior = 0; prior < 3; prior += 1) state.crashes.record(mapKey);

      expect(state.runtimeTurnCoordinator.enqueuePerChatRuntimeTurn(mapKey, turn)).toBe(true);
      await vi.waitFor(() => {
        expect(state.perChatInboundSeqQueue.get(mapKey)).toEqual([24]);
        expect(state.perChatTurnQueues.get(mapKey)?.activeTurn).toBe(turn);
      });
      expect(state.perChatRuntimeTurnContexts.has(mapKey)).toBe(false);
      expect(queue.beginTurnEvidence).not.toHaveBeenCalled();

      session.getStatus.mockReturnValue({
        active: false,
        sessionId: 'session-crash-before-evidence',
        pid: null,
      });
      expect(() => state.handlePerChatCrash(mapKey, runtimeContext.identity.deliveryJid, {
        exitCode: 1,
        signal: null,
        sessionId: 'session-crash-before-evidence',
        dbRowId: 41,
        generationIdentity: { managerId, generation: owner.generation },
      }, session)).not.toThrow();

      await firstFinalize;
      expect(durability.finalizeTurnTerminal).toHaveBeenCalledTimes(1);
      expect(state.perChatTurnQueues.get(mapKey)?.activeTurn).toBe(turn);
      expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: 'turn-crash-before-evidence',
          attemptKind: 'failed',
          attemptFailureClass: 'crash',
        }),
      }));
      expect(session.sendTurn).not.toHaveBeenCalledWith(runtimeContext.replay.text);
      expect(session.spawnSession).not.toHaveBeenCalled();
      expect(session.shutdown).not.toHaveBeenCalled();
      expect(queue.beginTurnEvidence).not.toHaveBeenCalled();
      expect(queue.flushTurnEvidence).not.toHaveBeenCalled();
      expect(state.perChatInboundSeqQueue.get(mapKey)).toEqual([24]);
      expect(state.chatSessions.get(mapKey)).toBe(session);
      expect(state.chatQueues.get(mapKey)).toBe(queue);
      runtime.handleJidAliasChanged(
        runtimeContext.identity.conversationKey,
        '15550199924@s.whatsapp.net',
      );
      expect(queue.updateDeliveryJid).not.toHaveBeenCalled();

      await expect(state.runtimeTurnCoordinator.retryRuntimeTurnFinalizations()).resolves.toMatchObject({
        recovered: 1,
        remaining: 0,
      });
      expect(durability.finalizeTurnTerminal).toHaveBeenLastCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: 'turn-crash-before-evidence',
          attemptKind: 'failed',
          attemptFailureClass: 'crash',
        }),
      }));
      await state.perChatTurnQueues.get(mapKey)?.idle();

      expect(session.sendTurn).not.toHaveBeenCalledWith(runtimeContext.replay.text);
      expect(state.perChatTurnQueues.get(mapKey)?.activeTurn).toBeNull();
      expect(queue.updateDeliveryJid).toHaveBeenCalledWith('15550199924@s.whatsapp.net');
      expect(state.chatSessions.has(mapKey)).toBe(false);
      expect(state.chatQueues.has(mapKey)).toBe(false);
      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'degraded',
        details: { recentCrashes: 4 },
      });
    } finally {
      db.close();
    }
  });

  it('halts the per-chat FIFO when a pre-evidence crash terminal lacks release proof', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const mapKey = '15550190025';
      const session = sessionStub();
      const managerId = state.managerIdFor(session);
      const owner = state.sessionOwnership.claim(mapKey, managerId);
      const base = context('per_chat', mapKey, 25, 'turn-crash-unproven-terminal');
      const runtimeContext: RuntimeTurnContext = {
        ...base,
        identity: { ...base.identity, managerId, generation: owner.generation },
      };
      const turn: QueuedTurn = {
        sourceMessageId: runtimeContext.replay.sourceMessageId,
        receivedAtUnixSeconds: runtimeContext.replay.receivedAtUnixSeconds,
        conversationKey: runtimeContext.identity.conversationKey,
        chatJid: runtimeContext.identity.deliveryJid,
        senderJid: runtimeContext.replay.senderJid,
        senderName: runtimeContext.replay.senderName,
        text: runtimeContext.replay.text,
        isGroup: false,
        contentType: 'text',
        runtimeContext,
        inboundSeq: 25,
      };
      const durability = durabilityMock();
      durability.finalizeTurnTerminal.mockImplementation(() => {
        state.perChatInboundSeqQueue.set(mapKey, [999]);
        return {
          applied: true,
          winnerMatchesRequest: true,
          recordId: 1,
          duplicateFinalizeCount: 0,
          replyGuaranteeDisarmed: true,
          effectiveReplyGuaranteeDisarmed: true,
        };
      });
      state.durability = durability;
      state.replyGuarantee = replyGuaranteeMock();
      state.chatSessions.set(mapKey, session);
      state.chatQueues.set(mapKey, queueStub(runtimeContext.identity.deliveryJid));
      state.pendingSystemResults.mark(mapKey);

      expect(state.runtimeTurnCoordinator.enqueuePerChatRuntimeTurn(mapKey, turn)).toBe(true);
      await vi.waitFor(() => expect(state.perChatTurnQueues.get(mapKey)?.activeTurn).toBe(turn));
      const runtimeQueue = state.perChatTurnQueues.get(mapKey);
      if (!runtimeQueue) throw new Error('per-chat runtime queue was not created');

      state.handlePerChatCrash(mapKey, runtimeContext.identity.deliveryJid, {
        exitCode: 1,
        signal: null,
        sessionId: null,
        dbRowId: 41,
        generationIdentity: { managerId, generation: owner.generation },
      }, session);

      await expect(runtimeQueue.idle()).rejects.toThrow(/Per-chat inbound sequence FIFO drift/);
      expect(session.sendTurn).not.toHaveBeenCalledWith(runtimeContext.replay.text);
      expect(state.perChatInboundSeqQueue.get(mapKey)).toEqual([999]);
    } finally {
      db.close();
    }
  });

  it('does not start a user evidence epoch while an earlier system result is outstanding', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const session = sessionStub();
      const beforeUserSend = vi.fn();
      state.pendingSystemResults.mark('chat-system-barrier');

      const sending = state.sendTurnToSession(
        session,
        'chat-system-barrier@s.whatsapp.net',
        'real user turn',
        'chat-system-barrier',
        undefined,
        beforeUserSend,
      );
      await Promise.resolve();
      expect(beforeUserSend).not.toHaveBeenCalled();
      expect(session.sendTurn).not.toHaveBeenCalled();

      state.pendingSystemResults.consumeIfPending('chat-system-barrier');
      await sending;
      expect(beforeUserSend).toHaveBeenCalledOnce();
      expect(session.sendTurn).toHaveBeenCalledWith('real user turn');
    } finally {
      db.close();
    }
  });

  it('does not start auto-compact until the user evidence finalization has completed', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const mapKey = '15550190010';
      const runtimeContext = context('per_chat', mapKey, 16, 'turn-compact-order');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      let releaseEvidence!: () => void;
      vi.mocked(queue.flushTurnEvidence).mockImplementation(async (turnId) => {
        await new Promise<void>((resolve) => { releaseEvidence = resolve; });
        return { turnId, answerOpIds: [], lifecycleOpIds: [], statusOpIds: [] };
      });
      const session = sessionStub();
      const compact = vi.spyOn(state, 'maybeStartAutoCompact').mockImplementation(() => {});
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.perChatRuntimeTurnContexts.set(mapKey, [runtimeContext]);
      state.perChatInboundSeqQueue.set(mapKey, [16]);

      state.handleEventWithContext(
        { type: 'result', text: null },
        queue,
        session,
        mapKey,
        16,
        mapKey,
        `${mapKey}#session`,
      );
      await vi.waitFor(() => expect(releaseEvidence).toBeTypeOf('function'));
      expect(compact).not.toHaveBeenCalled();

      releaseEvidence();
      await state.runtimeTurnCoordinator.awaitActiveFinalizations();
      expect(compact).toHaveBeenCalledWith(session, mapKey);
    } finally {
      db.close();
    }
  });

  it('marks replay unsafe as soon as partial assistant output is accepted', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const mapKey = '15550190003';
      const runtimeContext = context('per_chat', mapKey, 9, 'turn-partial-output');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      state.perChatRuntimeTurnContexts.set(mapKey, [runtimeContext]);

      state.handleEventWithContext(
        { type: 'assistant_text', text: 'partial answer' },
        queue,
        sessionStub(),
        mapKey,
        9,
        mapKey,
        `${mapKey}#session`,
      );

      expect(queue.enqueueStreamingText).toHaveBeenCalledWith('partial answer');
      expect(state.perChatRuntimeTurnContexts.get(mapKey)?.[0]?.replay.replaySafe).toBe(false);
      expect(runtimeContext.replay.replaySafe).toBe(true);
    } finally {
      db.close();
    }
  });

  it('clears the per-chat replay latch after streamed output and a successful null result', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const mapKey = '15550190004';
      const runtimeContext = context('per_chat', mapKey, 10, 'turn-null-result');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      vi.mocked(queue.flushTurnEvidence).mockResolvedValue({
        turnId: runtimeContext.identity.logicalTurnId,
        answerOpIds: [10],
        lifecycleOpIds: [],
        statusOpIds: [],
      });
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.perChatRuntimeTurnContexts.set(mapKey, [runtimeContext]);
      state.perChatInboundSeqQueue.set(mapKey, [10]);
      state.pendingTurnText.set(mapKey, 'original prompt');

      state.handleEventWithContext(
        { type: 'assistant_text', text: 'streamed answer' },
        queue,
        sessionStub(),
        mapKey,
        10,
        mapKey,
        `${mapKey}#session`,
      );
      state.handleEventWithContext(
        { type: 'result', text: null },
        queue,
        sessionStub(),
        mapKey,
        10,
        mapKey,
        `${mapKey}#session`,
      );

      await state.runtimeTurnCoordinator.awaitActiveFinalizations();
      expect(state.pendingTurnText.has(mapKey)).toBe(false);
      expect(state.durability.finalizeTurnTerminal).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('rebinds a queued per-chat context to a replacement session owner at dispatch', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const mapKey = '15550190005';
      const queuedContext = context('per_chat', mapKey, 11, 'turn-owner-rebind');
      const replacement = sessionStub();
      const replacementManagerId = state.managerIdFor(replacement);
      const owner = state.sessionOwnership.claim(mapKey, replacementManagerId);
      state.chatSessions.set(mapKey, replacement);
      state.chatQueues.set(mapKey, queueStub(queuedContext.identity.deliveryJid));

      const completion = state.beginPerChatRuntimeTurn(
        replacement,
        queuedContext.identity.deliveryJid,
        mapKey,
        queuedContext,
        { value: mapKey },
      );

      expect(completion?.context.identity).toEqual({
        ...queuedContext.identity,
        managerId: replacementManagerId,
        generation: owner.generation,
      });
      expect(state.perChatRuntimeTurnContexts.get(mapKey)?.[0]).toBe(completion?.context);
      expect(queuedContext.identity.managerId).toBe('manager-per_chat');
    } finally {
      db.close();
    }
  });

  it('rebinds a queued shared context when the singleton manager was replaced before dispatch', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState<RuntimeState & {
        session: ReturnType<typeof sessionStub> | null;
      }>(db, {
        shared: true,
      });
      const queuedContext = context('shared', '15550190006', 12, 'turn-shared-owner-rebind');
      const replacement = sessionStub();
      const replacementManagerId = state.managerIdFor(replacement);
      const queue = queueStub(queuedContext.identity.deliveryJid);
      state.session = replacement;
      const sourceBoundState = state as unknown as {
        sessionEventToolScopes: WeakMap<object, string>;
        handleEvent(sourceSession: object, event: AgentEvent): void;
      };
      sourceBoundState.sessionEventToolScopes.set(replacement, GLOBAL_CONVERSATION_KEY);
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.outboundQueues.set(queuedContext.identity.deliveryJid, queue);
      const queued: QueuedTurn = {
        sourceMessageId: queuedContext.replay.sourceMessageId,
        receivedAtUnixSeconds: queuedContext.replay.receivedAtUnixSeconds,
        conversationKey: queuedContext.identity.conversationKey,
        chatJid: queuedContext.identity.deliveryJid,
        senderJid: queuedContext.replay.senderJid,
        senderName: null,
        text: queuedContext.replay.text,
        isGroup: false,
        contentType: 'text',
        runtimeContext: queuedContext,
        inboundSeq: 12,
      };

      const processing = state.processTurn(queued);
      await vi.waitFor(() => expect(replacement.sendTurn).toHaveBeenCalledOnce());
      expect(state.currentRuntimeTurnContext?.identity).toEqual({
        ...queuedContext.identity,
        managerId: replacementManagerId,
        generation: 1,
      });

      sourceBoundState.handleEvent(replacement, { type: 'result', text: null });
      await processing;
    } finally {
      db.close();
    }
  });

  it('terminalizes a journaled stdin timeout instead of leaving the shared FIFO waiting forever', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState<RuntimeState & {
        session: ReturnType<typeof sessionStub> | null;
      }>(db, {
        shared: true,
      });
      const runtimeContext = context('shared', '15550190007', 13, 'turn-stdin-timeout');
      const session = sessionStub();
      session.sendTurn.mockRejectedValue(new Error('STDIN_WRITE_TIMEOUT: child stdin stalled'));
      state.session = session;
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.outboundQueues.set(
        runtimeContext.identity.deliveryJid,
        queueStub(runtimeContext.identity.deliveryJid),
      );
      const queued: QueuedTurn = {
        sourceMessageId: runtimeContext.replay.sourceMessageId,
        receivedAtUnixSeconds: runtimeContext.replay.receivedAtUnixSeconds,
        conversationKey: runtimeContext.identity.conversationKey,
        chatJid: runtimeContext.identity.deliveryJid,
        senderJid: runtimeContext.replay.senderJid,
        senderName: null,
        text: runtimeContext.replay.text,
        isGroup: false,
        contentType: 'text',
        runtimeContext,
        inboundSeq: 13,
      };

      expect(state.turnQueue.enqueue(queued)).toBe(true);
      await state.turnQueue.idle();
      expect(state.durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: 'turn-stdin-timeout',
          attemptKind: 'failed',
          attemptFailureClass: 'processor_throw',
          inboundDisposition: 'failed_terminal',
        }),
      }));
      expect(state.currentRuntimeTurnContext).toBeNull();
    } finally {
      db.close();
    }
  });

  it('terminalizes shared recovery admission rejection without waiting for evidence that never began', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState<RuntimeState & {
        session: ReturnType<typeof sessionStub> | null;
      }>(db, {
        shared: true,
      });
      const runtimeContext = context('shared', '15550190008', 14, 'turn-shared-admission');
      const session = sessionStub();
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      const durability = durabilityMock();
      durability.hasOutstandingTurnRecoveryForScope.mockReturnValue(true);
      state.session = session;
      state.durability = durability;
      state.replyGuarantee = replyGuaranteeMock();
      state.outboundQueues.set(runtimeContext.identity.deliveryJid, queue);

      expect(state.turnQueue.enqueue({
        sourceMessageId: runtimeContext.replay.sourceMessageId,
        receivedAtUnixSeconds: runtimeContext.replay.receivedAtUnixSeconds,
        conversationKey: runtimeContext.identity.conversationKey,
        chatJid: runtimeContext.identity.deliveryJid,
        senderJid: runtimeContext.replay.senderJid,
        senderName: null,
        text: runtimeContext.replay.text,
        isGroup: false,
        contentType: 'text',
        runtimeContext,
        inboundSeq: 14,
      })).toBe(true);
      await state.turnQueue.idle();

      expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: 'turn-shared-admission',
          attemptKind: 'admission_rejected',
        }),
      }));
      expect(queue.beginTurnEvidence).not.toHaveBeenCalled();
      expect(queue.flushTurnEvidence).not.toHaveBeenCalled();
      expect(state.currentRuntimeTurnContext).toBeNull();
      expect(state.currentInboundSeq).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it.each([
    { scope: 'per_chat' as const, error: false, seq: 17, logicalTurnId: 'turn-per-chat-bookkeeping' },
    { scope: 'per_chat' as const, error: true, seq: 18, logicalTurnId: 'turn-per-chat-error' },
    { scope: 'shared' as const, error: false, seq: 23, logicalTurnId: 'turn-shared-bookkeeping' },
    { scope: 'shared' as const, error: true, seq: 24, logicalTurnId: 'turn-shared-error' },
  ])('terminalizes $scope result (error=$error) through one immutable transaction', async ({
    scope,
    error,
    seq,
    logicalTurnId,
  }) => {
    const db = new Database(':memory:');
    db.open();
    try {
      const conversationKey = scope === 'per_chat' ? '15550190011' : '15550190012';
      const chatJid = `${conversationKey}@s.whatsapp.net`;
      const { runtime, state } = makeRuntimeState(db, scope === 'per_chat' ? { sessionScope: 'per_chat' } : { shared: true });
      const durability = durabilityMock();
      const guarantee = replyGuaranteeMock();
      const queue = queueStub(chatJid);
      if (!error) {
        vi.mocked(queue.flushTurnEvidence).mockResolvedValue({
          turnId: logicalTurnId,
          answerOpIds: [seq],
          lifecycleOpIds: [],
          statusOpIds: [],
        });
      }
      const session = sessionStub();
      const runtimeContext = context(scope, conversationKey, seq, logicalTurnId);
      state.durability = durability;
      state.replyGuarantee = guarantee;

      const event: Extract<AgentEvent, { type: 'result' }> = error
        ? { type: 'result', text: 'unclassified provider terminal', isError: true }
        : { type: 'result', text: 'done', inputTokens: 3, outputTokens: 5 };
      if (scope === 'per_chat') {
        state.perChatRuntimeTurnContexts.set(conversationKey, [runtimeContext]);
        state.perChatInboundSeqQueue.set(conversationKey, [seq]);
        state.handleEventWithContext(
          event,
          queue,
          session,
          conversationKey,
          seq,
          conversationKey,
          `${conversationKey}#session`,
        );
      } else {
        const sourceBoundState = state as unknown as {
          sessionEventToolScopes: WeakMap<object, string>;
          handleEvent(sourceSession: object, event: AgentEvent): void;
        };
        (state as unknown as { session: ReturnType<typeof sessionStub> }).session = session;
        const sourceManagerId = state.managerIdFor(session);
        sourceBoundState.sessionEventToolScopes.set(session, GLOBAL_CONVERSATION_KEY);
        state.currentRuntimeTurnContext = {
          ...runtimeContext,
          identity: {
            ...runtimeContext.identity,
            managerId: sourceManagerId,
            generation: 1,
          },
        };
        state.currentInboundSeq = seq;
        state.currentTurnChatJid = chatJid;
        state.activeChatJid = chatJid;
        state.turnHadVisibleOutput = !error;
        state.outboundQueues.set(chatJid, queue);
        sourceBoundState.handleEvent(session, event);
      }

      await vi.waitFor(() => expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce());
      expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId,
          inboundSeq: seq,
          attemptKind: error ? 'failed' : 'completed',
          ...(error ? { attemptFailureClass: 'unknown_terminal' } : {}),
        }),
        bookkeeping: expect.objectContaining({
          checkpoint: {
            conversationKey,
            fields: expect.objectContaining({ activeTurnId: null, lastInboundSeq: seq }),
          },
        }),
      }));
      expect(queue.flushTurnEvidence).toHaveBeenCalledWith(logicalTurnId);
      expect(queue.clearLastOpId).toHaveBeenCalledOnce();
      expect(guarantee.disarm).toHaveBeenCalledWith(seq);
      if (scope === 'per_chat') {
        expect(state.perChatRuntimeTurnContexts.has(conversationKey)).toBe(false);
        expect(state.perChatInboundSeqQueue.has(conversationKey)).toBe(false);
      } else {
        expect(state.currentRuntimeTurnContext).toBeNull();
        expect(state.currentInboundSeq).toBeUndefined();
      }
    } finally {
      db.close();
    }
  });

  it('terminalizes startup rejection and admits the next FIFO head cleanly', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const durability = durabilityMock();
      const guarantee = replyGuaranteeMock();
      const mapKey = '15550190021';
      const first = context('per_chat', mapKey, 31, 'turn-startup-fifo-1');
      const second = context('per_chat', mapKey, 32, 'turn-startup-fifo-2');
      const queued = (runtimeContext: RuntimeTurnContext): QueuedTurn => ({
        sourceMessageId: runtimeContext.replay.sourceMessageId,
        receivedAtUnixSeconds: runtimeContext.replay.receivedAtUnixSeconds,
        conversationKey: mapKey,
        chatJid: runtimeContext.identity.deliveryJid,
        senderJid: runtimeContext.replay.senderJid,
        senderName: null,
        text: runtimeContext.replay.text,
        isGroup: false,
        contentType: 'text',
        runtimeContext,
        inboundSeq: runtimeContext.identity.inboundSeq ?? undefined,
      });
      state.durability = durability;
      state.replyGuarantee = guarantee;
      state.ensureSessionAndQueueSync = vi.fn();

      await state.processPerChatTurn({ value: mapKey }, queued(first));

      expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          inboundSeq: 31,
          attemptKind: 'admission_rejected',
        }),
      }));
      expect(durability.markInboundFailed).not.toHaveBeenCalled();
      expect(guarantee.disarm).toHaveBeenCalledWith(31);
      expect(state.perChatInboundSeqQueue.has(mapKey)).toBe(false);

      state.sendTurnPerChat = vi.fn(async () => {});
      await state.processPerChatTurn({ value: mapKey }, queued(second));
      expect(state.perChatInboundSeqQueue.get(mapKey)).toEqual([32]);
    } finally {
      db.close();
    }
  });

  it('terminalizes active shutdown work before closing the supervisor or clearing runtime state', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const queue = queueStub('15550190031@s.whatsapp.net');
      const runtimeContext = context('singleton', '15550190031', 41, 'turn-shutdown-order');
      let sessionShutdownComplete = false;
      const session = {
        ...sessionStub(),
        shutdown: vi.fn(async () => { sessionShutdownComplete = true; }),
      };
      let supervisorSnapshot: {
        sessionShutdownComplete: boolean;
        queueReachable: boolean;
        contextReachable: boolean;
      } | null = null;
      const { runtime, state } = makeRuntimeState<RuntimeState & {
        session: typeof session | null;
        queue: IOutboundQueue | null;
        runtimeTurnSupervisor: { shutdown(): Promise<void> };
      }>(db);
      state.session = session;
      state.queue = queue;
      state.currentRuntimeTurnContext = runtimeContext;
      state.currentInboundSeq = 41;
      state.currentTurnChatJid = runtimeContext.identity.deliveryJid;
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      vi.spyOn(state.runtimeTurnSupervisor, 'shutdown').mockImplementation(async () => {
        supervisorSnapshot = {
          sessionShutdownComplete,
          queueReachable: state.queue === queue,
          contextReachable: state.currentRuntimeTurnContext === runtimeContext,
        };
      });

      await runtime.shutdown();

      expect(supervisorSnapshot).toEqual({
        sessionShutdownComplete: true,
        queueReachable: true,
        contextReachable: false,
      });
      expect(state.durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: 'turn-shutdown-order',
          attemptKind: 'failed',
          attemptFailureClass: 'crash',
        }),
      }));
    } finally {
      db.close();
    }
  });

  it('retains per-chat terminal ownership when shutdown cannot prove the recovery handoff', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const mapKey = '15550190033';
      const runtimeContext = context('per_chat', mapKey, 63, 'turn-shutdown-unproven-handoff');
      const session = sessionStub();
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      vi.mocked(queue.flushTurnEvidence).mockResolvedValue({
        turnId: runtimeContext.identity.logicalTurnId,
        answerOpIds: [63],
        lifecycleOpIds: [],
        statusOpIds: [],
      });
      const durability = durabilityMock();
      durability.getOutboundDeliverySnapshot.mockReturnValue({
        opId: 63,
        conversationKey: runtimeContext.identity.conversationKey,
        deliveryJid: runtimeContext.identity.deliveryJid,
        sourceInboundSeq: 63,
        status: 'pending',
      });
      durability.finalizeTurnTerminal.mockReturnValue({
        applied: false,
        winnerMatchesRequest: true,
        recordId: 1,
        duplicateFinalizeCount: 1,
        replyGuaranteeDisarmed: false,
        effectiveReplyGuaranteeDisarmed: false,
      });
      state.durability = durability;
      state.replyGuarantee = replyGuaranteeMock();
      state.chatSessions.set(mapKey, session);
      state.chatQueues.set(mapKey, queue);
      state.perChatRuntimeTurnContexts.set(mapKey, [runtimeContext]);
      state.perChatInboundSeqQueue.set(mapKey, [63]);

      await expect(runtime.shutdown()).rejects.toThrow(/terminal|finalization|handoff/i);

      expect(state.chatSessions.get(mapKey)).toBe(session);
      expect(state.chatQueues.get(mapKey)).toBe(queue);
      expect(state.perChatRuntimeTurnContexts.get(mapKey)).toEqual([runtimeContext]);
      expect(state.perChatInboundSeqQueue.get(mapKey)).toEqual([63]);
      expect(queue.clearLastOpId).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('cancels a singleton turn waiting before evidence instead of dispatching it after shutdown', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState<RuntimeState & {
        session: ReturnType<typeof sessionStub> | null;
        queue: IOutboundQueue | null;
      }>(db);
      const chatJid = '15550190034@s.whatsapp.net';
      const session = sessionStub();
      const queue = queueStub(chatJid);
      session.sendTurn.mockRejectedValue(new Error('late singleton dispatch'));
      state.session = session;
      state.queue = queue;
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.pendingSystemResults.mark(GLOBAL_CONVERSATION_KEY);

      const send = state.sendTurnNonShared(
        chatJid,
        'must not dispatch after shutdown',
        '15550190002@s.whatsapp.net',
        {
          sourceMessageId: 'wamid-singleton-shutdown-race', receivedAtUnixSeconds: 1_780_000_000,
          conversationKey: '15550190034',
          senderJid: '15550190002@s.whatsapp.net',
          senderName: null,
          contentType: 'text',
          isGroup: false,
        },
        64,
      ).catch(() => {});
      await Promise.resolve();

      await Promise.all([runtime.shutdown(), send]);

      expect(session.spawnSession).not.toHaveBeenCalled();
      expect(session.sendTurn).not.toHaveBeenCalled();
      expect(state.durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: expect.any(String),
          attemptKind: 'failed',
          attemptFailureClass: 'crash',
        }),
      }));
    } finally {
      db.close();
    }
  });

  it('fails shutdown without waiting forever on a singleton whose terminal proof is unproven', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState<RuntimeState & {
        session: ReturnType<typeof sessionStub> | null;
        queue: IOutboundQueue | null;
      }>(db);
      const chatJid = '15550190035@s.whatsapp.net';
      const session = sessionStub();
      const queue = queueStub(chatJid);
      vi.mocked(queue.flushTurnEvidence).mockImplementation(async (turnId) => ({
        turnId,
        answerOpIds: [66],
        lifecycleOpIds: [],
        statusOpIds: [],
      }));
      const durability = durabilityMock();
      durability.getOutboundDeliverySnapshot.mockImplementation((opId, expected) => ({
        opId,
        ...expected,
        status: 'pending',
      }));
      durability.finalizeTurnTerminal.mockReturnValue({
        applied: false,
        winnerMatchesRequest: true,
        recordId: 1,
        duplicateFinalizeCount: 1,
        replyGuaranteeDisarmed: false,
        effectiveReplyGuaranteeDisarmed: false,
      });
      state.session = session;
      state.queue = queue;
      state.durability = durability;
      state.replyGuarantee = replyGuaranteeMock();

      const send = state.sendTurnNonShared(
        chatJid,
        'hold ownership until handoff proof exists',
        '15550190002@s.whatsapp.net',
        {
          sourceMessageId: 'wamid-singleton-unproven-handoff', receivedAtUnixSeconds: 1_780_000_000,
          conversationKey: '15550190035',
          senderJid: '15550190002@s.whatsapp.net',
          senderName: null,
          contentType: 'text',
          isGroup: false,
        },
        66,
      );
      let sendSettled = false;
      void send.then(
        () => { sendSettled = true; },
        () => { sendSettled = true; },
      );
      await vi.waitFor(() => expect(state.currentRuntimeTurnContext).not.toBeNull());

      await expect(runtime.shutdown()).rejects.toThrow(/terminal|finalization|handoff/i);

      expect(sendSettled).toBe(false);
      expect(state.session).toBe(session);
      expect(state.queue).toBe(queue);
      expect(state.currentRuntimeTurnContext?.identity.inboundSeq).toBe(66);
    } finally {
      db.close();
    }
  });

  it('terminalizes pre-evidence and pending per-chat admissions before shutdown clears their queue', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const durability = durabilityMock();
      const mapKey = '15550190032';
      const session = sessionStub();
      let releaseSessionShutdown!: () => void;
      session.shutdown.mockImplementation(() => new Promise<void>((resolve) => {
        releaseSessionShutdown = resolve;
      }));
      const managerId = state.managerIdFor(session);
      const owner = state.sessionOwnership.claim(mapKey, managerId);
      const makeOwnedContext = (seq: number, turnId: string): RuntimeTurnContext => {
        const base = context('per_chat', mapKey, seq, turnId);
        return {
          ...base,
          identity: { ...base.identity, managerId, generation: owner.generation },
        };
      };
      const first = makeOwnedContext(61, 'turn-shutdown-before-evidence');
      const second = makeOwnedContext(62, 'turn-shutdown-still-pending');
      const late = makeOwnedContext(65, 'turn-shutdown-late-admission');
      const queued = (runtimeContext: RuntimeTurnContext): QueuedTurn => ({
        sourceMessageId: runtimeContext.replay.sourceMessageId,
        receivedAtUnixSeconds: runtimeContext.replay.receivedAtUnixSeconds,
        conversationKey: runtimeContext.identity.conversationKey,
        chatJid: runtimeContext.identity.deliveryJid,
        senderJid: runtimeContext.replay.senderJid,
        senderName: runtimeContext.replay.senderName,
        text: runtimeContext.replay.text,
        isGroup: false,
        contentType: 'text',
        runtimeContext,
        inboundSeq: runtimeContext.identity.inboundSeq ?? undefined,
      });
      state.durability = durability;
      state.replyGuarantee = replyGuaranteeMock();
      state.chatSessions.set(mapKey, session);
      state.chatQueues.set(mapKey, queueStub(first.identity.deliveryJid));
      state.pendingSystemResults.mark(mapKey);

      expect(state.runtimeTurnCoordinator.enqueuePerChatRuntimeTurn(mapKey, queued(first))).toBe(true);
      expect(state.runtimeTurnCoordinator.enqueuePerChatRuntimeTurn(mapKey, queued(second))).toBe(true);
      await vi.waitFor(() => {
        expect(state.perChatTurnQueues.get(mapKey)?.activeTurn?.runtimeContext).toBe(first);
        expect(state.perChatInboundSeqQueue.get(mapKey)).toEqual([61]);
      });
      const runtimeQueue = state.perChatTurnQueues.get(mapKey);
      if (!runtimeQueue) throw new Error('per-chat runtime queue was not created');

      const shuttingDown = runtime.shutdown();
      await vi.waitFor(() => expect(session.shutdown).toHaveBeenCalledTimes(1));
      expect(state.runtimeTurnCoordinator.enqueuePerChatRuntimeTurn(mapKey, queued(late))).toBe(false);
      releaseSessionShutdown();
      await shuttingDown;
      await runtimeQueue.idle();

      expect(session.sendTurn).not.toHaveBeenCalledWith(first.replay.text);
      expect(session.sendTurn).not.toHaveBeenCalledWith(second.replay.text);
      expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: 'turn-shutdown-before-evidence',
          attemptKind: 'failed',
          attemptFailureClass: 'crash',
        }),
      }));
      expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: 'turn-shutdown-still-pending',
          attemptKind: 'admission_rejected',
        }),
      }));
      expect(durability.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminal: expect.objectContaining({
          logicalTurnId: 'turn-shutdown-late-admission',
          attemptKind: 'admission_rejected',
        }),
      }));
    } finally {
      db.close();
    }
  });

  it('retains shutdown state when a late rejected admission cannot reach its terminal sink', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const mapKey = '15550190036';
      const session = sessionStub();
      const queue = queueStub(`${mapKey}@s.whatsapp.net`);
      const late = context('per_chat', mapKey, 67, 'turn-shutdown-rejected-sink-failure');
      const lateTurn: QueuedTurn = {
        sourceMessageId: late.replay.sourceMessageId,
        receivedAtUnixSeconds: late.replay.receivedAtUnixSeconds,
        conversationKey: late.identity.conversationKey,
        chatJid: late.identity.deliveryJid,
        senderJid: late.replay.senderJid,
        senderName: late.replay.senderName,
        text: late.replay.text,
        isGroup: false,
        contentType: 'text',
        runtimeContext: late,
        inboundSeq: late.identity.inboundSeq ?? undefined,
      };
      let releaseSessionShutdown!: () => void;
      session.shutdown.mockImplementation(() => new Promise<void>((resolve) => {
        releaseSessionShutdown = resolve;
      }));
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.chatSessions.set(mapKey, session);
      state.chatQueues.set(mapKey, queue);

      const shuttingDown = runtime.shutdown();
      await vi.waitFor(() => expect(session.shutdown).toHaveBeenCalledTimes(1));
      state.durability = null as never;
      state.runtimeTurnCoordinator.finalizeRejectedRuntimeTurn(lateTurn);
      releaseSessionShutdown();

      await expect(shuttingDown).rejects.toThrow(/rejected|finalization|durability/i);
      expect(state.chatSessions.get(mapKey)).toBe(session);
      expect(state.chatQueues.get(mapKey)).toBe(queue);
    } finally {
      db.close();
    }
  });

  it('does not repaint a durability-closed session checkpoint as suspended', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db);
      const runtimeContext = context('singleton', '15550190013', 43, 'turn-closed-checkpoint');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      const session = sessionStub();
      session.getStatus.mockReturnValue({
        active: false,
        sessionId: 'session-closed',
        pid: 4300,
        durableFailureClosed: true,
      });
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.currentRuntimeTurnContext = runtimeContext;
      state.currentInboundSeq = 43;

      await state.runtimeTurnCoordinator.finalizeRuntimeTurnContext({
        context: runtimeContext,
        queue,
        attemptOutcome: { kind: 'failed', class: 'crash' },
        session,
      });

      const call = state.durability.finalizeTurnTerminal.mock.calls[0]?.[0] as {
        bookkeeping: { checkpoint: { fields: Record<string, unknown> } };
      } | undefined;
      expect(call).toBeDefined();
      expect(call!.bookkeeping.checkpoint.fields).not.toHaveProperty('sessionStatus');
      expect(call!.bookkeeping.checkpoint.fields).toMatchObject({
        activeTurnId: null,
        lastInboundSeq: 43,
      });
    } finally {
      db.close();
    }
  });

  it('does not repaint an inconclusive durable checkpoint as suspended', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db);
      const runtimeContext = context('singleton', '15550190014', 44, 'turn-inconclusive-checkpoint');
      const queue = queueStub(runtimeContext.identity.deliveryJid);
      const session = sessionStub();
      session.getStatus.mockReturnValue({
        active: false,
        sessionId: null,
        pid: null,
        durableFailureClosed: false,
        durableFailureInconclusive: true,
      });
      state.durability = durabilityMock();
      state.replyGuarantee = replyGuaranteeMock();
      state.currentRuntimeTurnContext = runtimeContext;
      state.currentInboundSeq = 44;

      await state.runtimeTurnCoordinator.finalizeRuntimeTurnContext({
        context: runtimeContext,
        queue,
        attemptOutcome: { kind: 'failed', class: 'crash' },
        session,
      });

      const call = state.durability.finalizeTurnTerminal.mock.calls[0]?.[0] as {
        bookkeeping: { checkpoint: { fields: Record<string, unknown> } };
      } | undefined;
      expect(call).toBeDefined();
      expect(call!.bookkeeping.checkpoint.fields).not.toHaveProperty('sessionStatus');
      expect(call!.bookkeeping.checkpoint.fields).toMatchObject({
        activeTurnId: null,
        lastInboundSeq: 44,
      });
    } finally {
      db.close();
    }
  });

  it('flushes a per-chat system result without consuming the user terminal owner', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });
      const durability = durabilityMock();
      const guarantee = replyGuaranteeMock();
      const queue = queueStub('15550190041@s.whatsapp.net');
      state.durability = durability;
      state.replyGuarantee = guarantee;

      state.handleEventWithContext(
        { type: 'result', text: null },
        queue,
        sessionStub(),
        '15550190041',
        51,
        '15550190041',
        '15550190041#session',
        true,
      );

      await vi.waitFor(() => expect(queue.flush).toHaveBeenCalledOnce());
      expect(durability.finalizeTurnTerminal).not.toHaveBeenCalled();
      expect(guarantee.disarm).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('normalizes assistant item snapshots without duplicating completed text', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const { runtime, state } = makeRuntimeState(db, {
        sessionScope: 'per_chat',
      });

      expect(state.normalizeAssistantTextForDelivery({
        type: 'assistant_text', itemId: 'item-edge', text: 'Hello ', complete: false,
      }, 'delta-edge@s.whatsapp.net')).toBe('Hello ');
      expect(state.normalizeAssistantTextForDelivery({
        type: 'assistant_text', itemId: 'item-edge', text: 'Hello world', complete: true,
      }, 'delta-edge@s.whatsapp.net')).toBe('world');
      expect(state.normalizeAssistantTextForDelivery({
        type: 'assistant_text', itemId: 'same-edge', text: 'same text', complete: false,
      })).toBe('same text');
      expect(state.normalizeAssistantTextForDelivery({
        type: 'assistant_text', itemId: 'same-edge', text: 'same text', complete: true,
      })).toBeNull();
      expect(state.normalizeAssistantTextForDelivery({
        type: 'assistant_text', itemId: 'replace-edge', text: 'prior', complete: false,
      })).toBe('prior');
      expect(state.normalizeAssistantTextForDelivery({
        type: 'assistant_text', itemId: 'replace-edge', text: 'replacement', complete: true,
      })).toBe('replacement');

      const queue = queueStub('ignored-edge@s.whatsapp.net');
      for (const event of [
        { type: 'parse_error', line: '{bad' },
        { type: 'unknown_block', blockType: 'future_side_effect', raw: { type: 'future_side_effect' } },
      ] satisfies AgentEvent[]) {
        state.handleEventWithContext(event, queue, sessionStub());
        expect(runtimeLogger.debug).toHaveBeenCalledWith(
          { event },
          'ignored/unknown_block/unknown/parse_error event',
        );
      }
    } finally {
      db.close();
    }
  });
});
