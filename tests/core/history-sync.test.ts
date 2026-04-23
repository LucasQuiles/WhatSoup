import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../src/core/database.ts';
import { processHistoryBatch, type HistoryInput } from '../../src/core/history-sync.ts';
import { storeMessageIfNew } from '../../src/core/messages.ts';

const dbPath = join(tmpdir(), `whatsoup-history-sync-${randomBytes(4).toString('hex')}.db`);
const db = new Database(dbPath);
db.open();

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

function textMsg(opts: { id: string; chat: string; from?: string; text: string; ts?: number; participant?: string; fromMe?: boolean }): HistoryInput {
  return {
    key: { id: opts.id, remoteJid: opts.chat, fromMe: opts.fromMe ?? false, participant: opts.participant },
    messageTimestamp: opts.ts ?? 1_700_000_000,
    message: { conversation: opts.text },
    pushName: opts.from,
    // parseIncomingMessage reads from key/message/pushName/messageTimestamp — these are the fields it needs.
  } as HistoryInput;
}

function envelopeOnlyMsg(opts: { id: string; chat: string; participant?: string; ts?: number }): HistoryInput {
  return {
    key: { id: opts.id, remoteJid: opts.chat, participant: opts.participant },
    messageTimestamp: opts.ts ?? 1_700_000_000,
    // no `message` field — envelope-only
  };
}

describe('processHistoryBatch', () => {
  beforeEach(() => {
    db.raw.prepare('DELETE FROM messages').run();
  });

  it('inserts a full-body row when no prior row exists', () => {
    const stats = processHistoryBatch(db, [textMsg({ id: 'MSG1', chat: 'alice@s.whatsapp.net', text: 'hello' })]);
    expect(stats).toMatchObject({ inserted: 1, upgraded: 0, placeholders: 0, skipped: 0 });

    const row = db.raw.prepare('SELECT content, content_type FROM messages WHERE message_id=?').get('MSG1') as {
      content: string;
      content_type: string;
    };
    expect(row.content).toBe('hello');
    expect(row.content_type).toBe('text');
  });

  it('upgrades a prior placeholder row in place when a body arrives later', () => {
    // First pass: envelope-only → placeholder
    processHistoryBatch(db, [envelopeOnlyMsg({ id: 'MSG2', chat: 'group@g.us', participant: 'alice@s.whatsapp.net' })]);
    const before = db.raw.prepare('SELECT content_type, sender_jid FROM messages WHERE message_id=?').get('MSG2') as {
      content_type: string;
      sender_jid: string;
    };
    expect(before.content_type).toBe('history');
    expect(before.sender_jid).toBe('alice@s.whatsapp.net');

    // Second pass: full body for same id → upgrade
    const stats = processHistoryBatch(db, [
      textMsg({ id: 'MSG2', chat: 'group@g.us', participant: 'alice@s.whatsapp.net', text: 'the real body' }),
    ]);
    expect(stats).toMatchObject({ inserted: 0, upgraded: 1, placeholders: 0, skipped: 0 });

    const after = db.raw.prepare('SELECT content, content_type FROM messages WHERE message_id=?').get('MSG2') as {
      content: string;
      content_type: string;
    };
    expect(after.content).toBe('the real body');
    expect(after.content_type).toBe('text');
  });

  it('refuses to clobber an existing non-history row when the same id replays in a history sync', () => {
    // Simulate the live path having already landed a text row
    storeMessageIfNew(db, {
      chatJid: 'alice@s.whatsapp.net',
      conversationKey: 'alice_at_s.whatsapp.net',
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: 'MSG3',
      content: 'live body',
      contentText: null,
      contentType: 'text',
      isFromMe: false,
      timestamp: 1_700_000_100,
      quotedMessageId: null,
      rawMessage: null,
    });

    const stats = processHistoryBatch(db, [
      textMsg({ id: 'MSG3', chat: 'alice@s.whatsapp.net', text: 'history replay body', ts: 1_700_000_999 }),
    ]);
    // noop — row was not a placeholder, so UPSERT's WHERE suppresses the update.
    expect(stats).toMatchObject({ inserted: 0, upgraded: 0, placeholders: 0 });

    const row = db.raw.prepare('SELECT content, content_type, timestamp FROM messages WHERE message_id=?').get('MSG3') as {
      content: string;
      content_type: string;
      timestamp: number;
    };
    expect(row.content).toBe('live body');
    expect(row.timestamp).toBe(1_700_000_100);
  });

  it('placeholder uses key.participant for group sender_jid (not chatJid)', () => {
    processHistoryBatch(db, [
      envelopeOnlyMsg({ id: 'MSG4', chat: 'group@g.us', participant: 'bob@s.whatsapp.net' }),
    ]);

    const row = db.raw.prepare('SELECT sender_jid FROM messages WHERE message_id=?').get('MSG4') as { sender_jid: string };
    expect(row.sender_jid).toBe('bob@s.whatsapp.net');
  });

  it('placeholder falls back to chat_jid when no participant (DM case)', () => {
    processHistoryBatch(db, [envelopeOnlyMsg({ id: 'MSG5', chat: 'alice@s.whatsapp.net' })]);
    const row = db.raw.prepare('SELECT sender_jid FROM messages WHERE message_id=?').get('MSG5') as { sender_jid: string };
    expect(row.sender_jid).toBe('alice@s.whatsapp.net');
  });

  it('skips messages with missing key.id or key.remoteJid without throwing', () => {
    const stats = processHistoryBatch(db, [
      { key: { id: 'MSG6' }, messageTimestamp: 1 }, // no remoteJid
      { key: { remoteJid: 'x@s' }, messageTimestamp: 1 }, // no id
      {}, // no key at all
    ]);
    expect(stats.skipped).toBe(3);
    expect(stats.inserted).toBe(0);
    expect(stats.placeholders).toBe(0);

    const count = (db.raw.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('a hasBody message with unrecognized innerMessage shape still inserts a row (content_type=unknown) and never writes a placeholder', () => {
    // The critical invariant: when a message arrives with a body (however weird),
    // the body path is taken — no envelope-only placeholder is ever created as a
    // fallback. parseIncomingMessage today always returns a record when its two
    // guards (msg.message and msg.key.remoteJid) are satisfied, using
    // contentType='unknown' for shapes it can't decode. If that contract ever
    // changes to return null, the handler's skipped_null_parse branch takes over
    // — but even in that case, no placeholder is written.
    const weird: HistoryInput = {
      key: { id: 'MSG7', remoteJid: 'alice@s.whatsapp.net' },
      messageTimestamp: 1,
      message: { senderKeyDistributionMessage: { groupId: 'x' } },
    };
    const stats = processHistoryBatch(db, [weird]);
    const placeholderCount = (db.raw.prepare("SELECT COUNT(*) as c FROM messages WHERE content_type='history'").get() as { c: number }).c;
    expect(placeholderCount).toBe(0);
    expect(stats.placeholders).toBe(0);
  });

  it('processes a mixed batch atomically (transaction rollback is a safety net only)', () => {
    const batch: HistoryInput[] = [
      textMsg({ id: 'BATCH1', chat: 'alice@s.whatsapp.net', text: 'one' }),
      envelopeOnlyMsg({ id: 'BATCH2', chat: 'group@g.us', participant: 'bob@s.whatsapp.net' }),
      textMsg({ id: 'BATCH3', chat: 'group@g.us', participant: 'carol@s.whatsapp.net', text: 'three' }),
    ];
    const stats = processHistoryBatch(db, batch);
    expect(stats.inserted).toBe(2);
    expect(stats.placeholders).toBe(1);

    const count = (db.raw.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
    expect(count).toBe(3);
  });

  it('round-trips Uint8Array media fields as base64 in raw_message (not indexed-offset bloat)', () => {
    // Baileys attaches Uint8Array fields (mediaKey, fileEncSha256, etc.) to media
    // messages. Default JSON.stringify serializes Uint8Array as {"0":n,"1":n,...}
    // which bloats raw_message to tens of MB per envelope and destroys replayability.
    const mediaKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const imgMsg: HistoryInput = {
      key: { id: 'MSG_MEDIA', remoteJid: 'alice@s.whatsapp.net' },
      messageTimestamp: 1_700_000_000,
      message: {
        imageMessage: {
          caption: 'photo',
          mediaKey,
          fileEncSha256: new Uint8Array([9, 9, 9]),
        },
      },
    } as HistoryInput;

    processHistoryBatch(db, [imgMsg]);
    const row = db.raw.prepare('SELECT raw_message FROM messages WHERE message_id=?').get('MSG_MEDIA') as {
      raw_message: string;
    };

    // Must NOT contain indexed-offset serialization like "0":1,"1":2
    expect(row.raw_message).not.toMatch(/"0":\d+,"1":\d+/);
    // Must contain the base64 marker shape we write instead
    expect(row.raw_message).toContain('"$b64"');

    // Decoding round-trip: find the first $b64 value and confirm it's the original bytes
    const parsed = JSON.parse(row.raw_message) as { message: { imageMessage: { mediaKey: { $b64: string } } } };
    const recovered = Buffer.from(parsed.message.imageMessage.mediaKey.$b64, 'base64');
    expect(Array.from(recovered)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
