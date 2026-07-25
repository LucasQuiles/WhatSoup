// tests/core/transport-refs.test.ts
import { describe, it, expect } from 'vitest';
import {
  makeChannelId, kindOf, accountOf,
  isImessageGroupAddress,
  refToKey, msgToKey,
  type ChannelId, type ChannelKind,
  type ConversationRef, type ParticipantRef, type MessageRef,
} from '../../src/core/transport-refs.ts';
import {
  isBluebubblesPasswordService,
  isBluebubblesPasswordServiceForAccount,
  isTrustedBluebubblesUrl,
} from '../../src/lib/bluebubbles-config.ts';

describe('ChannelId / ChannelKind', () => {
  it('makeChannelId produces "kind:account" form', () => {
    const id = makeChannelId('whatsapp', 'mw-bot');
    expect(id).toBe('whatsapp:mw-bot');
  });

  it('kindOf extracts the kind prefix', () => {
    expect(kindOf(makeChannelId('telegram', 'studio-bot'))).toBe('telegram');
  });

  it('accountOf extracts the account segment', () => {
    expect(accountOf(makeChannelId('whatsapp', 'anabot'))).toBe('anabot');
  });

  it('makeChannelId rejects invalid account names', () => {
    expect(() => makeChannelId('whatsapp', 'Has Spaces')).toThrow();
    expect(() => makeChannelId('whatsapp', 'UPPERCASE')).toThrow();
    expect(() => makeChannelId('whatsapp', '')).toThrow();
    expect(() => makeChannelId('whatsapp', '0starts-with-digit')).toThrow();
  });

  it('makeChannelId accepts hyphens and digits after the leading letter', () => {
    expect(makeChannelId('whatsapp', 'mw-bot-2')).toBe('whatsapp:mw-bot-2');
  });
});

describe('sms channel kind', () => {
  it('constructs and parses an sms channel id', () => {
    const id = makeChannelId('sms', 'ml-bot');
    expect(id).toBe('sms:ml-bot');
    expect(kindOf(id)).toBe('sms');
    expect(accountOf(id)).toBe('ml-bot');
  });
});

describe('signal channel kind', () => {
  it('constructs and parses a signal channel id', () => {
    const id = makeChannelId('signal', 'ops-line');
    expect(id).toBe('signal:ops-line');
    expect(kindOf(id)).toBe('signal');
    expect(accountOf(id)).toBe('ops-line');
  });
});

describe('imessage channel kind', () => {
  it('constructs and parses an imessage channel id', () => {
    const id = makeChannelId('imessage', 'mac-mini');
    expect(id).toBe('imessage:mac-mini');
    expect(kindOf(id)).toBe('imessage');
    expect(accountOf(id)).toBe('mac-mini');
  });

  it('recognizes only iMessage group chat GUIDs with a provider id', () => {
    expect(isImessageGroupAddress('iMessage;+;chatABC')).toBe(true);
    expect(isImessageGroupAddress('iMessage;+;')).toBe(false);
    expect(isImessageGroupAddress('iMessage;-;chatABC')).toBe(false);
    expect(isImessageGroupAddress('owner@example.test')).toBe(false);
    expect(isImessageGroupAddress('+15551230008')).toBe(false);
    expect(isImessageGroupAddress('imessage;+;chatABC')).toBe(false);
  });

  it('accepts only provider-scoped BlueBubbles password services', () => {
    expect(isBluebubblesPasswordService('whatsoup-bluebubbles')).toBe(true);
    expect(isBluebubblesPasswordService('whatsoup-bluebubbles-support-1')).toBe(true);
    expect(isBluebubblesPasswordService('whatsoup-health-token')).toBe(false);
    expect(isBluebubblesPasswordService('openai')).toBe(false);
  });

  it('binds a BlueBubbles password service to its exact transport account', () => {
    expect(isBluebubblesPasswordServiceForAccount('whatsoup-bluebubbles-support-1', 'support-1')).toBe(true);
    expect(isBluebubblesPasswordServiceForAccount('whatsoup-bluebubbles-support-2', 'support-1')).toBe(false);
    expect(isBluebubblesPasswordServiceForAccount('whatsoup-bluebubbles', 'support-1')).toBe(false);
  });

  it('requires HTTPS except for loopback BlueBubbles endpoints', () => {
    expect(isTrustedBluebubblesUrl('https://messages.example.test')).toBe(true);
    expect(isTrustedBluebubblesUrl('http://localhost:1234')).toBe(true);
    expect(isTrustedBluebubblesUrl('http://127.0.0.1:1234')).toBe(true);
    expect(isTrustedBluebubblesUrl('http://messages.example.test')).toBe(false);
    expect(isTrustedBluebubblesUrl('https://user:secret@messages.example.test')).toBe(false);
    expect(isTrustedBluebubblesUrl('https://messages.example.test?password=secret')).toBe(false);
  });
});

describe('refToKey / msgToKey', () => {
  it('refToKey serializes a ConversationRef stably', () => {
    const c: ConversationRef = { channel: makeChannelId('whatsapp', 'mw-bot'), id: '1234@s.whatsapp.net' };
    expect(refToKey(c)).toBe('whatsapp:mw-bot:1234@s.whatsapp.net');
  });

  it('msgToKey serializes a MessageRef stably', () => {
    const m: MessageRef = {
      channel: makeChannelId('telegram', 'studio-bot'),
      conversation: '-1001234',
      id: '42',
    };
    expect(msgToKey(m)).toBe('telegram:studio-bot:-1001234:42');
  });
});
