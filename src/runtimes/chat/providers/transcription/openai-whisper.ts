import OpenAI from 'openai';
import { config } from '../../../../config.ts';
import { CircuitBreaker } from '../../../../core/circuit-breaker.ts';
import { sleep } from '../../../../core/retry.ts';
import { clearAlertSource, emitAlert } from '../../../../lib/emit-alert.ts';
import { createChildLogger } from '../../../../logger.ts';
import type { TranscriptionProvider } from './types.ts';

const log = createChildLogger('openai-whisper');
const WHISPER_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 500;

const breaker = new CircuitBreaker('openai-whisper', 5, 60_000, log);
let whisperAlerted = false;
let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

export async function transcribeWithOpenAI(buffer: Buffer, mimeType: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set');
  }

  if (breaker.isOpen()) {
    throw new Error('openai whisper circuit breaker open');
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
    breaker.recordSuccess();
    if (whisperAlerted) {
      whisperAlerted = false;
      clearAlertSource(config.botName, 'whisper_degraded');
    }
    log.info({ durationMs: Date.now() - startMs, textLength: result.text.length }, 'OpenAI whisper transcription complete');
    return result.text;
  } catch {
    await sleep(RETRY_DELAY_MS);
  }

  try {
    const result = await doTranscribe();
    breaker.recordSuccess();
    if (whisperAlerted) {
      whisperAlerted = false;
      clearAlertSource(config.botName, 'whisper_degraded');
    }
    log.info({ durationMs: Date.now() - startMs, textLength: result.text.length, retried: true }, 'OpenAI whisper transcription complete (after retry)');
    return result.text;
  } catch (retryErr) {
    breaker.recordFailure();
    const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
    log.warn({ error: message, elapsedMs: Date.now() - startMs, audioSize: buffer.length }, 'openai_whisper_transcription_failed');

    if (breaker.isOpen()) {
      whisperAlerted = true;
      emitAlert(
        config.botName,
        'whisper_degraded',
        'Whisper circuit breaker tripped',
        `Last error: ${message}`,
      );
    }

    throw retryErr instanceof Error ? retryErr : new Error(message);
  }
}

export const openAIWhisperProvider: TranscriptionProvider = {
  name: 'openai',
  isAvailable: () => Boolean(process.env.OPENAI_API_KEY),
  transcribe: transcribeWithOpenAI,
};

export const _testing = {
  reset(): void {
    client = null;
    whisperAlerted = false;
    breaker.recordSuccess();
  },
};
