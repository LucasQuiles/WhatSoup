import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboundDeliverySnapshot } from '../../../src/core/durability.ts';
import { finalizeQueuedRuntimeTurn } from '../../../src/runtimes/agent/runtime-turn-finalization.ts';
import { createRuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';

const emitAlert = vi.hoisted(() => vi.fn());

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlert,
}));

function context() {
  return createRuntimeTurnContext({
    identity: {
      scope: 'shared',
      conversationKey: '15550000000',
      deliveryJid: '15550000000@s.whatsapp.net',
      inboundSeq: 73,
      logicalTurnId: 'turn-73',
      managerId: 'manager-c',
      generation: 1,
    },
    recoveryOwner: {
      logicalTurnId: 'turn-73-recovery',
      managerId: 'recovery-manager',
      generation: 11,
    },
    replay: {
      sourceMessageId: 'wamid-73',
      replaySafe: true,
      senderJid: '15551111111@s.whatsapp.net',
      senderName: null,
      text: '[DM from 15551111111]\nhello',
      isGroup: false,
    },
    contentType: 'text',
    toolScopeKey: '__global__',
  });
}

describe('queued runtime turn finalization', () => {
  beforeEach(() => {
    emitAlert.mockReset();
    emitAlert.mockReturnValue({ status: 'durably_queued' });
  });

  it('uses only ordered answer op ids as delivery proof', async () => {
    const snapshots = new Map<number, OutboundDeliverySnapshot>([
      [101, {
        opId: 101,
        conversationKey: '15550000000',
        deliveryJid: '15550000000@s.whatsapp.net',
        sourceInboundSeq: 73,
        status: 'echoed',
      }],
      [102, {
        opId: 102,
        conversationKey: '15550000000',
        deliveryJid: '15550000000@s.whatsapp.net',
        sourceInboundSeq: 73,
        status: 'echoed',
      }],
    ]);
    const durability = {
      getOutboundDeliverySnapshot: vi.fn((opId: number) => snapshots.get(opId)),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn(() => ({
        applied: true,
        winnerMatchesRequest: true,
        recordId: 1,
        duplicateFinalizeCount: 0,
        replyGuaranteeDisarmed: true,
        effectiveReplyGuaranteeDisarmed: true,
      })),
    };
    const queue = {
      flushTurnEvidence: vi.fn(async () => ({
        turnId: 'turn-73',
        answerOpIds: [101, 102],
        lifecycleOpIds: [201],
        statusOpIds: [301],
      })),
    };

    const result = await finalizeQueuedRuntimeTurn({
      instanceName: 'personal',
      durability,
      queue,
      context: context(),
      attemptOutcome: { kind: 'completed' },
    });

    expect(result.kind).toBe('terminal');
    expect(queue.flushTurnEvidence).toHaveBeenCalledWith('turn-73');
    expect(durability.getOutboundDeliverySnapshot.mock.calls.map(([opId]) => opId)).toEqual([101, 102]);
    expect(durability.getOutboundDeliverySnapshot).not.toHaveBeenCalledWith(201, expect.anything());
    expect(durability.getOutboundDeliverySnapshot).not.toHaveBeenCalledWith(301, expect.anything());
  });

  it('turns a queue durability/drain rejection into failed evidence without fake op ids', async () => {
    const flushFailure = new Error('outbound evidence durability failed');
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
      markContinuityCandidateIfNoTerminalOutbound: vi.fn(() => true),
      finalizeTurnTerminal: vi.fn(),
    };
    const queue = {
      flushTurnEvidence: vi.fn(async () => {
        throw flushFailure;
      }),
    };

    const result = await finalizeQueuedRuntimeTurn({
      instanceName: 'personal',
      durability,
      queue,
      context: context(),
      attemptOutcome: { kind: 'completed' },
    });

    expect(result).toMatchObject({
      kind: 'durable_failure_incident',
      failureStage: 'delivery_proof',
      mayAdvance: false,
      retryOwned: true,
    });
    expect(durability.getOutboundDeliverySnapshot).not.toHaveBeenCalled();
    expect(durability.finalizeTurnTerminal).not.toHaveBeenCalled();
    expect(emitAlert).toHaveBeenCalledOnce();
  });
});
