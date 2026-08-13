import OpenAI from 'openai';
import { config } from '../../../../config.ts';
import { CircuitBreaker } from '../../../../core/circuit-breaker.ts';
import { clearAlertSourceChecked, emitAlertChecked } from '../../../../lib/emit-alert.ts';
import {
  clearRecoveryMarker,
  loadRecoveryMarkers,
  setRecoveryMarker,
} from '../../../../lib/recovery-authority-store.ts';
import { createChildLogger } from '../../../../logger.ts';
import { extensionForMimeType } from './local-audio.ts';
import type { TranscriptionProvider } from './types.ts';
import { errorMessage } from '../../../../lib/error-message.ts';
import { resolveApiKey } from '../../../../lib/api-key-resolver.ts';

const log = createChildLogger('openai-whisper');
const WHISPER_TIMEOUT_MS = 20_000;

const breaker = new CircuitBreaker('openai-whisper', 5, 60_000, log);
let whisperAlerted = false;
// #2394 (whisper_degraded): true once the prior-process marker has been
// consulted and resolved (absent, or its clear durably accepted). Keeps the
// startup reconcile to at most one marker-store read per healthy process.
let startupReconcileDone = false;
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
    client = providerConfig
      ? new OpenAI({
          baseURL: providerConfig.baseUrl,
          apiKey: resolveTranscriptionApiKey() || undefined,
        })
      : new OpenAI();
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
    reconcileWhisperRecovery();
    log.info({ durationMs: Date.now() - startMs, textLength: result.text.length }, 'OpenAI whisper transcription complete');
    return result.text;
  } catch (err) {
    breaker.recordFailure();
    const message = errorMessage(err);
    log.warn({ error: message, elapsedMs: Date.now() - startMs, audioSize: buffer.length }, 'openai_whisper_transcription_failed');

    if (breaker.isOpen()) {
      // #2394 (whisper_degraded): arm incident ownership only on CHECKED
      // acceptance — a rejected emit leaves the flag false so the next
      // breaker-open failure retries it (bounded: while open, calls
      // short-circuit before the API, so retries ride half-open probes).
      whisperAlerted = emitAlertChecked(
        config.botName,
        'whisper_degraded',
        'Whisper circuit breaker tripped',
        `Last error: ${message}`,
      );
      if (whisperAlerted) {
        try {
          setRecoveryMarker(`whisper_degraded:${config.botName}`);
        } catch {
          // intentional: marker write is best-effort — the alert itself was
          // durably queued; a missing marker only loses cross-restart
          // reconciliation for this incident.
        }
      }
    }

    throw err instanceof Error ? err : new Error(message);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * #2394 (whisper_degraded): clear the incident on successful same-route
 * (OpenAI) transcription proof — the only valid recovery evidence for this
 * source. Owns three obligations: (1) retain clear-retry authority until the
 * checked clear is accepted (a rejected handoff keeps the flag/marker so the
 * next success retries); (2) reconcile a prior-process incident from the
 * durable marker exactly once per process; (3) never clear from process-local
 * silence — with no flag and no marker this is a no-op. Local-fallback
 * success never reaches this module, so it cannot clear the source.
 */
function reconcileWhisperRecovery(): void {
  let hadPriorIncident = whisperAlerted;
  if (!hadPriorIncident && !startupReconcileDone) {
    try {
      hadPriorIncident = loadRecoveryMarkers().has(`whisper_degraded:${config.botName}`);
    } catch {
      // intentional: marker file unreadable — treat as no prior incident and
      // stop consulting the store this process.
    }
    if (!hadPriorIncident) startupReconcileDone = true;
  }
  if (!hadPriorIncident) return;
  if (!clearAlertSourceChecked(config.botName, 'whisper_degraded')) {
    // Clear not durably accepted — retain ownership (flag and/or marker) so
    // the next successful transcription retries the idempotent clear.
    return;
  }
  whisperAlerted = false;
  startupReconcileDone = true;
  try {
    clearRecoveryMarker(`whisper_degraded:${config.botName}`);
  } catch {
    // intentional: marker removal is best-effort — a stale marker only causes
    // one redundant idempotent clear after the next restart.
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
    startupReconcileDone = false;
    breaker.recordSuccess();
  },
};
