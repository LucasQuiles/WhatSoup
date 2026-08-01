import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mock: @whiskeysockets/baileys
// We need to control isJidGroup and jidNormalizedUser
// ---------------------------------------------------------------------------
vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('@whiskeysockets/baileys');
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

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

import { parseIncomingMessage, unwrapMessage, extractContextInfo } from '../../src/core/message-parser.ts';
import { hasLoneSurrogates } from '../../src/core/sanitize-surrogates.ts';

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

describe('parseIncomingMessage — surrogate sanitization (QR-056)', () => {
  it('strips lone surrogates from senderName (pushName) as well as content', () => {
    const LS = '\uD800'; // lone high surrogate
    const msg = msgWith({ conversation: `hi${LS}there` }, { pushName: `Mallory${LS}` });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    // content was already sanitized on main; senderName must be too (the gap).
    expect(hasLoneSurrogates(result!.content ?? '')).toBe(false);
    expect(hasLoneSurrogates(result!.senderName ?? '')).toBe(false);
    expect(result!.senderName).toBe('Mallory\uFFFD'); // lone surrogate -> replacement char
  });

  it('leaves a clean senderName unchanged', () => {
    const msg = msgWith({ conversation: 'hello' }, { pushName: 'Alice' });
    expect(parseIncomingMessage(msg)!.senderName).toBe('Alice');
  });
});

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

  it.each(['pollCreationMessageV2', 'pollCreationMessageV3'])(
    '%s → preserves the poll question and options instead of an unknown blank row',
    (field) => {
      const msg = msgWith({
        [field]: {
          name: 'Ship the repair?',
          options: [{ optionName: 'Proceed' }, { optionName: 'Hold' }],
          selectableOptionCount: 1,
        },
      });
      const result = parseIncomingMessage(msg);
      expect(result).not.toBeNull();
      expect(result!.contentType).toBe('poll');
      expect(result!.contentText).toBe('Poll: Ship the repair? — 2 options');
      expect(JSON.parse(result!.content!)).toEqual({
        type: 'poll',
        name: 'Ship the repair?',
        options: ['Proceed', 'Hold'],
        selectableCount: 1,
      });
    },
  );

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

  it('timestamp milliseconds → normalized to unix seconds', () => {
    const msg = msgWith({ conversation: 'hi' }, { messageTimestamp: BigInt(1_777_824_570_676) });
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.timestamp).toBe(1_777_824_570);
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

  it('from-me DM sender falls back to remoteJid when participant is absent', () => {
    const msg = msgWith(
      { conversation: 'sent text' },
      {
        key: {
          id: 'sent-001',
          remoteJid: '15552223333@s.whatsapp.net',
          fromMe: true,
          participant: undefined,
        },
      },
    );
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.isFromMe).toBe(true);
    expect(result!.senderJid).toBe('15552223333@s.whatsapp.net');
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

  it('status broadcast → stored but not response-worthy (SP8)', () => {
    const msg = msgWith(
      { conversation: 'status update' },
      { key: { id: 'stat-001', remoteJid: 'status@broadcast', fromMe: false } },
    );
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.isResponseWorthy).toBe(false);
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
    expect(result).toStrictEqual(null);
  });

  it('missing remoteJid → returns null', () => {
    const msg = { key: { id: 'nojid-001', remoteJid: null }, message: { conversation: 'hello' } };
    const result = parseIncomingMessage(msg as any);
    expect(result).toStrictEqual(null);
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
    expect(result.contentText).toStrictEqual(null);
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
    expect(parsed.emoji).toBe('\u{1F602}');
  });

  it('liveLocation: content is text with lat/lng/accuracy, contentType is live_location', () => {
    const msg = msgWith({
      liveLocationMessage: {
        degreesLatitude: 37.7749,
        degreesLongitude: -122.4194,
        accuracyInMeters: 15,
        speedInMps: 5.2,
        sequenceNumber: 3,
      },
    });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('live_location');
    expect(result.content).toBe('Live location: 37.7749, -122.4194 (accuracy: 15m)');
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
    expect(result.contentText).toStrictEqual(null);
  });

  it('plain text: contentText is null (content IS the readable text)', () => {
    const msg = msgWith({ conversation: 'Hello world' });
    const result = parseIncomingMessage(msg)!;
    expect(result.contentType).toBe('text');
    expect(result.content).toBe('Hello world');
    expect(result.contentText).toStrictEqual(null);
  });
});

describe('parseIncomingMessage — fallback/default structured content', () => {
  it('video without caption or metadata uses null metadata and unknown duration text', () => {
    const result = parseIncomingMessage(msgWith({ videoMessage: {} }))!;
    expect(result.contentType).toBe('video');
    expect(JSON.parse(result.content!)).toEqual({
      type: 'video',
      duration: null,
      width: null,
      height: null,
    });
    expect(result.contentText).toBe('Video: ?s');
  });

  it('document without caption or metadata uses null metadata and generic filename text', () => {
    const result = parseIncomingMessage(msgWith({ documentMessage: {} }))!;
    expect(result.contentType).toBe('document');
    expect(JSON.parse(result.content!)).toEqual({
      type: 'document',
      fileName: null,
      mimetype: null,
      pageCount: null,
    });
    expect(result.contentText).toBe('Document: file');
  });

  it('sticker with associatedEmoji but no emoji uses the associated emoji', () => {
    const result = parseIncomingMessage(msgWith({ stickerMessage: { associatedEmoji: '\u{1F602}' } }))!;
    expect(result.contentType).toBe('sticker');
    expect(JSON.parse(result.content!)).toEqual({
      type: 'sticker',
      emoji: '\u{1F602}',
      isAnimated: false,
    });
    expect(result.contentText).toBe('Sticker: \u{1F602}');
  });

  it('location without optional fields uses null metadata and shared summary text', () => {
    const result = parseIncomingMessage(msgWith({ locationMessage: {} }))!;
    expect(result.contentType).toBe('location');
    expect(JSON.parse(result.content!)).toEqual({
      type: 'location',
      latitude: null,
      longitude: null,
      name: null,
      address: null,
      url: null,
    });
    expect(result.contentText).toBe('Location: shared (undefined, undefined)');
  });

  it('live location without coordinates defaults numeric fields to zero', () => {
    const result = parseIncomingMessage(msgWith({ liveLocationMessage: {} }))!;
    expect(result.contentType).toBe('live_location');
    expect(result.content).toBe('Live location: 0, 0 (accuracy: 0m)');
    expect(result.contentText).toBe('Live location: 0, 0 (accuracy: 0m)');
  });

  it('group invite with group name and caption includes both in the summary', () => {
    const result = parseIncomingMessage(msgWith({
      groupInviteMessage: {
        groupName: 'Kitchen Crew',
        caption: 'Join here',
      },
    }))!;
    expect(result.contentType).toBe('group_invite');
    expect(result.content).toBe('Group invite: Kitchen Crew - Join here');
    expect(result.contentText).toBe('Group invite: Kitchen Crew - Join here');
  });

  it('group invite without optional fields uses the unknown-group fallback', () => {
    const result = parseIncomingMessage(msgWith({ groupInviteMessage: {} }))!;
    expect(result.contentType).toBe('group_invite');
    expect(result.content).toBe('Group invite: Unknown group');
    expect(result.contentText).toBe('Group invite: Unknown group');
  });

  it('product message with nested product details includes description and price text', () => {
    const result = parseIncomingMessage(msgWith({
      productMessage: {
        product: {
          title: 'Sauce Kit',
          description: 'Batch tools',
          currencyCode: 'USD',
          priceAmount1000: 12999,
        },
      },
    }))!;
    expect(result.contentType).toBe('product');
    expect(result.content).toBe('Product: Sauce Kit - Batch tools(USD 12.999)');
    expect(result.contentText).toBe('Product: Sauce Kit - Batch tools(USD 12.999)');
  });

  it('direct product message can use price without currency', () => {
    const result = parseIncomingMessage(msgWith({
      productMessage: {
        title: 'Tokens',
        priceAmount1000: 5000,
      },
    }))!;
    expect(result.contentType).toBe('product');
    expect(result.content).toBe('Product: Tokens( 5)');
  });

  it('product message without details uses the unknown-product fallback', () => {
    const result = parseIncomingMessage(msgWith({ productMessage: {} }))!;
    expect(result.contentType).toBe('product');
    expect(result.content).toBe('Product: Unknown product');
    expect(result.contentText).toBe('Product: Unknown product');
  });

  it('pin message produces the pinned-message summary', () => {
    const result = parseIncomingMessage(msgWith({ pinInChatMessage: { type: 1 } }))!;
    expect(result.contentType).toBe('pin');
    expect(result.content).toBe('Pinned a message');
    expect(result.contentText).toBe('Pinned a message');
  });

  it('interactive message prefers body text when present', () => {
    const result = parseIncomingMessage(msgWith({
      interactiveMessage: {
        body: { text: 'Choose a button' },
        type: 'button',
      },
    }))!;
    expect(result.contentType).toBe('interactive');
    expect(result.content).toBe('Interactive: Choose a button');
    expect(result.contentText).toBe('Interactive: Choose a button');
  });

  it('interactive message without body or type uses the generic fallback', () => {
    const result = parseIncomingMessage(msgWith({ interactiveMessage: {} }))!;
    expect(result.contentType).toBe('interactive');
    expect(result.content).toBe('Interactive: interactive');
    expect(result.contentText).toBe('Interactive: interactive');
  });

  it('contact without display name or vcard uses null fields and unknown summary', () => {
    const result = parseIncomingMessage(msgWith({ contactMessage: {} }))!;
    expect(result.contentType).toBe('contact');
    expect(JSON.parse(result.content!)).toEqual({
      type: 'contact',
      displayName: null,
      vcard: null,
    });
    expect(result.contentText).toBe('Contact: Unknown');
  });

  it('contacts array without contacts uses an empty array', () => {
    const result = parseIncomingMessage(msgWith({ contactsArrayMessage: {} }))!;
    expect(result.contentType).toBe('contact');
    expect(JSON.parse(result.content!)).toEqual({
      type: 'contacts',
      contacts: [],
    });
    expect(result.contentText).toBe('Contacts: ');
  });

  it('contacts array contact without details uses null fields', () => {
    const result = parseIncomingMessage(msgWith({ contactsArrayMessage: { contacts: [{}] } }))!;
    expect(result.contentType).toBe('contact');
    expect(JSON.parse(result.content!)).toEqual({
      type: 'contacts',
      contacts: [{ displayName: null, vcard: null }],
    });
    expect(result.contentText).toBe('Contacts: ');
  });

  it('poll without name or options uses unnamed empty-option summary', () => {
    const result = parseIncomingMessage(msgWith({ pollCreationMessage: {} }))!;
    expect(result.contentType).toBe('poll');
    expect(JSON.parse(result.content!)).toEqual({
      type: 'poll',
      name: null,
      options: [],
      selectableCount: null,
    });
    expect(result.contentText).toBe('Poll: Unnamed — 0 options');
  });
});

// ---------------------------------------------------------------------------
// extractContextInfo — contextInfo lives on the content node, not the wrapper
// ---------------------------------------------------------------------------

describe('extractContextInfo', () => {
  it('finds contextInfo on extendedTextMessage', () => {
    const ci = extractContextInfo({
      extendedTextMessage: { text: 'hi @bot', contextInfo: { mentionedJid: ['111@lid'] } },
    });
    expect(ci).toEqual({ mentionedJid: ['111@lid'] });
  });

  it('finds contextInfo on documentMessage', () => {
    const ci = extractContextInfo({
      documentMessage: { fileName: 'a.pdf', contextInfo: { mentionedJid: ['111@lid'] } },
    });
    expect(ci).toEqual({ mentionedJid: ['111@lid'] });
  });

  it('finds contextInfo on imageMessage', () => {
    const ci = extractContextInfo({
      imageMessage: { caption: 'pic', contextInfo: { stanzaId: 'Q1' } },
    });
    expect(ci).toEqual({ stanzaId: 'Q1' });
  });

  it('returns top-level contextInfo when present', () => {
    const ci = extractContextInfo({ contextInfo: { mentionedJid: ['222@lid'] }, conversation: 'x' });
    expect(ci).toEqual({ mentionedJid: ['222@lid'] });
  });

  it('skips sibling metadata objects without contextInfo (messageContextInfo)', () => {
    const ci = extractContextInfo({
      messageContextInfo: { deviceListMetadataVersion: 2 },
      documentMessage: { contextInfo: { mentionedJid: ['111@lid'] } },
    });
    expect(ci).toEqual({ mentionedJid: ['111@lid'] });
  });

  it('returns null for plain conversation payloads', () => {
    expect(extractContextInfo({ conversation: 'hello' })).toBeNull();
  });

  it('returns null for null/undefined/non-object input', () => {
    expect(extractContextInfo(null)).toBeNull();
    expect(extractContextInfo(undefined)).toBeNull();
    expect(extractContextInfo('string')).toBeNull();
  });

  it('returns null when contextInfo is explicitly null on the content node', () => {
    expect(extractContextInfo({ imageMessage: { caption: 'pic', contextInfo: null } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Media caption mentions + media replies (regression: BOT - GENERAL ADMIN
// group, 2026-06-11 — document caption @mention dropped as not_mentioned)
// ---------------------------------------------------------------------------

describe('parseIncomingMessage — contextInfo on media content nodes', () => {
  it('document-with-caption @mention → mentionedJids extracted (production shape)', () => {
    const msg = msgWith(
      {
        messageContextInfo: { deviceListMetadataVersion: 2 },
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              caption: '@111111199834183 Review the attached PDF',
              fileName: 'invoice.pdf',
              mimetype: 'application/pdf',
              contextInfo: { mentionedJid: ['111111199834183@lid'] },
            },
          },
        },
      },
      {
        key: {
          id: 'msg-doc-mention',
          remoteJid: '120363555555555000@g.us',
          fromMe: false,
          participant: '15557654321@s.whatsapp.net',
        },
      },
    );
    const result = parseIncomingMessage(msg);
    expect(result).not.toBeNull();
    expect(result!.contentType).toBe('document');
    expect(result!.content).toBe('@111111199834183 Review the attached PDF');
    expect(result!.mentionedJids).toContain('111111199834183@lid');
  });

  it('image caption @mention → mentionedJids extracted', () => {
    const msg = msgWith({
      imageMessage: {
        caption: '@111111199834183 look at this',
        contextInfo: { mentionedJid: ['111111199834183@lid'] },
      },
    });
    expect(parseIncomingMessage(msg)!.mentionedJids).toContain('111111199834183@lid');
  });

  it('video caption @mention → mentionedJids extracted', () => {
    const msg = msgWith({
      videoMessage: {
        caption: '@111111199834183 watch',
        seconds: 12,
        contextInfo: { mentionedJid: ['111111199834183@lid'] },
      },
    });
    expect(parseIncomingMessage(msg)!.mentionedJids).toContain('111111199834183@lid');
  });

  it('reply-with-image → quotedMessageId taken from media contextInfo.stanzaId', () => {
    const msg = msgWith({
      imageMessage: {
        caption: 'replying with a pic',
        contextInfo: { stanzaId: 'QUOTED-123', participant: '15551234567@s.whatsapp.net' },
      },
    });
    expect(parseIncomingMessage(msg)!.quotedMessageId).toBe('QUOTED-123');
  });

  it('plain text reply still carries quotedMessageId (no regression)', () => {
    const msg = msgWith({
      extendedTextMessage: { text: 'replying', contextInfo: { stanzaId: 'QUOTED-456' } },
    });
    expect(parseIncomingMessage(msg)!.quotedMessageId).toBe('QUOTED-456');
  });

  it('plain conversation → mentionedJids=[] and quotedMessageId=null (no regression)', () => {
    const result = parseIncomingMessage(msgWith({ conversation: 'hi' }))!;
    expect({ mentionedJids: result.mentionedJids, quotedMessageId: result.quotedMessageId }).toEqual({
      mentionedJids: [],
      quotedMessageId: null,
    });
  });
});
