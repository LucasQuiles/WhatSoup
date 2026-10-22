/**
 * Render voice notes readably in agent context. Pure and synchronous: it
 * never downloads, transcribes or waits.
 *
 * Live audio is transcribed on the inbound path (media-prep.ts). Audio
 * recovered through history sync is transcribed only by the explicit operator
 * command `prepare-recovered-audio`. Either way the transcript is stored on
 * the row. Without this renderer, context showed an audio row as its raw
 * `{"type":"audio",...}` JSON, with or without a transcript inside it.
 */
import type { ContentType } from '../../core/types.ts';
import { storedAudioTranscript } from '../../core/audio-transcript-content.ts';
import { CONTEXT_LINE_MAX_CHARS_PER_MESSAGE } from './context-lines.ts';

export interface ContextAudioMessage {
  messageId: string;
  contentType: ContentType;
  content: string | null;
  contentText: string | null;
}

function voiceNoteText(messageId: string, transcript: string | null): string {
  if (transcript === null) return `[Voice note — not transcribed (message ${messageId})]`;
  const text = `[Voice note transcription]: ${transcript}`;
  if (text.length <= CONTEXT_LINE_MAX_CHARS_PER_MESSAGE) return text;
  const suffix = ` … [transcript truncated; full text stored with message ${messageId}]`;
  return text.slice(0, CONTEXT_LINE_MAX_CHARS_PER_MESSAGE - suffix.length) + suffix;
}

/**
 * Returns the messages in the same order, with each audio message's `content`
 * replaced by its stored transcript or an explicit marker.
 */
export function renderVoiceNotes<T extends ContextAudioMessage>(messages: readonly T[]): T[] {
  return messages.map((message) => {
    if (message.contentType !== 'audio') return message;
    // StoredMessage.contentText falls back to content (the audio JSON) when
    // content_text is NULL, so only a distinct value can be a transcript.
    const contentText = message.contentText === message.content ? null : message.contentText;
    const transcript = storedAudioTranscript({ content: message.content, content_text: contentText });
    return { ...message, content: voiceNoteText(message.messageId, transcript) };
  });
}
