import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mock: @whiskeysockets/baileys
// We need to control isJidGroup and jidNormalizedUser
// ---------------------------------------------------------------------------
vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const original = await importOriginal<typeof import('@whiskeysockets/baileys')>();
  return {
    ...original,
    isJidGroup: (jid: string) => jid.endsWith('@g.us'),
    jidNormalizedUser: (jid: string) => {
      // Strip the :device suffix if present, e.g. "15551234567:1@s.whatsapp.net" → "15551234567@s.whatsapp.net"
      const colonIdx = jid.indexOf(':');
      const atIdx = jid.indexOf('@');
      if (colonIdx !== -1 && atIdx !== -1 && colonIdx < atIdx) {
        return jid.slice(0, colonIdx) + jid.slice(atIdx);
      }
      return jid;
    },
  };
});

// Mock config + logger so we never touch the filesystem
vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['18459780919']),
    authDir: '/tmp/wa-test-auth',
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

import { parseIncomingMessage, unwrapMessage } from '../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides: Record<string, unknown> = {}): any {
  return {
    key: {
      id: 'msg-001',
      remoteJid: '15551234567@s.whatsapp.net',
      fromMe: false,
      participant: undefined,
    },
    pushName: 'Alice',
    messageTimestamp: BigInt(1700000000),
    message: {},
    ...overrides,
  };
}

function msgWith(messagePayload: Record<string, unknown>, overrides: Record<string, unknown> = {}): any {
  return makeMsg({ message: messagePayload, ...overrides });
}

// ---------------------------------------------------------------------------
// T23: Message Parsing — Positive
// ---------------------------------------------------------------------------

describe('parseIncomingMessage — positive cases', () => {
  it('plain text (conversation field) → content extracted, contentType=text', () => {
    const msg = msgWith({ conversation: 'Hello world' });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('Hello world');
    expect(result!.contentType).toBe('text');
    expect(result!.isResponseWorthy).toBe(true);
  });

  it('extended text → content from extendedTextMessage.text', () => {
    const msg = msgWith({ extendedTextMessage: { text: 'Extended hello' } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('Extended hello');
    expect(result!.contentType).toBe('text');
  });

  it('image with caption → content=caption, contentType=image', () => {
    const msg = msgWith({ imageMessage: { caption: 'Look at this', mimeType: 'image/jpeg' } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('Look at this');
    expect(result!.contentType).toBe('image');
  });

  it('image without caption → content=null, contentType=image', () => {
    const msg = msgWith({ imageMessage: { mimeType: 'image/jpeg' } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.content).toBeNull();
    expect(result!.contentType).toBe('image');
  });

  it('location with address → content=address, contentType=location', () => {
    const msg = msgWith({ locationMessage: { address: '123 Main St', degreesLatitude: 40.7, degreesLongitude: -74.0 } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('123 Main St');
    expect(result!.contentType).toBe('location');
  });

  it('contact → content=displayName, contentType=contact', () => {
    const msg = msgWith({ contactMessage: { displayName: 'Bob Smith', vcard: 'BEGIN:VCARD\nEND:VCARD' } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('Bob Smith');
    expect(result!.contentType).toBe('contact');
  });

  it('poll creation → content=name, contentType=poll', () => {
    const msg = msgWith({ pollCreationMessage: { name: 'Favourite color?', options: [] } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('Favourite color?');
    expect(result!.contentType).toBe('poll');
  });

  it('mentionedJid extracted from extendedTextMessage.contextInfo', () => {
    const msg = msgWith({
      extendedTextMessage: {
        text: 'Hey @someone',
        contextInfo: {
          mentionedJid: ['99887766554@s.whatsapp.net'],
        },
      },
    });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.mentionedJids).toContain('99887766554@s.whatsapp.net');
  });

  it('timestamp BigInt → converted to number', () => {
    const msg = msgWith({ conversation: 'hi' }, { messageTimestamp: BigInt(1700000000) });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(typeof result!.timestamp).toBe('number');
    expect(result!.timestamp).toBe(1700000000);
  });

  it('group sender: participant field used as senderJid', () => {
    const msg = msgWith(
      { conversation: 'group msg' },
      {
        key: {
          id: 'grp-001',
          remoteJid: '120363000000@g.us',
          fromMe: false,
          participant: '15559876543@s.whatsapp.net',
        },
        pushName: 'GroupPerson',
      },
    );
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.isGroup).toBe(true);
    expect(result!.senderJid).toBe('15559876543@s.whatsapp.net');
  });

  it('DM sender: remoteJid used as senderJid', () => {
    const msg = msgWith(
      { conversation: 'dm text' },
      {
        key: {
          id: 'dm-001',
          remoteJid: '15551112222@s.whatsapp.net',
          fromMe: false,
          participant: undefined,
        },
      },
    );
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.isGroup).toBe(false);
    expect(result!.senderJid).toBe('15551112222@s.whatsapp.net');
  });
});

// ---------------------------------------------------------------------------
// T23: Message Parsing — Negative / Edge cases
// ---------------------------------------------------------------------------

describe('parseIncomingMessage — negative cases', () => {
  it('reaction message → isResponseWorthy=false', () => {
    const msg = msgWith({ reactionMessage: { text: '👍', key: {} } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.isResponseWorthy).toBe(false);
  });

  it('protocol message (delete) → isResponseWorthy=false', () => {
    const msg = msgWith({ protocolMessage: { type: 0 } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.isResponseWorthy).toBe(false);
  });

  it('poll vote (pollUpdateMessage) → isResponseWorthy=false', () => {
    const msg = msgWith({ pollUpdateMessage: { pollCreationMessageKey: {} } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.isResponseWorthy).toBe(false);
  });

  it('status broadcast → returns null', () => {
    const msg = msgWith(
      { conversation: 'status update' },
      { key: { id: 'stat-001', remoteJid: 'status@broadcast', fromMe: false } },
    );
    const result = parseIncomingMessage(msg);
    expect(result).toBeNull();
  });

  it('null content on non-media type → isResponseWorthy=false', () => {
    // Use a message with no recognizable content type (falls through to unknown)
    const msg = msgWith({ unknownMessage: {} });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.content).toBeNull();
    expect(result!.contentType).toBe('unknown');
    expect(result!.isResponseWorthy).toBe(false);
  });

  it('audio with null content → isResponseWorthy=true (media processed via pipeline)', () => {
    const msg = msgWith({ audioMessage: { mimeType: 'audio/ogg' } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.content).toBeNull();
    expect(result!.contentType).toBe('audio');
    expect(result!.isResponseWorthy).toBe(true);
  });

  it('missing pushName → phone number fallback, no crash', () => {
    const msg = msgWith(
      { conversation: 'no name' },
      {
        key: { id: 'noname-001', remoteJid: '15553334444@s.whatsapp.net', fromMe: false },
        pushName: undefined,
      },
    );
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    // Should fall back to the phone portion of the JID
    expect(result!.senderName).toBe('15553334444');
  });

  it('null message → returns null', () => {
    const msg = { key: { id: 'null-001', remoteJid: '15551234567@s.whatsapp.net' }, message: null };
    const result = parseIncomingMessage(msg as any);
    expect(result).toBeNull();
  });

  it('missing remoteJid → returns null', () => {
    const msg = { key: { id: 'nojid-001', remoteJid: null }, message: { conversation: 'hello' } };
    const result = parseIncomingMessage(msg as any);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T23: unwrapMessage — wrapper unwrapping
// ---------------------------------------------------------------------------

describe('unwrapMessage', () => {
  it('passes through plain messages unchanged', () => {
    const inner = { conversation: 'hello' };
    expect(unwrapMessage(inner)).toBe(inner);
  });

  it('unwraps ephemeral wrapper', () => {
    const inner = { conversation: 'ephemeral text' };
    const wrapped = { ephemeralMessage: { message: inner } };
    expect(unwrapMessage(wrapped)).toBe(inner);
  });

  it('unwraps viewOnceMessage wrapper', () => {
    const inner = { imageMessage: { mimeType: 'image/jpeg' } };
    const wrapped = { viewOnceMessage: { message: inner } };
    expect(unwrapMessage(wrapped)).toBe(inner);
  });

  it('unwraps viewOnceMessageV2 wrapper', () => {
    const inner = { imageMessage: { mimeType: 'image/jpeg' } };
    const wrapped = { viewOnceMessageV2: { message: inner } };
    expect(unwrapMessage(wrapped)).toBe(inner);
  });

  it('unwraps documentWithCaptionMessage wrapper', () => {
    const inner = { documentMessage: { fileName: 'file.pdf' } };
    const wrapped = { documentWithCaptionMessage: { message: inner } };
    expect(unwrapMessage(wrapped)).toBe(inner);
  });

  it('unwraps editedMessage wrapper', () => {
    const inner = { conversation: 'edited text' };
    const wrapped = { editedMessage: { message: inner } };
    expect(unwrapMessage(wrapped)).toBe(inner);
  });

  it('recursively unwraps nested wrappers (ephemeral inside viewOnce)', () => {
    const inner = { conversation: 'deeply nested' };
    const nested = { ephemeralMessage: { message: inner } };
    const outer = { viewOnceMessage: { message: nested } };
    expect(unwrapMessage(outer)).toBe(inner);
  });

  it('returns null/undefined unchanged', () => {
    expect(unwrapMessage(null)).toBeNull();
    expect(unwrapMessage(undefined)).toBeUndefined();
  });

  it('parseIncomingMessage correctly unwraps ephemeral messages end-to-end', () => {
    const inner = { conversation: 'ephemeral content' };
    const msg = makeMsg({
      message: { ephemeralMessage: { message: inner } },
    });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('ephemeral content');
    expect(result!.contentType).toBe('text');
  });
});
