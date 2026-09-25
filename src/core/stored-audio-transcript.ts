/**
 * Transcribe an audio message that is already stored in the messages table.
 *
 * Used by the transcribe_audio MCP tool. Rows written by history sync carry
 * no media file and no transcript; their raw_message is the only way back to
 * the audio. The transcriber is injected because core may not import the
 * runtimes layer that owns the provider chain.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { Database } from './database.ts';
import { downloadMedia, writeTempFile } from './media-download.ts';
import { extractRawMime } from './media-mime.ts';
import { updateMediaPath, updateTranscription } from './messages.ts';
import { errorMessage } from '../lib/error-message.ts';
import { isUsableTranscript as usable, storedAudioTranscript } from './audio-transcript-content.ts';

export interface StoredAudioRow {
  message_id: string;
  content: string | null;
  content_text: string | null;
  media_path: string | null;
  raw_message: string | null;
}

export type AudioTranscriber = (buffer: Buffer, mimeType: string) => Promise<string>;

export type StoredAudioTranscriptFailure =
  | 'no_audio_data'
  | 'media_expired'
  | 'download_failed'
  | 'transcription_failed';

export type StoredAudioTranscriptResult =
  | { status: 'cached'; transcription: string }
  | { status: 'transcribed'; transcription: string }
  | { status: StoredAudioTranscriptFailure; message: string };

export async function ensureStoredAudioTranscript(
  db: Database,
  row: StoredAudioRow,
  transcribe: AudioTranscriber,
): Promise<StoredAudioTranscriptResult> {
  const cached = storedAudioTranscript(row);
  if (cached !== null) return { status: 'cached', transcription: cached };

  let audioBuffer: Buffer | null = null;
  let audioMime = 'audio/ogg';

  if (row.media_path && existsSync(row.media_path)) {
    audioBuffer = readFileSync(row.media_path) as unknown as Buffer;
    const ext = row.media_path.split('.').pop()?.toLowerCase();
    if (ext === 'mp3') audioMime = 'audio/mpeg';
    else if (ext === 'm4a') audioMime = 'audio/mp4';
    else if (ext === 'wav') audioMime = 'audio/wav';
    else if (ext === 'webm') audioMime = 'audio/webm';
  } else if (row.raw_message) {
    let rawMsg: unknown;
    try {
      rawMsg = JSON.parse(row.raw_message);
    } catch {
      return { status: 'no_audio_data', message: 'Cannot parse raw message data for audio download.' };
    }

    const mime = extractRawMime(rawMsg, 'audio') ?? 'audio/ogg';
    const downloadFn = async (): Promise<Buffer> => {
      const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
      return downloadMediaMessage(rawMsg as WAMessage, 'buffer', {}) as Promise<Buffer>;
    };

    try {
      const result = await downloadMedia(downloadFn, mime);
      if (result) {
        audioBuffer = result.buffer;
        audioMime = result.mimeType;
        const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
        const filePath = writeTempFile(result.buffer, ext);
        updateMediaPath(db, row.message_id, filePath);
      }
    } catch (err) {
      if (/404|410|gone|expired/i.test(errorMessage(err))) {
        return { status: 'media_expired', message: 'Audio media URL has expired.' };
      }
      return { status: 'download_failed', message: 'Failed to download audio for transcription.' };
    }
  }

  if (!audioBuffer) {
    return {
      status: 'no_audio_data',
      message: 'No audio data available. Media path missing and raw message unavailable.',
    };
  }

  const transcription = await transcribe(audioBuffer, audioMime);
  if (!usable(transcription)) {
    return { status: 'transcription_failed', message: 'Transcription failed or is unavailable.' };
  }

  updateTranscription(db, row.message_id, transcription);
  return { status: 'transcribed', transcription };
}
