// tests/core/heal-degradation.test.ts
// Behavioral coverage for checkDegradationSignals: the 5-failures-in-5-minutes
// per-sender aggregation that emits a 'degraded' heal report.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.ts', () => ({
  config: {
    controlPeers: new Map([['q', '15559998888']]),
    adminPhones: new Set<string>(),
    dbPath: ':memory:',
    authDir: '/tmp/wa-test-auth',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
    models: {
      conversation: 'claude-opus-4-6',
      extraction: 'claude-sonnet-4-6',
      validation: 'claude-haiku-4-5',
      fallback: 'gpt-5.4',
    },
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

vi.mock('../../src/core/durability.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../src/core/durability.ts');
  return { ...actual, sendTracked: vi.fn().mockResolvedValue(undefined) };
});

import { Database } from '../../src/core/database.ts';
import type { Messenger } from '../../src/core/types.ts';
import { checkDegradationSignals } from '../../src/core/heal.ts';
import { sendTracked } from '../../src/core/durability.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: 'test-mid' }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: 'test-mid' }),
  } as unknown as Messenger;
}

function insertDecryptionFailure(
  db: Database,
  senderJid: string,
  createdAt: string,
  resolved = 0,
): void {
  db.raw
    .prepare(
      `INSERT INTO decryption_failures (message_id, chat_jid, conversation_key, sender_jid, error_message, raw_key, seen_count, created_at, resolved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `msg-${Math.random().toString(36).slice(2)}`,
      'chat@s.whatsapp.net',
      'chat_at_s.whatsapp.net',
      senderJid,
      'decrypt error',
      'raw',
      1,
      createdAt,
      resolved,
    );
}

describe('checkDegradationSignals', () => {
  let db: Database;
  let messenger: Messenger;

  beforeEach(() => {
    db = makeDb();
    messenger = makeMessenger();
    vi.mocked(sendTracked).mockClear();
  });

  it('emits a heal report when 5+ unresolved failures from one sender in the last 5 minutes', () => {
    const recentTs = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 minutes ago
    for (let i = 0; i < 5; i++) {
      insertDecryptionFailure(db, 'spammer@s.whatsapp.net', recentTs);
    }

    checkDegradationSignals(db, messenger, null, null);

    expect(sendTracked).toHaveBeenCalledOnce();
    const message = vi.mocked(sendTracked).mock.calls[0][2] as string;
    expect(message).toContain('degraded');
    expect(message).toContain('Occurrences: 5');
    expect(message).toContain('Affected scopes: 1');
    expect(message).not.toContain('spammer@s.whatsapp.net');
  });

  it('does not emit when fewer than 5 unresolved failures from a sender', () => {
    const recentTs = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    for (let i = 0; i < 4; i++) {
      insertDecryptionFailure(db, 'spammer@s.whatsapp.net', recentTs);
    }

    checkDegradationSignals(db, messenger, null, null);

    expect(sendTracked).not.toHaveBeenCalled();
  });

  it('does not emit when failures are older than 5 minutes', () => {
    const oldTs = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
    for (let i = 0; i < 10; i++) {
      insertDecryptionFailure(db, 'spammer@s.whatsapp.net', oldTs);
    }

    checkDegradationSignals(db, messenger, null, null);

    expect(sendTracked).not.toHaveBeenCalled();
  });

  it('does not emit when all failures are resolved', () => {
    const recentTs = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    for (let i = 0; i < 5; i++) {
      insertDecryptionFailure(db, 'spammer@s.whatsapp.net', recentTs, 1);
    }

    checkDegradationSignals(db, messenger, null, null);

    expect(sendTracked).not.toHaveBeenCalled();
  });

  it('coalesces multiple senders into ONE aggregated report per tick', () => {
    const recentTs = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    for (let i = 0; i < 5; i++) {
      insertDecryptionFailure(db, 'sender-a@s.whatsapp.net', recentTs);
      insertDecryptionFailure(db, 'sender-b@s.whatsapp.net', recentTs);
    }

    checkDegradationSignals(db, messenger, null, null);

    expect(sendTracked).toHaveBeenCalledOnce();
    const message = vi.mocked(sendTracked).mock.calls[0][2] as string;
    expect(message).toContain('Occurrences: 10');
    expect(message).toContain('Affected scopes: 2');
    expect(message).not.toContain('sender-a@s.whatsapp.net');
    expect(message).not.toContain('sender-b@s.whatsapp.net');
  });

  it('single-flights across ticks even as failure counts change (stable error class)', () => {
    const recentTs = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    for (let i = 0; i < 5; i++) insertDecryptionFailure(db, 'sender-a@s.whatsapp.net', recentTs);

    // Tick 1 → one report.
    checkDegradationSignals(db, messenger, null, null);
    expect(sendTracked).toHaveBeenCalledOnce();

    // More failures arrive (count rises) and a second sender appears; next 60s tick.
    for (let i = 0; i < 3; i++) {
      insertDecryptionFailure(db, 'sender-a@s.whatsapp.net', recentTs);
      insertDecryptionFailure(db, 'sender-b@s.whatsapp.net', recentTs);
    }
    checkDegradationSignals(db, messenger, null, null);

    // Still one report — the active degraded report suppresses the repeat (was the bug:
    // sender_jid+count baked into the class made every tick a "new" class).
    expect(sendTracked).toHaveBeenCalledOnce();
  });
});
