import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const { mockDownloadMediaMessage, mockWriteTempFile } = vi.hoisted(() => ({
  mockDownloadMediaMessage: vi.fn(),
  mockWriteTempFile: vi.fn(() => '/managed/media/voice.ogg'),
}));

vi.mock('@whiskeysockets/baileys', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  downloadMediaMessage: mockDownloadMediaMessage,
}));

vi.mock('../../../src/core/media-download.ts', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  writeTempFile: mockWriteTempFile,
}));

import { proto } from '../../../node_modules/@whiskeysockets/baileys/WAProto/index.js';
import { getMediaKeys } from '../../../node_modules/@whiskeysockets/baileys/lib/Utils/messages-media.js';
import { Database } from '../../../src/core/database.ts';
import { processHistoryBatch, type HistoryInput } from '../../../src/core/history-sync.ts';
import { getMessagesSince } from '../../../src/core/messages.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import { formatContextLines, CONTEXT_LINE_MAX_CHARS_PER_MESSAGE } from '../../../src/runtimes/agent/context-lines.ts';
import {
  prepareContextAudio,
  warmHistoryAudio,
  __resetContextAudioForTests,
  HISTORY_AUDIO_WARM_WINDOW_SECONDS,
} from '../../../src/runtimes/agent/context-audio.ts';

const CHAT = '15550003333@s.whatsapp.net';
const NOW = 1_790_000_000;
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60)]);
const MEDIA_KEY = new Uint8Array(32).map((_, i) => i + 7);

function makeDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `whatsoup-context-audio-${randomBytes(4).toString('hex')}.db`);
  const db = new Database(path);
  db.open();
  return { db, path };
}

function cleanup(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

/** A history message decoded by the real protobuf decoder, as Baileys delivers it. */
function historyAudio(id: string, opts: { ts?: number; fromMe?: boolean } = {}): HistoryInput {
  const encoded = proto.HistorySync.encode({
    syncType: proto.HistorySync.HistorySyncType.RECENT,
    conversations: [{
      id: CHAT,
      messages: [{
        message: {
          key: { remoteJid: CHAT, id, fromMe: opts.fromMe ?? false },
          messageTimestamp: opts.ts ?? NOW - 600,
          message: {
            audioMessage: {
              url: 'https://media.example.invalid/v/t62/voice',
              directPath: '/v/t62/voice',
              mediaKey: MEDIA_KEY,
              mimetype: 'audio/ogg; codecs=opus',
              seconds: 12,
              ptt: true,
            },
          },
        },
      }],
    }],
  }).finish();
  const decoded = proto.HistorySync.decode(encoded);
  return decoded.conversations![0]!.messages![0]!.message as unknown as HistoryInput;
}

function historyText(id: string, text: string, ts = NOW - 500): HistoryInput {
  return {
    key: { id, remoteJid: CHAT, fromMe: false },
    messageTimestamp: ts,
    message: { conversation: text },
  };
}

function storedTranscript(db: Database, id: string): string | null {
  const row = db.raw.prepare('SELECT content_text FROM messages WHERE message_id = ?').get(id) as
    { content_text: string | null } | undefined;
  return row?.content_text ?? null;
}

function contextMessages(db: Database) {
  const messages = getMessagesSince(db, toConversationKey(CHAT), 0, 30);
  expect(messages.length).toBeGreaterThan(0);
  return messages;
}

describe('context audio readiness', () => {
  let db: Database;
  let path: string;

  beforeEach(() => {
    ({ db, path } = makeDb());
    __resetContextAudioForTests();
    mockDownloadMediaMessage.mockReset();
    mockWriteTempFile.mockClear();
    mockDownloadMediaMessage.mockImplementation(async (msg: { message: { audioMessage: { mediaKey: unknown } } }) => {
      // The stored raw_message must still carry a key Baileys can derive from.
      await getMediaKeys(msg.message.audioMessage.mediaKey as string, 'audio');
      return OGG;
    });
  });

  afterEach(() => {
    db.close();
    cleanup(path);
  });

  it('transcribes history audio from its stored raw_message before context is formatted', async () => {
    processHistoryBatch(db, [historyAudio('HISTAUDIO0001'), historyText('HISTTEXT0001', 'go ahead')]);
    const transcribe = vi.fn(async () => 'please book the plumber for friday');

    const prepared = await prepareContextAudio(db, contextMessages(db), { transcribe });

    expect(mockDownloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith(OGG, expect.stringContaining('audio/ogg'));
    expect(storedTranscript(db, 'HISTAUDIO0001')).toBe('please book the plumber for friday');
    const lines = formatContextLines(prepared, false);
    expect(lines).toContain('[Voice note transcription]: please book the plumber for friday');
    expect(lines).toContain('go ahead');
    expect(lines).not.toContain('"transcription":null');
  });

  it('renders an explicit failure marker and does not retry a failed voice note', async () => {
    processHistoryBatch(db, [historyAudio('HISTAUDIO0002')]);
    mockDownloadMediaMessage.mockRejectedValue(new Error('Request failed with status code 410'));
    const transcribe = vi.fn(async () => 'never');

    const first = await prepareContextAudio(db, contextMessages(db), { transcribe });
    const second = await prepareContextAudio(db, contextMessages(db), { transcribe });

    expect(first[0]!.content).toBe('[Voice note — transcription failed: no_audio_data (message HISTAUDIO0002)]');
    expect(second[0]!.content).toBe(first[0]!.content);
    expect(mockDownloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('marks a transcription that misses the deadline, then shares and reuses the finished result', async () => {
    processHistoryBatch(db, [historyAudio('HISTAUDIO0003')]);
    let release!: (text: string) => void;
    const transcribe = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));

    const early = await prepareContextAudio(db, contextMessages(db), { transcribe, deadlineMs: 10 });
    expect(early[0]!.content).toBe('[Voice note — transcription still in progress (message HISTAUDIO0003)]');

    const waiting = prepareContextAudio(db, contextMessages(db), { transcribe, deadlineMs: 5_000 });
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    release('call me back');
    const done = await waiting;

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(done[0]!.content).toBe('[Voice note transcription]: call me back');
    const again = await prepareContextAudio(db, contextMessages(db), { transcribe });
    expect(again[0]!.content).toBe('[Voice note transcription]: call me back');
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('transcribes only the newest voice notes when the per-assembly cap binds', async () => {
    processHistoryBatch(db, [1, 2, 3, 4].map((n) => historyAudio(`HISTAUDIO010${n}`, { ts: NOW - 1_000 + n })));
    const transcribe = vi.fn(async () => 'ok');

    const prepared = await prepareContextAudio(db, contextMessages(db), { transcribe, maxPerAssembly: 3 });

    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(prepared.map((m) => m.content)).toEqual([
      '[Voice note — not transcribed (message HISTAUDIO0101)]',
      '[Voice note transcription]: ok',
      '[Voice note transcription]: ok',
      '[Voice note transcription]: ok',
    ]);
  });

  it('truncates a long transcript within the per-message cap and points at the stored text', async () => {
    processHistoryBatch(db, [historyAudio('HISTAUDIO0004')]);
    const transcribe = vi.fn(async () => 'word '.repeat(1_000));

    const [message] = await prepareContextAudio(db, contextMessages(db), { transcribe });

    expect(message!.content!.length).toBeLessThanOrEqual(CONTEXT_LINE_MAX_CHARS_PER_MESSAGE);
    expect(message!.content).toMatch(/transcript truncated; full text stored with message HISTAUDIO0004]$/);
    expect(formatContextLines([message!], false)).not.toContain('[truncated');
  });

  it('leaves non-audio messages untouched', async () => {
    processHistoryBatch(db, [historyText('HISTTEXT0002', 'plain text')]);
    const messages = contextMessages(db);
    const prepared = await prepareContextAudio(db, messages, { transcribe: vi.fn() });
    expect(prepared).toEqual(messages);
    expect(prepared[0]!.content).toBe('plain text');
  });

  it('warms only recent inbound untranscribed history audio', async () => {
    const batch = [
      historyAudio('HISTAUDIO0201'),
      historyAudio('HISTAUDIO0202', { ts: NOW - HISTORY_AUDIO_WARM_WINDOW_SECONDS - 60 }),
      historyAudio('HISTAUDIO0203', { fromMe: true }),
      historyText('HISTTEXT0201', 'not audio'),
    ];
    processHistoryBatch(db, batch);
    const transcribe = vi.fn(async () => 'warmed');

    const started = warmHistoryAudio(db, batch, { transcribe, nowSeconds: NOW });

    expect(started).toBe(1);
    await vi.waitFor(() => expect(storedTranscript(db, 'HISTAUDIO0201')).toBe('warmed'));
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(storedTranscript(db, 'HISTAUDIO0202')).toBeNull();
    expect(storedTranscript(db, 'HISTAUDIO0203')).toBeNull();
    expect(warmHistoryAudio(db, batch, { transcribe, nowSeconds: NOW })).toBe(0);
  });
});
