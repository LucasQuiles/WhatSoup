import { describe, it, expect } from 'vitest';
import { perChatActorSession } from '../../../src/runtimes/agent/per-chat-actor-session.ts';

const CHAT = '12345@s.whatsapp.net';
const GROUP = 'team-room@g.us';
const CANONICAL_CHAT = 'canonical-user@s.whatsapp.net';
const DELIVERY_LID = 'delivery-alias@lid';

describe('perChatActorSession', () => {
  it('default (not conversation-bound) reproduces the #1785 rec-3 shape exactly — no binding, no deliveryJid', () => {
    const session = perChatActorSession(CHAT, '/root', false);
    expect(session).toEqual({ tier: 'global', allowedRoot: '/root', conversationKey: '12345' });
  });

  it('conversation-bound carries a frozen binding with coherent top-level mirrors', () => {
    const session = perChatActorSession(CHAT, '/root', true);
    expect(session.tier).toBe('global');
    expect(session.binding).toEqual({
      kind: 'conversation-bound',
      conversationKey: '12345',
      deliveryJid: CHAT,
    });
    expect(Object.isFrozen(session.binding)).toBe(true);
    // Top-level fields mirror the binding (SSOT invariant).
    expect(session.conversationKey).toBe(session.binding!.conversationKey);
    expect(session.deliveryJid).toBe(session.binding!.deliveryJid);
  });

  it('encodes group JIDs to the canonical conversation key in both shapes', () => {
    expect(perChatActorSession(GROUP, '/root', false).conversationKey).toBe('team-room_at_g.us');
    expect(perChatActorSession(GROUP, '/root', true).binding!.conversationKey).toBe('team-room_at_g.us');
  });

  it('keeps canonical conversation identity separate from the raw delivery JID', () => {
    expect(perChatActorSession(CANONICAL_CHAT, '/root', false, DELIVERY_LID)).toEqual({
      tier: 'global',
      allowedRoot: '/root',
      conversationKey: 'canonical-user',
    });

    const bound = perChatActorSession(CANONICAL_CHAT, '/root', true, DELIVERY_LID);
    expect(bound).toMatchObject({
      conversationKey: 'canonical-user',
      deliveryJid: DELIVERY_LID,
      binding: {
        kind: 'conversation-bound',
        conversationKey: 'canonical-user',
        deliveryJid: DELIVERY_LID,
      },
    });
  });
});
