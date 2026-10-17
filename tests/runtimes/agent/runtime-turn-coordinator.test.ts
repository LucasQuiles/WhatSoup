import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeTurnCoordinator, type RuntimeTurnCoordinatorPort } from '../../../src/runtimes/agent/runtime-turn-coordinator.ts';
import { coordinatorPortDouble } from './lib/runtime-turn-coordinator-port-double.ts';
import { createRuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import type { AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import type { AttemptOutcome } from '../../../src/runtimes/agent/turn-terminal.ts';
import { Database } from '../../../src/core/database.ts';
import { DurabilityEngine } from '../../../src/core/durability.ts';
import { TurnQueue, type QueuedTurn } from '../../../src/runtimes/agent/turn-queue.ts';

const emitAlertChecked = vi.hoisted(() => vi.fn(() => true));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked,
  emitObservationChecked: vi.fn(() => true),
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
      receivedAtUnixSeconds: 1_780_000_000,
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
  const host = coordinatorPortDouble({
    instanceName: 'bookkeeping-test',
    runtimeTurnSupervisor: {
      scopeKey: vi.fn(() => 'per_chat:15550190099'),
      isDegraded: vi.fn(() => false),
    } as unknown as RuntimeTurnCoordinatorPort['runtimeTurnSupervisor'],
  });
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

  it('alerts when a journaled turn is rejected before dispatch and has no automatic replay owner', () => {
    const coordinator = makeCoordinator();

    const params = coordinator.turnFinalizationBookkeeping(
      context(),
      sessionWithRowId(13),
      undefined,
      { kind: 'admission_rejected', class: 'queue_closed' },
    );

    expect(params.sessionTokens).toBeUndefined();
    expect(emitAlertChecked).toHaveBeenCalledOnce();
    expect(emitAlertChecked).toHaveBeenCalledWith(
      'bookkeeping-test',
      'agent_turn_admission_rejected',
      'Journaled agent turn rejected before dispatch',
      expect.stringContaining('inbound_seq=41 reason=queue_closed automatic_replay=false'),
      'warning',
      undefined,
      undefined,
      { conversationKey: '15550190099' },
    );
    const [, , , evidence] = emitAlertChecked.mock.calls[0] as unknown as [string, string, string, string, ...unknown[]];
    expect(evidence).not.toContain('scope_blocked');
  });

  it('keeps unjournaled system-turn admission rejection out of BOT ERRORS', () => {
    const coordinator = makeCoordinator();
    const unjournaled = createRuntimeTurnContext({
      ...context(),
      identity: { ...context().identity, inboundSeq: null },
    });

    coordinator.turnFinalizationBookkeeping(
      unjournaled,
      null,
      undefined,
      { kind: 'admission_rejected', class: 'queue_closed' },
    );

    expect(emitAlertChecked).not.toHaveBeenCalled();
  });

  it('#3570: a scheduled-agent-job scope keeps usage but never writes the chat checkpoint, on every finalization path', () => {
    const coordinator = makeCoordinator();
    const scheduledScope = '15550190099@s.whatsapp.net::scheduled-agent-job';

    // Dispatched turn: the scope comes from the runtime's own per-turn map.
    const refs = (coordinator as unknown as {
      host: { perChatRuntimeTurnScopeRefs: Map<string, { value: string }> };
    }).host.perChatRuntimeTurnScopeRefs;
    refs.set(context().identity.logicalTurnId, { value: scheduledScope });
    const dispatched = coordinator.turnFinalizationBookkeeping(
      context(),
      sessionWithRowId(7),
      resultEventWithUsage,
      { kind: 'completed' },
    );
    expect(dispatched.checkpoint).toBeUndefined();
    expect(dispatched.sessionTokens).toEqual({ dbRowId: 7, inputTokens: 500, outputTokens: 40, cacheReadTokens: 0 });
    refs.clear();

    // Undispatched (or crash) turn: no scope ref, so the caller's scope key decides.
    const undispatched = coordinator.turnFinalizationBookkeeping(
      context(),
      null,
      undefined,
      { kind: 'admission_rejected', class: 'queue_closed' },
      scheduledScope,
    );
    expect(undispatched.checkpoint).toBeUndefined();

    // Control: the chat's own scope still writes its checkpoint.
    const interactive = coordinator.turnFinalizationBookkeeping(
      context(),
      sessionWithRowId(7),
      resultEventWithUsage,
      { kind: 'completed' },
      '15550190099@s.whatsapp.net',
    );
    expect(interactive.checkpoint).toEqual({
      conversationKey: '15550190099',
      fields: expect.objectContaining({ sessionId: 'sess-1', claudePid: 123, activeTurnId: null, lastInboundSeq: 41 }),
    });
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

describe('turnFinalizationBookkeeping — checkpoint status ownership (#3658)', () => {
  it('a turn finalized while its session is live reports the checkpoint active', () => {
    const params = makeCoordinator().turnFinalizationBookkeeping(
      context(),
      sessionWithRowId(7),
      resultEventWithUsage,
      { kind: 'completed' },
    );
    expect(params.checkpoint?.fields).toMatchObject({ sessionStatus: 'active' });
  });

  it('a turn finalized after its session was torn down keeps an ended checkpoint ended', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const durability = new DurabilityEngine(db);
      durability.upsertSessionCheckpoint('15550190099', {
        sessionId: 'ended-provider-session',
        sessionStatus: 'ended',
      });
      // The session's own shutdown already closed its lifecycle as ended.
      const tornDown = {
        getDbRowId: vi.fn(() => null),
        getStatus: vi.fn(() => ({
          active: false,
          sessionId: null,
          pid: null,
          durableFailureClosed: false,
          durableFailureInconclusive: false,
        })),
      } as unknown as Parameters<RuntimeTurnCoordinator['turnFinalizationBookkeeping']>[1];

      const params = makeCoordinator().turnFinalizationBookkeeping(
        context(),
        tornDown,
        undefined,
        { kind: 'failed', class: 'unknown_terminal' },
      );
      const checkpoint = params.checkpoint;
      if (checkpoint === undefined) throw new Error('bookkeeping wrote no checkpoint');
      // The same upsert the terminal transaction applies for this bookkeeping.
      durability.upsertSessionCheckpoint(checkpoint.conversationKey, checkpoint.fields);

      expect(durability.getSessionCheckpoint('15550190099')).toMatchObject({
        session_id: 'ended-provider-session',
        session_status: 'ended',
        last_inbound_seq: 41,
      });
    } finally {
      db.close();
    }
  });
});

describe('takePendingTurnsForPlannedStop — teardown ownership (#3703)', () => {
  function queuedTurn(id: string): QueuedTurn {
    return {
      sourceMessageId: id,
      receivedAtUnixSeconds: 1_780_000_000,
      conversationKey: `key-${id}`,
      chatJid: `${id}@s.whatsapp.net`,
      senderJid: `${id}@s.whatsapp.net`,
      senderName: null,
      text: id,
      isGroup: false,
      contentType: 'text',
    };
  }

  /** A queue with no processor keeps admitted turns pending. */
  function queueHolding(...ids: string[]): { queue: TurnQueue; turns: QueuedTurn[] } {
    const queue = new TurnQueue();
    const turns = ids.map(queuedTurn);
    for (const turn of turns) expect(queue.enqueue(turn)).toBe(true);
    return { queue, turns };
  }

  function coordinatorWith(turnQueue: TurnQueue, perChat: Array<[string, TurnQueue]>): RuntimeTurnCoordinator {
    return new RuntimeTurnCoordinator(coordinatorPortDouble({
      turnQueue,
      perChatTurnQueues: new Map(perChat),
    }));
  }

  it('leaves a queue owned by a kill teardown to that lifecycle and reports no failure', async () => {
    const global = queueHolding('g1');
    const owned = new TurnQueue();
    const coordinator = coordinatorWith(global.queue, [['chat-owned', owned]]);
    const transaction = await coordinator.terminalizePerChatTurnQueueForKill('chat-owned');
    const close = vi.spyOn(owned, 'closeAndTakePendingTurns');

    const result = coordinator.takePendingTurnsForPlannedStop();

    expect(result.closeFailures).toEqual([]);
    expect(result.turns).toEqual(global.turns);
    expect(close).not.toHaveBeenCalled();
    // The teardown receipt is untouched: its own lifecycle can still commit it.
    expect(() => owned.commitTeardown(transaction.receipt!)).not.toThrow();
  });

  it('returns a close failure of a queue no coordinator teardown owns instead of treating it as teardown', () => {
    const global = queueHolding('g1');
    const unowned = queueHolding('u1');
    // Same throw the queue raises under teardown, but no coordinator teardown owns it.
    unowned.queue.beginTeardown();
    const coordinator = coordinatorWith(global.queue, [['chat-unowned', unowned.queue]]);

    const result = coordinator.takePendingTurnsForPlannedStop();

    expect(result.turns).toEqual(global.turns);
    expect(result.closeFailures).toHaveLength(1);
    expect(String(result.closeFailures[0])).toContain('teardown transaction is active');
  });

  it('keeps turns harvested from earlier queues when a later queue fails to close', () => {
    const global = queueHolding('g1');
    const first = queueHolding('a1', 'a2');
    const failing = queueHolding('b1');
    const last = queueHolding('c1');
    const failure = new Error('injected close failure');
    vi.spyOn(failing.queue, 'closeAndTakePendingTurns').mockImplementation(() => {
      throw failure;
    });
    const coordinator = coordinatorWith(global.queue, [
      ['chat-a', first.queue],
      ['chat-b', failing.queue],
      ['chat-c', last.queue],
    ]);

    const result = coordinator.takePendingTurnsForPlannedStop();

    expect(result.turns).toEqual([...global.turns, ...first.turns, ...last.turns]);
    expect(result.closeFailures).toEqual([failure]);
    // Closed queues admit nothing new during the drain.
    expect(first.queue.enqueue(queuedTurn('a3'))).toBe(false);
    expect(last.queue.enqueue(queuedTurn('c2'))).toBe(false);
  });
});
