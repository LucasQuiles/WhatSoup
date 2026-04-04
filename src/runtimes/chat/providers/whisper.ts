import OpenAI from 'openai';
import { createChildLogger } from '../../../logger.ts';
import { config } from '../../../config.ts';
import { emitAlert, clearAlertSource } from '../../../lib/emit-alert.ts';
import { CircuitBreaker } from '../../../core/circuit-breaker.ts';

const log = createChildLogger('whisper');
const WHISPER_TIMEOUT_MS = 60_000;
const FALLBACK_TEXT = '[🎤 Voice note received — transcription unavailable]';
const RETRY_DELAY_MS = 500;

const breaker = new CircuitBreaker('whisper', 5, 60_000, log);
let whisperAlerted = false;

// Lazy-init client (same env var as the chat provider)
let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  if (breaker.isOpen()) {
    log.warn('whisper circuit breaker open — returning fallback');
    return FALLBACK_TEXT;
  }

  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : 'webm';
  const file = new File([new Uint8Array(buffer)], `audio.${ext}`, { type: mimeType });

  const doTranscribe = () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);
    return getClient()
      .audio.transcriptions.create(
        { model: 'whisper-1', file },
        { signal: controller.signal },
      )
      .finally(() => clearTimeout(timeout));
  };

  const startMs = Date.now();
  try {
    const result = await doTranscribe();
    const durationMs = Date.now() - startMs;
    log.info({ durationMs, textLength: result.text.length }, 'Whisper transcription complete');
    breaker.recordSuccess();
    if (whisperAlerted) {
      whisperAlerted = false;
      clearAlertSource(config.botName, 'whisper_degraded');
    }
    return result.text;
  } catch (err) {
    // One retry after short delay to catch transient blips
    await sleep(RETRY_DELAY_MS);
    try {
      const result = await doTranscribe();
      const durationMs = Date.now() - startMs;
      log.info({ durationMs, textLength: result.text.length, retried: true }, 'Whisper transcription complete (after retry)');
      breaker.recordSuccess();
      if (whisperAlerted) {
        whisperAlerted = false;
        clearAlertSource(config.botName, 'whisper_degraded');
      }
      return result.text;
    } catch (retryErr) {
      const elapsed_ms = Date.now() - startMs;
      breaker.recordFailure();
      const message = retryErr instanceof Error ? retryErr.message : String(retryErr);

      log.warn({ error: message, elapsed_ms, audioSize: buffer?.length }, 'whisper_transcription_failed');

      if (breaker.isOpen()) {
        whisperAlerted = true;
        emitAlert(
          config.botName,
          'whisper_degraded',
          'Whisper circuit breaker tripped',
          `Last error: ${message}`,
        );
      }

      return FALLBACK_TEXT;
    }
  }
}
