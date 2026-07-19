import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TurnFinalizationBookkeepingParams } from '../../../src/core/durability.ts';
import {
  RuntimeTurnSupervisor,
  type RetainedRuntimeTurnFinalization,
} from '../../../src/runtimes/agent/runtime-turn-supervisor.ts';
import { createRuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import type { RuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import type { FinalizeRuntimeTurnResult } from '../../../src/runtimes/agent/turn-finalizer.ts';

const emitAlert = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/emit-alert.ts', () => ({ emitAlert }));

const bookkeeping: TurnFinalizationBookkeepingParams = {};

function context(
  logicalTurnId: string,
  scope: 'per_chat' | 'shared' | 'singleton' = 'shared',
): RuntimeTurnContext {
  const suffix = Number.parseInt(logicalTurnId.replace(/\D/g, ''), 10) || 1;
  return createRuntimeTurnContext({
    identity: {
      scope,
      conversationKey: scope === 'per_chat' ? `1555000${suffix}` : `shared-${suffix}`,
      deliveryJid: `1555000${suffix}@s.whatsapp.net`,
      inboundSeq: suffix,
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
      senderJid: '15559990000@s.whatsapp.net',
      senderName: null,
      text: `replay ${logicalTurnId}`,
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: scope === 'per_chat' ? `1555000${suffix}` : '__global__',
  });
}

function durableFailure(
  turn: RuntimeTurnContext,
  failureStage: 'delivery_proof' | 'terminal_finalize',
): Extract<FinalizeRuntimeTurnResult, { kind: 'durable_failure_incident' }> {
  return {
    kind: 'durable_failure_incident',
    identity: turn.identity,
    affectedScope: {
      scope: turn.identity.scope,
      conversationKey: turn.identity.conversationKey,
    },
    failureStage,
    incidentStatus: 'durably_queued',
    mayAdvance: false,
    retryOwned: true,
  };
}

function dualFailure(
  turn: RuntimeTurnContext,
  failureStage: 'delivery_proof' | 'terminal_finalize' = 'terminal_finalize',
): Extract<FinalizeRuntimeTurnResult, { kind: 'dual_sink_failure' }> {
  return {
    kind: 'dual_sink_failure',
    identity: turn.identity,
    affectedScope: {
      scope: turn.identity.scope,
      conversationKey: turn.identity.conversationKey,
    },
    failureStage,
    incidentStatus: 'legacy_accepted_unconfirmed',
    mayAdvance: false,
    stickyDegraded: true,
    stopAcceptingAffectedScope: true,
  };
}

function record<TPostEffects>(
  turn: RuntimeTurnContext,
  postEffects: TPostEffects,
  answerEvidence: { kind: 'ready'; opIds: readonly number[] } | { kind: 'failed' } = {
    kind: 'ready',
    opIds: [],
  },
  refreshAnswerEvidence?: () => Promise<
    { kind: 'ready'; opIds: readonly number[] } | { kind: 'failed' }
  >,
): Omit<
  RetainedRuntimeTurnFinalization<TPostEffects>,
  | 'attempts'
  | 'exhausted'
  | 'failureStage'
  | 'incidentDurable'
  | 'mayAdvance'
  | 'postEffectsApplied'
> {
  return {
    context: turn,
    attemptOutcome: { kind: 'completed' },
    answerEvidence,
    ...(refreshAnswerEvidence === undefined ? {} : { refreshAnswerEvidence }),
    bookkeeping,
    postEffects,
  };
}

function receipt(): Extract<FinalizeRuntimeTurnResult, { kind: 'terminal' }>['receipt'] {
  return {
    applied: true,
    winnerMatchesRequest: true,
    recordId: 1,
    duplicateFinalizeCount: 0,
    replyGuaranteeDisarmed: true,
    effectiveReplyGuaranteeDisarmed: true,
  };
}

describe('RuntimeTurnSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    emitAlert.mockReset();
    emitAlert.mockReturnValue({ status: 'durably_queued' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a shared scope degraded until every blocked turn in that lane recovers', async () => {
    const first = context('turn-1');
    const second = context('turn-2');
    let failSecond = true;
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn((params: { terminal: { logicalTurnId: string } }) => {
        if (params.terminal.logicalTurnId === second.identity.logicalTurnId && failSecond) {
          throw new Error('second terminal still unavailable');
        }
        return receipt();
      }),
    };
    const applyRecovered = vi.fn();
    const supervisor = new RuntimeTurnSupervisor('personal', () => durability, applyRecovered);

    supervisor.retain(record(first, { id: 'first' }), dualFailure(first));
    supervisor.retain(record(second, { id: 'second' }), dualFailure(second));
    expect(supervisor.health().degradedScopes).toBe(1);

    await expect(supervisor.retryAll()).resolves.toMatchObject({ recovered: 1, remaining: 1 });
    expect(supervisor.health().degradedScopes).toBe(1);
    expect(supervisor.canAccept(context('turn-3'))).toBe(false);

    failSecond = false;
    await expect(supervisor.retryAll()).resolves.toMatchObject({ recovered: 1, remaining: 0 });
    expect(supervisor.health().degradedScopes).toBe(0);
    expect(supervisor.canAccept(context('turn-3'))).toBe(true);
    supervisor.close();
  });

  it('recollects failed delivery evidence before retrying and parks the lane meanwhile', async () => {
    const turn = context('turn-4', 'per_chat');
    const refresh = vi.fn(async () => ({ kind: 'ready' as const, opIds: [] }));
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn(() => receipt()),
    };
    const applyRecovered = vi.fn();
    const supervisor = new RuntimeTurnSupervisor('personal', () => durability, applyRecovered);

    const retained = supervisor.retain(
      record(turn, { id: 'delivery' }, { kind: 'failed' }, refresh),
      durableFailure(turn, 'delivery_proof'),
    );
    expect(retained.mayAdvance).toBe(false);
    expect(supervisor.isDegraded(turn)).toBe(true);

    await expect(supervisor.retryAll()).resolves.toMatchObject({ recovered: 1, remaining: 0 });
    expect(refresh).toHaveBeenCalledOnce();
    expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce();
    expect(applyRecovered).toHaveBeenCalledOnce();
    expect(supervisor.isDegraded(turn)).toBe(false);
    supervisor.close();
  });

  it('reuses frozen ready evidence after terminal persistence failure', async () => {
    const turn = context('turn-5');
    const refresh = vi.fn();
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn(() => receipt()),
    };
    const supervisor = new RuntimeTurnSupervisor('personal', () => durability, vi.fn());

    supervisor.retain(
      record(turn, { id: 'ready' }, { kind: 'ready', opIds: [] }, refresh),
      durableFailure(turn, 'terminal_finalize'),
    );
    await supervisor.retryAll();

    expect(refresh).not.toHaveBeenCalled();
    expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce();
    supervisor.close();
  });

  it('does not regress an already durable incident when a later alert path is unavailable', async () => {
    const turn = context('turn-6');
    let persist = false;
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn(() => {
        if (!persist) throw new Error('sqlite unavailable');
        return receipt();
      }),
    };
    const supervisor = new RuntimeTurnSupervisor('personal', () => durability, vi.fn());

    supervisor.retain(
      record(turn, { id: 'sticky' }),
      durableFailure(turn, 'terminal_finalize'),
    );
    emitAlert.mockReturnValue({ status: 'legacy_accepted_unconfirmed' });

    await expect(supervisor.retryAll()).resolves.toMatchObject({ recovered: 0, remaining: 1 });
    expect(supervisor.health().degradedScopes).toBe(1);

    persist = true;
    await expect(supervisor.retryAll()).resolves.toMatchObject({ recovered: 1, remaining: 0 });
    expect(supervisor.health().degradedScopes).toBe(0);
    supervisor.close();
  });

  it('retains records beyond the admission high-watermark instead of dropping owned work', () => {
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn(() => receipt()),
    };
    const supervisor = new RuntimeTurnSupervisor('personal', () => durability, vi.fn());

    for (let index = 1; index <= 129; index += 1) {
      const turn = context(`turn-${index}`, 'per_chat');
      supervisor.retain(record(turn, { index }), dualFailure(turn));
    }

    expect(supervisor.health().retainedRetries).toBe(129);
    expect(supervisor.canAccept(context('turn-130', 'per_chat'))).toBe(false);
    supervisor.close();
  });

  it('bounds each retry pass and advances fairly through retained records', async () => {
    const attemptedIds: string[] = [];
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn((params: { terminal: { logicalTurnId: string } }) => {
        attemptedIds.push(params.terminal.logicalTurnId);
        throw new Error('still unavailable');
      }),
    };
    const supervisor = new RuntimeTurnSupervisor('personal', () => durability, vi.fn());
    for (let index = 1; index <= 20; index += 1) {
      const turn = context(`turn-${index}`, 'per_chat');
      supervisor.retain(record(turn, { index }), durableFailure(turn, 'terminal_finalize'));
    }

    await expect(supervisor.retryAll()).resolves.toMatchObject({ attempted: 16, remaining: 20 });
    await expect(supervisor.retryAll()).resolves.toMatchObject({ attempted: 16, remaining: 20 });

    expect(new Set(attemptedIds.slice(0, 16)).size).toBe(16);
    expect(attemptedIds.slice(16)).toEqual([
      'turn-17', 'turn-18', 'turn-19', 'turn-20',
      'turn-1', 'turn-2', 'turn-3', 'turn-4',
      'turn-5', 'turn-6', 'turn-7', 'turn-8',
      'turn-9', 'turn-10', 'turn-11', 'turn-12',
    ]);
    supervisor.close();
  });

  it('coalesces concurrent retry callers into one single-flight pass', async () => {
    const turn = context('turn-30');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn(() => receipt()),
    };
    const applyRecovered = vi.fn(async () => blocked);
    const supervisor = new RuntimeTurnSupervisor('personal', () => durability, applyRecovered);
    supervisor.retain(record(turn, { id: 'single-flight' }), dualFailure(turn));

    const first = supervisor.retryAll();
    const second = supervisor.retryAll();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(applyRecovered).toHaveBeenCalledOnce());
    release();
    await expect(first).resolves.toMatchObject({ recovered: 1, remaining: 0 });
    expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce();
    supervisor.close();
  });

  it('retains and degrades the scope when recovered post-effects throw', async () => {
    const turn = context('turn-31', 'per_chat');
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn(() => receipt()),
    };
    const supervisor = new RuntimeTurnSupervisor(
      'personal',
      () => durability,
      vi.fn(() => { throw new Error('post-effect failed'); }),
    );
    supervisor.retain(record(turn, { id: 'post-effect' }), dualFailure(turn));

    await expect(supervisor.retryAll()).resolves.toMatchObject({ recovered: 0, remaining: 1 });
    expect(supervisor.isDegraded(turn)).toBe(true);
    supervisor.close();
  });

  it('does not recover or apply post-effects for a conflicting duplicate winner', async () => {
    const turn = context('turn-33', 'per_chat');
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn(() => ({
        ...receipt(),
        applied: false,
        winnerMatchesRequest: false,
        duplicateFinalizeCount: 2,
        effectiveReplyGuaranteeDisarmed: false,
      })),
    };
    const applyRecovered = vi.fn();
    const supervisor = new RuntimeTurnSupervisor('personal', () => durability, applyRecovered);
    supervisor.retain(record(turn, { id: 'conflict' }), dualFailure(turn));

    await expect(supervisor.retryAll()).resolves.toMatchObject({
      attempted: 1,
      recovered: 0,
      remaining: 1,
    });
    expect(applyRecovered).not.toHaveBeenCalled();
    expect(supervisor.health().retainedRetries).toBe(1);
    supervisor.close();
  });

  it('counts retry exhaustion once and makes a sixth pass a no-op', async () => {
    const turn = context('turn-34', 'per_chat');
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn(() => { throw new Error('still unavailable'); }),
    };
    const supervisor = new RuntimeTurnSupervisor('personal', () => durability, vi.fn());
    supervisor.retain(record(turn, { id: 'exhaustion' }), dualFailure(turn));

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(supervisor.retryAll()).resolves.toMatchObject({
        attempted: 1,
        recovered: 0,
        remaining: 1,
      });
    }
    expect(supervisor.health()).toMatchObject({
      retainedRetries: 1,
      degradedScopes: 1,
      retryAttempts: 5,
      retryRecoveries: 0,
      retryExhaustions: 1,
    });

    await expect(supervisor.retryAll()).resolves.toMatchObject({
      attempted: 0,
      recovered: 0,
      remaining: 1,
      degradedScopes: 1,
    });
    expect(supervisor.health().retryExhaustions).toBe(1);
    expect(durability.finalizeTurnTerminal).toHaveBeenCalledTimes(5);
    supervisor.close();
  });

  it('cancels scheduled work on close and does not reschedule afterward', async () => {
    const turn = context('turn-32');
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn(() => receipt()),
    };
    const supervisor = new RuntimeTurnSupervisor('personal', () => durability, vi.fn());
    supervisor.retain(record(turn, { id: 'shutdown' }), dualFailure(turn));

    supervisor.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(durability.finalizeTurnTerminal).not.toHaveBeenCalled();
  });

  it('drains retained finalizations and settles recovery waiters during shutdown', async () => {
    const turn = context('turn-35');
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn(() => receipt()),
    };
    const supervisor = new RuntimeTurnSupervisor('personal', () => durability, vi.fn());
    supervisor.retain(record(turn, { id: 'shutdown-drain' }), dualFailure(turn));
    const waiter = supervisor.waitForRecovery(turn);

    await expect(supervisor.shutdown()).resolves.toMatchObject({ remaining: 0, recovered: 1 });
    await expect(waiter).resolves.toBeUndefined();
    expect(durability.finalizeTurnTerminal).toHaveBeenCalledOnce();
  });

  it('rejects shutdown and its waiters when bounded retries cannot terminalize', async () => {
    const turn = context('turn-36');
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn(() => { throw new Error('still unavailable'); }),
    };
    const supervisor = new RuntimeTurnSupervisor('personal', () => durability, vi.fn());
    supervisor.retain(record(turn, { id: 'shutdown-failure' }), dualFailure(turn));
    const waiter = supervisor.waitForRecovery(turn);

    await expect(supervisor.shutdown()).rejects.toThrow(/retained finalization/i);
    await expect(waiter).rejects.toThrow(/retained finalization/i);
    expect(durability.finalizeTurnTerminal).toHaveBeenCalledTimes(5);
  });

  it('refuses to retain a late finalization after shutdown has closed retry ownership', async () => {
    const turn = context('turn-37');
    const supervisor = new RuntimeTurnSupervisor(
      'personal',
      () => ({
        getOutboundDeliverySnapshot: vi.fn(),
        markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
        finalizeTurnTerminal: vi.fn(() => receipt()),
      }),
      vi.fn(),
    );

    await expect(supervisor.shutdown()).resolves.toMatchObject({ remaining: 0 });
    expect(() => supervisor.retain(
      record(turn, { id: 'late-after-shutdown' }),
      dualFailure(turn),
    )).toThrow(/closed|shutdown/i);
    expect(supervisor.health().retainedRetries).toBe(0);
  });
});
