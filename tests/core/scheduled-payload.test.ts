/**
 * A10 — the shared scheduled-message payload contract.
 *
 * One validator decides whether a (content_type, payload, media_blob) triple
 * can ever become a send. Writers call it before a row exists; the scheduler
 * calls it before the transport is reached. These cases pin the contract
 * itself; the writer and execution suites prove each call site uses it.
 */
import { describe, expect, it } from 'vitest';
import {
  assertScheduledPayloadWritable,
  decodeScheduledPayload,
  SCHEDULED_CONTENT_TYPES,
} from '../../src/core/scheduled-payload.ts';

const BLOB = new Uint8Array([1, 2, 3]);

function decode(contentType: string, payload: string, mediaBlob: Uint8Array | null = null) {
  return decodeScheduledPayload({ content_type: contentType, payload, media_blob: mediaBlob });
}

function shapeOf(contentType: string, payload: string, mediaBlob: Uint8Array | null = null): string {
  const verdict = decode(contentType, payload, mediaBlob);
  if (verdict.ok) throw new Error(`expected a refusal for ${contentType} ${payload}`);
  return verdict.shape;
}

/** Exactly the payloads the current and historical writers produce. */
const VALID_MEDIA: Record<string, Record<string, unknown>> = {
  image: { type: 'image', caption: 'c', mimetype: 'image/png', viewOnce: true },
  video: { type: 'video', caption: 'c', mimetype: 'video/mp4', ptv: false, gifPlayback: false, viewOnce: false },
  audio: { type: 'audio', mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 3 },
  document: { type: 'document', filename: 'a.pdf', mimetype: 'application/pdf', caption: 'c' },
  sticker: { type: 'sticker', mimetype: 'image/webp', isAnimated: false },
};

describe('decodeScheduledPayload: accepted forms', () => {
  it('covers exactly the six supported content types', () => {
    expect([...SCHEDULED_CONTENT_TYPES].sort()).toEqual(['audio', 'document', 'image', 'sticker', 'text', 'video']);
  });

  it('decodes a text payload to a send carrying only the text', () => {
    const verdict = decode('text', JSON.stringify({ text: 'hello' }));
    expect(verdict).toEqual({ ok: true, send: { kind: 'text', content: { text: 'hello' } } });
  });

  for (const [type, payload] of Object.entries(VALID_MEDIA)) {
    it(`decodes a ${type} payload with a media_blob to a media send with Buffer bytes`, () => {
      const verdict = decode(type, JSON.stringify(payload), BLOB);
      expect(verdict.ok).toBe(true);
      if (!verdict.ok || verdict.send.kind !== 'media') throw new Error('expected media send');
      expect(verdict.send.media.type).toBe(type);
      expect(Buffer.isBuffer(verdict.send.media.buffer)).toBe(true);
      expect([...(verdict.send.media.buffer as Buffer)]).toEqual([1, 2, 3]);
      const { buffer: _b, ...fields } = verdict.send.media as unknown as Record<string, unknown>;
      expect(fields).toEqual(payload);
    });
  }

  it('decodes the legacy { type: "Buffer", data } form when there is no media_blob', () => {
    const verdict = decode('image', JSON.stringify({ ...VALID_MEDIA.image, buffer: { type: 'Buffer', data: [9, 8] } }));
    if (!verdict.ok || verdict.send.kind !== 'media') throw new Error('expected media send');
    expect(Buffer.isBuffer(verdict.send.media.buffer)).toBe(true);
    expect([...(verdict.send.media.buffer as Buffer)]).toEqual([9, 8]);
  });

  it('decodes the legacy bare number[] buffer form when there is no media_blob', () => {
    const verdict = decode('document', JSON.stringify({ ...VALID_MEDIA.document, buffer: [65, 66] }));
    if (!verdict.ok || verdict.send.kind !== 'media') throw new Error('expected media send');
    expect([...(verdict.send.media.buffer as Buffer)]).toEqual([65, 66]);
  });

  it('prefers the media_blob over a legacy JSON buffer and never forwards the JSON buffer', () => {
    const verdict = decode('image', JSON.stringify({ ...VALID_MEDIA.image, buffer: [7] }), BLOB);
    if (!verdict.ok || verdict.send.kind !== 'media') throw new Error('expected media send');
    expect([...(verdict.send.media.buffer as Buffer)]).toEqual([1, 2, 3]);
  });
});

// F03: storage fields the contract ACCEPTS are separate from transport fields it EMITS.
describe('decodeScheduledPayload: accepted storage fields vs emitted transport fields', () => {
  function emitted(contentType: string, payload: Record<string, unknown>): Record<string, unknown> {
    const verdict = decode(contentType, JSON.stringify(payload), BLOB);
    if (!verdict.ok || verdict.send.kind !== 'media') throw new Error(`expected a media send for ${contentType}`);
    const { buffer: _b, ...fields } = verdict.send.media as unknown as Record<string, unknown>;
    return fields;
  }

  for (const type of ['image', 'video'] as const) {
    it(`accepts filename on a captioned ${type} and discards it from the emitted fields`, () => {
      const fields = emitted(type, { ...VALID_MEDIA[type], filename: 'clip.bin' });
      expect(fields).not.toHaveProperty('filename');
      expect(fields).toEqual(VALID_MEDIA[type]);
    });
  }

  it('accepts filename on an uncaptioned image (census row 63 key set) and discards it', () => {
    const fields = emitted('image', { type: 'image', filename: 'a.png', mimetype: 'image/png' });
    expect(fields).toEqual({ type: 'image', mimetype: 'image/png' });
  });

  it('preserves filename on a document, where it is the transport field', () => {
    expect(emitted('document', VALID_MEDIA.document)['filename']).toBe('a.pdf');
  });

  it('still type-checks a storage-only field: a non-string image filename is wrong_shape', () => {
    expect(shapeOf('image', JSON.stringify({ ...VALID_MEDIA.image, filename: 7 }), BLOB)).toBe('wrong_shape');
  });

  it('does not widen other types: filename on audio or sticker is still wrong_shape', () => {
    expect(shapeOf('audio', JSON.stringify({ ...VALID_MEDIA.audio, filename: 'a.ogg' }), BLOB)).toBe('wrong_shape');
    expect(shapeOf('sticker', JSON.stringify({ ...VALID_MEDIA.sticker, filename: 'a.webp' }), BLOB)).toBe('wrong_shape');
  });
});

// F04: the deterministic byte-precedence rule, at its boundary (zero vs one byte of media_blob).
describe('decodeScheduledPayload: media_blob vs legacy buffer precedence', () => {
  it('a 1-byte media_blob wins and an unusable legacy buffer beside it is neither validated nor emitted; a 0-byte media_blob defers to the legacy buffer', () => {
    const withInvalidLegacy = JSON.stringify({ ...VALID_MEDIA.image, buffer: [999] });
    const oneByte = decode('image', withInvalidLegacy, new Uint8Array([42]));
    if (!oneByte.ok || oneByte.send.kind !== 'media') throw new Error('expected media send');
    expect([...(oneByte.send.media.buffer as Buffer)]).toEqual([42]);

    // Same payload, zero-length blob: the legacy key is now consulted and refused.
    expect(shapeOf('image', withInvalidLegacy, new Uint8Array(0))).toBe('invalid_legacy_buffer');

    const zeroByteValidLegacy = decode('image', JSON.stringify({ ...VALID_MEDIA.image, buffer: [5, 6] }), new Uint8Array(0));
    if (!zeroByteValidLegacy.ok || zeroByteValidLegacy.send.kind !== 'media') throw new Error('expected media send');
    expect([...(zeroByteValidLegacy.send.media.buffer as Buffer)]).toEqual([5, 6]);
  });
});

describe('decodeScheduledPayload: refused shape classes', () => {
  it('not_json: plain text that is not JSON is never coerced into a send', () => {
    expect(shapeOf('text', 'Reminder: the meeting moved to Friday at 10.')).toBe('not_json');
  });

  it('json_null', () => {
    expect(shapeOf('text', 'null')).toBe('json_null');
    expect(shapeOf('image', 'null', BLOB)).toBe('json_null');
  });

  for (const primitive of ['"hello"', '42', 'true', 'false', '0', '""']) {
    it(`json_primitive: ${primitive}`, () => {
      expect(shapeOf('text', primitive)).toBe('json_primitive');
    });
  }

  it('json_array', () => {
    expect(shapeOf('text', '["hello"]')).toBe('json_array');
    expect(shapeOf('video', '[]', BLOB)).toBe('json_array');
  });

  it('unknown_content_type: a content_type outside the six supported ones', () => {
    expect(shapeOf('poll', JSON.stringify({ type: 'poll' }), BLOB)).toBe('unknown_content_type');
    expect(shapeOf('', JSON.stringify({ text: 'x' }))).toBe('unknown_content_type');
  });

  it('wrong_shape: text payloads that are not { text: non-empty string }', () => {
    expect(shapeOf('text', '{}')).toBe('wrong_shape');
    expect(shapeOf('text', JSON.stringify({ text: '' }))).toBe('wrong_shape');
    expect(shapeOf('text', JSON.stringify({ text: 5 }))).toBe('wrong_shape');
    expect(shapeOf('text', JSON.stringify({ text: null }))).toBe('wrong_shape');
    expect(shapeOf('text', JSON.stringify({ message: 'hi' }))).toBe('wrong_shape');
  });

  it('wrong_shape: a key outside the per-type allowlist never reaches the transport', () => {
    expect(shapeOf('text', JSON.stringify({ text: 'hi', mentions: ['x'] }))).toBe('wrong_shape');
    expect(shapeOf('image', JSON.stringify({ ...VALID_MEDIA.image, url: 'http://x' }), BLOB)).toBe('wrong_shape');
  });

  it('wrong_shape: a media field with the wrong runtime type', () => {
    expect(shapeOf('image', JSON.stringify({ ...VALID_MEDIA.image, caption: 3 }), BLOB)).toBe('wrong_shape');
    expect(shapeOf('video', JSON.stringify({ ...VALID_MEDIA.video, ptv: 'yes' }), BLOB)).toBe('wrong_shape');
    expect(shapeOf('audio', JSON.stringify({ ...VALID_MEDIA.audio, seconds: '3' }), BLOB)).toBe('wrong_shape');
    expect(shapeOf('sticker', JSON.stringify({ ...VALID_MEDIA.sticker, isAnimated: null }), BLOB)).toBe('wrong_shape');
  });

  it('wrong_shape: a required media field is missing', () => {
    const { filename: _f, ...noFilename } = VALID_MEDIA.document;
    expect(shapeOf('document', JSON.stringify(noFilename), BLOB)).toBe('wrong_shape');
    const { mimetype: _m, ...noMime } = VALID_MEDIA.audio;
    expect(shapeOf('audio', JSON.stringify(noMime), BLOB)).toBe('wrong_shape');
  });

  it('type_mismatch: the payload type disagrees with content_type', () => {
    expect(shapeOf('image', JSON.stringify({ ...VALID_MEDIA.video }), BLOB)).toBe('type_mismatch');
    expect(shapeOf('sticker', JSON.stringify({ type: 'image', mimetype: 'image/webp' }), BLOB)).toBe('type_mismatch');
  });

  // F03: census row 66 (ml-bot, sent image, payload keys [caption] only, blob
  // present, writer unidentified). The type is NOT inferred from content_type;
  // the refusal is stated as its own class.
  it('missing_type: a media payload with no type key is refused, never inferred (census row 66 shape)', () => {
    expect(shapeOf('image', JSON.stringify({ caption: 'c' }), BLOB)).toBe('missing_type');
    expect(shapeOf('sticker', JSON.stringify({ mimetype: 'image/webp' }), BLOB)).toBe('missing_type');
  });

  it('missing_media: no media_blob and no legacy buffer', () => {
    expect(shapeOf('image', JSON.stringify(VALID_MEDIA.image), null)).toBe('missing_media');
  });

  it('missing_media: a zero-length media_blob is not media', () => {
    expect(shapeOf('document', JSON.stringify(VALID_MEDIA.document), new Uint8Array(0))).toBe('missing_media');
  });

  for (const [label, buffer] of [
    ['a byte above 255', [1, 256]],
    ['a negative byte', [-1]],
    ['a fractional byte', [1.5]],
    ['a string byte', ['a']],
    ['an empty array', []],
    ['a Buffer object with non-array data', { type: 'Buffer', data: 'AAA=' }],
    ['a non-Buffer object', { type: 'Blob', data: [1] }],
    ['a string', 'AAEC'],
  ] as const) {
    it(`invalid_legacy_buffer: ${label}`, () => {
      expect(shapeOf('image', JSON.stringify({ ...VALID_MEDIA.image, buffer }), null)).toBe('invalid_legacy_buffer');
    });
  }
});

describe('assertScheduledPayloadWritable', () => {
  it('returns silently for a valid payload', () => {
    expect(() => assertScheduledPayloadWritable('text', JSON.stringify({ text: 'ok' }), null)).not.toThrow();
  });

  it('throws a reason naming payload_undecodable and the shape class, and no payload bytes', () => {
    const secret = 'SECRET-BODY-7731';
    expect(() => assertScheduledPayloadWritable('text', JSON.stringify(secret), null))
      .toThrow(/payload_undecodable shape=json_primitive/);
    let message = '';
    try {
      assertScheduledPayloadWritable('text', `${secret} not json`, null);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/payload_undecodable shape=not_json/);
    expect(message).not.toContain(secret);
  });
});
