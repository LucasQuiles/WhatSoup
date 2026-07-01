import { createChildLogger } from '../../../logger.ts';

const log = createChildLogger('media:documents');

const MAX_TEXT_LENGTH = 2000;

// QR-058: the 2000-char output cap bounds nothing about the DECODE work — pdf-parse's
// getText() decodes the WHOLE document (every page + content stream) into memory BEFORE
// the slice, so a small attacker PDF (e.g. ~50k pages in 7MB, under the 25MB download cap)
// pins this inline media handler for tens of seconds / >1GB RSS. Bound it two ways:
//   (1) parse only the first N pages — the output is tiny, so a handful of pages is plenty;
//   (2) wall-clock-bound the parse so a single decompression-bomb page cannot hang forever.
// The timeout abandons the await but cannot cancel the pdfjs worker (same uncancellable-work
// caveat as image-resize / QR-026); the PAGE CAP is the real bound, the timeout is the backstop.
const MAX_PDF_PAGES = 8;
const PDF_PARSE_TIMEOUT_MS = 10_000;

export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<string> {
  try {
    if (mimeType === 'application/pdf') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pdf-parse ships no usable types for the dynamic import; expires 2026-12-31
      const { PDFParse } = await import('pdf-parse') as any;
      const parser = new PDFParse({ data: buffer });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          parser.getText({ first: MAX_PDF_PAGES }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`pdf parse exceeded ${PDF_PARSE_TIMEOUT_MS}ms`)),
              PDF_PARSE_TIMEOUT_MS,
            );
          }),
        ]);
        return result.text.slice(0, MAX_TEXT_LENGTH);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (
      mimeType.startsWith('text/') ||
      mimeType === 'application/json' ||
      mimeType === 'application/xml'
    ) {
      return buffer.toString('utf8').slice(0, MAX_TEXT_LENGTH);
    }

    return `[Document: ${fileName} — format not supported]`;
  } catch (err) {
    log.error({ err, mimeType, fileName }, 'Document text extraction failed');
    return `[Document: ${fileName} — couldn't extract text]`;
  }
}
