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
    adminPhones: new Set(['15550100001']),
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

  it('location with address → content=JSON, contentType=location', () => {
    const msg = msgWith({ locationMessage: { address: '123 Main St', degreesLatitude: 40.7, degreesLongitude: -74.0 } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content!);
    expect(parsed.address).toBe('123 Main St');
    expect(result!.contentType).toBe('location');
  });

  it('contact → content=JSON, contentType=contact', () => {
    const msg = msgWith({ contactMessage: { displayName: 'Bob Smith', vcard: 'BEGIN:VCARD\nEND:VCARD' } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content!);
    expect(parsed.displayName).toBe('Bob Smith');
    expect(result!.contentType).toBe('contact');
  });

  it('poll creation → content=JSON, contentType=poll', () => {
    const msg = msgWith({ pollCreationMessage: { name: 'Favourite color?', options: [] } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.content!);
    expect(parsed.name).toBe('Favourite color?');
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

  it('audio with JSON content → isResponseWorthy=true (media processed via pipeline)', () => {
    const msg = msgWith({ audioMessage: { mimeType: 'audio/ogg' } });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.content).not.toBeNull();
    expect(JSON.parse(result!.content!).type).toBe('audio');
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

// ---------------------------------------------------------------------------
// SP2: Structured content extraction
// ---------------------------------------------------------------------------

describe('parseIncomingMessage — structured content (SP2)', () => {
  it('location: content is JSON with lat/lng, contentText is human summary', () => {
    const msg = msgWith({
      locationMessage: {
        degreesLatitude: 40.7128,
        degreesLongitude: -74.006,
        name: 'New York',
        address: '123 Broadway',
        url: 'https://maps.google.com/...',
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('location');
    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('location');
    expect(parsed.latitude).toBe(40.7128);
    expect(parsed.longitude).toBe(-74.006);
    expect(parsed.name).toBe('New York');
    expect(parsed.address).toBe('123 Broadway');
    expect(result.contentText).toContain('Location');
    expect(result.contentText).toContain('New York');
    expect(result.contentText).toContain('40.7128');
  });

  it('location without name: falls back to address in contentText', () => {
    const msg = msgWith({
      locationMessage: {
        degreesLatitude: 51.5,
        degreesLongitude: -0.12,
        address: '10 Downing St',
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentText).toContain('10 Downing St');
  });

  it('contact: content is JSON with vcard, contentText is display name', () => {
    const msg = msgWith({
      contactMessage: {
        displayName: 'Bob Smith',
        vcard: 'BEGIN:VCARD\nFN:Bob Smith\nTEL:+1234567890\nEND:VCARD',
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('contact');
    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('contact');
    expect(parsed.displayName).toBe('Bob Smith');
    expect(parsed.vcard).toContain('BEGIN:VCARD');
    expect(result.contentText).toBe('Contact: Bob Smith');
  });

  it('contactsArray: content is JSON array, contentText lists names', () => {
    const msg = msgWith({
      contactsArrayMessage: {
        contacts: [
          { displayName: 'Alice', vcard: 'BEGIN:VCARD\nFN:Alice\nEND:VCARD' },
          { displayName: 'Bob', vcard: 'BEGIN:VCARD\nFN:Bob\nEND:VCARD' },
        ],
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('contact');
    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('contacts');
    expect(parsed.contacts).toHaveLength(2);
    expect(result.contentText).toContain('Alice');
    expect(result.contentText).toContain('Bob');
  });

  it('poll: content is JSON with options, contentText is poll summary', () => {
    const msg = msgWith({
      pollCreationMessage: {
        name: 'Favourite color?',
        options: [
          { optionName: 'Red' },
          { optionName: 'Blue' },
          { optionName: 'Green' },
        ],
        selectableOptionCount: 1,
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('poll');
    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('poll');
    expect(parsed.name).toBe('Favourite color?');
    expect(parsed.options).toEqual(['Red', 'Blue', 'Green']);
    expect(parsed.selectableCount).toBe(1);
    expect(result.contentText).toContain('Poll');
    expect(result.contentText).toContain('Favourite color?');
    expect(result.contentText).toContain('3 options');
  });

  it('audio: content is JSON with duration/ptt, contentText is null (filled by Whisper later)', () => {
    const msg = msgWith({
      audioMessage: {
        seconds: 15,
        ptt: true,
        mimetype: 'audio/ogg; codecs=opus',
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('audio');
    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('audio');
    expect(parsed.duration).toBe(15);
    expect(parsed.ptt).toBe(true);
    expect(parsed.transcription).toBeNull();
    expect(result.contentText).toBeNull();
  });

  it('video with caption: content preserves caption, contentText is caption', () => {
    const msg = msgWith({
      videoMessage: {
        caption: 'Check this out',
        seconds: 30,
        width: 1920,
        height: 1080,
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('video');
    expect(result.content).toBe('Check this out');
    expect(result.contentText).toBe('Check this out');
  });

  it('video without caption: content is JSON metadata, contentText is duration summary', () => {
    const msg = msgWith({
      videoMessage: {
        seconds: 45,
        width: 1280,
        height: 720,
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('video');
    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('video');
    expect(parsed.duration).toBe(45);
    expect(result.contentText).toContain('Video');
    expect(result.contentText).toContain('45');
  });

  it('document with caption: content preserves caption, contentText is caption', () => {
    const msg = msgWith({
      documentMessage: {
        caption: 'Here is the report',
        fileName: 'report.pdf',
        mimetype: 'application/pdf',
        pageCount: 5,
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('document');
    expect(result.content).toBe('Here is the report');
    expect(result.contentText).toBe('Here is the report');
  });

  it('document without caption: content is JSON metadata, contentText is filename summary', () => {
    const msg = msgWith({
      documentMessage: {
        fileName: 'data.xlsx',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('document');
    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('document');
    expect(parsed.fileName).toBe('data.xlsx');
    expect(result.contentText).toContain('Document');
    expect(result.contentText).toContain('data.xlsx');
  });

  it('sticker: content is JSON with emoji, contentText is emoji summary', () => {
    const msg = msgWith({
      stickerMessage: {
        mimetype: 'image/webp',
        isAnimated: false,
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('sticker');
    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('sticker');
    expect(result.contentText).toBe('Sticker');
  });

  it('sticker with emoji association: contentText includes emoji', () => {
    const msg = msgWith({
      stickerMessage: {
        mimetype: 'image/webp',
        isAnimated: true,
        associatedEmoji: '\u{1F602}',
      },
    });
    const innerMsg = msg.message.stickerMessage;
    innerMsg.emoji = innerMsg.associatedEmoji;
    const result = parseIncomingMessage(msg)!;
    const parsed = JSON.parse(result.content!);
    expect(parsed.emoji).toBeTruthy();
  });

  it('liveLocation: content is JSON with lat/lng/speed, contentText is summary', () => {
    const msg = msgWith({
      liveLocationMessage: {
        degreesLatitude: 37.7749,
        degreesLongitude: -122.4194,
        speedInMps: 5.2,
        sequenceNumber: 3,
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('location');
    const parsed = JSON.parse(result.content!);
    expect(parsed.type).toBe('liveLocation');
    expect(parsed.latitude).toBe(37.7749);
    expect(parsed.speed).toBe(5.2);
    expect(result.contentText).toContain('Live location');
    expect(result.contentText).toContain('37.7749');
  });

  it('image with caption: content preserves caption, contentText is caption', () => {
    const msg = msgWith({
      imageMessage: { caption: 'Beach sunset', mimeType: 'image/jpeg' },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('image');
    expect(result.content).toBe('Beach sunset');
    expect(result.contentText).toBe('Beach sunset');
  });

  it('image without caption: content is null, contentText is null', () => {
    const msg = msgWith({
      imageMessage: { mimeType: 'image/jpeg' },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('image');
    expect(result.content).toBeNull();
    expect(result.contentText).toBeNull();
  });

  it('plain text: contentText is null (content IS the readable text)', () => {
    const msg = msgWith({ conversation: 'Hello world' });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('text');
    expect(result.content).toBe('Hello world');
    expect(result.contentText).toBeNull();
  });
});
