/**
 * Direct unit coverage for src/core/media-mime.ts.
 *
 * Single exported helper `extractRawMime(rawMessage, contentType)` mines
 * the MIME type from a raw Baileys message shape. Four content types map
 * to specific message keys (imageMessage / audioMessage / videoMessage /
 * documentMessage); `document` has an additional one-level wrap path
 * through `documentWithCaptionMessage`. No test mirror existed despite
 * this being on the media-ingest critical path.
 */
import { describe, expect, it } from 'vitest';
import { extractRawMime, extractRawFileLength } from '../../src/core/media-mime.ts';

describe('extractRawFileLength (QR-057)', () => {
  it('extracts a numeric fileLength for each media type', () => {
    expect(extractRawFileLength({ message: { imageMessage: { fileLength: 12345 } } }, 'image')).toBe(12345);
    expect(extractRawFileLength({ message: { audioMessage: { fileLength: 6789 } } }, 'audio')).toBe(6789);
    expect(extractRawFileLength({ message: { videoMessage: { fileLength: 99999 } } }, 'video')).toBe(99999);
    expect(extractRawFileLength({ message: { documentMessage: { fileLength: 4096 } } }, 'document')).toBe(4096);
  });

  it('coerces a Long-like fileLength via toNumber()', () => {
    const longLike = { toNumber: () => 26_000_000, low: 0, high: 0 };
    expect(extractRawFileLength({ message: { videoMessage: { fileLength: longLike } } }, 'video')).toBe(26_000_000);
  });

  it('coerces a numeric-string fileLength', () => {
    expect(extractRawFileLength({ message: { documentMessage: { fileLength: '5242880' } } }, 'document')).toBe(5242880);
  });

  it('reads the documentWithCaptionMessage wrapper', () => {
    const raw = { message: { documentWithCaptionMessage: { message: { documentMessage: { fileLength: 777 } } } } };
    expect(extractRawFileLength(raw, 'document')).toBe(777);
  });

  it('returns undefined when fileLength is absent, unparseable, or rawMessage is missing', () => {
    expect(extractRawFileLength({ message: { imageMessage: {} } }, 'image')).toBeUndefined();
    expect(extractRawFileLength({ message: { imageMessage: { fileLength: 'not-a-number' } } }, 'image')).toBeUndefined();
    expect(extractRawFileLength(null, 'image')).toBeUndefined();
    expect(extractRawFileLength({ message: { imageMessage: { fileLength: 100 } } }, 'sticker')).toBeUndefined();
  });
});

describe('extractRawMime', () => {
  it('returns the mimetype for image content', () => {
    expect(
      extractRawMime({ message: { imageMessage: { mimetype: 'image/jpeg' } } }, 'image'),
    ).toBe('image/jpeg');
  });

  it('returns the mimetype for audio content', () => {
    expect(
      extractRawMime({ message: { audioMessage: { mimetype: 'audio/ogg' } } }, 'audio'),
    ).toBe('audio/ogg');
  });

  it('returns the mimetype for video content', () => {
    expect(
      extractRawMime({ message: { videoMessage: { mimetype: 'video/mp4' } } }, 'video'),
    ).toBe('video/mp4');
  });

  it('returns the mimetype for document content (direct shape)', () => {
    expect(
      extractRawMime({ message: { documentMessage: { mimetype: 'application/pdf' } } }, 'document'),
    ).toBe('application/pdf');
  });

  it('unwraps documentWithCaptionMessage for document content', () => {
    // Baileys ships documents-with-captions inside a wrapper one level deeper.
    const raw = {
      message: {
        documentWithCaptionMessage: {
          message: { documentMessage: { mimetype: 'image/png' } },
        },
      },
    };
    expect(extractRawMime(raw, 'document')).toBe('image/png');
  });

  it('returns undefined when rawMessage is null or undefined', () => {
    expect(extractRawMime(null, 'image')).toBeUndefined();
    expect(extractRawMime(undefined, 'image')).toBeUndefined();
  });

  it('returns undefined when rawMessage is falsy in another way (empty string, 0)', () => {
    expect(extractRawMime('', 'image')).toBeUndefined();
    expect(extractRawMime(0, 'image')).toBeUndefined();
  });

  it('returns undefined for unknown content type', () => {
    const raw = { message: { imageMessage: { mimetype: 'image/jpeg' } } };
    expect(extractRawMime(raw, 'unknown')).toBeUndefined();
    expect(extractRawMime(raw, '')).toBeUndefined();
    expect(extractRawMime(raw, 'sticker')).toBeUndefined();
  });

  it('returns undefined when the message node for the content type is missing', () => {
    expect(extractRawMime({ message: {} }, 'image')).toBeUndefined();
    expect(extractRawMime({}, 'image')).toBeUndefined();
  });

  it('returns undefined when the matched message node has no mimetype field', () => {
    expect(extractRawMime({ message: { imageMessage: {} } }, 'image')).toBeUndefined();
    expect(
      extractRawMime({ message: { audioMessage: { other: 'field' } } }, 'audio'),
    ).toBeUndefined();
  });

  it('returns undefined for document when neither direct nor wrapped shape has a mimetype', () => {
    expect(
      extractRawMime(
        { message: { documentWithCaptionMessage: { message: { documentMessage: {} } } } },
        'document',
      ),
    ).toBeUndefined();
    expect(extractRawMime({ message: { documentMessage: {} } }, 'document')).toBeUndefined();
  });

  it('prefers the direct documentMessage shape over the wrapped one (early return)', () => {
    // If both shapes carry mimetypes, the direct path wins because the
    // wrapper-unwrap only runs when msgNode is falsy after the direct lookup.
    const raw = {
      message: {
        documentMessage: { mimetype: 'application/pdf' },
        documentWithCaptionMessage: {
          message: { documentMessage: { mimetype: 'image/png' } },
        },
      },
    };
    expect(extractRawMime(raw, 'document')).toBe('application/pdf');
  });
});
