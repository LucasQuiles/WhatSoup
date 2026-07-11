import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../../../src/config.ts';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { createRuntimeTurnContext, type RuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import type { QueuedTurn } from '../../../src/runtimes/agent/turn-queue.ts';
import { makeMessenger } from './lib/session-harness.ts';

vi.mock('../../../src/logger.ts', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    default: { ...logger, child: () => logger },
    createChildLogger: () => logger,
    flushLogger: () => Promise.resolve(),
  };
});

interface RuntimeState {
  turnQueue: { enqueue(turn: QueuedTurn): boolean; idle(): Promise<void> };
  chatQueues: Map<string, IOutboundQueue>;
  outboundQueues: Map<string, IOutboundQueue>;
  perChatRuntimeTurnContexts: Map<string, RuntimeTurnContext[]>;
  perChatInboundSeqQueue: Map<string, number[]>;
  perChatRuntimeTurnScopeRefs: Map<string, { value: string }>;
  pendingTurnText: Map<string, string>;
  pendingTurnActorJid: Map<string, string | undefined>;
  runtimeTurnCoordinator: {
    consumeRuntimeTurnContinuationDeferral(context: RuntimeTurnContext): boolean;
  };
  enqueuePerChatRuntimeTurn(mapKey: string, turn: QueuedTurn): boolean;
  finalizePerChatProcessorError(mapKey: string, turn: QueuedTurn, error: unknown): Promise<void>;
  finalizeRuntimeTurnContext(args: {
    context: RuntimeTurnContext;
    queue: IOutboundQueue;
    attemptOutcome: { kind: 'completed' } | { kind: 'failed'; class: 'usage-limit' };
    session: null;
    mapKey: string;
    clearReplayOnSuccess: boolean;
  }): Promise<unknown>;
  scheduleFallbackReplay(args: {
    activation: {
      primaryProvider: string;
      fallbackProvider: string;
      fallbackModel: string | undefined;
      reason: 'usage-limit';
      resetAt: Date | null;
      activeUntil: number;
      extended: boolean;
      keyPresent: boolean | null;
      recoveryProbeRequired: boolean;
    };
    chatJid: string;
    mapKey: string;
    oldSession: null;
    hadToolActivity: boolean;
  }): boolean;
  replayTurnOnFallback(args: unknown): Promise<void>;
  setOwnedPerChatSession(mapKey: string, session: {
    bindGenerationOwnership(resolver: () => unknown): void;
    getStatus(): { active: boolean };
  }): void;
}

const ORIGINAL_MAX_DEPTH = config.agentMaxQueueDepth;
const mutableConfig = config as { agentMaxQueueDepth: number };

function context(
  scope: 'per_chat' | 'shared',
  inboundSeq: number,
  logicalTurnId: string,
  deliveryJid = '15550170001:3@s.whatsapp.net',
): RuntimeTurnContext {
  const conversationKey = '15550170001';
  return createRuntimeTurnContext({
    identity: {
      scope,
      conversationKey,
      deliveryJid,
      inboundSeq,
      logicalTurnId,
      managerId: `manager-${scope}`,
      generation: 1,
    },
    recoveryOwner: {
      logicalTurnId: `${logicalTurnId}:recovery`,
      managerId: 'recovery-manager',
      generation: 2,
    },
    replay: {
      sourceMessageId: `wamid-${logicalTurnId}`,
      replaySafe: true,
      senderJid: '15550170002@s.whatsapp.net',
      senderName: 'Sender',
      text: 'exact transformed text',
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: scope === 'per_chat' ? conversationKey : '__global__',
  });
}

function turn(runtimeContext: RuntimeTurnContext): QueuedTurn {
  return {
    sourceMessageId: runtimeContext.replay.sourceMessageId,
    conversationKey: runtimeContext.identity.conversationKey,
    chatJid: runtimeContext.identity.deliveryJid,
    senderJid: runtimeContext.replay.senderJid,
    senderName: runtimeContext.replay.senderName,
    text: runtimeContext.replay.text,
    isGroup: runtimeContext.replay.isGroup,
    contentType: runtimeContext.contentType,
    runtimeContext,
    inboundSeq: runtimeContext.identity.inboundSeq ?? undefined,
  };
}

function evidenceQueue(): IOutboundQueue {
  return {
    targetChatJid: '15550170001:3@s.whatsapp.net',
    beginTurnEvidence: vi.fn(),
    flushTurnEvidence: vi.fn(async (turnId: string) => ({
      turnId,
      answerOpIds: [],
      lifecycleOpIds: [],
      statusOpIds: [],
    })),
    setInboundSeq: vi.fn(),
    clearLastOpId: vi.fn(),
  } as unknown as IOutboundQueue;
}

function journal(
  durability: DurabilityEngine,
  messageId: string,
  deliveryJid = '15550170001:3@s.whatsapp.net',
): number {
  return durability.journalInbound(messageId, '15550170001', deliveryJid, 'agent');
}

describe('runtime terminal transaction reachability', () => {
  beforeEach(() => {
    mutableConfig.agentMaxQueueDepth = 0;
  });

  afterEach(() => {
    mutableConfig.agentMaxQueueDepth = ORIGINAL_MAX_DEPTH;
    vi.restoreAllMocks();
  });

  it('finalizes a per-chat processor throw before advancing its FIFO', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'terminal-matrix', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);
      const state = runtime as unknown as RuntimeState;
      const seq = journal(durability, 'wamid-turn-processor-throw');
      const runtimeContext = context('per_chat', seq, 'turn-processor-throw');
      const mapKey = runtimeContext.identity.conversationKey;
      state.chatQueues.set(mapKey, evidenceQueue());
      state.perChatRuntimeTurnContexts.set(mapKey, [runtimeContext]);
      state.perChatInboundSeqQueue.set(mapKey, [seq]);

      await state.finalizePerChatProcessorError(
        mapKey,
        turn(runtimeContext),
        new Error('processor exploded'),
      );

      expect(durability.getTurnTerminal(seq, 'turn-processor-throw', 1)).toMatchObject({
        attempt_kind: 'failed',
        attempt_failure_class: 'processor_throw',
        inbound_disposition: 'failed_terminal',
      });
      expect(state.perChatRuntimeTurnContexts.has(mapKey)).toBe(false);
      expect(state.perChatInboundSeqQueue.has(mapKey)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('settles a processor failure before provider dispatch as admission rejection', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'terminal-matrix', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);
      const state = runtime as unknown as RuntimeState;
      const seq = journal(durability, 'wamid-turn-pre-dispatch-throw');
      const runtimeContext = context('per_chat', seq, 'turn-pre-dispatch-throw');
      const mapKey = runtimeContext.identity.conversationKey;
      state.chatQueues.set(mapKey, evidenceQueue());
      state.perChatInboundSeqQueue.set(mapKey, [seq]);

      await expect(state.finalizePerChatProcessorError(
        mapKey,
        turn(runtimeContext),
        new Error('spawn failed before dispatch'),
      )).resolves.toBeUndefined();

      expect(durability.getTurnTerminal(seq, 'turn-pre-dispatch-throw', 1)).toMatchObject({
        attempt_kind: 'admission_rejected',
        inbound_disposition: 'failed_terminal',
      });
      expect(state.perChatInboundSeqQueue.has(mapKey)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('settles a shared processor failure before context publication as admission rejection', async () => {
    mutableConfig.agentMaxQueueDepth = 25;
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'terminal-matrix', {
        shared: true,
      });
      runtime.setDurability(durability);
      const state = runtime as unknown as RuntimeState;
      const logicalTurnId = 'turn-shared-processor-throw';
      const seq = journal(durability, `wamid-${logicalTurnId}`);
      const runtimeContext = context('shared', seq, logicalTurnId);
      state.outboundQueues.set(runtimeContext.identity.deliveryJid, evidenceQueue());

      expect(state.turnQueue.enqueue(turn(runtimeContext))).toBe(true);
      await state.turnQueue.idle();

      expect(durability.getTurnTerminal(seq, logicalTurnId, 1)).toMatchObject({
        attempt_kind: 'admission_rejected',
        attempt_failure_class: null,
        inbound_disposition: 'failed_terminal',
      });
    } finally {
      db.close();
    }
  });

  it.each([
    { scope: 'per_chat' as const, logicalTurnId: 'turn-rejected-per-chat' },
    { scope: 'shared' as const, logicalTurnId: 'turn-rejected-shared' },
  ])('terminalizes a journaled $scope queue rejection as admission_rejected', ({ scope, logicalTurnId }) => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'terminal-matrix', {
        ...(scope === 'per_chat' ? { sessionScope: 'per_chat' as const } : { shared: true }),
      });
      runtime.setDurability(durability);
      const state = runtime as unknown as RuntimeState;
      const seq = journal(durability, `wamid-${logicalTurnId}`);
      const runtimeContext = context(scope, seq, logicalTurnId);
      const queuedTurn = turn(runtimeContext);

      const accepted = scope === 'per_chat'
        ? state.enqueuePerChatRuntimeTurn(runtimeContext.identity.conversationKey, queuedTurn)
        : state.turnQueue.enqueue(queuedTurn);

      expect(accepted).toBe(false);
      expect(durability.getTurnTerminal(seq, logicalTurnId, 1)).toMatchObject({
        attempt_kind: 'admission_rejected',
        inbound_disposition: 'failed_terminal',
        delivery_kind: 'none',
      });
      expect(durability.getInboundStatus(seq)).toBe('failed');
    } finally {
      db.close();
    }
  });

  it('continues fallback under the original terminal owner without creating a recovery job', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'terminal-matrix', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);
      const state = runtime as unknown as RuntimeState;
      const seq = journal(durability, 'wamid-turn-fallback-replay');
      const runtimeContext = context('per_chat', seq, 'turn-fallback-replay');
      const mapKey = runtimeContext.identity.conversationKey;
      const queue = evidenceQueue();
      state.chatQueues.set(mapKey, queue);
      state.perChatRuntimeTurnContexts.set(mapKey, [runtimeContext]);
      state.perChatInboundSeqQueue.set(mapKey, [seq]);
      state.pendingTurnText.set(mapKey, runtimeContext.replay.text);
      state.pendingTurnActorJid.set(mapKey, runtimeContext.replay.senderJid);
      const replay = vi.spyOn(state, 'replayTurnOnFallback').mockResolvedValue(undefined);

      expect(state.scheduleFallbackReplay({
        activation: {
          primaryProvider: 'claude-cli',
          fallbackProvider: 'codex-cli',
          fallbackModel: undefined,
          reason: 'usage-limit',
          resetAt: null,
          activeUntil: Date.now() + 60_000,
          extended: false,
          keyPresent: true,
          recoveryProbeRequired: true,
        },
        chatJid: runtimeContext.identity.deliveryJid,
        mapKey,
        oldSession: null,
        hadToolActivity: false,
      })).toBe(true);
      expect(replay).toHaveBeenCalledOnce();
      expect(state.runtimeTurnCoordinator.consumeRuntimeTurnContinuationDeferral(runtimeContext))
        .toBe(true);
      expect(durability.getTurnRecoveryJobBySource({
        inboundSeq: seq,
        logicalTurnId: runtimeContext.identity.logicalTurnId,
        generation: runtimeContext.identity.generation,
      })).toBeUndefined();

      await state.finalizeRuntimeTurnContext({
        context: runtimeContext,
        queue,
        attemptOutcome: { kind: 'failed', class: 'usage-limit' },
        session: null,
        mapKey,
        clearReplayOnSuccess: false,
      });

      expect(durability.getTurnRecoveryJobBySource({
        inboundSeq: seq,
        logicalTurnId: runtimeContext.identity.logicalTurnId,
        generation: runtimeContext.identity.generation,
      })).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('freezes answer delivery identity until terminal evidence commits, then re-keys', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'terminal-matrix', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);
      const state = runtime as unknown as RuntimeState;
      const lidKey = '15550170001@lid';
      const seq = journal(durability, 'wamid-turn-rekey', lidKey);
      const runtimeContext = context('per_chat', seq, 'turn-rekey', lidKey);
      const canonicalJid = `${runtimeContext.identity.conversationKey}@s.whatsapp.net`;
      const answerOpId = durability.createOutboundOp({
        conversationKey: runtimeContext.identity.conversationKey,
        chatJid: lidKey,
        opType: 'send_text',
        payload: '{"text":"answer"}',
        replayPolicy: 'safe',
        sourceInboundSeq: seq,
      });
      durability.markSending(answerOpId);
      durability.markSubmitted(answerOpId, 'wamid-answer-before-rekey');
      durability.markEchoed(answerOpId);
      let releaseEvidence!: () => void;
      const evidenceReady = new Promise<void>((resolve) => { releaseEvidence = resolve; });
      const queue = {
        ...evidenceQueue(),
        updateDeliveryJid: vi.fn(),
        flushTurnEvidence: vi.fn(async (turnId: string) => {
          await evidenceReady;
          return { turnId, answerOpIds: [answerOpId], lifecycleOpIds: [], statusOpIds: [] };
        }),
      } as unknown as IOutboundQueue;
      const scopeRef = { value: lidKey };
      const session = {
        bindGenerationOwnership: vi.fn(),
        getStatus: vi.fn(() => ({ active: true })),
      };
      state.setOwnedPerChatSession(lidKey, session);
      state.chatQueues.set(lidKey, queue);
      state.perChatRuntimeTurnContexts.set(lidKey, [runtimeContext]);
      state.perChatInboundSeqQueue.set(lidKey, [seq]);
      state.perChatRuntimeTurnScopeRefs.set(runtimeContext.identity.logicalTurnId, scopeRef);

      const finalization = state.finalizeRuntimeTurnContext({
        context: runtimeContext,
        queue,
        attemptOutcome: { kind: 'completed' },
        session: null,
        mapKey: lidKey,
        clearReplayOnSuccess: true,
      });
      await vi.waitFor(() => expect(queue.flushTurnEvidence).toHaveBeenCalledOnce());

      runtime.handleJidAliasChanged(runtimeContext.identity.conversationKey, canonicalJid);
      expect(scopeRef.value).toBe(lidKey);
      expect(state.chatQueues.has(lidKey)).toBe(true);
      expect(state.chatQueues.has(canonicalJid)).toBe(false);
      expect(queue.updateDeliveryJid).not.toHaveBeenCalled();
      releaseEvidence();
      await expect(finalization).resolves.toMatchObject({ kind: 'terminal' });

      expect(durability.getTurnTerminal(seq, runtimeContext.identity.logicalTurnId, 1)).toMatchObject({
        delivery_jid: lidKey,
        delivery_kind: 'echoed',
        delivery_op_id: answerOpId,
      });
      expect(state.chatQueues.has(lidKey)).toBe(false);
      expect(state.chatQueues.get(canonicalJid)).toBe(queue);
      expect(queue.updateDeliveryJid).toHaveBeenCalledWith(canonicalJid);
      expect(state.perChatRuntimeTurnContexts.has(canonicalJid)).toBe(false);
      expect(state.perChatInboundSeqQueue.has(canonicalJid)).toBe(false);
    } finally {
      db.close();
    }
  });
});
