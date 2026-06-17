import { beforeEach, describe, it, expect, vi } from 'vitest';

const { mockLogError, mockGetText, mockPdfParseConstructor } = vi.hoisted(() => {
  const getText = vi.fn();
  return {
    mockLogError: vi.fn(),
    mockGetText: getText,
    mockPdfParseConstructor: vi.fn(function (_opts: { data: Buffer }) {
      return { getText };
    }),
  };
});

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLogError,
    debug: vi.fn(),
  }),
}));

vi.mock('pdf-parse', () => ({
  PDFParse: mockPdfParseConstructor,
}));

import { extractDocumentText } from '../../../../src/runtimes/chat/media/documents.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractDocumentText — positive', () => {
  it('extracts and truncates PDF text through pdf-parse', async () => {
    mockGetText.mockResolvedValue({ text: `${'p'.repeat(2100)}tail` });
    const buffer = Buffer.from('%PDF-1.7 fake', 'utf8');

    const result = await extractDocumentText(buffer, 'application/pdf', 'report.pdf');

    expect(result).toBe('p'.repeat(2000));
    expect(mockPdfParseConstructor).toHaveBeenCalledWith({ data: buffer });
    expect(mockGetText).toHaveBeenCalledTimes(1);
  });

  it('UTF-8 text/plain extracted correctly', async () => {
    const text = 'Hello, this is plain text content.';
    const buffer = Buffer.from(text, 'utf8');

    const result = await extractDocumentText(buffer, 'text/plain', 'readme.txt');

    expect(result).toBe(text);
  });

  it('text/html buffer returned as UTF-8 string', async () => {
    const html = '<p>Some HTML content</p>';
    const buffer = Buffer.from(html, 'utf8');

    const result = await extractDocumentText(buffer, 'text/html', 'page.html');

    expect(result).toBe(html);
  });

  it('application/json buffer returned as string', async () => {
    const json = '{"key":"value"}';
    const buffer = Buffer.from(json, 'utf8');

    const result = await extractDocumentText(buffer, 'application/json', 'data.json');

    expect(result).toBe(json);
  });

  it('text content truncated to 2000 chars', async () => {
    const longText = 'a'.repeat(5000);
    const buffer = Buffer.from(longText, 'utf8');

    const result = await extractDocumentText(buffer, 'text/plain', 'big.txt');

    expect(result.length).toBe(2000);
    expect(result).toBe('a'.repeat(2000));
  });
});

describe('extractDocumentText — negative', () => {
  it('returns extraction fallback and logs context when PDF parsing fails', async () => {
    const parseError = new Error('pdf parser failed');
    mockGetText.mockRejectedValue(parseError);

    const result = await extractDocumentText(Buffer.from('broken pdf'), 'application/pdf', 'broken.pdf');

    expect(result).toBe("[Document: broken.pdf — couldn't extract text]");
    expect(mockLogError).toHaveBeenCalledWith(
      { err: parseError, mimeType: 'application/pdf', fileName: 'broken.pdf' },
      'Document text extraction failed',
    );
  });

  it('unsupported format returns label string', async () => {
    const buffer = Buffer.from([0x00, 0x01, 0x02]); // binary garbage

    const result = await extractDocumentText(buffer, 'application/octet-stream', 'binary.bin');

    expect(result).toContain('binary.bin');
    expect(result).toContain('format not supported');
  });

  it('unknown MIME type returns label string with fileName', async () => {
    const buffer = Buffer.from([0x1f, 0x8b]); // gzip magic bytes

    const result = await extractDocumentText(buffer, 'application/x-unknown-type', 'archive.gz');

    expect(result).toContain('archive.gz');
  });
});
