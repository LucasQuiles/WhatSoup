import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { createRuntimeTurnContext, type RuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type TurnTerminalResult,
} from '../../../src/runtimes/agent/turn-terminal.ts';
import type { QueuedTurn } from '../../../src/runtimes/agent/turn-queue.ts';
import { makeMessenger } from './lib/session-harness.ts';

const emitAlert = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/emit-alert.ts')>(),
  emitAlert,
}));

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

interface RetryResult {
  attempted: number;
  recovered: number;
  remaining: number;
  degradedScopes: number;
}

interface RuntimeState {
  chatQueues: Map<string, IOutboundQueue>;
  perChatRuntimeTurnContexts: Map<string, RuntimeTurnContext[]>;
  perChatInboundSeqQueue: Map<string, number[]>;
  finalizePerChatProcessorError(mapKey: string, turn: QueuedTurn, error: unknown): Promise<void>;
  retryRuntimeTurnFinalizations(): Promise<RetryResult>;
}

function recoveryCounts(
  overrides: Partial<ReturnType<DurabilityEngine['getTurnRecoverySupervisorCounts']>> = {},
): ReturnType<DurabilityEngine['getTurnRecoverySupervisorCounts']> {
  return {
    outstanding: 0,
    blockedUnsafe: 0,
    pending: 0,
    liveClaimed: 0,
    expiredClaimed: 0,
    exhausted: 0,
    quarantinedDelivery: 0,
    corruptLinks: 0,
    orphanTransfers: 0,
    echoConflicts: 0,
    openRecoveries: 0,
    ...overrides,
  };
}

function context(inboundSeq: number, logicalTurnId: string): RuntimeTurnContext {
  return createRuntimeTurnContext({
    identity: {
      scope: 'per_chat',
      conversationKey: '15550180001',
      deliveryJid: '15550180001:4@s.whatsapp.net',
      inboundSeq,
      logicalTurnId,
      managerId: 'manager-primary',
      generation: 1,
    },
    recoveryOwner: {
      logicalTurnId: `${logicalTurnId}:recovery`,
      managerId: 'manager-recovery',
      generation: 2,
    },
    replay: {
      sourceMessageId: `wamid-${logicalTurnId}`,
      replaySafe: true,
      senderJid: '15550180002@s.whatsapp.net',
      senderName: null,
      text: 'exact transformed retry text',
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: '15550180001',
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

function installTurn(
  runtime: AgentRuntime,
  durability: DurabilityEngine,
  logicalTurnId: string,
): { state: RuntimeState; context: RuntimeTurnContext; queue: IOutboundQueue; seq: number } {
  const seq = durability.journalInbound(
    `wamid-${logicalTurnId}`,
    '15550180001',
    '15550180001:4@s.whatsapp.net',
    'agent',
  );
  const runtimeContext = context(seq, logicalTurnId);
  const queue = {
    flushTurnEvidence: vi.fn(async (turnId: string) => ({
      turnId,
      answerOpIds: [],
      lifecycleOpIds: [],
      statusOpIds: [],
    })),
    clearLastOpId: vi.fn(),
  } as unknown as IOutboundQueue;
  const state = runtime as unknown as RuntimeState;
  const mapKey = runtimeContext.identity.conversationKey;
  state.chatQueues.set(mapKey, queue);
  state.perChatRuntimeTurnContexts.set(mapKey, [runtimeContext]);
  state.perChatInboundSeqQueue.set(mapKey, [seq]);
  return { state, context: runtimeContext, queue, seq };
}

describe('runtime turn finalization recovery health', () => {
  beforeEach(() => {
    emitAlert.mockReset();
    emitAlert.mockReturnValue({ ok: true, channel: 'outbox', status: 'durably_queued' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a lone blocked-unsafe receipt informational and healthy', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      vi.spyOn(durability, 'getTurnRecoverySupervisorCounts').mockReturnValue(
        recoveryCounts({ blockedUnsafe: 1 }),
      );
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'blocked-health', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);

      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'healthy',
        details: {
          turnRecoveryOutstanding: 0,
          turnRecoveryBlockedUnsafe: 1,
          turnRecoveryOpenRecoveries: 0,
        },
      });
    } finally {
      db.close();
    }
  });

  it('keeps blocked-unsafe informational while open catch-up independently degrades health', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      vi.spyOn(durability, 'getTurnRecoverySupervisorCounts').mockReturnValue(
        recoveryCounts({ blockedUnsafe: 3, openRecoveries: 11 }),
      );
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'blocked-open-health', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);

      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'degraded',
        details: {
          turnRecoveryOutstanding: 0,
          turnRecoveryBlockedUnsafe: 3,
          turnRecoveryOpenRecoveries: 11,
        },
      });
    } finally {
      db.close();
    }
  });

  it('degrades for exhausted work without treating it as admission-blocking', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      vi.spyOn(durability, 'getTurnRecoverySupervisorCounts').mockReturnValue(
        recoveryCounts({ exhausted: 1 }),
      );
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'exhausted-health', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);

      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'degraded',
        details: {
          turnRecoveryOutstanding: 0,
          turnRecoveryExhausted: 1,
          turnRecoveryOpenRecoveries: 0,
        },
      });
    } finally {
      db.close();
    }
  });

  it('degrades while operator catch-up is open and returns healthy after closure', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const recoveryStats = vi.spyOn(durability, 'getTurnRecoverySupervisorCounts');
      recoveryStats.mockReturnValueOnce(recoveryCounts({ openRecoveries: 1 }));
      recoveryStats.mockReturnValue(recoveryCounts());
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'catch-up-health', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);

      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'degraded',
        details: { turnRecoveryOpenRecoveries: 1 },
      });
      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'healthy',
        details: { turnRecoveryOpenRecoveries: 0 },
      });
    } finally {
      db.close();
    }
  });

  it.each([
    {
      label: 'live claim',
      counts: recoveryCounts({ outstanding: 1, liveClaimed: 1 }),
      details: {
        turnRecoveryOutstanding: 1,
        turnRecoveryLiveClaimed: 1,
        turnRecoveryExpiredClaimed: 0,
      },
    },
    {
      label: 'expired claim',
      counts: recoveryCounts({ outstanding: 1, expiredClaimed: 1 }),
      details: {
        turnRecoveryOutstanding: 1,
        turnRecoveryLiveClaimed: 0,
        turnRecoveryExpiredClaimed: 1,
      },
    },
    {
      label: 'orphan transfer',
      counts: recoveryCounts({ outstanding: 1, corruptLinks: 1, orphanTransfers: 1 }),
      details: {
        turnRecoveryOutstanding: 1,
        turnRecoveryCorruptLinks: 1,
        turnRecoveryOrphanTransfers: 1,
      },
    },
    {
      label: 'corrupt link',
      counts: recoveryCounts({ corruptLinks: 1 }),
      details: { turnRecoveryOutstanding: 0, turnRecoveryCorruptLinks: 1 },
    },
    {
      label: 'quarantined active delivery',
      counts: recoveryCounts({
        outstanding: 1,
        pending: 1,
        quarantinedDelivery: 1,
      }),
      details: {
        turnRecoveryOutstanding: 1,
        turnRecoveryPending: 1,
        turnRecoveryQuarantinedDelivery: 1,
      },
    },
  ])('degrades for independent $label recovery evidence', ({ counts, details }) => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      vi.spyOn(durability, 'getTurnRecoverySupervisorCounts').mockReturnValue(counts);
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'independent-health', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);

      expect(runtime.getHealthSnapshot()).toMatchObject({ status: 'degraded', details });
    } finally {
      db.close();
    }
  });

  it('reports a completed recovery echo conflict as degraded audit health', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      vi.spyOn(durability, 'getTurnRecoverySupervisorCounts').mockReturnValue({
        outstanding: 0,
        blockedUnsafe: 0,
        pending: 0,
        liveClaimed: 0,
        expiredClaimed: 0,
        exhausted: 0,
        quarantinedDelivery: 0,
        corruptLinks: 0,
        orphanTransfers: 0,
        echoConflicts: 1,
        openRecoveries: 0,
      });
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'echo-conflict-health', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);

      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'degraded',
        details: {
          turnRecoveryOutstanding: 0,
          turnRecoveryEchoConflicts: 1,
        },
      });
    } finally {
      db.close();
    }
  });

  it('reports durable recovery obligations even when no in-memory retry exists', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'durable-recovery-health', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);
      const installed = installTurn(runtime, durability, 'turn-durable-recovery-health');
      const opId = durability.createOutboundOp({
        conversationKey: installed.context.identity.conversationKey,
        chatJid: installed.context.identity.deliveryJid,
        opType: 'text',
        payload: JSON.stringify({ text: 'selected unresolved answer' }),
        sourceInboundSeq: installed.seq,
        replayPolicy: 'unsafe',
      });
      const terminal: TurnTerminalResult = {
        identity: installed.context.identity,
        attemptOutcome: { kind: 'failed', class: 'transient-network' },
        inboundDisposition: 'transferred_to_recovery_owner',
        deliveryEvidence: { kind: 'enqueued', opId },
      };
      durability.finalizeTurnTerminal({
        ...toTurnFinalizationPersistence(terminal, installed.context.recoveryOwner),
        recoveryJob: toTurnRecoveryJobPersistence(
          terminal,
          installed.context.recoveryOwner,
          installed.context.replay,
        ),
      });

      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'degraded',
        details: {
          turnRecoveryOutstanding: 1,
          turnRecoveryPending: 1,
          turnRecoveryLiveClaimed: 0,
          turnRecoveryExpiredClaimed: 0,
          turnRecoveryBlockedUnsafe: 0,
          turnRecoveryExhausted: 0,
          turnRecoveryQuarantinedDelivery: 0,
          turnRecoveryCorruptLinks: 0,
        },
      });
    } finally {
      db.close();
    }
  });

  it('retains a bounded retry owner, reports degraded, and clears after retry succeeds', async () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const finalize = durability.finalizeTurnTerminal.bind(durability);
      let failTerminalWrite = true;
      vi.spyOn(durability, 'finalizeTurnTerminal').mockImplementation((params) => {
        if (failTerminalWrite) throw new Error('sqlite terminal write unavailable');
        return finalize(params);
      });
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'retry-health', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);
      const installed = installTurn(runtime, durability, 'turn-retry-health');

      const parked = installed.state.finalizePerChatProcessorError(
        installed.context.identity.conversationKey,
        turn(installed.context),
        new Error('processor failed'),
      );
      await vi.waitFor(() => {
        expect(runtime.getHealthSnapshot().details.turnFinalizationRetainedRetries).toBe(1);
      });

      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'degraded',
        details: {
          turnFinalizationRetainedRetries: 1,
          turnFinalizationDegradedScopes: 1,
        },
      });
      expect(installed.state.perChatInboundSeqQueue.get(installed.context.identity.conversationKey))
        .toEqual([installed.seq]);

      failTerminalWrite = false;
      await expect(installed.state.retryRuntimeTurnFinalizations()).resolves.toEqual({
        attempted: 1,
        recovered: 1,
        remaining: 0,
        degradedScopes: 0,
      });
      await parked;
      expect(installed.state.perChatInboundSeqQueue.has(installed.context.identity.conversationKey)).toBe(false);

      expect(durability.getTurnTerminal(installed.seq, installed.context.identity.logicalTurnId, 1))
        .toBeDefined();
      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'healthy',
        details: {
          turnFinalizationRetainedRetries: 0,
          turnFinalizationDegradedScopes: 0,
        },
      });
      expect(installed.queue.flushTurnEvidence).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('keeps a dual-sink failure sticky and blocked until the same terminal request recovers', async () => {
    emitAlert.mockReturnValue({
      ok: true,
      channel: 'legacy',
      status: 'legacy_accepted_unconfirmed',
    });
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      const finalize = durability.finalizeTurnTerminal.bind(durability);
      let failTerminalWrite = true;
      vi.spyOn(durability, 'finalizeTurnTerminal').mockImplementation((params) => {
        if (failTerminalWrite) throw new Error('sqlite terminal write unavailable');
        return finalize(params);
      });
      const runtime = new AgentRuntime(db, makeMessenger().messenger, 'dual-sink-health', {
        sessionScope: 'per_chat',
      });
      runtime.setDurability(durability);
      const installed = installTurn(runtime, durability, 'turn-dual-sink-health');
      const mapKey = installed.context.identity.conversationKey;

      let parkedSettled = false;
      const parked = installed.state.finalizePerChatProcessorError(
        mapKey,
        turn(installed.context),
        new Error('processor failed'),
      ).then(() => { parkedSettled = true; });
      await vi.waitFor(() => {
        expect(runtime.getHealthSnapshot().details.turnFinalizationRetainedRetries).toBe(1);
      });
      expect(parkedSettled).toBe(false);

      expect(installed.state.perChatInboundSeqQueue.get(mapKey)).toEqual([installed.seq]);
      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'degraded',
        details: {
          turnFinalizationRetainedRetries: 1,
          turnFinalizationDegradedScopes: 1,
        },
      });

      failTerminalWrite = false;
      await expect(installed.state.retryRuntimeTurnFinalizations()).resolves.toEqual({
        attempted: 1,
        recovered: 1,
        remaining: 0,
        degradedScopes: 0,
      });
      await parked;
      expect(parkedSettled).toBe(true);

      expect(installed.state.perChatInboundSeqQueue.has(mapKey)).toBe(false);
      expect(runtime.getHealthSnapshot()).toMatchObject({
        status: 'healthy',
        details: {
          turnFinalizationRetainedRetries: 0,
          turnFinalizationDegradedScopes: 0,
        },
      });
      expect(installed.queue.flushTurnEvidence).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });
});
