/**
 * Selected preparation of recovered voice notes (history-sync audio rows).
 *
 * An operator names exact message IDs. Preview checks the selection and the
 * budgets without writing anything. Apply downloads each selected voice note
 * from its stored raw_message, transcribes it with one explicitly chosen local
 * provider, and records the transcript with a compare-and-set write. Readiness
 * is all-or-nothing: the run is ready only when every selected, non-excluded
 * item is ready, and catch-up must not proceed otherwise.
 *
 * Cancellation: once the wall-clock budget is spent, no new item starts and a
 * result that arrives late is discarded, never written. An in-flight provider
 * call is still awaited before returning (it is bounded by the provider's own
 * timeout), so no transcription process outlives the command.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { extractRawFileLength, extractRawMime } from '../../src/core/media-mime.ts';
import {
  isUsableTranscript,
  mergeTranscriptionContent,
  storedAudioTranscript,
} from '../../src/core/audio-transcript-content.ts';

export const HARD_LIMITS = {
  maxItems: 10,
  maxTotalAudioSeconds: 3600,
  maxTotalBytes: 100 * 1024 * 1024,
  maxWallSeconds: 1800,
} as const;

export type ItemStatus =
  | 'ready'
  | 'needs_transcription'
  | 'excluded'
  | 'blocked'
  | 'failed'
  | 'cancelled_budget'
  | 'row_changed';

export interface ItemRecord {
  messageId: string;
  status: ItemStatus;
  reason: string | null;
  conversationKey: string | null;
  rowSha256: string | null;
  durationSeconds: number | null;
  declaredBytes: number | null;
  audioSha256: string | null;
  audioBytes: number | null;
  mediaPath: string | null;
  transcriptSha256: string | null;
  transcriptChars: number | null;
}

export interface PrepOptions {
  messageIds: string[];
  exclude: string[];
  maxWallSeconds: number;
  maxTotalAudioSeconds: number;
}

export interface PrepDeps {
  download(rawMessage: unknown, mimeType: string, declaredBytes: number | null): Promise<Buffer>;
  transcribe(buffer: Buffer, mimeType: string): Promise<string>;
  writeMedia(fileName: string, buffer: Buffer): string;
  nowMs(): number;
  /** Resolves after `ms`, or never once `signal` aborts (the timer is released). */
  after(ms: number, signal: AbortSignal): Promise<void>;
}

export function realAfter(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  });
}

export interface PrepResult {
  mode: 'preview' | 'apply';
  ready: boolean;
  blockers: string[];
  totals: { selected: number; excluded: number; audioSeconds: number; declaredBytes: number };
  items: ItemRecord[];
}

interface AudioRow {
  message_id: string;
  conversation_key: string;
  content_type: string;
  content: string | null;
  content_text: string | null;
  raw_message: string | null;
  deleted_at: string | null;
}

const ROW_SQL = `SELECT message_id, conversation_key, content_type, content, content_text, raw_message, deleted_at
                   FROM messages WHERE message_id = ?`;

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function rowFingerprint(row: AudioRow): string {
  return sha256(JSON.stringify([row.content, row.content_text, row.raw_message]));
}

function emptyRecord(messageId: string): ItemRecord {
  return {
    messageId, status: 'blocked', reason: null, conversationKey: null, rowSha256: null,
    durationSeconds: null, declaredBytes: null, audioSha256: null, audioBytes: null,
    mediaPath: null, transcriptSha256: null, transcriptChars: null,
  };
}

function audioDuration(content: string | null): number | null {
  try {
    const seconds = (JSON.parse(content ?? '') as { duration?: unknown }).duration;
    return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null;
  } catch {
    // by design: an unparseable content column has no duration; the caller
    // treats a missing duration as a blocker.
    return null;
  }
}

function parseRaw(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // by design: an unparseable raw_message cannot be downloaded; null makes
    // the caller block the item with reason raw_message_unreadable.
    return null;
  }
}

function hasDownloadableAudio(raw: unknown): boolean {
  const audio = (raw as { message?: { audioMessage?: Record<string, unknown> } } | null)?.message?.audioMessage;
  return Boolean(audio?.mediaKey && (audio.directPath || audio.url));
}

/** Validate the selection and budgets. Reads only. */
export function planPreparation(db: DatabaseSync, options: PrepOptions): PrepResult {
  const blockers: string[] = [];
  const ids = options.messageIds;
  if (ids.length === 0) blockers.push('no_message_ids');
  if (ids.length > HARD_LIMITS.maxItems) blockers.push(`too_many_items:${ids.length}>${HARD_LIMITS.maxItems}`);
  if (new Set(ids).size !== ids.length) blockers.push('duplicate_message_id');
  for (const id of options.exclude) {
    if (!ids.includes(id)) blockers.push(`exclude_not_selected:${id}`);
  }

  const select = db.prepare(ROW_SQL);
  const items: ItemRecord[] = [];
  let audioSeconds = 0;
  let declaredBytes = 0;
  for (const messageId of ids) {
    const item = emptyRecord(messageId);
    items.push(item);
    const row = select.get(messageId) as AudioRow | undefined;
    if (!row) { item.reason = 'not_found'; continue; }
    item.conversationKey = row.conversation_key;
    item.rowSha256 = rowFingerprint(row);
    if (options.exclude.includes(messageId)) { item.status = 'excluded'; item.reason = 'operator_excluded'; continue; }
    if (row.deleted_at) { item.reason = 'deleted'; continue; }
    if (row.content_type !== 'audio') { item.reason = `not_audio:${row.content_type}`; continue; }
    item.durationSeconds = audioDuration(row.content);
    const existing = storedAudioTranscript(row);
    if (existing !== null) {
      item.status = 'ready';
      item.reason = 'already_transcribed';
      item.transcriptSha256 = sha256(existing);
      item.transcriptChars = existing.length;
      continue;
    }
    const raw = parseRaw(row.raw_message);
    if (!hasDownloadableAudio(raw)) { item.reason = 'raw_message_unreadable'; continue; }
    if (item.durationSeconds === null) { item.reason = 'duration_unknown'; continue; }
    item.declaredBytes = extractRawFileLength(raw, 'audio') ?? null;
    item.status = 'needs_transcription';
    audioSeconds += item.durationSeconds;
    declaredBytes += item.declaredBytes ?? 0;
  }

  for (const item of items) {
    if (item.status === 'blocked') blockers.push(`${item.messageId}:${item.reason}`);
  }
  const audioBudget = Math.min(options.maxTotalAudioSeconds, HARD_LIMITS.maxTotalAudioSeconds);
  if (audioSeconds > audioBudget) blockers.push(`audio_seconds_over_budget:${audioSeconds}>${audioBudget}`);
  if (declaredBytes > HARD_LIMITS.maxTotalBytes) blockers.push(`bytes_over_budget:${declaredBytes}>${HARD_LIMITS.maxTotalBytes}`);
  if (options.maxWallSeconds <= 0 || options.maxWallSeconds > HARD_LIMITS.maxWallSeconds) {
    blockers.push(`wall_seconds_out_of_range:${options.maxWallSeconds}`);
  }

  return {
    mode: 'preview',
    ready: blockers.length === 0 && items.every((i) => i.status === 'ready' || i.status === 'excluded'),
    blockers,
    totals: {
      selected: ids.length,
      excluded: items.filter((i) => i.status === 'excluded').length,
      audioSeconds,
      declaredBytes,
    },
    items,
  };
}

function classifyDownloadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/404|410|gone|expired/i.test(message)) return 'media_expired';
  if (/timed? ?out/i.test(message)) return 'download_timeout';
  if (/exceeds|too large/i.test(message)) return 'media_too_large';
  return 'download_failed';
}

/**
 * Prepare every item that needs a transcript, sequentially, within the wall
 * budget. The plan must have no blockers.
 */
export async function applyPreparation(
  db: DatabaseSync,
  plan: PrepResult,
  options: PrepOptions,
  deps: PrepDeps,
): Promise<PrepResult> {
  if (plan.blockers.length > 0) throw new Error(`Selection is blocked: ${plan.blockers.join(', ')}`);
  const deadline = deps.nowMs() + options.maxWallSeconds * 1000;
  const select = db.prepare(ROW_SQL);
  const items = plan.items.map((item) => ({ ...item }));

  for (const item of items) {
    if (item.status !== 'needs_transcription') continue;
    if (deps.nowMs() >= deadline) { item.status = 'cancelled_budget'; item.reason = 'wall_budget_spent'; continue; }

    const row = select.get(item.messageId) as AudioRow | undefined;
    if (!row || rowFingerprint(row) !== item.rowSha256) { item.status = 'row_changed'; item.reason = 'changed_before_download'; continue; }
    const raw = parseRaw(row.raw_message);
    const mime = extractRawMime(raw, 'audio') ?? 'audio/ogg';

    let audio: Buffer;
    try {
      audio = await deps.download(raw, mime, item.declaredBytes);
    } catch (error) {
      item.status = 'failed';
      item.reason = classifyDownloadError(error);
      continue;
    }
    item.audioSha256 = sha256(audio);
    item.audioBytes = audio.length;

    const remaining = deadline - deps.nowMs();
    if (remaining <= 0) { item.status = 'cancelled_budget'; item.reason = 'wall_budget_spent'; continue; }
    const stopTimer = new AbortController();
    const work = deps.transcribe(audio, mime).then(
      (text) => ({ kind: 'done' as const, text }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
    const outcome = await Promise.race([
      work,
      deps.after(remaining, stopTimer.signal).then(() => ({ kind: 'late' as const })),
    ]);
    stopTimer.abort();
    if (outcome.kind === 'late') {
      // The provider call is bounded by its own timeout; wait for it so no
      // process outlives the command, then discard whatever it produced.
      await work;
      item.status = 'cancelled_budget';
      item.reason = 'wall_budget_spent_during_transcription';
      continue;
    }
    if (outcome.kind === 'error' || !isUsableTranscript(outcome.text)) {
      item.status = 'failed';
      item.reason = outcome.kind === 'error' ? 'transcription_error' : 'transcription_unavailable';
      continue;
    }

    const transcript = outcome.text;
    const mediaPath = deps.writeMedia(`recovered-${item.audioSha256.slice(0, 16)}.${mime.includes('mp4') ? 'm4a' : 'ogg'}`, audio);
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = select.get(item.messageId) as AudioRow | undefined;
      if (!current || rowFingerprint(current) !== item.rowSha256) {
        db.exec('ROLLBACK');
        item.status = 'row_changed';
        item.reason = 'changed_during_preparation';
        item.mediaPath = mediaPath;
        continue;
      }
      db.prepare('UPDATE messages SET content = ?, content_text = ?, media_path = ? WHERE message_id = ?')
        .run(mergeTranscriptionContent(current.content, transcript), transcript, mediaPath, item.messageId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    item.status = 'ready';
    item.reason = 'transcribed';
    item.mediaPath = mediaPath;
    item.transcriptSha256 = sha256(transcript);
    item.transcriptChars = transcript.length;
  }

  return {
    ...plan,
    mode: 'apply',
    ready: items.every((i) => i.status === 'ready' || i.status === 'excluded'),
    items,
  };
}
