import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeTurnCoordinator, type RuntimeTurnCoordinatorPort } from '../../../src/runtimes/agent/runtime-turn-coordinator.ts';
import { createRuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { AttemptOutcome } from '../../../src/runtimes/agent/turn-terminal.ts';

const emitAlertChecked = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked,
}));

function context() {
  return createRuntimeTurnContext({
    identity: {
      scope: 'per_chat',
      conversationKey: '15550190099',
      deliveryJid: '15550190099@s.whatsapp.net',
      inboundSeq: 41,
      logicalTurnId: 'turn-bookkeeping-41',
      managerId: 'manager-bookkeeping',
      generation: 1,
    },
    recoveryOwner: {
      logicalTurnId: 'turn-bookkeeping-41-recovery',
      managerId: 'manager-bookkeeping-recovery',
      generation: 1,
    },
    replay: {
      sourceMessageId: 'wamid-bookkeeping-41',
      replaySafe: true,
      senderJid: '15550190099@s.whatsapp.net',
      senderName: null,
      text: 'hello',
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: '15550190099#session',
  });
}

function makeCoordinator(): RuntimeTurnCoordinator {
  const host = {
    instanceName: 'bookkeeping-test',
    runtimeTurnSupervisor: {
      scopeKey: vi.fn(() => 'per_chat:15550190099'),
    },
  } as unknown as RuntimeTurnCoordinatorPort;
  return new RuntimeTurnCoordinator(host);
}

function sessionWithRowId(rowId: number | null) {
  return {
    getDbRowId: vi.fn(() => rowId),
    getStatus: vi.fn(() => ({ active: true, sessionId: 'sess-1', pid: 123 })),
  } as unknown as Parameters<RuntimeTurnCoordinator['turnFinalizationBookkeeping']>[1];
}

const resultEventWithUsage: Extract<AgentEvent, { type: 'result' }> = {
  type: 'result',
  text: null,
  inputTokens: 500,
  outputTokens: 40,
};

describe('turnFinalizationBookkeeping — token-loss visibility (#1775)', () => {
  beforeEach(() => {
    emitAlertChecked.mockClear();
  });

  it('records sessionTokens and stays silent when the result event carries usage', () => {
    const coordinator = makeCoordinator();
    const params = coordinator.turnFinalizationBookkeeping(
      context(),
      sessionWithRowId(7),
      resultEventWithUsage,
      { kind: 'completed' },
    );

    expect(params.sessionTokens).toEqual({ dbRowId: 7, inputTokens: 500, outputTokens: 40, cacheReadTokens: 0 });
    expect(emitAlertChecked).not.toHaveBeenCalled();
  });

  it('alerts when a dispatched turn (crash) finalizes with no result event and cannot record usage', () => {
    const coordinator = makeCoordinator();
    const crashOutcome: AttemptOutcome = { kind: 'failed', class: 'crash' };

    const params = coordinator.turnFinalizationBookkeeping(
      context(),
      sessionWithRowId(9),
      undefined,
      crashOutcome,
    );

    expect(params.sessionTokens).toBeUndefined();
    expect(emitAlertChecked).toHaveBeenCalledTimes(1);
    const [instanceName, source] = emitAlertChecked.mock.calls[0] as unknown as [string, string, string, string, string?];
    expect(instanceName).toBe('bookkeeping-test');
    expect(source).toBe('agent_turn_usage_unavailable');
  });

  it('alerts when a dispatched turn (processor_throw) finalizes with an event that carries no usage', () => {
    const coordinator = makeCoordinator();
    const noUsageEvent: Extract<AgentEvent, { type: 'result' }> = { type: 'result', text: null };

    const params = coordinator.turnFinalizationBookkeeping(
      context(),
      sessionWithRowId(11),
      noUsageEvent,
      { kind: 'failed', class: 'processor_throw' },
    );

    expect(params.sessionTokens).toBeUndefined();
    expect(emitAlertChecked).toHaveBeenCalledTimes(1);
  });

  it('does NOT alert when the turn was never dispatched (admission_rejected)', () => {
    const coordinator = makeCoordinator();

    const params = coordinator.turnFinalizationBookkeeping(
      context(),
      sessionWithRowId(13),
      undefined,
      { kind: 'admission_rejected' },
    );

    expect(params.sessionTokens).toBeUndefined();
    expect(emitAlertChecked).not.toHaveBeenCalled();
  });

  it('does NOT alert when there is no db row to attribute the loss to', () => {
    const coordinator = makeCoordinator();

    const params = coordinator.turnFinalizationBookkeeping(
      context(),
      sessionWithRowId(null),
      undefined,
      { kind: 'failed', class: 'crash' },
    );

    expect(params.sessionTokens).toBeUndefined();
    expect(emitAlertChecked).not.toHaveBeenCalled();
  });
});

describe('finalizePerChatProcessorError — contextless turn must not halt the chat (C-F3)', () => {
  const MAP_KEY = 'chatA';
  const CHAT_JID = 'chatA@s.whatsapp.net';

  function makeCoordinatorWithHost() {
    const queue = { abortTurn: vi.fn() };
    const host = {
      instanceName: 'cf3-test',
      getQueueForChat: vi.fn(() => queue),
      replyGuarantee: { disarm: vi.fn(), arm: vi.fn() },
      perChatRuntimeTurnContexts: new Map<string, unknown>(),
      perChatTurnText: new Map<string, string>([[MAP_KEY, 'partial']]),
      perChatTurnSourceMessageId: new Map<string, string>([[MAP_KEY, 'wamid-x']]),
      perChatTurnContentType: new Map<string, string>([[MAP_KEY, 'text']]),
      perChatTurnSuppressedReplySatisfaction: new Set<string>([MAP_KEY]),
      perChatAssistantItemText: new Map<string, unknown>([[MAP_KEY, {}]]),
      perChatRouteMarkerHold: new Map<string, string>([[MAP_KEY, '']]),
    } as unknown as RuntimeTurnCoordinatorPort;
    return { coordinator: new RuntimeTurnCoordinator(host), host: host as unknown as {
      getQueueForChat: ReturnType<typeof vi.fn>;
      replyGuarantee: { disarm: ReturnType<typeof vi.fn> };
      perChatTurnText: Map<string, string>;
    }, queue };
  }

  const contextlessTurn = {
    sourceMessageId: 'wamid-x',
    conversationKey: MAP_KEY,
    chatJid: CHAT_JID,
    senderJid: 'sender@s.whatsapp.net',
    senderName: null,
    text: 'scheduled job',
    isGroup: false,
    contentType: 'text' as const,
    // No runtimeContext, no inboundSeq — a scheduled agent job / access-replay.
  };

  it('cleans up and returns instead of throwing for a contextless per-chat turn', async () => {
    const { coordinator, host, queue } = makeCoordinatorWithHost();

    // RED before the fix: this rejects with 'has no immutable runtime turn context',
    // which sets TurnQueue.halted (never reset) and silences the chat forever.
    await expect(
      (coordinator as unknown as {
        finalizePerChatProcessorError: (k: string, t: unknown, e: unknown) => Promise<void>;
      }).finalizePerChatProcessorError(MAP_KEY, contextlessTurn, new Error('provider dispatch failed')),
      'a contextless processor throw must be tolerated, not halt the chat (parity with the shared path)',
    ).resolves.toBeUndefined();

    expect(queue.abortTurn, 'the aborted turn must be cleared').toHaveBeenCalled();
    expect(host.replyGuarantee.disarm).toHaveBeenCalled();
    expect(host.perChatTurnText.has(MAP_KEY), 'stale per-chat scratch must be cleared').toBe(false);
  });

  it('still throws for a context-bearing turn with no outbound queue (genuine halt preserved)', async () => {
    // The tolerant branch must not swallow a real accounting failure; a turn WITH
    // a context that cannot be finalized must still throw (Family B).
    const { coordinator, host } = makeCoordinatorWithHost();
    (host as unknown as { getQueueForChat: ReturnType<typeof vi.fn> }).getQueueForChat.mockReturnValue(undefined);
    const withContext = { ...contextlessTurn, inboundSeq: 7, runtimeContext: context() };

    await expect(
      (coordinator as unknown as {
        finalizePerChatProcessorError: (k: string, t: unknown, e: unknown) => Promise<void>;
      }).finalizePerChatProcessorError(MAP_KEY, withContext, new Error('boom')),
      'a context-bearing turn that cannot finalize must still halt — the guard is preserved',
    ).rejects.toThrow();
  });
});
