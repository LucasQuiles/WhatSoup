import OpenAI from 'openai';
import { createChildLogger } from '../../../logger.ts';

const log = createChildLogger('whisper');
const WHISPER_TIMEOUT_MS = 60_000;
const FALLBACK_TEXT = "[Voice note — couldn't transcribe]";

// Lazy-init client (same env var as the chat provider)
let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : 'webm';
  const file = new File([new Uint8Array(buffer)], `audio.${ext}`, { type: mimeType });

  const startMs = Date.now();
  try {
    const result = await getClient().audio.transcriptions.create(
      { model: 'whisper-1', file },
      { signal: controller.signal },
    );
    const durationMs = Date.now() - startMs;
    log.info({ durationMs, textLength: result.text.length }, 'Whisper transcription complete');
    return result.text;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      log.warn({ durationMs: Date.now() - startMs }, 'Whisper transcription timed out');
      return FALLBACK_TEXT;
    }
    log.error({ err }, 'Whisper transcription failed');
    return FALLBACK_TEXT;
  } finally {
    clearTimeout(timeout);
  }
}
