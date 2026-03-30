import { createChildLogger } from '../../../logger.ts';

const log = createChildLogger('media:documents');

const MAX_TEXT_LENGTH = 2000;

export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<string> {
  try {
    if (mimeType === 'application/pdf') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { PDFParse } = await import('pdf-parse') as any;
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      return result.text.slice(0, MAX_TEXT_LENGTH);
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
