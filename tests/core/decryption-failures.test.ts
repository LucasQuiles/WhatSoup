import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Database, storeDecryptionFailure, resolveDecryptionFailure, getUnresolvedDecryptionFailures } from '../../src/core/database.ts';
import { storeMessageIfNew, type StoreMessageInput } from '../../src/core/messages.ts';

// ─── Shared in-memory DB ──────────────────────────────────────────────────────

const db = new Database(':memory:');
db.open();

afterAll(() => {
  db.close();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return randomBytes(6).toString('hex');
}

function makeFailureInput(overrides: Partial<Parameters<typeof storeDecryptionFailure>[1]> = {}) {
  const id = uid();
  return {
    messageId: `msg-${id}`,
    chatJid: `1234567890@s.whatsapp.net`,
    senderJid: `sender-${id}@s.whatsapp.net`,
    errorMessage: 'test decryption error',
    rawKey: { remoteJid: `1234567890@s.whatsapp.net`, id: `msg-${id}`, fromMe: false },
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeMessage(messageId: string, overrides: Partial<StoreMessageInput> = {}): StoreMessageInput {
  return {
    chatJid: '1234567890@s.whatsapp.net',
    conversationKey: '1234567890_at_s.whatsapp.net',
    senderJid: 'sender@s.whatsapp.net',
    senderName: 'Test Sender',
    messageId,
    content: 'hello world',
    contentType: 'text',
    isFromMe: false,
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('decryption_failures table', () => {
  beforeEach(() => {
    db.raw.prepare('DELETE FROM decryption_failures').run();
    db.raw.prepare('DELETE FROM messages').run();
  });

  it('table exists after migration 9', () => {
    const row = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decryption_failures'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('decryption_failures');
  });

  it('UNIQUE constraint on message_id prevents duplicate inserts', () => {
    const input = makeFailureInput({ messageId: 'dup-msg-001' });
    storeDecryptionFailure(db, input);
    // Second call should upsert (increment seen_count), not throw
    expect(() => storeDecryptionFailure(db, input)).not.toThrow();
    const row = db.raw
      .prepare('SELECT seen_count FROM decryption_failures WHERE message_id = ?')
      .get('dup-msg-001') as { seen_count: number } | undefined;
    expect(row?.seen_count).toBe(2);
  });

  it('storeDecryptionFailure inserts a new row', () => {
    const input = makeFailureInput();
    storeDecryptionFailure(db, input);
    const row = db.raw
      .prepare('SELECT * FROM decryption_failures WHERE message_id = ?')
      .get(input.messageId) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.message_id).toBe(input.messageId);
    expect(row!.sender_jid).toBe(input.senderJid);
    expect(row!.seen_count).toBe(1);
    expect(row!.resolved).toBe(0);
  });

  it('upsert increments seen_count on duplicate message_id', () => {
    const input = makeFailureInput();
    storeDecryptionFailure(db, input);
    storeDecryptionFailure(db, { ...input, errorMessage: 'updated error' });
    storeDecryptionFailure(db, { ...input, errorMessage: 'final error' });
    const row = db.raw
      .prepare('SELECT seen_count, error_message FROM decryption_failures WHERE message_id = ?')
      .get(input.messageId) as { seen_count: number; error_message: string } | undefined;
    expect(row?.seen_count).toBe(3);
    expect(row?.error_message).toBe('final error');
  });

  it('getUnresolvedDecryptionFailures returns only unresolved rows', () => {
    const a = makeFailureInput();
    const b = makeFailureInput();
    storeDecryptionFailure(db, a);
    storeDecryptionFailure(db, b);
    // Mark one as resolved directly
    db.raw.prepare("UPDATE decryption_failures SET resolved = 1 WHERE message_id = ?").run(a.messageId);

    const rows = getUnresolvedDecryptionFailures(db);
    expect(rows.some(r => r.messageId === b.messageId)).toBe(true);
    expect(rows.some(r => r.messageId === a.messageId)).toBe(false);
  });

  it('resolveDecryptionFailure marks the row resolved', () => {
    const input = makeFailureInput();
    storeDecryptionFailure(db, input);
    resolveDecryptionFailure(db, input.messageId);
    const row = db.raw
      .prepare('SELECT resolved, resolved_at FROM decryption_failures WHERE message_id = ?')
      .get(input.messageId) as { resolved: number; resolved_at: string | null } | undefined;
    expect(row?.resolved).toBe(1);
    expect(row?.resolved_at).not.toBeNull();
  });

  it('resolveDecryptionFailure is idempotent on already-resolved row', () => {
    const input = makeFailureInput();
    storeDecryptionFailure(db, input);
    resolveDecryptionFailure(db, input.messageId);
    expect(() => resolveDecryptionFailure(db, input.messageId)).not.toThrow();
    const row = db.raw
      .prepare('SELECT resolved FROM decryption_failures WHERE message_id = ?')
      .get(input.messageId) as { resolved: number } | undefined;
    expect(row?.resolved).toBe(1);
  });

  it('storeMessageIfNew auto-clears a prior decryption failure for the same message_id', () => {
    const msgId = `msg-${uid()}`;
    const input = makeFailureInput({ messageId: msgId });
    storeDecryptionFailure(db, input);

    // Verify it starts unresolved
    const before = db.raw
      .prepare('SELECT resolved FROM decryption_failures WHERE message_id = ?')
      .get(msgId) as { resolved: number } | undefined;
    expect(before?.resolved).toBe(0);

    // Now the real message arrives
    storeMessageIfNew(db, makeMessage(msgId));

    // Should be resolved now
    const after = db.raw
      .prepare('SELECT resolved FROM decryption_failures WHERE message_id = ?')
      .get(msgId) as { resolved: number } | undefined;
    expect(after?.resolved).toBe(1);
  });

  it('storeMessageIfNew auto-clears for null-content media stubs', () => {
    const msgId = `media-${uid()}`;
    const input = makeFailureInput({ messageId: msgId });
    storeDecryptionFailure(db, input);

    // Media message with null content (e.g., image without caption)
    storeMessageIfNew(db, makeMessage(msgId, { content: null, contentType: 'image' }));

    const after = db.raw
      .prepare('SELECT resolved FROM decryption_failures WHERE message_id = ?')
      .get(msgId) as { resolved: number } | undefined;
    expect(after?.resolved).toBe(1);
  });
});
