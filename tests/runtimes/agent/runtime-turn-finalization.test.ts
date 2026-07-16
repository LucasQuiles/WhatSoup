import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurabilityEngine, OutboundDeliverySnapshot } from '../../../src/core/durability.ts';
import type { Messenger } from '../../../src/core/types.ts';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
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

  it('terminalizes the sole streamed answer when an identical result is suppressed', async () => {
    const turnContext = context();
    const messenger: Messenger = {
      sendMessage: vi.fn(async () => ({ waMessageId: null })),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
      setTyping: vi.fn(async () => undefined),
    };
    const finalizeTurnTerminal = vi.fn(() => ({
      applied: true,
      winnerMatchesRequest: true,
      recordId: 1,
      duplicateFinalizeCount: 0,
      replyGuaranteeDisarmed: true,
      effectiveReplyGuaranteeDisarmed: true,
    }));
    const durability = {
      createOutboundOp: vi.fn(() => 101),
      markSending: vi.fn(),
      markSubmitted: vi.fn(),
      markMaybeSent: vi.fn(),
      markFailedPermanent: vi.fn(),
      markTerminal: vi.fn(),
      getOutboundDeliverySnapshot: vi.fn((): OutboundDeliverySnapshot => ({
        opId: 101,
        conversationKey: turnContext.identity.conversationKey,
        deliveryJid: turnContext.identity.deliveryJid,
        sourceInboundSeq: turnContext.identity.inboundSeq,
        status: 'echoed',
      })),
      finalizeTurnTerminal,
    };
    const queue = new OutboundQueue(
      messenger,
      turnContext.identity.deliveryJid,
      { conversationKey: turnContext.identity.conversationKey },
    );
    queue.setDurability(durability as unknown as DurabilityEngine);
    queue.setInboundSeq(turnContext.identity.inboundSeq ?? undefined);
    queue.beginTurnEvidence(turnContext.identity.logicalTurnId);

    queue.enqueueStreamingText('Fleet check complete.');
    queue.endTurn();
    queue.enqueueResultText('Fleet check complete.');

    const result = await finalizeQueuedRuntimeTurn({
      instanceName: 'personal',
      durability,
      queue,
      context: turnContext,
      attemptOutcome: { kind: 'completed' },
    });

    expect(messenger.sendMessage).toHaveBeenCalledOnce();
    expect(durability.createOutboundOp).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      kind: 'terminal',
      terminal: {
        inboundDisposition: 'finalized_replied',
        deliveryEvidence: { kind: 'echoed', opId: 101 },
      },
    });
    expect(finalizeTurnTerminal).toHaveBeenCalledWith(expect.objectContaining({
      terminal: expect.objectContaining({
        inboundDisposition: 'finalized_replied',
        deliveryKind: 'echoed',
        deliveryOpId: 101,
      }),
      inbound: {
        kind: 'complete',
        seq: turnContext.identity.inboundSeq,
        terminalReason: 'response_echoed',
      },
    }));
  });

  it('turns a queue durability/drain rejection into failed evidence without fake op ids', async () => {
    const flushFailure = new Error('outbound evidence durability failed');
    const durability = {
      getOutboundDeliverySnapshot: vi.fn(),
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
