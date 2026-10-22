import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { proto } from '../../node_modules/@whiskeysockets/baileys/WAProto/index.js';
import { getMediaKeys } from '../../node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js';
import { Database } from '../../src/core/database.ts';
import { processHistoryBatch, type HistoryInput } from '../../src/core/history-sync.ts';
import {
  parsePrepareRecoveredAudioArgs,
  runPrepareRecoveredAudioCli,
} from '../../scripts/prepare-recovered-audio.ts';
import type { PrepDeps } from '../../scripts/lib/recovered-audio-prep.ts';

const CHAT = '15550003333@s.whatsapp.net';
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60)]);
const MEDIA_KEY = new Uint8Array(32).map((_, i) => i + 7);

/** A history message decoded by the real protobuf decoder, as Baileys delivers it. */
function historyAudio(id: string, seconds = 12): HistoryInput {
  const encoded = proto.HistorySync.encode({
    syncType: proto.HistorySync.HistorySyncType.RECENT,
    conversations: [{ id: CHAT, messages: [{ message: {
      key: { remoteJid: CHAT, id, fromMe: false },
      messageTimestamp: 1_790_000_000,
      message: { audioMessage: {
        url: 'https://media.example.invalid/v/t62/voice', directPath: '/v/t62/voice',
        mediaKey: MEDIA_KEY, mimetype: 'audio/ogg; codecs=opus', seconds, ptt: true, fileLength: OGG.length,
      } },
    } }] }],
  }).finish();
  return proto.HistorySync.decode(encoded).conversations![0]!.messages![0]!.message as unknown as HistoryInput;
}

function historyText(id: string): HistoryInput {
  return { key: { id, remoteJid: CHAT, fromMe: false }, messageTimestamp: 1_790_000_100, message: { conversation: 'plain' } };
}

let dir: string;
let dbPath: string;
let mediaDir: string;
let out: string;

function readRow(id: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT content, content_text, media_path FROM messages WHERE message_id = ?').get(id) as
      { content: string | null; content_text: string | null; media_path: string | null };
  } finally {
    db.close();
  }
}

function fileSha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function manifest() {
  return JSON.parse(readFileSync(out, 'utf8')) as {
    mode: string; ready: boolean; blockers: string[];
    items: Array<{ messageId: string; status: string; reason: string | null; audioSha256: string | null; transcriptSha256: string | null }>;
  };
}

function deps(overrides: Partial<PrepDeps> = {}): Partial<PrepDeps> {
  return {
    download: async (raw) => {
      // The stored raw_message must still carry a key Baileys can derive from.
      const key = (raw as { message: { audioMessage: { mediaKey: string } } }).message.audioMessage.mediaKey;
      await getMediaKeys(key, 'audio');
      return OGG;
    },
    transcribe: async () => 'please book the plumber for friday',
    ...overrides,
  };
}

const applyArgs = (...ids: string[]) => [
  '--db', dbPath, '--out', out, '--apply', '--provider', 'whisper.cpp', '--media-dir', mediaDir,
  ...ids.flatMap((id) => ['--message-id', id]),
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prep-recovered-audio-'));
  dbPath = join(dir, 'bot.db');
  mediaDir = join(dir, 'media');
  out = join(dir, 'manifest.json');
  const db = new Database(dbPath);
  db.open();
  processHistoryBatch(db, [historyAudio('RECAUDIO0001'), historyAudio('RECAUDIO0002'), historyText('RECTEXT0001')]);
  db.close();
  mkdirSync(mediaDir, { mode: 0o700 });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('prepare-recovered-audio', () => {
  it('previews without touching the database', async () => {
    const before = fileSha(dbPath);
    const code = await runPrepareRecoveredAudioCli(['--db', dbPath, '--out', out, '--message-id', 'RECAUDIO0001']);
    expect(code).toBe(0);
    expect(fileSha(dbPath)).toBe(before);
    expect(manifest()).toMatchObject({ mode: 'preview', ready: false, blockers: [] });
    expect(manifest().items[0]).toMatchObject({ messageId: 'RECAUDIO0001', status: 'needs_transcription' });
  });

  it('transcribes exactly the selected voice note from its stored raw_message and records hashes', async () => {
    const transcribe = vi.fn(async () => 'please book the plumber for friday');
    const code = await runPrepareRecoveredAudioCli(applyArgs('RECAUDIO0001'), deps({ transcribe }));

    expect(code).toBe(0);
    expect(transcribe).toHaveBeenCalledTimes(1);
    const row = readRow('RECAUDIO0001');
    expect(row.content_text).toBe('please book the plumber for friday');
    expect(JSON.parse(row.content!)).toMatchObject({ type: 'audio', transcription: 'please book the plumber for friday' });
    expect(existsSync(row.media_path!)).toBe(true);
    expect(readRow('RECAUDIO0002').content_text).toBeNull();
    expect(manifest().items[0]).toMatchObject({
      status: 'ready', reason: 'transcribed',
      audioSha256: createHash('sha256').update(OGG).digest('hex'),
      transcriptSha256: createHash('sha256').update('please book the plumber for friday').digest('hex'),
    });
  });

  it('blocks the whole selection when any item is not usable audio', async () => {
    const transcribe = vi.fn();
    const code = await runPrepareRecoveredAudioCli(applyArgs('RECAUDIO0001', 'RECTEXT0001', 'MISSING0001'), deps({ transcribe }));

    expect(code).toBe(2);
    expect(transcribe).not.toHaveBeenCalled();
    expect(manifest().blockers).toEqual(['RECTEXT0001:not_audio:text', 'MISSING0001:not_found']);
    expect(readRow('RECAUDIO0001').content_text).toBeNull();
  });

  it('is not ready when a download fails, and says why', async () => {
    const code = await runPrepareRecoveredAudioCli(applyArgs('RECAUDIO0001', 'RECAUDIO0002'), deps({
      download: async () => { throw new Error('Request failed with status code 410'); },
    }));

    expect(code).toBe(3);
    expect(manifest().items.map((i) => [i.status, i.reason])).toEqual([
      ['failed', 'media_expired'], ['failed', 'media_expired'],
    ]);
  });

  it('never records the transcription fallback text as a transcript', async () => {
    const code = await runPrepareRecoveredAudioCli(applyArgs('RECAUDIO0001'), deps({
      transcribe: async () => '[🎤 Voice note received — transcription unavailable]',
    }));

    expect(code).toBe(3);
    expect(manifest().items[0]).toMatchObject({ status: 'failed', reason: 'transcription_unavailable' });
    expect(readRow('RECAUDIO0001').content_text).toBeNull();
  });

  it('accepts an explicit operator exclusion as ready-to-proceed', async () => {
    const code = await runPrepareRecoveredAudioCli(
      [...applyArgs('RECAUDIO0001', 'RECAUDIO0002'), '--exclude', 'RECAUDIO0002'], deps(),
    );
    expect(code).toBe(0);
    expect(manifest().items.map((i) => i.status)).toEqual(['ready', 'excluded']);
    expect(readRow('RECAUDIO0002').content_text).toBeNull();
  });

  it('discards a transcript that finishes after the wall budget and starts nothing more', async () => {
    let now = 0;
    let fireDeadline!: () => void;
    let release!: (text: string) => void;
    let settled = false;
    const transcribe = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const run = runPrepareRecoveredAudioCli(
      [...applyArgs('RECAUDIO0001', 'RECAUDIO0002'), '--max-wall-seconds', '1'],
      deps({ transcribe, nowMs: () => now, after: () => new Promise((resolve) => { fireDeadline = resolve; }) }),
    ).finally(() => { settled = true; });

    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    now = 5_000;
    fireDeadline();
    // One full event-loop turn: every remaining step of the command is
    // synchronous or microtask-driven, so it would finish here if it did not
    // wait for the in-flight provider call.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release('too late');
    const code = await run;

    expect(code).toBe(3);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(manifest().items.map((i) => [i.status, i.reason])).toEqual([
      ['cancelled_budget', 'wall_budget_spent_during_transcription'],
      ['cancelled_budget', 'wall_budget_spent'],
    ]);
    expect(readRow('RECAUDIO0001').content_text).toBeNull();
  });

  it('refuses to overwrite a row that changed while it was being prepared', async () => {
    const code = await runPrepareRecoveredAudioCli(applyArgs('RECAUDIO0001'), deps({
      transcribe: async () => {
        const db = new DatabaseSync(dbPath);
        db.prepare("UPDATE messages SET content_text = 'edited elsewhere' WHERE message_id = 'RECAUDIO0001'").run();
        db.close();
        return 'mine';
      },
    }));

    expect(code).toBe(3);
    expect(manifest().items[0]).toMatchObject({ status: 'row_changed', reason: 'changed_during_preparation' });
    expect(readRow('RECAUDIO0001').content_text).toBe('edited elsewhere');
  });

  it('rejects over-budget selections before any work', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `ID${i}`);
    expect(await runPrepareRecoveredAudioCli(['--db', dbPath, '--out', out, ...eleven.flatMap((id) => ['--message-id', id])])).toBe(2);
    expect(manifest().blockers).toContain('too_many_items:11>10');

    rmSync(out);
    await runPrepareRecoveredAudioCli(['--db', dbPath, '--out', out, '--message-id', 'RECAUDIO0001', '--max-audio-seconds', '5']);
    expect(manifest().blockers).toContain('audio_seconds_over_budget:12>5');
  });

  it('only accepts local providers and requires one for --apply', () => {
    expect(() => parsePrepareRecoveredAudioArgs(['--db', 'a', '--out', 'b', '--apply', '--media-dir', 'm', '--provider', 'openai']))
      .toThrow('--provider must be one of: whisper.cpp, faster-whisper');
    expect(() => parsePrepareRecoveredAudioArgs(['--db', 'a', '--out', 'b', '--apply']))
      .toThrow('--apply requires --provider and --media-dir');
  });

  it('reports an already transcribed item as ready without new work', async () => {
    await runPrepareRecoveredAudioCli(applyArgs('RECAUDIO0001'), deps());
    rmSync(out);
    const transcribe = vi.fn();
    const code = await runPrepareRecoveredAudioCli(applyArgs('RECAUDIO0001'), deps({ transcribe }));
    expect(code).toBe(0);
    expect(transcribe).not.toHaveBeenCalled();
    expect(manifest().items[0]).toMatchObject({ status: 'ready', reason: 'already_transcribed' });
  });
});
