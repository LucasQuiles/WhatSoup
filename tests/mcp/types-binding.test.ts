import { describe, it, expect } from 'vitest';
import {
  assertConversationAccess,
  conversationBoundKey,
  resolveConversationKey,
  type SessionContext,
} from '../../src/mcp/types.ts';

// Conversation-bound sessions (per-chat actor sockets) carry an explicit
// `binding` discriminator. Presence of a top-level conversationKey on a global
// session is NOT a binding — shared/operator sockets get their conversationKey
// re-pinned per turn (bindActiveGlobalMcpConversation) and legitimately read
// other conversations mid-turn. Hard confinement keys on binding.kind only.

const BOUND_KEY = '12345';
const BOUND_JID = '12345@s.whatsapp.net';
const OTHER_KEY = '99999';
const OTHER_JID = '99999@s.whatsapp.net';

const bound = (over: Partial<SessionContext> = {}): SessionContext => ({
  tier: 'global',
  conversationKey: BOUND_KEY,
  deliveryJid: BOUND_JID,
  binding: Object.freeze({
    kind: 'conversation-bound' as const,
    conversationKey: BOUND_KEY,
    deliveryJid: BOUND_JID,
  }),
  ...over,
});

describe('conversationBoundKey', () => {
  it('returns the binding key for a conversation-bound session', () => {
    expect(conversationBoundKey(bound())).toBe(BOUND_KEY);
  });

  it('returns undefined for a plain global session, even with a turn-pinned conversationKey', () => {
    expect(conversationBoundKey({ tier: 'global' })).toBeUndefined();
    expect(conversationBoundKey({ tier: 'global', conversationKey: BOUND_KEY })).toBeUndefined();
  });

  it('returns undefined for a chat-scoped session (tier already confines it)', () => {
    expect(conversationBoundKey({ tier: 'chat-scoped', conversationKey: BOUND_KEY })).toBeUndefined();
  });
});

describe('resolveConversationKey — conversation-bound sessions', () => {
  it('accepts the bound conversation as a raw JID and returns the binding key', () => {
    expect(resolveConversationKey(bound(), BOUND_JID)).toBe(BOUND_KEY);
  });

  it('accepts the bound conversation as an already-encoded key', () => {
    expect(resolveConversationKey(bound(), BOUND_KEY)).toBe(BOUND_KEY);
  });

  it('REJECTS a cross-conversation key (list_messages leak regression)', () => {
    expect(() => resolveConversationKey(bound(), OTHER_KEY)).toThrow(/conversation-bound/);
    expect(() => resolveConversationKey(bound(), OTHER_JID)).toThrow(/conversation-bound/);
  });

  it('REJECTS an unparseable key rather than passing it through (fail-closed)', () => {
    expect(() => resolveConversationKey(bound(), '@')).toThrow(/conversation-bound/);
  });

  it('enforces from the binding even if the top-level conversationKey diverges (SSOT)', () => {
    const divergent = bound({ conversationKey: OTHER_KEY });
    expect(() => resolveConversationKey(divergent, OTHER_KEY)).toThrow(/conversation-bound/);
    expect(resolveConversationKey(divergent, BOUND_KEY)).toBe(BOUND_KEY);
  });
});

describe('resolveConversationKey — existing behavior preserved', () => {
  it('chat-scoped sessions always resolve to the session key', () => {
    const session: SessionContext = { tier: 'chat-scoped', conversationKey: BOUND_KEY };
    expect(resolveConversationKey(session, OTHER_KEY)).toBe(BOUND_KEY);
  });

  it('a plain global session resolves the CALLER key (operator capability)', () => {
    expect(resolveConversationKey({ tier: 'global' }, OTHER_JID)).toBe(OTHER_KEY);
    expect(resolveConversationKey({ tier: 'global' }, OTHER_KEY)).toBe(OTHER_KEY);
  });

  it('a turn-pinned global session (conversationKey set, NO binding) still resolves the caller key', () => {
    const operatorMidTurn: SessionContext = { tier: 'global', conversationKey: BOUND_KEY };
    expect(resolveConversationKey(operatorMidTurn, OTHER_JID)).toBe(OTHER_KEY);
  });
});

describe('assertConversationAccess — conversation-bound sessions', () => {
  it('throws on a cross-conversation resource', () => {
    expect(() => assertConversationAccess(OTHER_KEY, bound(), 'Audio message')).toThrow(/different conversation/);
  });

  it('allows the bound conversation resource', () => {
    expect(() => assertConversationAccess(BOUND_KEY, bound())).not.toThrow();
  });

  it('enforces the BINDING key even when the top-level conversationKey is absent (transcribe_audio fail-open regression)', () => {
    const noTopLevel = bound({ conversationKey: undefined });
    expect(() => assertConversationAccess(OTHER_KEY, noTopLevel)).toThrow(/different conversation/);
    expect(() => assertConversationAccess(BOUND_KEY, noTopLevel)).not.toThrow();
  });

  it('enforces the BINDING key even when the top-level conversationKey diverges (SSOT)', () => {
    const divergent = bound({ conversationKey: OTHER_KEY });
    expect(() => assertConversationAccess(OTHER_KEY, divergent)).toThrow(/different conversation/);
    expect(() => assertConversationAccess(BOUND_KEY, divergent)).not.toThrow();
  });
});

describe('assertConversationAccess — existing behavior preserved', () => {
  it('no-op for an unbound session without a conversationKey (operator path)', () => {
    expect(() => assertConversationAccess(OTHER_KEY, { tier: 'global' })).not.toThrow();
  });

  it('enforces a top-level conversationKey when present (turn-pinned / chat-scoped)', () => {
    const session: SessionContext = { tier: 'global', conversationKey: BOUND_KEY };
    expect(() => assertConversationAccess(OTHER_KEY, session)).toThrow(/different conversation/);
    expect(() => assertConversationAccess(BOUND_KEY, session)).not.toThrow();
  });
});

// A LID DM mapped to its phone binds to the phone key and delivers to the LID.
// Rows journaled before the mapping keep the LID key, so the session's own
// conversation has two spellings. The second one comes from the binding only.
describe('a conversation-bound session delivered through a mapped LID', () => {
  const PHONE_KEY = '15550001111';
  const PHONE_JID = '15550001111@s.whatsapp.net';
  const LID_KEY = '15550009999';
  const LID_JID = '15550009999@lid';
  const FOREIGN = ['15550002222', '15550002222@s.whatsapp.net', '15550008888', '15550008888@lid', '15550007777@lid', '123456@g.us', '123456_at_g.us'];
  const binding = (conversationKey: string, deliveryJid: string) =>
    Object.freeze({ kind: 'conversation-bound' as const, conversationKey, deliveryJid });
  const lidDelivered = (over: Partial<SessionContext> = {}): SessionContext => ({
    tier: 'global',
    conversationKey: PHONE_KEY,
    deliveryJid: LID_JID,
    binding: binding(PHONE_KEY, LID_JID),
    ...over,
  });

  it('resolveConversationKey returns the key passed for each of its own spellings', () => {
    expect(resolveConversationKey(lidDelivered(), PHONE_KEY)).toBe(PHONE_KEY);
    expect(resolveConversationKey(lidDelivered(), PHONE_JID)).toBe(PHONE_KEY);
    expect(resolveConversationKey(lidDelivered(), LID_KEY)).toBe(LID_KEY);
    expect(resolveConversationKey(lidDelivered(), LID_JID)).toBe(LID_KEY);
    expect(resolveConversationKey(lidDelivered(), '15550009999:3@lid')).toBe(LID_KEY);
  });

  it('resolveConversationKey rejects a foreign phone, a foreign or unmapped LID and a group', () => {
    for (const key of FOREIGN) {
      expect(() => resolveConversationKey(lidDelivered(), key)).toThrow(/conversation-bound/);
    }
  });

  it('the LID spelling comes from the binding, never from the top-level mirror', () => {
    const phoneBound = lidDelivered({ binding: binding(PHONE_KEY, PHONE_JID) });
    expect(() => resolveConversationKey(phoneBound, LID_KEY)).toThrow(/conversation-bound/);
    expect(() => assertConversationAccess(LID_KEY, phoneBound)).toThrow(/different conversation/);
    const foreignMirror = lidDelivered({ deliveryJid: '15550002222@s.whatsapp.net' });
    expect(() => resolveConversationKey(foreignMirror, '15550002222')).toThrow(/conversation-bound/);
    expect(() => assertConversationAccess('15550002222', foreignMirror)).toThrow(/different conversation/);
    expect(resolveConversationKey(foreignMirror, LID_JID)).toBe(LID_KEY);
  });

  it('assertConversationAccess admits rows under either of its own keys and refuses foreign rows', () => {
    expect(() => assertConversationAccess(PHONE_KEY, lidDelivered())).not.toThrow();
    expect(() => assertConversationAccess(LID_KEY, lidDelivered())).not.toThrow();
    expect(() => assertConversationAccess(LID_KEY, lidDelivered({ conversationKey: undefined }))).not.toThrow();
    for (const key of ['15550002222', '15550008888', '15550007777', '123456_at_g.us']) {
      expect(() => assertConversationAccess(key, lidDelivered(), 'Audio message')).toThrow(/different conversation/);
    }
  });

  it('control: chat-scoped and unbound sessions with a LID delivery JID are unchanged', () => {
    const chatScoped: SessionContext = { tier: 'chat-scoped', conversationKey: PHONE_KEY, deliveryJid: LID_JID };
    expect(resolveConversationKey(chatScoped, LID_KEY)).toBe(PHONE_KEY);
    expect(() => assertConversationAccess(LID_KEY, chatScoped)).toThrow(/different conversation/);
    const turnPinned: SessionContext = { tier: 'global', conversationKey: PHONE_KEY, deliveryJid: LID_JID };
    expect(resolveConversationKey(turnPinned, '15550002222')).toBe('15550002222');
    expect(() => assertConversationAccess(LID_KEY, turnPinned)).toThrow(/different conversation/);
  });
});
