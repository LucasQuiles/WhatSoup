import OpenAI from 'openai';
import { config } from '../../../../config.ts';
import { CircuitBreaker } from '../../../../core/circuit-breaker.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../../../../lib/emit-alert.ts';
import { createChildLogger } from '../../../../logger.ts';
import { extensionForMimeType } from './local-audio.ts';
import type { TranscriptionProvider } from './types.ts';
import { errorMessage } from '../../../../lib/error-message.ts';
import { resolveApiKey } from '../../../../lib/api-key-resolver.ts';

const log = createChildLogger('openai-whisper');
const WHISPER_TIMEOUT_MS = 20_000;

const breaker = new CircuitBreaker('openai-whisper', 5, 60_000, log);
let whisperAlerted = false;
let client: OpenAI | null = null;

type OpenAIProviderConfig = { baseUrl?: string; apiKeyService?: string };

function transcriptionProviderConfig(): OpenAIProviderConfig | undefined {
  return config.transcriptionOpenAIProviderConfig as OpenAIProviderConfig | undefined;
}

function resolveTranscriptionApiKey(): string {
  return resolveApiKey({
    service: transcriptionProviderConfig()?.apiKeyService,
    envVar: 'OPENAI_API_KEY',
  });
}

function getClient(): OpenAI {
  const providerConfig = transcriptionProviderConfig();
  if (!client) {
    client = new OpenAI({
      ...(providerConfig?.baseUrl ? { baseURL: providerConfig.baseUrl } : {}),
      apiKey: resolveTranscriptionApiKey() || undefined,
    });
  }
  return client;
}

export async function transcribeWithOpenAI(buffer: Buffer, mimeType: string): Promise<string> {
  if (!resolveTranscriptionApiKey()) {
    throw new Error('OPENAI_API_KEY not set');
  }

  if (breaker.isOpen()) {
    throw new Error('openai whisper circuit breaker open');
  }

  const ext = extensionForMimeType(mimeType);
  const file = new File([new Uint8Array(buffer)], `audio.${ext}`, { type: mimeType });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);
  const startMs = Date.now();

  try {
    const result = await getClient().audio.transcriptions.create(
      { model: 'whisper-1', file },
      { signal: controller.signal },
    );
    breaker.recordSuccess();
    if (whisperAlerted) {
      whisperAlerted = false;
      clearAlertSourceChecked(config.botName, 'whisper_degraded');
    }
    log.info({ durationMs: Date.now() - startMs, textLength: result.text.length }, 'OpenAI whisper transcription complete');
    return result.text;
  } catch (err) {
    breaker.recordFailure();
    const message = errorMessage(err);
    log.warn({ error: message, elapsedMs: Date.now() - startMs, audioSize: buffer.length }, 'openai_whisper_transcription_failed');

    if (breaker.isOpen()) {
      whisperAlerted = true;
      emitAlertChecked(
        config.botName,
        'whisper_degraded',
        'Whisper circuit breaker tripped',
        `Last error: ${message}`,
      );
    }

    throw err instanceof Error ? err : new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}

export const openAIWhisperProvider: TranscriptionProvider = {
  name: 'openai',
  isAvailable: () => Boolean(resolveTranscriptionApiKey()),
  transcribe: transcribeWithOpenAI,
};

export const _testing = {
  reset(): void {
    client = null;
    whisperAlerted = false;
    breaker.recordSuccess();
  },
};
