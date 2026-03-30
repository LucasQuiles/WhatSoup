import { createChildLogger } from '../../../logger.ts';
import type { IncomingMessage } from '../../../core/types.ts';
import { transcribeAudio } from '../providers/whisper.ts';
import { downloadMedia } from '../../../core/media-download.ts';
import { extractFrames } from './video.ts';
import { extractUrls, extractLinkContent } from './links.ts';
import { extractDocumentText } from './documents.ts';

const log = createChildLogger('media:processor');

const MAX_LINKS = 3;

export interface ProcessedMedia {
  content: string;
  images: Array<{ mimeType: string; base64: string }>;
}

export async function processMedia(
  msg: IncomingMessage,
  downloadFn: (() => Promise<Buffer>) | null,
): Promise<ProcessedMedia> {
  const { contentType, content } = msg;

  // Text: extract URLs and fetch link content
  if (contentType === 'text') {
    const text = content ?? '';
    const urls = extractUrls(text).slice(0, MAX_LINKS);

    if (urls.length === 0) {
      return { content: text, images: [] };
    }

    const linkResults = await Promise.all(urls.map(url => extractLinkContent(url)));
    const linkSummaries = linkResults.map((lc, i) => {
      const url = urls[i];
      if (lc.fallbackLevel === 'raw') {
        return `[Link: ${url} — ${lc.content}]`;
      }
      return `[Link: ${lc.title}\n${lc.content}]`;
    });

    const combined = [text, ...linkSummaries].filter(Boolean).join('\n\n');
    return { content: combined, images: [] };
  }

  // Images and stickers: download → base64
  if (contentType === 'image' || contentType === 'sticker') {
    const label = contentType === 'sticker' ? 'sticker' : 'image';
    if (!downloadFn) {
      return { content: `[${label} — couldn't download]`, images: [] };
    }

    const mimeType = contentType === 'sticker' ? 'image/webp' : 'image/jpeg';
    const result = await downloadMedia(downloadFn, mimeType);
    if (!result) {
      return { content: `[${label} — couldn't download]`, images: [] };
    }

    return {
      content: content ?? '',
      images: [{ mimeType: result.mimeType, base64: result.buffer.toString('base64') }],
    };
  }

  // Audio: download → Whisper transcription
  if (contentType === 'audio') {
    if (!downloadFn) {
      return { content: "[audio — couldn't download]", images: [] };
    }

    const result = await downloadMedia(downloadFn, 'audio/ogg');
    if (!result) {
      return { content: "[audio — couldn't download]", images: [] };
    }

    const transcript = await transcribeAudio(result.buffer, result.mimeType);
    return { content: transcript, images: [] };
  }

  // Video: download → extract frames → images array with timestamps
  if (contentType === 'video') {
    if (!downloadFn) {
      return { content: "[video — couldn't download]", images: [] };
    }

    const result = await downloadMedia(downloadFn, 'video/mp4');
    if (!result) {
      return { content: "[video — couldn't download]", images: [] };
    }

    const frames = await extractFrames(result.buffer);
    if (frames.length === 0) {
      return { content: content ?? "[video — no frames extracted]", images: [] };
    }

    const images = frames.map(f => ({
      mimeType: 'image/jpeg',
      base64: f.buffer.toString('base64'),
    }));

    const caption = content ? `${content}\n` : '';
    const timestamps = frames.map(f => f.timestamp).join(', ');
    return {
      content: `${caption}[Video frames at: ${timestamps}]`,
      images,
    };
  }

  // Documents: download → extractDocumentText
  if (contentType === 'document') {
    if (!downloadFn) {
      return { content: "[document — couldn't download]", images: [] };
    }

    const fileName = content ?? 'document';
    const mimeType = 'application/octet-stream';
    const result = await downloadMedia(downloadFn, mimeType);
    if (!result) {
      return { content: "[document — couldn't download]", images: [] };
    }

    const text = await extractDocumentText(result.buffer, result.mimeType, fileName);
    return { content: text, images: [] };
  }

  // Location
  if (contentType === 'location') {
    const locationContent = content ? `[Location: ${content}]` : '[Location shared]';
    return { content: locationContent, images: [] };
  }

  // Contact
  if (contentType === 'contact') {
    const contactContent = content ? `[Contact: ${content}]` : '[Contact shared]';
    return { content: contactContent, images: [] };
  }

  // Poll
  if (contentType === 'poll') {
    const pollContent = content ? `[Poll: ${content}]` : '[Poll]';
    return { content: pollContent, images: [] };
  }

  // Unknown / fallback
  log.warn({ contentType }, 'processMedia: unhandled contentType');
  return { content: content ?? '[unsupported message type]', images: [] };
}
