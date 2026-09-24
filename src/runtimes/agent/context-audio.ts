/**
 * Voice-note readiness for agent context assembly.
 *
 * Live audio is transcribed on the inbound path (media-prep.ts). Audio that
 * arrives through history sync after a relink never takes that path, so it
 * reaches the agent's catch-up context as an empty `{transcription: null}`
 * blob. Two entry points close that gap:
 *   - warmHistoryAudio starts transcribing recent inbound history audio as
 *     soon as a batch is stored, so the transcript normally exists before the
 *     next turn;
 *   - prepareContextAudio runs before context lines are formatted. It waits a
 *     bounded time for pending transcripts and renders an explicit marker for
 *     every voice note that has none, instead of a raw JSON blob.
 *
 * Transcription is serialized (the local providers are CPU bound), a message
 * is never transcribed twice concurrently, and failures are remembered for the
 * life of the process so an expired voice note is not retried on every turn.
 */
import type { Database } from '../../core/database.ts';
import type { ContentType } from '../../core/types.ts';
import type { HistoryInput } from '../../core/history-sync.ts';
import { unwrapMessage } from '../../core/message-parser.ts';
import {
  ensureStoredAudioTranscript,
  storedAudioTranscript,
  type AudioTranscriber,
  type StoredAudioRow,
  type StoredAudioTranscriptResult,
} from '../../core/stored-audio-transcript.ts';
import { CONTEXT_LINE_MAX_CHARS_PER_MESSAGE } from './context-lines.ts';
import { createChildLogger } from '../../logger.ts';

const log = createChildLogger('agent:context-audio');

/** Voice notes transcribed while one context block is assembled. */
export const CONTEXT_AUDIO_MAX_PER_ASSEMBLY = 3;
/** Longest a context assembly waits for transcripts before rendering markers. */
export const CONTEXT_AUDIO_DEADLINE_MS = 60_000;
/** History audio older than this is not transcribed eagerly. */
export const HISTORY_AUDIO_WARM_WINDOW_SECONDS = 72 * 3600;
export const HISTORY_AUDIO_WARM_MAX_PER_BATCH = 10;
const MAX_REMEMBERED_FAILURES = 1_000;

export interface ContextAudioMessage {
  messageId: string;
  contentType: ContentType;
  content: string | null;
  contentText: string | null;
  isFromMe: boolean;
}

export interface ContextAudioOptions {
  transcribe?: AudioTranscriber;
  maxPerAssembly?: number;
  deadlineMs?: number;
}

type Outcome = StoredAudioTranscriptResult;

const inflight = new Map<string, Promise<Outcome>>();
const failures = new Map<string, Outcome>();
let queueTail: Promise<unknown> = Promise.resolve();

const defaultTranscriber: AudioTranscriber = async (buffer, mimeType) => {
  const { transcribeAudio } = await import('../chat/providers/whisper.ts');
  return transcribeAudio(buffer, mimeType);
};

export function __resetContextAudioForTests(): void {
  inflight.clear();
  failures.clear();
  queueTail = Promise.resolve();
}

function rememberFailure(messageId: string, outcome: Outcome): void {
  failures.delete(messageId);
  failures.set(messageId, outcome);
  if (failures.size > MAX_REMEMBERED_FAILURES) {
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
}

async function transcribeRow(db: Database, messageId: string, transcribe: AudioTranscriber): Promise<Outcome> {
  const row = db.raw.prepare(
    `SELECT message_id, content, content_text, media_path, raw_message
       FROM messages WHERE message_id = ? AND content_type = 'audio'`,
  ).get(messageId) as StoredAudioRow | undefined;
  if (!row) return { status: 'no_audio_data', message: 'Audio message row not found.' };
  try {
    return await ensureStoredAudioTranscript(db, row, transcribe);
  } catch (err) {
    log.warn({ err, messageId }, 'voice note transcription threw');
    return { status: 'transcription_failed', message: 'Transcription threw.' };
  }
}

function schedule(db: Database, messageId: string, transcribe: AudioTranscriber): Promise<Outcome> {
  const existing = inflight.get(messageId);
  if (existing) return existing;
  const run = queueTail.then(() => transcribeRow(db, messageId, transcribe));
  const tracked = run.then((outcome) => {
    if (outcome.status !== 'cached' && outcome.status !== 'transcribed') rememberFailure(messageId, outcome);
    return outcome;
  }).finally(() => inflight.delete(messageId));
  queueTail = tracked.catch(() => undefined);
  inflight.set(messageId, tracked);
  return tracked;
}

function hasAudio(message: unknown): boolean {
  return unwrapMessage(message)?.audioMessage != null;
}

/**
 * Start transcribing recent inbound voice notes from a stored history batch.
 * Fire and forget: failures are logged and remembered, never thrown.
 */
export function warmHistoryAudio(
  db: Database,
  messages: readonly HistoryInput[],
  options: { transcribe?: AudioTranscriber; nowSeconds?: number } = {},
): number {
  const transcribe = options.transcribe ?? defaultTranscriber;
  const since = (options.nowSeconds ?? Math.floor(Date.now() / 1000)) - HISTORY_AUDIO_WARM_WINDOW_SECONDS;
  const lookup = db.raw.prepare(
    `SELECT content, content_text FROM messages
      WHERE message_id = ? AND content_type = 'audio' AND is_from_me = 0
        AND timestamp >= ? AND deleted_at IS NULL`,
  );
  let started = 0;
  for (const msg of messages) {
    if (started >= HISTORY_AUDIO_WARM_MAX_PER_BATCH) break;
    const messageId = msg.key?.id;
    if (!messageId || msg.key?.fromMe || !hasAudio(msg.message)) continue;
    if (failures.has(messageId)) continue;
    const row = lookup.get(messageId, since) as Pick<StoredAudioRow, 'content' | 'content_text'> | undefined;
    if (!row || storedAudioTranscript(row) !== null) continue;
    started++;
    void schedule(db, messageId, transcribe).then((outcome) => {
      log.info({ messageId, status: outcome.status }, 'history voice note transcription finished');
    });
  }
  if (started > 0) log.info({ started }, 'transcribing recent history voice notes');
  return started;
}

function voiceNoteText(messageId: string, outcome: Outcome | 'pending' | 'not_attempted'): string {
  if (outcome === 'pending') return `[Voice note — transcription still in progress (message ${messageId})]`;
  if (outcome === 'not_attempted') return `[Voice note — not transcribed (message ${messageId})]`;
  if (outcome.status === 'cached' || outcome.status === 'transcribed') {
    const text = `[Voice note transcription]: ${outcome.transcription}`;
    if (text.length <= CONTEXT_LINE_MAX_CHARS_PER_MESSAGE) return text;
    const suffix = ` … [transcript truncated; full text stored with message ${messageId}]`;
    return text.slice(0, CONTEXT_LINE_MAX_CHARS_PER_MESSAGE - suffix.length) + suffix;
  }
  if (outcome.status === 'media_expired') return `[Voice note — media expired, no transcript (message ${messageId})]`;
  return `[Voice note — transcription failed: ${outcome.status} (message ${messageId})]`;
}

/**
 * Make voice notes readable before context lines are formatted. Returns the
 * messages in the same order, with every audio message's `content` replaced by
 * its transcript or an explicit marker. Never throws.
 */
export async function prepareContextAudio<T extends ContextAudioMessage>(
  db: Database,
  messages: readonly T[],
  options: ContextAudioOptions = {},
): Promise<T[]> {
  const transcribe = options.transcribe ?? defaultTranscriber;
  const maxPerAssembly = options.maxPerAssembly ?? CONTEXT_AUDIO_MAX_PER_ASSEMBLY;
  const deadlineMs = options.deadlineMs ?? CONTEXT_AUDIO_DEADLINE_MS;

  const outcomes = new Map<string, Outcome | 'pending' | 'not_attempted'>();
  const waits: Promise<unknown>[] = [];
  let scheduled = 0;

  // Newest first: when the cap binds, the most recent voice notes win.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.contentType !== 'audio' || outcomes.has(message.messageId)) continue;
    // StoredMessage.contentText falls back to content (the audio JSON) when
    // content_text is NULL, so only a distinct value can be a transcript.
    const contentText = message.contentText === message.content ? null : message.contentText;
    const cached = storedAudioTranscript({ content: message.content, content_text: contentText });
    if (cached !== null) {
      outcomes.set(message.messageId, { status: 'cached', transcription: cached });
      continue;
    }
    const remembered = failures.get(message.messageId);
    if (remembered) {
      outcomes.set(message.messageId, remembered);
      continue;
    }
    if (message.isFromMe || scheduled >= maxPerAssembly) {
      outcomes.set(message.messageId, 'not_attempted');
      continue;
    }
    scheduled++;
    outcomes.set(message.messageId, 'pending');
    const messageId = message.messageId;
    waits.push(schedule(db, messageId, transcribe).then((outcome) => outcomes.set(messageId, outcome)));
  }

  if (waits.length > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deadlineMs);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled(waits), deadline]);
    clearTimeout(timer);
    const pending = [...outcomes.values()].filter((o) => o === 'pending').length;
    if (pending > 0) log.warn({ pending, deadlineMs }, 'context assembled before every voice note was transcribed');
  }

  return messages.map((message) => {
    const outcome = outcomes.get(message.messageId);
    if (message.contentType !== 'audio' || outcome === undefined) return message;
    return { ...message, content: voiceNoteText(message.messageId, outcome) };
  });
}
