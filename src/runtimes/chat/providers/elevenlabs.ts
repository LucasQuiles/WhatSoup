import { execFileSync } from 'node:child_process';
import { createChildLogger } from '../../../logger.ts';
import { CircuitBreaker } from '../../../core/circuit-breaker.ts';
import { sleep } from '../../../core/retry.ts';

const log = createChildLogger('elevenlabs');
const ELEVENLABS_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 500;
const DEFAULT_VOICE_ID = 'pNInz6obpgDQGcFmaJgB'; // Adam
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const API_BASE = 'https://api.elevenlabs.io';

const breaker = new CircuitBreaker('elevenlabs', 5, 60_000, log);

// Lazy-init API key from GNOME Keyring
let apiKey: string | null = null;
function getApiKey(): string {
  if (!apiKey) {
    try {
      const raw = execFileSync('secret-tool', ['lookup', 'service', 'elevenlabs'], {
        timeout: 5_000,
      });
      apiKey = (typeof raw === 'string' ? raw : raw.toString('utf-8')).trim();
    } catch (err) {
      throw new Error(
        'ElevenLabs API key not found in keyring. Run: secret-tool store --label="ElevenLabs" service elevenlabs',
      );
    }
    if (!apiKey) {
      throw new Error('ElevenLabs API key is empty in keyring.');
    }
  }
  return apiKey;
}

export interface VoiceSynthesisResult {
  buffer: Buffer;
  duration: number;
  mimeType: string;
}

export interface SynthesisOptions {
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
}

export async function synthesizeSpeech(
  text: string,
  options?: SynthesisOptions,
): Promise<VoiceSynthesisResult> {
  if (breaker.isOpen()) {
    throw new Error('ElevenLabs circuit breaker open — TTS unavailable');
  }

  const voiceId = options?.voiceId ?? DEFAULT_VOICE_ID;
  const modelId = options?.modelId ?? DEFAULT_MODEL_ID;
  const stability = options?.stability ?? 0.5;
  const similarityBoost = options?.similarityBoost ?? 0.75;

  const url = `${API_BASE}/v1/text-to-speech/${voiceId}`;
  const body = JSON.stringify({
    text,
    model_id: modelId,
    voice_settings: {
      stability,
      similarity_boost: similarityBoost,
    },
  });

  const doSynthesize = async (): Promise<VoiceSynthesisResult> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': getApiKey(),
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`ElevenLabs API error ${response.status}: ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const mimeType = response.headers.get('content-type') ?? 'audio/mpeg';

      // Estimate duration from buffer size (rough: mp3 at ~128kbps)
      const estimatedDuration = Math.ceil(buffer.length / (128 * 1024 / 8));

      return { buffer, duration: estimatedDuration, mimeType };
    } finally {
      clearTimeout(timeout);
    }
  };

  const startMs = Date.now();
  try {
    const result = await doSynthesize();
    const durationMs = Date.now() - startMs;
    log.info(
      { durationMs, textLength: text.length, audioBytes: result.buffer.length },
      'ElevenLabs synthesis complete',
    );
    breaker.recordSuccess();
    return result;
  } catch (err) {
    // One retry after short delay (matches Whisper pattern)
    await sleep(RETRY_DELAY_MS);
    try {
      const result = await doSynthesize();
      const durationMs = Date.now() - startMs;
      log.info(
        { durationMs, textLength: text.length, retried: true },
        'ElevenLabs synthesis complete (after retry)',
      );
      breaker.recordSuccess();
      return result;
    } catch (retryErr) {
      const elapsedMs = Date.now() - startMs;
      breaker.recordFailure();
      const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
      log.warn({ error: message, elapsedMs, textLength: text.length }, 'elevenlabs_synthesis_failed');
      throw new Error(`ElevenLabs synthesis failed: ${message}`);
    }
  }
}

// Exported for testing only — allows resetting circuit breaker state between tests
export const _testing = {
  resetBreaker: () => {
    (breaker as any).failures = 0;
    (breaker as any).state = 'closed';
    (breaker as any).probing = false;
    (breaker as any).lastFailureAt = 0;
    apiKey = null;
  },
};
