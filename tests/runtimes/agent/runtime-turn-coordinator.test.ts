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
