/**
 * Concurrency and duplicate-delivery tests for the heal control plane.
 *
 * Covers:
 *   12.2.1  Same control message_id twice → idempotent (INSERT OR IGNORE)
 *   12.2.2  HEAL_COMPLETE for already-resolved reportId → no-op
 *   12.2.3  Duplicate error_class in pending_heal_reports → unique index rejects it
 *   12.2.4  emitHealReport with same error class while active → suppressed
 *   12.2.5  Rapid crash loop: 3 calls same error class → only first creates row
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Messenger } from '../../src/core/types.ts';

// ---------------------------------------------------------------------------
// Module mocks — registered before any imports of mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../src/config.ts', () => ({
  config: {
    controlPeers: new Map<string, string>([['q', '15559998888']]),
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

// Mock sendTracked so tests don't attempt real network sends
vi.mock('../../src/core/durability.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/durability.ts')>();
  return {
    ...actual,
    sendTracked: vi.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { Database } from '../../src/core/database.ts';
import {
  emitHealReport,
  handleHealComplete,
} from '../../src/core/heal.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function makeMessenger(): Messenger {
  return {
    sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
    sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
  };
}

function insertControlMsg(db: Database, messageId: string, peerJid: string, protocol: string, payload: string): void {
  db.raw.prepare(`
    INSERT OR IGNORE INTO control_messages (message_id, direction, peer_jid, protocol, payload)
    VALUES (?, 'inbound', ?, ?, ?)
  `).run(messageId, peerJid, protocol, payload);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 12.2.1  Same control message_id twice → idempotent (INSERT OR IGNORE)
// ---------------------------------------------------------------------------

describe('12.2.1: duplicate control message_id is idempotent', () => {
  it('inserts only one row when the same message_id is stored twice', () => {
    const db = makeDb();
    const peerJid = '15559998888@s.whatsapp.net';
    const msgId = 'dup-ctrl-msg-001';
    const payload = '[HEAL_COMPLETE] {"reportId":"r1","errorClass":"crash__x","result":"fixed","diagnosis":"done"}';

    // First insert
    insertControlMsg(db, msgId, peerJid, 'HEAL_COMPLETE', payload);

    // Second insert with identical message_id — INSERT OR IGNORE should silently skip
    insertControlMsg(db, msgId, peerJid, 'HEAL_COMPLETE', payload);

    const count = (db.raw.prepare(
      `SELECT COUNT(*) as cnt FROM control_messages WHERE message_id = ?`,
    ).get(msgId) as { cnt: number }).cnt;
    expect(count).toBe(1);
  });

  it('does not throw on duplicate control message_id insert', () => {
    const db = makeDb();
    const msgId = 'dup-ctrl-no-throw-001';

    expect(() => {
      insertControlMsg(db, msgId, '15559998888@s.whatsapp.net', 'LOOPS_HEAL', '[LOOPS_HEAL] {}');
      insertControlMsg(db, msgId, '15559998888@s.whatsapp.net', 'LOOPS_HEAL', '[LOOPS_HEAL] {}');
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 12.2.2  HEAL_COMPLETE for already-resolved reportId → no-op
// ---------------------------------------------------------------------------

describe('12.2.2: HEAL_COMPLETE for already-resolved reportId is a no-op', () => {
  it('leaves state as resolved and does not throw on second call', () => {
    const db = makeDb();

    const reportId = randomUUID();
    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, resolved_at)
      VALUES (?, 'crash__already_resolved', 'crash', 'resolved', 1, datetime('now'))
    `).run(reportId);

    // First call on already-resolved report
    expect(() => handleHealComplete(db, {
      reportId,
      errorClass: 'crash__already_resolved',
      result: 'fixed',
      diagnosis: 'Original fix',
    })).not.toThrow();

    // Second call with different result — should still be resolved (no-op)
    expect(() => handleHealComplete(db, {
      reportId,
      errorClass: 'crash__already_resolved',
      result: 'escalate',
      diagnosis: 'Trying to escalate already-resolved report',
    })).not.toThrow();

    const row = db.raw.prepare(
      `SELECT state FROM heal_reports WHERE report_id = ?`,
    ).get(reportId) as { state: string };
    expect(row.state).toBe('resolved');
  });

  it('calling handleHealComplete twice for the same active report transitions once then no-ops', () => {
    const db = makeDb();

    const reportId = randomUUID();
    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count)
      VALUES (?, 'crash__double_complete', 'crash', 'attempt_1', 1)
    `).run(reportId);

    // First complete
    handleHealComplete(db, {
      reportId,
      errorClass: 'crash__double_complete',
      result: 'fixed',
      diagnosis: 'Fix applied',
    });

    const rowAfterFirst = db.raw.prepare(
      `SELECT state FROM heal_reports WHERE report_id = ?`,
    ).get(reportId) as { state: string };
    expect(rowAfterFirst.state).toBe('resolved');

    // Second complete — no-op, state must remain 'resolved'
    handleHealComplete(db, {
      reportId,
      errorClass: 'crash__double_complete',
      result: 'escalate',
      diagnosis: 'Attempting second complete',
    });

    const rowAfterSecond = db.raw.prepare(
      `SELECT state FROM heal_reports WHERE report_id = ?`,
    ).get(reportId) as { state: string };
    expect(rowAfterSecond.state).toBe('resolved');
  });
});

// ---------------------------------------------------------------------------
// 12.2.3  Duplicate error_class in pending_heal_reports → unique index rejects it
// ---------------------------------------------------------------------------

describe('12.2.3: pending_heal_reports unique index enforces one active entry per error_class', () => {
  it('throws a unique constraint error when inserting duplicate active error_class', () => {
    const db = makeDb();

    const reportId1 = randomUUID();
    const reportId2 = randomUUID();
    const errorClass = 'crash__unique_constraint_test';

    // First insert — succeeds
    db.raw.prepare(`
      INSERT INTO pending_heal_reports (report_id, error_class, state)
      VALUES (?, ?, 'attempt_1')
    `).run(reportId1, errorClass);

    // Second insert with same error_class and non-resolved state — must fail
    expect(() => {
      db.raw.prepare(`
        INSERT INTO pending_heal_reports (report_id, error_class, state)
        VALUES (?, ?, 'attempt_1')
      `).run(reportId2, errorClass);
    }).toThrow();
  });

  it('allows a new active entry once the prior one is resolved', () => {
    const db = makeDb();

    const reportId1 = randomUUID();
    const reportId2 = randomUUID();
    const errorClass = 'crash__unique_after_resolve';

    // Insert first and then mark it resolved
    db.raw.prepare(`
      INSERT INTO pending_heal_reports (report_id, error_class, state)
      VALUES (?, ?, 'attempt_1')
    `).run(reportId1, errorClass);

    db.raw.prepare(`
      UPDATE pending_heal_reports SET state = 'resolved' WHERE report_id = ?
    `).run(reportId1);

    // Now a second entry for the same class can be inserted
    expect(() => {
      db.raw.prepare(`
        INSERT INTO pending_heal_reports (report_id, error_class, state)
        VALUES (?, ?, 'attempt_1')
      `).run(reportId2, errorClass);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 12.2.4  emitHealReport with same error class while active → suppressed
// ---------------------------------------------------------------------------

describe('12.2.4: emitHealReport suppresses when same error class is active', () => {
  it('returns null for the second call with the same error class while first is active', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    const firstId = emitHealReport(db, messenger, null, {
      type: 'crash',
      stderr: 'ReferenceError: foo is not defined',
    });
    expect(firstId).not.toBeNull();

    // Active report exists for this class → second must be suppressed
    const secondId = emitHealReport(db, messenger, null, {
      type: 'crash',
      stderr: 'ReferenceError: foo is not defined',
    });
    expect(secondId).toBeNull();

    // Exactly one row
    const count = (db.raw.prepare(
      `SELECT COUNT(*) as cnt FROM heal_reports`,
    ).get() as { cnt: number }).cnt;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 12.2.5  Rapid crash loop: 3 emitHealReport calls → only first creates a row
// ---------------------------------------------------------------------------

describe('12.2.5: rapid crash loop — only first emitHealReport creates a row', () => {
  it('suppresses 2nd and 3rd calls for the same crash data', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    const crashData = {
      type: 'crash' as const,
      stderr: 'MemoryError: allocation failure at heap',
    };

    const id1 = emitHealReport(db, messenger, null, crashData);
    const id2 = emitHealReport(db, messenger, null, crashData);
    const id3 = emitHealReport(db, messenger, null, crashData);

    expect(id1).not.toBeNull();
    expect(id2).toBeNull();
    expect(id3).toBeNull();

    // Exactly one row in heal_reports
    const count = (db.raw.prepare(
      `SELECT COUNT(*) as cnt FROM heal_reports`,
    ).get() as { cnt: number }).cnt;
    expect(count).toBe(1);

    // The single row belongs to the first call
    const row = db.raw.prepare(
      `SELECT report_id, state FROM heal_reports LIMIT 1`,
    ).get() as { report_id: string; state: string } | undefined;
    expect(row?.report_id).toBe(id1);
    expect(row?.state).toBe('attempt_1');
  });

  it('all 3 suppressions do not throw', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    const crashData = {
      type: 'service_crash' as const,
      stderr: 'SIGKILL received',
    };

    expect(() => {
      emitHealReport(db, messenger, null, crashData);
      emitHealReport(db, messenger, null, crashData);
      emitHealReport(db, messenger, null, crashData);
    }).not.toThrow();
  });
});
