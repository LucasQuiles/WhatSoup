import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { createOutboundSendsWriter } from '../../src/core/outbound-sends.ts';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('outbound_sends audit writer', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('writeIntent returns the inserted row id with intent status', () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });

    const id = writer.writeIntent({
      caller: 'mcp',
      chatJid: '15550100001@s.whatsapp.net',
      targetKind: 'alias',
      alias: 'q',
      profile: 'notify',
      text: 'hello from audit',
      linkPreviewMode: 'off',
    });

    expect(id).toBeGreaterThan(0);
    const row = db.raw.prepare('SELECT * FROM outbound_sends WHERE id = ?').get(id) as {
      status: string;
      line: string;
      caller: string;
      chat_jid: string;
      target_kind: string;
      alias: string;
      profile: string;
      link_preview_mode: string;
    };
    expect(row).toMatchObject({
      status: 'intent',
      line: 'personal',
      caller: 'mcp',
      chat_jid: '15550100001@s.whatsapp.net',
      target_kind: 'alias',
      alias: 'q',
      profile: 'notify',
      link_preview_mode: 'off',
    });
  });

  it('writeIntent stores SHA-256 of the final text without storing the text itself', () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const text = '[ALERT] final body';

    const id = writer.writeIntent({
      caller: 'health',
      chatJid: '15550100002@s.whatsapp.net',
      targetKind: 'chatJid',
      text,
      linkPreviewMode: 'auto',
    });

    const cols = db.raw
      .prepare('PRAGMA table_info(outbound_sends)')
      .all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).not.toContain('text');

    const row = db.raw
      .prepare('SELECT text_hash, text_length FROM outbound_sends WHERE id = ?')
      .get(id) as { text_hash: string; text_length: number };
    expect(row.text_hash).toBe(sha256(text));
    expect(row.text_length).toBe(text.length);
  });

  it('markSuccess finalizes a row as sent with the optional transport id', () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const id = writer.writeIntent({
      caller: 'mcp',
      chatJid: '15550100003@s.whatsapp.net',
      targetKind: 'chatJid',
      text: 'sent message',
    });

    writer.markSuccess(id, 'wamid.test');

    const row = db.raw
      .prepare('SELECT status, transport_message_id, completed_at FROM outbound_sends WHERE id = ?')
      .get(id) as { status: string; transport_message_id: string; completed_at: string | null };
    expect(row.status).toBe('sent');
    expect(row.transport_message_id).toBe('wamid.test');
    expect(row.completed_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}/));
  });

  it('markFailure finalizes a row as failed with sanitized error text', () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const id = writer.writeIntent({
      caller: 'health',
      chatJid: '15550100004@s.whatsapp.net',
      targetKind: 'alias',
      alias: 'ops',
      text: 'failed message',
    });

    writer.markFailure(id, 'transport unavailable');

    const row = db.raw
      .prepare('SELECT status, error, completed_at FROM outbound_sends WHERE id = ?')
      .get(id) as { status: string; error: string; completed_at: string | null };
    expect(row.status).toBe('failed');
    expect(row.error).toBe('transport unavailable');
    expect(row.completed_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}/));
  });

  it('outcome markers throw when the audit row is already finalized', () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const failedId = writer.writeIntent({
      caller: 'mcp',
      chatJid: '15550100005@s.whatsapp.net',
      targetKind: 'chatJid',
      text: 'failure wins',
    });
    writer.markFailure(failedId, 'first outcome wins');

    const sentId = writer.writeIntent({
      caller: 'health',
      chatJid: '15550100006@s.whatsapp.net',
      targetKind: 'chatJid',
      text: 'success wins',
    });
    writer.markSuccess(sentId, 'wamid.first');

    expect(() => writer.markSuccess(failedId, 'wamid.late')).toThrow(/already finalized/i);
    expect(() => writer.markFailure(sentId, 'late failure')).toThrow(/already finalized/i);
    expect(() => writer.markSuccess(sentId, 'wamid.second')).toThrow(/already finalized/i);
  });

  it('outcome markers throw when the audit row does not exist', () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    // No row with this id was ever inserted → UPDATE affects 0 rows and the
    // status lookup returns undefined → the `!row` not-found branch.
    expect(() => writer.markSuccess(999_999, 'wamid.ghost')).toThrow(/not found/i);
    expect(() => writer.markFailure(999_998, 'ghost failure')).toThrow(/not found/i);
  });

  it('markSuccess without a transport id stores null (?? null arm)', () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const id = writer.writeIntent({
      caller: 'mcp',
      chatJid: '15550100009@s.whatsapp.net',
      targetKind: 'chatJid',
      text: 'no transport id',
    });
    writer.markSuccess(id); // transportMessageId omitted → `transportMessageId ?? null`

    const row = db.raw
      .prepare('SELECT status, transport_message_id FROM outbound_sends WHERE id = ?')
      .get(id) as { status: string; transport_message_id: string | null };
    expect(row).toEqual({ status: 'sent', transport_message_id: null });
  });

  it('listRecent surfaces error_text for a failed row (spread true arm)', () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const id = writer.writeIntent({
      caller: 'mcp',
      chatJid: '222@s.whatsapp.net',
      targetKind: 'chatJid',
      text: 'will fail',
    });
    writer.markFailure(id, 'delivery rejected');

    const failed = writer.listRecent({ limit: 10 }).find((r) => r.id === id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error_text).toContain('delivery rejected');
  });

  it('listRecent returns bounded rows without message text', () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    const id = writer.writeIntent({
      caller: 'mcp',
      chatJid: '111@s.whatsapp.net',
      targetKind: 'chatJid',
      profile: 'notify',
      text: 'private body',
    });
    writer.markSuccess(id, 'wamid.audit');

    const rows = writer.listRecent({ limit: 10 });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      chat_jid: '111@s.whatsapp.net',
      status: 'sent',
      profile: 'notify',
      transport_id: 'wamid.audit',
    });
    expect(Object.keys(rows[0])).not.toContain('text');
  });

  it('listRecent filters by raw chatJid and clamps large limits', () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });
    for (let i = 0; i < 120; i += 1) {
      writer.writeIntent({
        caller: 'mcp',
        chatJid: i % 2 === 0 ? 'include@s.whatsapp.net' : 'exclude@s.whatsapp.net',
        targetKind: 'chatJid',
        text: `message ${i}`,
      });
    }

    expect(writer.listRecent({ limit: 500 })).toHaveLength(100);
    expect(writer.listRecent({ chatJid: 'include@s.whatsapp.net' }).every((row) => row.chat_jid === 'include@s.whatsapp.net')).toBe(true);
  });

  it('listRecent rejects invalid limits', () => {
    const writer = createOutboundSendsWriter({ db: db.raw, line: 'personal' });

    expect(() => writer.listRecent({ limit: 0 })).toThrow(/limit must be at least 1/i);
    expect(() => writer.listRecent({ limit: -1 })).toThrow(/limit must be at least 1/i);
    expect(() => writer.listRecent({ limit: 1.5 })).toThrow(/limit must be an integer/i);
  });
});
