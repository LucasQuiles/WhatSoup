import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FinalizeTurnTerminalResult,
  OutboundDeliveryIdentity,
  OutboundDeliverySnapshot,
  OutboundStatus,
  TurnFinalizationBookkeepingParams,
} from '../../../src/core/durability.ts';
import { normalizeFinalizeTurnTerminalParams } from '../../../src/core/turn-finalization-contract.ts';
import type { AlertEmissionResult } from '../../../src/lib/emit-alert.ts';
import {
  finalizeRuntimeTurn,
  type FinalizeRuntimeTurnResult,
  type RuntimeTurnFinalizerDurability,
} from '../../../src/runtimes/agent/turn-finalizer.ts';
import type {
  AttemptOutcome,
  RecoveryOwnerIdentity,
  TurnIdentity,
  TurnRecoveryReplayEnvelope,
} from '../../../src/runtimes/agent/turn-terminal.ts';

const emitAlertMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert: emitAlertMock,
}));

const IDENTITY: TurnIdentity = {
  scope: 'per_chat',
  conversationKey: 'conversation-41',
  deliveryJid: '15550100001:7@s.whatsapp.net',
  inboundSeq: 41,
  logicalTurnId: 'turn-41',
  managerId: 'manager-a',
  generation: 3,
};

const RECOVERY_OWNER: RecoveryOwnerIdentity = {
  logicalTurnId: 'turn-recovery-41',
  managerId: 'manager-recovery',
  generation: 4,
};

const REPLAY: TurnRecoveryReplayEnvelope = {
  sourceMessageId: 'wamid-41',
  replaySafe: true,
  senderJid: '15550100002:9@s.whatsapp.net',
  senderName: 'Exact Sender',
  text: '[voice transcript]\nexact transformed text',
  isGroup: true,
  groupName: 'Exact Group',
};

const BOOKKEEPING: TurnFinalizationBookkeepingParams = {
  sessionTokens: { dbRowId: 18, inputTokens: 13, outputTokens: 5, cacheReadTokens: 0 },
  checkpoint: {
    conversationKey: IDENTITY.conversationKey,
    fields: { lastInboundSeq: 41, lastFlushedOutboundId: 72 },
  },
};

const APPLIED_RECEIPT: FinalizeTurnTerminalResult = {
  applied: true,
  winnerMatchesRequest: true,
  recordId: 91,
  duplicateFinalizeCount: 0,
  replyGuaranteeDisarmed: false,
  effectiveReplyGuaranteeDisarmed: true,
};

interface Harness {
  durability: RuntimeTurnFinalizerDurability;
  getOutboundDeliverySnapshot: ReturnType<typeof vi.fn<RuntimeTurnFinalizerDurability['getOutboundDeliverySnapshot']>>;
  finalizeTurnTerminal: ReturnType<typeof vi.fn<RuntimeTurnFinalizerDurability['finalizeTurnTerminal']>>;
  markContinuityCandidateIfNoTerminalOutbound: ReturnType<
    typeof vi.fn<RuntimeTurnFinalizerDurability['markContinuityCandidateIfNoTerminalOutbound']>
  >;
}

function harness(
  statuses: Readonly<Record<number, OutboundStatus | undefined>> = {},
  receipt: FinalizeTurnTerminalResult = APPLIED_RECEIPT,
): Harness {
  const getOutboundDeliverySnapshot = vi.fn<RuntimeTurnFinalizerDurability['getOutboundDeliverySnapshot']>(
    (opId: number, identity: OutboundDeliveryIdentity): OutboundDeliverySnapshot | undefined => {
      const status = statuses[opId];
      return status === undefined ? undefined : { opId, ...identity, status };
    },
  );
  const finalizeTurnTerminal = vi.fn<RuntimeTurnFinalizerDurability['finalizeTurnTerminal']>(
    () => receipt,
  );
  const markContinuityCandidateIfNoTerminalOutbound = vi.fn<
    RuntimeTurnFinalizerDurability['markContinuityCandidateIfNoTerminalOutbound']
  >(() => true);
  return {
    durability: {
      getOutboundDeliverySnapshot,
      finalizeTurnTerminal,
      markContinuityCandidateIfNoTerminalOutbound,
    },
    getOutboundDeliverySnapshot,
    finalizeTurnTerminal,
    markContinuityCandidateIfNoTerminalOutbound,
  };
}

function terminalResult(
  result: FinalizeRuntimeTurnResult,
): Extract<FinalizeRuntimeTurnResult, { kind: 'terminal' }> {
  expect(result.kind).toBe('terminal');
  if (result.kind !== 'terminal') throw new Error(`expected terminal result, received ${result.kind}`);
  return result;
}

function run(
  durability: RuntimeTurnFinalizerDurability,
  overrides: {
    identity?: TurnIdentity;
    attemptOutcome?: AttemptOutcome;
    answerOpIds?: readonly number[];
    recoveryOwner?: RecoveryOwnerIdentity;
    replay?: TurnRecoveryReplayEnvelope;
    bookkeeping?: TurnFinalizationBookkeepingParams;
  } = {},
): FinalizeRuntimeTurnResult {
  return finalizeRuntimeTurn({
    instanceName: 'agent-alpha',
    durability,
    identity: overrides.identity ?? IDENTITY,
    attemptOutcome: overrides.attemptOutcome ?? { kind: 'completed' },
    answerEvidence: { kind: 'ready', opIds: overrides.answerOpIds ?? [] },
    recoveryOwner: overrides.recoveryOwner ?? RECOVERY_OWNER,
    replay: overrides.replay ?? REPLAY,
    bookkeeping: overrides.bookkeeping,
  });
}

function durableAlert(): AlertEmissionResult {
  return { ok: true, channel: 'outbox', status: 'durably_queued' };
}

beforeEach(() => {
  emitAlertMock.mockReset();
  emitAlertMock.mockReturnValue(durableAlert());
});

describe('runtime turn delivery proof', () => {
  it.each([
    {
      label: 'no answer operations',
      opIds: [] as readonly number[],
      statuses: {},
      expected: { kind: 'none' },
      disposition: 'failed_terminal',
    },
    {
      label: 'pending',
      opIds: [11],
      statuses: { 11: 'pending' } as const,
      expected: { kind: 'enqueued', opId: 11 },
      disposition: 'transferred_to_recovery_owner',
    },
    {
      label: 'submitted',
      opIds: [12],
      statuses: { 12: 'submitted' } as const,
      expected: { kind: 'flushed', opId: 12 },
      disposition: 'transferred_to_recovery_owner',
    },
    {
      label: 'echoed',
      opIds: [13],
      statuses: { 13: 'echoed' } as const,
      expected: { kind: 'echoed', opId: 13 },
      disposition: 'finalized_replied',
    },
    {
      label: 'maybe sent',
      opIds: [14],
      statuses: { 14: 'maybe_sent' } as const,
      expected: { kind: 'delivery_unknown', opId: 14 },
      disposition: 'transferred_to_recovery_owner',
    },
    {
      label: 'not sent (governor shed)',
      opIds: [15],
      statuses: { 15: 'failed_permanent' } as const,
      expected: { kind: 'not_sent', opId: 15 },
      disposition: 'failed_terminal',
    },
  ])('maps $label conservatively', ({ opIds, statuses, expected, disposition }) => {
    const ctx = harness(statuses);

    const result = terminalResult(run(ctx.durability, { answerOpIds: opIds }));

    expect(result.terminal.deliveryEvidence).toEqual(expected);
    expect(result.terminal.inboundDisposition).toBe(disposition);
  });

  it.each([
    {
      label: 'maybe_sent outranks pending, submitted, and echoed',
      statuses: { 21: 'echoed', 22: 'pending', 23: 'maybe_sent', 24: 'submitted' } as const,
      expected: { kind: 'delivery_unknown', opId: 23 },
    },
    {
      label: 'the first maybe_sent operation is retained',
      statuses: { 21: 'maybe_sent', 22: 'maybe_sent', 23: 'echoed', 24: 'echoed' } as const,
      expected: { kind: 'delivery_unknown', opId: 21 },
    },
    {
      label: 'pending outranks submitted and echoed',
      statuses: { 21: 'echoed', 22: 'pending', 23: 'submitted', 24: 'echoed' } as const,
      expected: { kind: 'enqueued', opId: 22 },
    },
    {
      label: 'mixed submitted and echoed is only flushed',
      statuses: { 21: 'echoed', 22: 'submitted', 23: 'echoed', 24: 'echoed' } as const,
      expected: { kind: 'flushed', opId: 22 },
    },
    {
      label: 'all echoed uses the final answer operation',
      statuses: { 21: 'echoed', 22: 'echoed', 23: 'echoed', 24: 'echoed' } as const,
      expected: { kind: 'echoed', opId: 24 },
    },
    {
      label: 'maybe_sent outranks a mixed not_sent chunk',
      statuses: { 21: 'failed_permanent', 22: 'maybe_sent', 23: 'echoed', 24: 'echoed' } as const,
      expected: { kind: 'delivery_unknown', opId: 22 },
    },
    {
      label: 'a single not_sent chunk fails the whole answer even among echoed chunks',
      statuses: { 21: 'echoed', 22: 'failed_permanent', 23: 'echoed', 24: 'echoed' } as const,
      expected: { kind: 'not_sent', opId: 22 },
    },
  ])('$label', ({ statuses, expected }) => {
    const ctx = harness(statuses);

    const result = terminalResult(run(ctx.durability, { answerOpIds: [21, 22, 23, 24] }));

    expect(result.terminal.deliveryEvidence).toEqual(expected);
    expect(ctx.getOutboundDeliverySnapshot).toHaveBeenCalledTimes(4);
  });

  it('queries every answer operation with the exact delivery identity', () => {
    const ctx = harness({ 31: 'echoed', 32: 'echoed' });

    run(ctx.durability, { answerOpIds: [31, 32] });

    const lookupIdentity = {
      conversationKey: IDENTITY.conversationKey,
      deliveryJid: IDENTITY.deliveryJid,
      sourceInboundSeq: IDENTITY.inboundSeq,
    };
    expect(ctx.getOutboundDeliverySnapshot.mock.calls).toEqual([
      [31, lookupIdentity],
      [32, lookupIdentity],
    ]);
  });

  it.each(['sending', 'quarantined'] as const)(
    'fails closed for unsupported %s delivery status',
    (status) => {
      const ctx = harness({ 41: status });

      const result = run(ctx.durability, { answerOpIds: [41] });

      expect(result).toMatchObject({
        kind: 'durable_failure_incident',
        failureStage: 'delivery_proof',
        mayAdvance: false,
        retryOwned: true,
      });
      expect(ctx.finalizeTurnTerminal).not.toHaveBeenCalled();
    },
  );

  it('fails closed for a missing outbound operation', () => {
    const ctx = harness();

    const result = run(ctx.durability, { answerOpIds: [404] });

    expect(result).toMatchObject({ kind: 'durable_failure_incident', failureStage: 'delivery_proof' });
    expect(ctx.finalizeTurnTerminal).not.toHaveBeenCalled();
  });

  it.each([
    ['conversationKey', 'wrong-conversation'],
    ['deliveryJid', 'wrong-jid@s.whatsapp.net'],
    ['sourceInboundSeq', 404],
    ['opId', 404],
  ] as const)('fails closed when snapshot %s does not match the requested identity', (field, value) => {
    const ctx = harness({ 51: 'echoed' });
    ctx.getOutboundDeliverySnapshot.mockReturnValue({
      opId: 51,
      conversationKey: IDENTITY.conversationKey,
      deliveryJid: IDENTITY.deliveryJid,
      sourceInboundSeq: IDENTITY.inboundSeq,
      status: 'echoed',
      [field]: value,
    });

    const result = run(ctx.durability, { answerOpIds: [51] });

    expect(result).toMatchObject({ kind: 'durable_failure_incident', failureStage: 'delivery_proof' });
    expect(ctx.finalizeTurnTerminal).not.toHaveBeenCalled();
  });
});

describe('runtime turn terminal mapping', () => {
  it('finalizes an explicit no-reply policy only when no answer evidence exists', () => {
    const ctx = harness();

    const result = terminalResult(run(ctx.durability, {
      attemptOutcome: { kind: 'suppressed_by_policy' },
      recoveryOwner: undefined,
      replay: undefined,
    }));

    expect(result.terminal).toMatchObject({
      attemptOutcome: { kind: 'suppressed_by_policy' },
      inboundDisposition: 'finalized_no_reply_policy',
      deliveryEvidence: { kind: 'none' },
    });
    expect(ctx.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      terminal: expect.objectContaining({ inboundDisposition: 'finalized_no_reply_policy' }),
      inbound: { kind: 'complete', seq: 41, terminalReason: 'no_reply_policy' },
    }));
  });

  it('records admission rejection without manufacturing recovery ownership', () => {
    const ctx = harness();

    const result = terminalResult(run(ctx.durability, {
      attemptOutcome: { kind: 'admission_rejected' },
      recoveryOwner: undefined,
      replay: undefined,
    }));

    expect(result.terminal).toMatchObject({
      attemptOutcome: { kind: 'admission_rejected' },
      inboundDisposition: 'failed_terminal',
      deliveryEvidence: { kind: 'none' },
    });
    expect(ctx.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      terminal: expect.objectContaining({ inboundDisposition: 'failed_terminal' }),
      inbound: { kind: 'failed', seq: 41, failureClass: 'unknown' },
    }));
  });

  it.each([
    { kind: 'failed', class: 'rate-limit' },
    { kind: 'suppressed_by_policy' },
  ] satisfies AttemptOutcome[])(
    'lets echoed delivery truth outrank the later $kind attempt outcome',
    (attemptOutcome) => {
      const ctx = harness({ 61: 'echoed' });
      ctx.finalizeTurnTerminal.mockImplementation((params) => {
        normalizeFinalizeTurnTerminalParams(params);
        return APPLIED_RECEIPT;
      });

      const result = terminalResult(run(ctx.durability, {
        answerOpIds: [61],
        attemptOutcome,
      }));

      expect(result.terminal).toMatchObject({
        attemptOutcome,
        inboundDisposition: 'finalized_replied',
        deliveryEvidence: { kind: 'echoed', opId: 61 },
      });
      expect(ctx.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
        inbound: { kind: 'complete', seq: 41, terminalReason: 'response_echoed' },
      }));
    },
  );

  it.each([
    'pending',
    'submitted',
    'maybe_sent',
    'echoed',
  ] as const)('fails closed when admission rejection contradicts %s answer evidence', (status) => {
    const ctx = harness({ 62: status });

    const result = run(ctx.durability, {
      answerOpIds: [62],
      attemptOutcome: { kind: 'admission_rejected' },
    });

    expect(result).toMatchObject({
      kind: 'durable_failure_incident',
      failureStage: 'terminal_finalize',
    });
    expect(ctx.finalizeTurnTerminal).not.toHaveBeenCalled();
  });

  it.each([
    'usage-limit',
    'rate-limit',
    'auth-required',
    'model-unavailable',
    'policy-block',
    'context-overflow',
    'server-error',
    'transient-network',
    'crash',
    'processor_throw',
    'unknown_terminal',
  ] as const)('transfers %s failures to an exact linked recovery owner', (failureClass) => {
    const ctx = harness({ 63: 'pending' });

    const result = terminalResult(run(ctx.durability, {
      answerOpIds: [63],
      attemptOutcome: { kind: 'failed', class: failureClass },
    }));

    expect(result.terminal.inboundDisposition).toBe('transferred_to_recovery_owner');
    expect(ctx.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      terminal: expect.objectContaining({
        inboundDisposition: 'transferred_to_recovery_owner',
        recoveryOwnerLogicalTurnId: RECOVERY_OWNER.logicalTurnId,
        recoveryOwnerManagerId: RECOVERY_OWNER.managerId,
        recoveryOwnerGeneration: RECOVERY_OWNER.generation,
      }),
      recoveryJob: expect.objectContaining({
        sourceInboundSeq: IDENTITY.inboundSeq,
        sourceLogicalTurnId: IDENTITY.logicalTurnId,
        sourceManagerId: IDENTITY.managerId,
        sourceGeneration: IDENTITY.generation,
        ownerLogicalTurnId: RECOVERY_OWNER.logicalTurnId,
        ownerManagerId: RECOVERY_OWNER.managerId,
        ownerGeneration: RECOVERY_OWNER.generation,
        replayText: REPLAY.text,
      }),
    }));
  });

  it('normalizes a completed empty attempt to a terminal unknown failure without a recovery job', () => {
    const ctx = harness();

    const result = terminalResult(run(ctx.durability));

    expect(result.terminal).toMatchObject({
      attemptOutcome: { kind: 'failed', class: 'unknown_terminal' },
      inboundDisposition: 'failed_terminal',
      deliveryEvidence: { kind: 'none' },
    });
    expect(ctx.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      inbound: { kind: 'failed', seq: 41, failureClass: 'unknown' },
    }));
    expect(ctx.finalizeTurnTerminal.mock.calls[0]?.[0]).not.toHaveProperty('recoveryJob');
  });

  it('settles a failed attempt with no delivery evidence without manufacturing prompt recovery', () => {
    const ctx = harness();

    const result = terminalResult(run(ctx.durability, {
      attemptOutcome: { kind: 'failed', class: 'crash' },
    }));

    expect(result.terminal).toMatchObject({
      attemptOutcome: { kind: 'failed', class: 'crash' },
      inboundDisposition: 'failed_terminal',
      deliveryEvidence: { kind: 'none' },
    });
    expect(ctx.finalizeTurnTerminal.mock.calls[0]?.[0]).not.toHaveProperty('recoveryJob');
  });

  it('finalizes a governor-shed answer op (#1749) as failed_terminal instead of raising a failure incident', () => {
    const ctx = harness({ 98: 'failed_permanent' });

    const result = terminalResult(run(ctx.durability, { answerOpIds: [98] }));

    expect(result.terminal).toMatchObject({
      attemptOutcome: { kind: 'failed', class: 'unknown_terminal' },
      inboundDisposition: 'failed_terminal',
      deliveryEvidence: { kind: 'not_sent', opId: 98 },
    });
    expect(ctx.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      terminal: expect.objectContaining({
        deliveryKind: 'none',
        deliveryOpId: null,
        inboundDisposition: 'failed_terminal',
      }),
      inbound: { kind: 'failed', seq: 41, failureClass: 'unknown' },
    }));
    expect(ctx.finalizeTurnTerminal.mock.calls[0]?.[0]).not.toHaveProperty('recoveryJob');
  });

  it('routes an already-failed attempt whose answer op was shed to failed_terminal, not recovery transfer', () => {
    const ctx = harness({ 99: 'failed_permanent' });

    const result = terminalResult(run(ctx.durability, {
      answerOpIds: [99],
      attemptOutcome: { kind: 'failed', class: 'crash' },
    }));

    expect(result.terminal).toMatchObject({
      attemptOutcome: { kind: 'failed', class: 'crash' },
      inboundDisposition: 'failed_terminal',
      deliveryEvidence: { kind: 'not_sent', opId: 99 },
    });
    expect(ctx.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      inbound: { kind: 'failed', seq: 41, failureClass: 'session_crash' },
    }));
  });

  it('fails closed when a not_sent answer op contradicts a policy suppression', () => {
    const ctx = harness({ 100: 'failed_permanent' });

    const result = run(ctx.durability, {
      answerOpIds: [100],
      attemptOutcome: { kind: 'suppressed_by_policy' },
    });

    expect(result).toMatchObject({
      kind: 'durable_failure_incident',
      failureStage: 'terminal_finalize',
    });
    expect(ctx.finalizeTurnTerminal).not.toHaveBeenCalled();
  });

  it('preserves replaySafe=false so core durability can park recovery as blocked', () => {
    const receipt: FinalizeTurnTerminalResult = {
      ...APPLIED_RECEIPT,
      recoveryJob: {
        status: 'durably_blocked',
        applied: true,
        jobId: 71,
        state: 'blocked_unsafe',
        duplicateEnqueueCount: 0,
      },
    };
    const ctx = harness({ 71: 'pending' }, receipt);

    const result = terminalResult(run(ctx.durability, {
      answerOpIds: [71],
      replay: { ...REPLAY, replaySafe: false },
    }));

    expect(ctx.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      recoveryJob: expect.objectContaining({ replaySafe: false }),
    }));
    expect(result.receipt).toBe(receipt);
  });

  it('passes bookkeeping inside the sole terminal finalization call', () => {
    const ctx = harness({ 72: 'echoed' });

    run(ctx.durability, { answerOpIds: [72], bookkeeping: BOOKKEEPING });

    expect(ctx.finalizeTurnTerminal).toHaveBeenCalledTimes(1);
    expect(ctx.finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      bookkeeping: BOOKKEEPING,
    }));
  });

  it('constructs a core-normalizable transfer with matching bookkeeping and recovery payload', () => {
    const ctx = harness({ 72: 'submitted' });
    ctx.finalizeTurnTerminal.mockImplementation((params) => {
      normalizeFinalizeTurnTerminalParams(params);
      return APPLIED_RECEIPT;
    });

    const result = run(ctx.durability, { answerOpIds: [72], bookkeeping: BOOKKEEPING });

    expect(result.kind).toBe('terminal');
    expect(ctx.finalizeTurnTerminal).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      ...APPLIED_RECEIPT,
      applied: false,
      duplicateFinalizeCount: 1,
      effectiveReplyGuaranteeDisarmed: false,
    },
    {
      ...APPLIED_RECEIPT,
      applied: false,
      duplicateFinalizeCount: 4,
      effectiveReplyGuaranteeDisarmed: true,
    },
  ] satisfies FinalizeTurnTerminalResult[])(
    'accepts idempotent duplicate receipts whose durable winner matches the request',
    (receipt) => {
      const ctx = harness({ 81: 'echoed' }, receipt);

      const result = terminalResult(run(ctx.durability, { answerOpIds: [81] }));

      expect(result.receipt).toBe(receipt);
      expect(result.effectiveReplyGuaranteeDisarmed)
        .toBe(receipt.effectiveReplyGuaranteeDisarmed);
      expect(ctx.finalizeTurnTerminal).toHaveBeenCalledTimes(1);
    },
  );

  it('routes a conflicting duplicate winner to durable retry instead of terminal recovery', () => {
    const ctx = harness({ 82: 'echoed' }, {
      ...APPLIED_RECEIPT,
      applied: false,
      winnerMatchesRequest: false,
      duplicateFinalizeCount: 2,
      effectiveReplyGuaranteeDisarmed: false,
    });

    const result = run(ctx.durability, { answerOpIds: [82] });

    expect(result).toMatchObject({
      kind: 'durable_failure_incident',
      failureStage: 'terminal_finalize',
      retryOwned: true,
    });
    expect(emitAlertMock).toHaveBeenCalledOnce();
  });
});

describe('runtime turn finalization failure sink', () => {
  it('routes answer evidence acquisition failure to a durable incident without fabricating op IDs', () => {
    const ctx = harness();

    const result = finalizeRuntimeTurn({
      instanceName: 'agent-alpha',
      durability: ctx.durability,
      identity: IDENTITY,
      attemptOutcome: { kind: 'completed' },
      answerEvidence: { kind: 'failed' },
    });

    expect(result).toMatchObject({
      kind: 'durable_failure_incident',
      failureStage: 'delivery_proof',
      incidentStatus: 'durably_queued',
      mayAdvance: false,
      retryOwned: true,
    });
    expect(ctx.getOutboundDeliverySnapshot).not.toHaveBeenCalled();
    expect(ctx.finalizeTurnTerminal).not.toHaveBeenCalled();
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
    expect(emitAlertMock).toHaveBeenCalledWith(
      'agent-alpha',
      'agent_turn_finalization_failed',
      'Agent turn finalization could not reach durable terminal state',
      expect.stringContaining('failure_stage=delivery_proof'),
    );
    expect(emitAlertMock.mock.calls[0]?.[3]).toContain('answer_evidence=failed');
  });

  it('routes answer evidence acquisition plus non-durable alerting to dual-sink failure', () => {
    const ctx = harness();
    emitAlertMock.mockReturnValue({
      ok: true,
      channel: 'legacy',
      status: 'legacy_accepted_unconfirmed',
    } satisfies AlertEmissionResult);

    const result = finalizeRuntimeTurn({
      instanceName: 'agent-alpha',
      durability: ctx.durability,
      identity: IDENTITY,
      attemptOutcome: { kind: 'completed' },
      answerEvidence: { kind: 'failed' },
    });

    expect(result).toMatchObject({
      kind: 'dual_sink_failure',
      failureStage: 'delivery_proof',
      incidentStatus: 'legacy_accepted_unconfirmed',
      mayAdvance: false,
      stickyDegraded: true,
      stopAcceptingAffectedScope: true,
    });
    expect(ctx.getOutboundDeliverySnapshot).not.toHaveBeenCalled();
    expect(ctx.finalizeTurnTerminal).not.toHaveBeenCalled();
  });

  it('keeps the lane blocked when only the terminal-finalization incident is durable', () => {
    const ctx = harness({ 91: 'echoed' });
    ctx.finalizeTurnTerminal.mockImplementation(() => {
      throw new Error('sqlite terminal transaction failed');
    });

    const result = run(ctx.durability, { answerOpIds: [91] });

    expect(result).toMatchObject({
      kind: 'durable_failure_incident',
      identity: IDENTITY,
      affectedScope: { scope: 'per_chat', conversationKey: IDENTITY.conversationKey },
      failureStage: 'terminal_finalize',
      incidentStatus: 'durably_queued',
      mayAdvance: false,
      retryOwned: true,
    });
    expect(ctx.finalizeTurnTerminal).toHaveBeenCalledTimes(1);
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
  });

  it('treats a truthy legacy acceptance as a dual-sink failure', () => {
    const ctx = harness({ 92: 'echoed' });
    ctx.finalizeTurnTerminal.mockImplementation(() => {
      throw new Error('sqlite terminal transaction failed');
    });
    emitAlertMock.mockReturnValue({
      ok: true,
      channel: 'legacy',
      status: 'legacy_accepted_unconfirmed',
    } satisfies AlertEmissionResult);

    const result = run(ctx.durability, { answerOpIds: [92] });

    expect(result).toMatchObject({
      kind: 'dual_sink_failure',
      incidentStatus: 'legacy_accepted_unconfirmed',
      mayAdvance: false,
      stickyDegraded: true,
      stopAcceptingAffectedScope: true,
    });
  });

  it('contains an alert sink exception as a dual-sink failure', () => {
    const ctx = harness({ 93: 'echoed' });
    ctx.finalizeTurnTerminal.mockImplementation(() => {
      throw new Error('sqlite terminal transaction failed');
    });
    emitAlertMock.mockImplementation(() => {
      throw new Error('alert sink unavailable');
    });

    let result: FinalizeRuntimeTurnResult | undefined;
    expect(() => {
      result = run(ctx.durability, { answerOpIds: [93] });
    }).not.toThrow();
    expect(result).toMatchObject({
      kind: 'dual_sink_failure',
      incidentStatus: 'threw',
      mayAdvance: false,
      stickyDegraded: true,
      stopAcceptingAffectedScope: true,
    });
    expect(ctx.finalizeTurnTerminal).toHaveBeenCalledTimes(1);
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
  });

  it('contains a delivery lookup exception without invoking the terminal transaction', () => {
    const ctx = harness({ 94: 'echoed' });
    ctx.getOutboundDeliverySnapshot.mockImplementation(() => {
      throw new Error('sqlite read failed');
    });

    expect(() => run(ctx.durability, { answerOpIds: [94] })).not.toThrow();
    expect(ctx.finalizeTurnTerminal).not.toHaveBeenCalled();
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
  });

  it('contains missing recovery ownership as a durable finalization incident', () => {
    const ctx = harness({ 95: 'pending' });

    const result = finalizeRuntimeTurn({
      instanceName: 'agent-alpha',
      durability: ctx.durability,
      identity: IDENTITY,
      attemptOutcome: { kind: 'completed' },
      answerEvidence: { kind: 'ready', opIds: [95] },
    });

    expect(result).toMatchObject({
      kind: 'durable_failure_incident',
      failureStage: 'terminal_finalize',
      mayAdvance: false,
      retryOwned: true,
    });
    expect(ctx.finalizeTurnTerminal).not.toHaveBeenCalled();
  });

  it('emits only bounded redacted identity evidence and never error or replay payloads', () => {
    const secret = 'sensitive-payload-marker-abcdefghijklmnopqrstuvwxyz';
    const ctx = harness({ 96: 'echoed' });
    ctx.finalizeTurnTerminal.mockImplementation(() => {
      throw new Error(`sqlite exposed ${secret}`);
    });

    run(ctx.durability, {
      identity: {
        ...IDENTITY,
        conversationKey: `conversation-${secret}`,
        deliveryJid: `delivery-${secret}`,
        logicalTurnId: `turn-${secret}`,
        managerId: `manager-${secret}`,
      },
      answerOpIds: [96],
      replay: { ...REPLAY, text: `transformed ${secret}` },
    });

    const evidence = emitAlertMock.mock.calls[0]?.[3];
    expect(evidence).toEqual(expect.any(String));
    expect(evidence).not.toContain(secret);
    expect(evidence.length).toBeLessThanOrEqual(512);
    expect(evidence).toContain('scope=per_chat');
    expect(evidence).toContain('inbound_seq=41');
  });
});

describe('reply guarantee breach visibility', () => {
  const FAILED_RECEIPT: FinalizeTurnTerminalResult = {
    ...APPLIED_RECEIPT,
    replyGuaranteeDisarmed: false,
    effectiveReplyGuaranteeDisarmed: false,
  };

  it('emits a durable breach alert and marks a continuity candidate for a failed turn with no delivery', () => {
    const h = harness({}, FAILED_RECEIPT);
    const result = run(h.durability, {
      attemptOutcome: { kind: 'failed', class: 'processor_throw' },
      answerOpIds: [],
    });

    const terminal = terminalResult(result);
    expect(terminal.terminal.inboundDisposition).toBe('failed_terminal');

    expect(h.markContinuityCandidateIfNoTerminalOutbound).toHaveBeenCalledExactlyOnceWith(
      IDENTITY.inboundSeq,
      'runtime_fault_no_terminal_outbound',
      'runtime_fault_disarm',
    );
    // The guarded statement refuses to mark once a terminal record exists, so
    // the candidate mark must land before terminal persistence.
    expect(h.markContinuityCandidateIfNoTerminalOutbound.mock.invocationCallOrder[0]!)
      .toBeLessThan(h.finalizeTurnTerminal.mock.invocationCallOrder[0]!);

    expect(emitAlertMock).toHaveBeenCalledTimes(1);
    expect(emitAlertMock).toHaveBeenCalledWith(
      'agent-alpha',
      'agent_reply_guarantee_breach',
      expect.any(String),
      expect.any(String),
    );
    const evidence = emitAlertMock.mock.calls[0]?.[3] as string;
    expect(evidence).toContain('attempt_failure_class=processor_throw');
    expect(evidence).toContain('inbound_seq=41');
    expect(evidence).toContain('reply_guarantee_disarmed=false');
    expect(evidence).toContain('continuity_marked=true');
    expect(evidence).not.toContain(IDENTITY.conversationKey);
  });

  it('keeps the terminal result when the breach alert throws', () => {
    const h = harness({}, FAILED_RECEIPT);
    emitAlertMock.mockImplementation(() => {
      throw new Error('sink unavailable');
    });
    const result = run(h.durability, {
      attemptOutcome: { kind: 'failed', class: 'crash' },
      answerOpIds: [],
    });
    expect(result.kind).toBe('terminal');
  });

  it('keeps the terminal result and reports continuity_marked=false when the candidate mark throws', () => {
    const h = harness({}, FAILED_RECEIPT);
    h.markContinuityCandidateIfNoTerminalOutbound.mockImplementation(() => {
      throw new Error('db locked');
    });
    const result = run(h.durability, {
      attemptOutcome: { kind: 'failed', class: 'processor_throw' },
      answerOpIds: [],
    });
    expect(result.kind).toBe('terminal');
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
    expect(emitAlertMock.mock.calls[0]?.[3]).toContain('continuity_marked=false');
  });

  it('does not fire for admission-rejected sheds (#1750 shed/fault separation)', () => {
    const h = harness({}, FAILED_RECEIPT);
    const result = run(h.durability, {
      attemptOutcome: { kind: 'admission_rejected', class: 'queue_full' },
      answerOpIds: [],
    });
    expect(result.kind).toBe('terminal');
    expect(emitAlertMock).not.toHaveBeenCalled();
    expect(h.markContinuityCandidateIfNoTerminalOutbound).not.toHaveBeenCalled();
  });

  it('does not fire for a delivered turn', () => {
    const h = harness({ 7: 'echoed' });
    const result = run(h.durability, { answerOpIds: [7] });
    expect(terminalResult(result).terminal.inboundDisposition).toBe('finalized_replied');
    expect(emitAlertMock).not.toHaveBeenCalled();
    expect(h.markContinuityCandidateIfNoTerminalOutbound).not.toHaveBeenCalled();
  });
});
