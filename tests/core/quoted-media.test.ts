// tests/core/quoted-media.test.ts
// Unit tests for extractQuotedMedia — SP10

import { describe, it, expect } from 'vitest';
import { extractQuotedMedia } from '../../src/core/quoted-media.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal raw WAMessage with the given carrier key quoting an imageMessage. */
function makeRaw(carrierKey: string, quotedKey: string, mediaNode: object = { mimetype: 'image/jpeg' }) {
  return {
    key: { remoteJid: 'chat@g.us', id: 'outer-id', fromMe: false },
    message: {
      [carrierKey]: {
        contextInfo: {
          stanzaId: 'quoted-stanza-id',
          quotedMessage: {
            [quotedKey]: mediaNode,
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Carrier key coverage — each message type that can carry contextInfo
// ---------------------------------------------------------------------------

describe('extractQuotedMedia — carrier key coverage', () => {
  const carriers = [
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'documentMessage',
    'extendedTextMessage',
    'stickerMessage',
  ] as const;

  for (const carrier of carriers) {
    it(`finds quoted imageMessage inside ${carrier}`, () => {
      const raw = makeRaw(carrier, 'imageMessage');
      const result = extractQuotedMedia(raw);

      expect(result).not.toBeNull();
      expect(result!.contentType).toBe('image');
      expect(result!.key.id).toBe('quoted-stanza-id');
      expect(result!.key.remoteJid).toBe('chat@g.us');
      expect(result!.message).toMatchObject({
        key: { remoteJid: 'chat@g.us', id: 'quoted-stanza-id', fromMe: false },
        message: { imageMessage: { mimetype: 'image/jpeg' } },
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Downloadable type coverage — each media type that can be quoted
// ---------------------------------------------------------------------------

describe('extractQuotedMedia — downloadable type coverage', () => {
  const cases = [
    { key: 'imageMessage',    contentType: 'image',    mediaNode: { mimetype: 'image/jpeg' } },
    { key: 'videoMessage',    contentType: 'video',    mediaNode: { mimetype: 'video/mp4' } },
    { key: 'audioMessage',    contentType: 'audio',    mediaNode: { mimetype: 'audio/ogg' } },
    { key: 'documentMessage', contentType: 'document', mediaNode: { mimetype: 'application/pdf', fileName: 'report.pdf' } },
    { key: 'stickerMessage',  contentType: 'sticker',  mediaNode: { mimetype: 'image/webp' } },
  ] as const;

  for (const { key, contentType, mediaNode } of cases) {
    it(`correctly identifies contentType="${contentType}" for ${key}`, () => {
      const raw = makeRaw('extendedTextMessage', key, mediaNode);
      const result = extractQuotedMedia(raw);

      expect(result).not.toBeNull();
      expect(result!.contentType).toBe(contentType);
      expect(result!.message.message).toHaveProperty(key);
    });
  }
});

// ---------------------------------------------------------------------------
// Null / missing structure cases
// ---------------------------------------------------------------------------

describe('extractQuotedMedia — null cases', () => {
  it('returns null when rawMessage is null', () => {
    expect(extractQuotedMedia(null)).toBeNull();
  });

  it('returns null when rawMessage is a primitive', () => {
    expect(extractQuotedMedia('not-an-object')).toBeNull();
    expect(extractQuotedMedia(42)).toBeNull();
  });

  it('returns null when rawMessage has no message field', () => {
    expect(extractQuotedMedia({ key: { remoteJid: 'chat@g.us' } })).toBeNull();
  });

  it('returns null when message field is not an object', () => {
    expect(extractQuotedMedia({ message: 'text' })).toBeNull();
  });

  it('returns null when no carrier key is present', () => {
    const raw = {
      key: { remoteJid: 'chat@g.us' },
      message: {
        conversation: 'plain text — no carrier key',
      },
    };
    expect(extractQuotedMedia(raw)).toBeNull();
  });

  it('returns null when carrier is present but has no contextInfo', () => {
    const raw = {
      key: { remoteJid: 'chat@g.us' },
      message: {
        imageMessage: { mimetype: 'image/jpeg', url: 'https://example.com/img' },
        // no contextInfo
      },
    };
    expect(extractQuotedMedia(raw)).toBeNull();
  });

  it('returns null when contextInfo is present but has no quotedMessage', () => {
    const raw = {
      key: { remoteJid: 'chat@g.us' },
      message: {
        extendedTextMessage: {
          text: 'hello',
          contextInfo: {
            stanzaId: 'some-id',
            // no quotedMessage
          },
        },
      },
    };
    expect(extractQuotedMedia(raw)).toBeNull();
  });

  it('returns null when quotedMessage exists but contains no downloadable media key', () => {
    const raw = {
      key: { remoteJid: 'chat@g.us' },
      message: {
        extendedTextMessage: {
          text: 'quoting plain text',
          contextInfo: {
            stanzaId: 'some-id',
            quotedMessage: {
              conversation: 'just a text reply',
            },
          },
        },
      },
    };
    expect(extractQuotedMedia(raw)).toBeNull();
  });

  it('returns null when quotedMessage downloadable node is not a plain object', () => {
    const raw = {
      key: { remoteJid: 'chat@g.us' },
      message: {
        extendedTextMessage: {
          text: 'quoting',
          contextInfo: {
            stanzaId: 'some-id',
            quotedMessage: {
              imageMessage: null,
            },
          },
        },
      },
    };
    expect(extractQuotedMedia(raw)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Synthetic message shape
// ---------------------------------------------------------------------------

describe('extractQuotedMedia — synthetic message shape', () => {
  it('builds a Baileys-compatible synthetic WAMessage', () => {
    const raw = {
      key: { remoteJid: '1234567890@s.whatsapp.net', id: 'outer-123', fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'look at this',
          contextInfo: {
            stanzaId: 'quoted-456',
            quotedMessage: {
              imageMessage: { mimetype: 'image/png', url: 'https://example.com/img.png' },
            },
          },
        },
      },
    };

    const result = extractQuotedMedia(raw);

    expect(result).not.toBeNull();
    // key mirrors the outer remoteJid with the quoted stanzaId
    expect(result!.key).toEqual({
      remoteJid: '1234567890@s.whatsapp.net',
      id: 'quoted-456',
      fromMe: false,
    });
    // message wraps the media node under the correct key
    expect(result!.message).toEqual({
      key: { remoteJid: '1234567890@s.whatsapp.net', id: 'quoted-456', fromMe: false },
      message: {
        imageMessage: { mimetype: 'image/png', url: 'https://example.com/img.png' },
      },
    });
  });

  it('falls back remoteJid to "unknown@s.whatsapp.net" when outer key is absent', () => {
    const raw = {
      // no key field
      message: {
        extendedTextMessage: {
          contextInfo: {
            stanzaId: 'quoted-789',
            quotedMessage: {
              videoMessage: { mimetype: 'video/mp4' },
            },
          },
        },
      },
    };

    const result = extractQuotedMedia(raw);

    expect(result).not.toBeNull();
    expect(result!.key.remoteJid).toBe('unknown@s.whatsapp.net');
  });

  it('falls back stanzaId to "quoted" when contextInfo.stanzaId is absent', () => {
    const raw = {
      key: { remoteJid: 'chat@g.us' },
      message: {
        extendedTextMessage: {
          contextInfo: {
            // no stanzaId
            quotedMessage: {
              audioMessage: { mimetype: 'audio/ogg' },
            },
          },
        },
      },
    };

    const result = extractQuotedMedia(raw);

    expect(result).not.toBeNull();
    expect(result!.key.id).toBe('quoted');
  });

  it('returns the first downloadable type when quotedMessage has multiple media keys', () => {
    // quotedMessage with two downloadable keys — should return the first one in DOWNLOADABLE_KEYS order
    const raw = {
      key: { remoteJid: 'chat@g.us' },
      message: {
        extendedTextMessage: {
          contextInfo: {
            stanzaId: 'multi-key',
            quotedMessage: {
              // imageMessage comes first in DOWNLOADABLE_KEYS constant
              imageMessage: { mimetype: 'image/jpeg' },
              videoMessage: { mimetype: 'video/mp4' },
            },
          },
        },
      },
    };

    const result = extractQuotedMedia(raw);

    expect(result).not.toBeNull();
    expect(result!.contentType).toBe('image');
  });
});
