import { createChildLogger } from '../../../logger.ts';
import type { IncomingMessage } from '../../../core/types.ts';
import { transcribeAudio } from '../providers/whisper.ts';
import { downloadMedia } from '../../../core/media-download.ts';
import { extractFrames } from './video.ts';
import { extractUrls, extractLinkContent } from './links.ts';
import { extractDocumentText } from './documents.ts';
import { extractRawMime } from '../../../core/media-mime.ts';

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

    let mimeType = contentType === 'sticker' ? 'image/webp' : 'image/jpeg';
    // Extract real MIME type from raw WhatsApp message when available
    if (contentType === 'image') {
      mimeType = extractRawMime(msg.rawMessage, 'image') ?? mimeType;
    }
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

    // Extract real MIME type from raw WhatsApp message when available
    const audioMime = extractRawMime(msg.rawMessage, 'audio') ?? 'audio/ogg';
    const result = await downloadMedia(downloadFn, audioMime);
    if (!result) {
      return { content: "[audio — couldn't download]", images: [] };
    }

    try {
      const transcript = await transcribeAudio(result.buffer, result.mimeType);
      return { content: transcript, images: [] };
    } catch (err) {
      log.error({ err }, 'audio transcription failed');
      return { content: '[voice message — transcription failed]', images: [] };
    }
  }

  // Video: download → extract frames → images array with timestamps
  if (contentType === 'video') {
    if (!downloadFn) {
      return { content: "[video — couldn't download]", images: [] };
    }

    // Extract real MIME type from raw WhatsApp message when available
    const videoMime = extractRawMime(msg.rawMessage, 'video') ?? 'video/mp4';
    const result = await downloadMedia(downloadFn, videoMime);
    if (!result) {
      return { content: "[video — couldn't download]", images: [] };
    }

    let frames: Awaited<ReturnType<typeof extractFrames>>;
    try {
      frames = await extractFrames(result.buffer);
    } catch (err) {
      log.error({ err }, 'video frame extraction failed');
      return { content: content ?? '[video — processing failed]', images: [] };
    }
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
    // Extract real MIME type from raw WhatsApp message when available
    const docMime = extractRawMime(msg.rawMessage, 'document') ?? 'application/octet-stream';
    const result = await downloadMedia(downloadFn, docMime);
    if (!result) {
      return { content: "[document — couldn't download]", images: [] };
    }

    try {
      const text = await extractDocumentText(result.buffer, result.mimeType, fileName);
      return { content: text, images: [] };
    } catch (err) {
      log.error({ err, fileName }, 'document text extraction failed');
      return { content: `[document: ${fileName} — could not extract text]`, images: [] };
    }
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
