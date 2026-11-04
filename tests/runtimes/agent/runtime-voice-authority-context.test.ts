import { describe, expect, it, vi } from 'vitest';
import type { Messenger } from '../../../src/core/types.ts';
import { withTransportInboundContext } from '../../../src/core/transport-inbound-context.ts';
import { FinalTransportAuthorityGate } from '../../../src/transport/operations-authority-gate.ts';
import type { TransportAdmissionInput } from '../../../src/transport/operations-authority-client.ts';
import { RuntimeTurnCoordinator } from '../../../src/runtimes/agent/runtime-turn-coordinator.ts';
import { createRuntimeTurnContext } from '../../../src/runtimes/agent/runtime-turn-context.ts';
import { OutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { coordinatorPortDouble } from './lib/runtime-turn-coordinator-port-double.ts';

vi.mock('../../../src/logger.ts', async () => (await import('../../helpers/logger-mock.ts')).loggerMock());
vi.mock('../../../src/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config.ts')>();
  return { ...actual, config: { ...actual.config, voiceReply: 'always' } };
});

describe('aggregated voice authority', () => {
  it.each(['finalized', 'unowned'] as const)('keeps %s aggregate voice unbound under a verified B terminal', async (path) => {
    const admissions: TransportAdmissionInput[] = [];
    const gate = new FinalTransportAuthorityGate({
      admit: async (input) => {
        admissions.push(input);
        return { attemptId: 'fake-attempt', payloadDigest: 'sha256:fake' };
      },
      recordReceipt: async () => undefined,
    });
    const messenger: Messenger = {
      sendMessage: vi.fn(async () => ({ waMessageId: null })),
      sendMedia: vi.fn(async () => ({ waMessageId: null })),
    };
    const jid = 'voice@s.whatsapp.net';
    const queue = new OutboundQueue(messenger, jid, { conversationKey: 'voice' });
    const context = createRuntimeTurnContext({
      identity: { scope: 'shared', conversationKey: 'voice', deliveryJid: jid, inboundSeq: 1, logicalTurnId: 'B', managerId: 'manager', generation: 1 },
      recoveryOwner: { logicalTurnId: 'B-recovery', managerId: 'recovery', generation: 1 },
      replay: { sourceMessageId: 'B', receivedAtUnixSeconds: 1_780_000_000, replaySafe: true, senderJid: jid, senderName: null, text: 'B', isGroup: false },
      contentType: 'text', toolScopeKey: '__global__',
    });
    const voice = { chatJid: jid, responseText: 'uncorrelated A text followed by B text', inboundContentType: 'text' };
    const host = coordinatorPortDouble({
      currentRuntimeTurnContext: context,
      sendVoiceReply: async (recipient, text) => {
        // Fake synthesis retains the complete aggregate and reaches the real final gate.
        await Promise.resolve();
        await gate.admit({ recipient, content: { audio: Buffer.from(text), ptt: true } });
      },
    });
    const coordinator = new RuntimeTurnCoordinator(host);
    await withTransportInboundContext({ inbound_event_id: 'verified-B', operation_id: 'B-only' }, async () => {
      if (path === 'finalized') {
        const effects = coordinator.createRuntimeTurnPostEffects({ queue, voice });
        await coordinator.applyRuntimeTurnPostEffects({
          kind: 'reclaimed_by_sweep', identity: context.identity,
          affectedScope: { scope: 'shared', conversationKey: 'voice' }, mayAdvance: true,
        }, context, effects);
      } else {
        coordinator.flushUnownedRuntimeResult(queue, '__global__', voice);
        await vi.waitFor(() => expect(admissions).toHaveLength(1));
      }
    });
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).not.toHaveProperty('context');
    expect(admissions[0]).not.toHaveProperty('operationId');
    expect(admissions[0]).toMatchObject({ recipient: jid, content: { audio: { $binary: Buffer.from(voice.responseText).toString('base64') }, ptt: true } });
    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(messenger.sendMedia).not.toHaveBeenCalled();
  });
});
