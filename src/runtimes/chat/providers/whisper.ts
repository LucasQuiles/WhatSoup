import OpenAI from 'openai';
import { createChildLogger } from '../../../logger.ts';
import { config } from '../../../config.ts';
import { emitAlert } from '../../../lib/emit-alert.ts';

const log = createChildLogger('whisper');
const WHISPER_TIMEOUT_MS = 60_000;
const FALLBACK_TEXT = "[Voice note — couldn't transcribe]";
const FAILURE_ALERT_THRESHOLD = 5;

let consecutiveFailures = 0;

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
    consecutiveFailures = 0;
    return result.text;
  } catch (err) {
    const elapsed_ms = Date.now() - startMs;
    consecutiveFailures++;
    const message = err instanceof Error ? err.message : String(err);

    log.warn({ error: message, elapsed_ms, audioSize: buffer?.length, consecutiveFailures }, 'whisper_transcription_failed');

    if (consecutiveFailures >= FAILURE_ALERT_THRESHOLD) {
      emitAlert(
        config.botName,
        'whisper_degraded',
        `Whisper has ${consecutiveFailures} consecutive transcription failures`,
        `Last error: ${message}`,
      );
    }

    return FALLBACK_TEXT;
  } finally {
    clearTimeout(timeout);
  }
}
