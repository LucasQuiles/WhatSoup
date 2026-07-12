import { describe, expect, it } from 'vitest';
import {
  createRuntimeTurnContext,
  markRuntimeTurnReplayUnsafe,
  rebindRuntimeTurnOwner,
} from '../../../src/runtimes/agent/runtime-turn-context.ts';

describe('runtime turn context', () => {
  it('snapshots and freezes the dispatch identity and exact transformed replay envelope', () => {
    const input = {
      identity: {
        scope: 'per_chat' as const,
        conversationKey: '15550000000',
        deliveryJid: '15550000000@s.whatsapp.net',
        inboundSeq: 71,
        logicalTurnId: 'turn-71',
        managerId: 'manager-a',
        generation: 4,
      },
      recoveryOwner: {
        logicalTurnId: 'turn-71-recovery',
        managerId: 'recovery-manager',
        generation: 9,
      },
      replay: {
        sourceMessageId: 'wamid-71',
        replaySafe: true,
        senderJid: '15551111111@s.whatsapp.net',
        senderName: 'Q',
        text: '[DM from Q]\n[image: already transformed]',
        isGroup: false,
      },
      contentType: 'image' as const,
      toolScopeKey: '15550000000#4',
    };

    const context = createRuntimeTurnContext(input);
    input.identity.deliveryJid = 'mutated@s.whatsapp.net';
    input.replay.text = 'mutated';

    expect(context.identity.deliveryJid).toBe('15550000000@s.whatsapp.net');
    expect(context.replay.text).toBe('[DM from Q]\n[image: already transformed]');
    expect(context.contentType).toBe('image');
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.identity)).toBe(true);
    expect(Object.isFrozen(context.recoveryOwner)).toBe(true);
    expect(Object.isFrozen(context.replay)).toBe(true);
  });

  it('marks replay unsafe by returning a new frozen snapshot without mutating the source', () => {
    const context = createRuntimeTurnContext({
      identity: {
        scope: 'shared',
        conversationKey: '15550000000',
        deliveryJid: '15550000000@s.whatsapp.net',
        inboundSeq: 72,
        logicalTurnId: 'turn-72',
        managerId: 'manager-b',
        generation: 1,
      },
      recoveryOwner: {
        logicalTurnId: 'turn-72-recovery',
        managerId: 'recovery-manager',
        generation: 10,
      },
      replay: {
        sourceMessageId: 'wamid-72',
        replaySafe: true,
        senderJid: '15551111111@s.whatsapp.net',
        senderName: null,
        text: '[DM from 15551111111]\nrun the task',
        isGroup: false,
      },
      contentType: 'text',
      toolScopeKey: '__global__',
    });

    const unsafe = markRuntimeTurnReplayUnsafe(context);

    expect(unsafe).not.toBe(context);
    expect(context.replay.replaySafe).toBe(true);
    expect(unsafe.replay.replaySafe).toBe(false);
    expect(unsafe.identity).toEqual(context.identity);
    expect(unsafe.recoveryOwner).toEqual(context.recoveryOwner);
    expect(Object.isFrozen(unsafe)).toBe(true);
    expect(Object.isFrozen(unsafe.replay)).toBe(true);
    expect(markRuntimeTurnReplayUnsafe(unsafe)).toBe(unsafe);
  });

  it('rebinds only the dispatch owner while retaining the immutable source and recovery identities', () => {
    const original = createRuntimeTurnContext({
      identity: {
        scope: 'per_chat',
        conversationKey: '15550000003',
        deliveryJid: '15550000003@s.whatsapp.net',
        inboundSeq: 73,
        logicalTurnId: 'turn-73',
        managerId: 'manager-old',
        generation: 2,
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
        text: 'queued before replacement',
        isGroup: false,
      },
      contentType: 'text',
      toolScopeKey: '15550000003#2',
    });

    const rebound = rebindRuntimeTurnOwner(original, {
      managerId: 'manager-new',
      generation: 3,
      toolScopeKey: '15550000003#3',
    });

    expect(rebound).not.toBe(original);
    expect(rebound.identity).toEqual({
      ...original.identity,
      managerId: 'manager-new',
      generation: 3,
    });
    expect(rebound.recoveryOwner).toEqual(original.recoveryOwner);
    expect(rebound.replay).toEqual(original.replay);
    expect(rebound.toolScopeKey).toBe('15550000003#3');
    expect(original.identity.managerId).toBe('manager-old');
    expect(Object.isFrozen(rebound)).toBe(true);
  });
});
