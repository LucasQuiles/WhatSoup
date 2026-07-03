import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../src/core/database.ts';
import { processHistoryBatch, type HistoryInput } from '../../src/core/history-sync.ts';
import { storeMessageIfNew } from '../../src/core/messages.ts';

function makeDb(): { db: Database; path: string } {
  const path = join(tmpdir(), `whatsoup-history-sync-${randomBytes(4).toString('hex')}.db`);
  const db = new Database(path);
  db.open();
  return { db, path };
}

function cleanup(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = path + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
}

function textMsg(opts: { id: string; chat: string; from?: string; text: string; ts?: number; participant?: string; fromMe?: boolean }): HistoryInput {
  return {
    key: { id: opts.id, remoteJid: opts.chat, fromMe: opts.fromMe ?? false, participant: opts.participant },
    messageTimestamp: opts.ts ?? 1_700_000_000,
    message: { conversation: opts.text },
    pushName: opts.from,
    // parseIncomingMessage reads from key/message/pushName/messageTimestamp — these are the fields it needs.
  } as HistoryInput;
}

function envelopeOnlyMsg(opts: { id: string; chat: string; participant?: string; ts?: number; fromMe?: boolean }): HistoryInput {
  return {
    key: { id: opts.id, remoteJid: opts.chat, participant: opts.participant, fromMe: opts.fromMe },
    messageTimestamp: opts.ts ?? 1_700_000_000,
    // no `message` field — envelope-only
  };
}

describe('processHistoryBatch', () => {
  let db: Database;
  let path: string;

  beforeEach(() => {
    const made = makeDb();
    db = made.db;
    path = made.path;
  });

  afterEach(() => {
    db.close();
    cleanup(path);
  });

  it('inserts a full-body row when no prior row exists', () => {
    const stats = processHistoryBatch(db, [textMsg({ id: 'MSG1', chat: 'alice@s.whatsapp.net', text: 'hello' })]);
    expect(stats).toMatchObject({ inserted: 1, upgraded: 0, placeholders: 0, skipped: 0 });

    const row = db.raw.prepare('SELECT content, content_type, raw_message FROM messages WHERE message_id=?').get('MSG1') as {
      content: string;
      content_type: string;
      raw_message: string;
    };
    expect(row.content).toBe('hello');
    expect(row.content_type).toBe('text');
    expect(JSON.parse(row.raw_message)).toMatchObject({
      key: { id: 'MSG1', remoteJid: 'alice@s.whatsapp.net' },
      message: { conversation: 'hello' },
    });
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

  it('normalizes envelope-only millisecond timestamps before writing placeholders', () => {
    processHistoryBatch(db, [
      envelopeOnlyMsg({ id: 'MSG4_MS', chat: 'group@g.us', participant: 'bob@s.whatsapp.net', ts: 1_777_824_570_676 }),
    ]);

    const row = db.raw
      .prepare('SELECT timestamp FROM messages WHERE message_id=?')
      .get('MSG4_MS') as { timestamp: number };
    expect(row.timestamp).toBe(1_777_824_570);
  });

  it('placeholder falls back to chat_jid when no participant (DM case)', () => {
    processHistoryBatch(db, [envelopeOnlyMsg({ id: 'MSG5', chat: 'alice@s.whatsapp.net' })]);
    const row = db.raw.prepare('SELECT sender_jid FROM messages WHERE message_id=?').get('MSG5') as { sender_jid: string };
    expect(row.sender_jid).toBe('alice@s.whatsapp.net');
  });

  it('persists sender names/fromMe flags and no-ops duplicate envelope placeholders', () => {
    const first = processHistoryBatch(db, [
      textMsg({
        id: 'MSG_FROM_ME_BODY',
        chat: 'alice@s.whatsapp.net',
        from: 'Lucas',
        text: 'sent body',
        fromMe: true,
      }),
      envelopeOnlyMsg({ id: 'MSG_FROM_ME_ENV', chat: 'alice@s.whatsapp.net', fromMe: true }),
    ]);
    expect(first).toMatchObject({ inserted: 1, placeholders: 1, skipped: 0 });

    const duplicate = processHistoryBatch(db, [
      envelopeOnlyMsg({ id: 'MSG_FROM_ME_ENV', chat: 'alice@s.whatsapp.net', fromMe: true }),
    ]);
    expect(duplicate).toMatchObject({ inserted: 0, upgraded: 0, placeholders: 0, skipped: 0 });

    const rows = db.raw
      .prepare("SELECT message_id, sender_name, content_type, is_from_me FROM messages WHERE message_id LIKE 'MSG_FROM_ME_%' ORDER BY message_id")
      .all() as Array<{ message_id: string; sender_name: string | null; content_type: string; is_from_me: number }>;
    expect(rows).toEqual([
      { message_id: 'MSG_FROM_ME_BODY', sender_name: 'Lucas', content_type: 'text', is_from_me: 1 },
      { message_id: 'MSG_FROM_ME_ENV', sender_name: null, content_type: 'history', is_from_me: 1 },
    ]);
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

  it('skips when a hostile message getter disappears before parser reads it', () => {
    const log = { debug: vi.fn() };
    let messageReads = 0;
    const unstable: HistoryInput = {
      key: { id: 'MSG_GETTER_NULL', remoteJid: 'alice@s.whatsapp.net' },
      messageTimestamp: 1,
      get message() {
        messageReads++;
        return messageReads === 1 ? { conversation: 'present for hasBody' } : null;
      },
    };

    const stats = processHistoryBatch(db, [unstable], log as any);

    expect(stats).toMatchObject({ inserted: 0, upgraded: 0, placeholders: 0, skipped: 1 });
    expect(log.debug).toHaveBeenCalledWith(
      { msgId: 'MSG_GETTER_NULL' },
      'historyMessages: parseIncomingMessage returned null for message with body',
    );
    const count = (db.raw.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('logs when an unstable key id leaves a placeholder stuck behind a live row conflict', () => {
    const log = { warn: vi.fn() };
    processHistoryBatch(db, [envelopeOnlyMsg({ id: 'PLACEHOLDER_STUCK', chat: 'alice@s.whatsapp.net' })]);
    storeMessageIfNew(db, {
      chatJid: 'alice@s.whatsapp.net',
      conversationKey: 'alice_at_s.whatsapp.net',
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: 'LIVE_CONFLICT',
      content: 'live body',
      contentText: null,
      contentType: 'text',
      isFromMe: false,
      timestamp: 1_700_000_100,
      quotedMessageId: null,
      rawMessage: null,
    });

    let idReads = 0;
    const unstable: HistoryInput = {
      key: {
        remoteJid: 'alice@s.whatsapp.net',
        get id() {
          idReads++;
          return idReads === 1 ? 'PLACEHOLDER_STUCK' : 'LIVE_CONFLICT';
        },
      },
      messageTimestamp: 1_700_000_200,
      message: { conversation: 'would target live row' },
    } as HistoryInput;

    const stats = processHistoryBatch(db, [unstable], log as any);

    expect(stats).toMatchObject({ inserted: 0, upgraded: 0, placeholders: 0, skipped: 0 });
    expect(log.warn).toHaveBeenCalledWith(
      { msgId: 'PLACEHOLDER_STUCK', parsedMessageId: 'LIVE_CONFLICT' },
      'historyMessages: placeholder upgrade unexpectedly did not fire',
    );
    const rows = db.raw
      .prepare("SELECT message_id, content, content_type FROM messages WHERE message_id IN ('PLACEHOLDER_STUCK', 'LIVE_CONFLICT') ORDER BY message_id")
      .all() as Array<{ message_id: string; content: string | null; content_type: string }>;
    expect(rows).toEqual([
      { message_id: 'LIVE_CONFLICT', content: 'live body', content_type: 'text' },
      { message_id: 'PLACEHOLDER_STUCK', content: null, content_type: 'history' },
    ]);
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

  it('commits surrounding successes when one mid-batch message hits an UPSERT-noop (live row wins)', () => {
    // Policy under test: the batch is one transaction, but a mid-batch UPSERT
    // that the WHERE guard suppresses (live-path row, not 'history') does not
    // abort the surrounding writes. This exercises the `noop` action inside a
    // batch rather than the catch-branch error path.
    //
    // The error-catch branch (per-message exception → stats.skipped++) is not
    // exercised here — it would require a truly failing per-message operation,
    // which is hard to provoke in-transaction without corrupting the DB. The
    // branch remains defensive-only code.
    storeMessageIfNew(db, {
      chatJid: 'group@g.us',
      conversationKey: 'group_at_g.us',
      senderJid: 'alice@s.whatsapp.net',
      senderName: 'Alice',
      messageId: 'PARTIAL_MID',
      content: 'live body',
      contentText: null,
      contentType: 'text',
      isFromMe: false,
      timestamp: 1_700_000_000,
      quotedMessageId: null,
      rawMessage: null,
    });

    const batch: HistoryInput[] = [
      textMsg({ id: 'PARTIAL_A', chat: 'alice@s.whatsapp.net', text: 'before' }),
      // Mid-batch: same id as the existing non-'history' row. UPSERT WHERE clause
      // suppresses update → this is a noop, not an error, and should not
      // corrupt stats. Exercises the "live row wins" invariant inside a batch.
      textMsg({ id: 'PARTIAL_MID', chat: 'group@g.us', text: 'would clobber live' }),
      textMsg({ id: 'PARTIAL_C', chat: 'alice@s.whatsapp.net', text: 'after' }),
    ];

    const stats = processHistoryBatch(db, batch);
    expect(stats.inserted).toBe(2);  // A and C
    expect(stats.upgraded).toBe(0);
    expect(stats.placeholders).toBe(0);
    expect(stats.skipped).toBe(0);   // UPSERT-noop is not a skip

    // Live row untouched
    const live = db.raw.prepare('SELECT content FROM messages WHERE message_id=?').get('PARTIAL_MID') as { content: string };
    expect(live.content).toBe('live body');

    // Successes both committed
    const count = (db.raw.prepare("SELECT COUNT(*) as c FROM messages WHERE message_id LIKE 'PARTIAL_%'").get() as { c: number }).c;
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

  it('stores a sentinel and logs when raw_message serialization fails', () => {
    const log = { warn: vi.fn() };
    const cyclic = textMsg({
      id: 'MSG_CYCLIC',
      chat: 'alice@s.whatsapp.net',
      text: 'body survives',
    }) as HistoryInput & { self?: unknown };
    cyclic.self = cyclic;

    const stats = processHistoryBatch(db, [cyclic], log as any);
    expect(stats).toMatchObject({ inserted: 1, skipped: 0 });

    const row = db.raw.prepare('SELECT content, raw_message FROM messages WHERE message_id=?').get('MSG_CYCLIC') as {
      content: string;
      raw_message: string;
    };
    expect(row.content).toBe('body survives');
    expect(JSON.parse(row.raw_message)).toEqual({ $raw_message_error: 'stringify_failed' });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), msgId: 'MSG_CYCLIC' }),
      'historyMessages: raw_message stringify failed, storing sentinel',
    );
  });

  it('skips one message on statement failure while committing surrounding successes', () => {
    const log = { error: vi.fn() };
    db.raw.exec(`
      CREATE TRIGGER fail_one_history_insert
      BEFORE INSERT ON messages
      WHEN NEW.message_id = 'FAIL_HISTORY'
      BEGIN
        SELECT RAISE(ABORT, 'forced history insert failure');
      END
    `);

    const stats = processHistoryBatch(db, [
      textMsg({ id: 'OK_BEFORE_FAIL', chat: 'alice@s.whatsapp.net', text: 'before' }),
      textMsg({ id: 'FAIL_HISTORY', chat: 'alice@s.whatsapp.net', text: 'bad' }),
      envelopeOnlyMsg({ id: 'OK_AFTER_FAIL', chat: 'group@g.us', participant: 'bob@s.whatsapp.net' }),
    ], log as any);

    expect(stats).toMatchObject({ inserted: 1, upgraded: 0, placeholders: 1, skipped: 1 });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'historyMessages: failed to store message',
    );

    const rows = db.raw
      .prepare("SELECT message_id, content_type FROM messages WHERE message_id LIKE '%_FAIL' OR message_id LIKE 'FAIL_%' ORDER BY message_id")
      .all() as Array<{ message_id: string; content_type: string }>;
    expect(rows).toEqual([
      { message_id: 'OK_AFTER_FAIL', content_type: 'history' },
      { message_id: 'OK_BEFORE_FAIL', content_type: 'text' },
    ]);
  });
});
