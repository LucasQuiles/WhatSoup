/**
 * Byte-preservation tests for the shared request-body readers.
 *
 * The euro sign '€' is UTF-8 E2 82 AC. Splitting a request between E2 and
 * 82 AC puts a multibyte code point across two 'data' events; a reader that
 * decodes each chunk separately corrupts it into replacement characters.
 */
import { describe, it, expect } from 'vitest';
import { readBody, readBodyBytes } from '../../src/lib/http.ts';
import { mockReq } from '../helpers/http-mocks.ts';

const EURO_JSON = Buffer.from('{"a":"€"}');
const SPLIT_AT = EURO_JSON.indexOf(0xe2) + 1;
const EURO_CHUNKS = [EURO_JSON.subarray(0, SPLIT_AT), EURO_JSON.subarray(SPLIT_AT)];

describe('readBody byte preservation', () => {
  it('preserves a multibyte character split across chunk boundaries', async () => {
    const req = mockReq({ chunks: EURO_CHUNKS });
    const body = await readBody(req);
    expect(body).toBe('{"a":"€"}');
    expect(Buffer.from(body, 'utf8').equals(EURO_JSON)).toBe(true);
  });

  it('applies the byte limit across multiple chunks', async () => {
    const req = mockReq({ chunks: [Buffer.alloc(6, 0x61), Buffer.alloc(6, 0x62)] });
    await expect(readBody(req, 10)).rejects.toMatchObject({
      message: 'request body too large',
      statusCode: 413,
    });
  });
});

describe('readBodyBytes', () => {
  it('returns the exact received byte sequence across chunk splits', async () => {
    const req = mockReq({ chunks: EURO_CHUNKS });
    const bytes = await readBodyBytes(req);
    expect(bytes.equals(EURO_JSON)).toBe(true);
  });

  it('preserves a UTF-8 BOM in the returned bytes', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]);
    const req = mockReq({ chunks: [withBom] });
    const bytes = await readBodyBytes(req);
    expect(bytes.equals(withBom)).toBe(true);
  });

  it('applies the byte limit across multiple chunks', async () => {
    const req = mockReq({ chunks: [Buffer.alloc(6, 0x61), Buffer.alloc(6, 0x62)] });
    await expect(readBodyBytes(req, 10)).rejects.toMatchObject({
      message: 'request body too large',
      statusCode: 413,
    });
  });
});
