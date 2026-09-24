/**
 * How a voice-note transcript is stored on a messages row. Pure, with no
 * imports that touch configuration, so operator scripts can share it.
 *
 * The audio parser stores `content` as `{"type":"audio",...,"transcription":null}`
 * and `content_text` as NULL. A transcript is written into both: merged into
 * the JSON and copied to `content_text` (FTS-indexed).
 */
import { isNonEmptyString } from '../lib/type-guards.ts';

/** Substring of the transcription chain's fallback text; never a transcript. */
export const TRANSCRIPTION_UNAVAILABLE_MARKER = 'transcription unavailable';

export function isUsableTranscript(text: unknown): text is string {
  return isNonEmptyString(text) && !text.includes(TRANSCRIPTION_UNAVAILABLE_MARKER);
}

/** The stored transcript of an audio row, or null when there is none. */
export function storedAudioTranscript(row: { content: string | null; content_text: string | null }): string | null {
  if (isUsableTranscript(row.content_text)) return row.content_text;
  if (row.content) {
    try {
      const parsed = JSON.parse(row.content) as { transcription?: unknown };
      if (isUsableTranscript(parsed.transcription)) return parsed.transcription;
    } catch {
      // by design: legacy rows store plain text in content, and such a row has
      // no transcript, which is what returning null below reports.
    }
  }
  return null;
}

/** The `content` value after recording `transcription` on an audio row. */
export function mergeTranscriptionContent(content: string | null, transcription: string): string {
  try {
    const parsed = JSON.parse(content || '{}') as Record<string, unknown>;
    parsed.transcription = transcription;
    return JSON.stringify(parsed);
  } catch {
    // by design: non-JSON legacy content is replaced by the structured form.
    return JSON.stringify({ transcription });
  }
}
