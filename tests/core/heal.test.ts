/**
 * Tests for src/core/heal.ts — circuit breaker state machine and heal report management.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Module mocks — registered before imports of mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../src/config.ts', () => ({
  config: {
    // Q control peer: name 'q' → phone '15559998888'
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

// Mock sendTracked so tests don't attempt real sends
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
import type { Messenger } from '../../src/core/types.ts';
import { sendTracked } from '../../src/core/durability.ts';
import {
  emitHealReport,
  handleHealComplete,
  handleHealEscalate,
  getActiveReportForClass,
  dequeueNextReport,
  checkGlobalValve,
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

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. emitHealReport creates heal_reports row with state='attempt_1'
// ---------------------------------------------------------------------------

describe('emitHealReport', () => {
  it('creates a heal_reports row with state=attempt_1', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    const reportId = emitHealReport(db, messenger, null, {
      type: 'crash',
      chatJid: '1234@s.whatsapp.net',
      exitCode: 1,
      stderr: 'TypeError: boom',
    });

    expect(reportId).not.toBeNull();

    const row = db.raw.prepare('SELECT * FROM heal_reports WHERE report_id = ?').get(reportId) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.state).toBe('attempt_1');
    expect(row?.error_type).toBe('crash');
    expect(row?.attempt_count).toBe(1);
  });

  // 2. emitHealReport suppresses for same error_class in active state
  it('suppresses a second report for the same error_class when active', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    const first = emitHealReport(db, messenger, null, {
      type: 'crash',
      stderr: 'TypeError: boom',
    });

    expect(first).not.toBeNull();

    // Same error hint → same error class → should suppress
    const second = emitHealReport(db, messenger, null, {
      type: 'crash',
      stderr: 'TypeError: boom',
    });

    expect(second).toBeNull();

    // Only one row in DB
    const count = (db.raw.prepare('SELECT COUNT(*) as cnt FROM heal_reports').get() as { cnt: number }).cnt;
    expect(count).toBe(1);
  });

  // 3. emitHealReport queues when activeControlReportId is set
  it('creates report with state=queued when activeControlReportId is provided', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    const reportId = emitHealReport(
      db,
      messenger,
      null,
      { type: 'degraded', recentLogs: 'hook denied tool' },
      'some-active-report-id',
    );

    expect(reportId).not.toBeNull();

    const row = db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get(reportId) as { state: string } | undefined;
    expect(row?.state).toBe('queued');

    // sendTracked must NOT be called for queued reports
    expect(vi.mocked(sendTracked)).not.toHaveBeenCalled();
  });

  // 4. sendTracked is called when state=attempt_1 and Q peer is configured
  it('calls sendTracked with a [LOOPS_HEAL] message when Q peer is configured', async () => {
    const db = makeDb();
    const messenger = makeMessenger();

    emitHealReport(db, messenger, null, {
      type: 'service_crash',
      exitCode: 137,
      stderr: 'Killed',
    });

    // Give the fire-and-forget promise a tick to settle
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(vi.mocked(sendTracked)).toHaveBeenCalledOnce();
    const [, targetJid, message] = vi.mocked(sendTracked).mock.calls[0]!;
    expect(targetJid).toBe('15559998888@s.whatsapp.net');
    expect(message).toMatch(/^\[LOOPS_HEAL\]/);
  });
});

// ---------------------------------------------------------------------------
// 5. handleHealComplete with result='fixed' → state='resolved'
// ---------------------------------------------------------------------------

describe('handleHealComplete', () => {
  it('transitions state to resolved when result=fixed', () => {
    const db = makeDb();

    const reportId = randomUUID();
    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count)
      VALUES (?, 'crash__boom', 'crash', 'attempt_1', 1)
    `).run(reportId);

    handleHealComplete(db, {
      reportId,
      errorClass: 'crash__boom',
      result: 'fixed',
      diagnosis: 'Patched null guard',
    });

    const row = db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get(reportId) as { state: string };
    expect(row.state).toBe('resolved');
  });

  // 6. handleHealComplete is idempotent — second call for same reportId is no-op
  it('is idempotent — second call for resolved reportId is a no-op', () => {
    const db = makeDb();

    const reportId = randomUUID();
    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, resolved_at)
      VALUES (?, 'crash__boom', 'crash', 'resolved', 1, datetime('now'))
    `).run(reportId);

    // Call again — should not throw and state remains resolved
    handleHealComplete(db, {
      reportId,
      errorClass: 'crash__boom',
      result: 'escalate',
      diagnosis: 'Second attempt',
    });

    const row = db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get(reportId) as { state: string };
    expect(row.state).toBe('resolved');
  });

  // 7. handleHealComplete for unknown reportId → creates adopted row (Type 3)
  it('adopts an unknown reportId as a resolved row (Type 3)', () => {
    const db = makeDb();

    const reportId = randomUUID();

    handleHealComplete(db, {
      reportId,
      errorClass: 'service_crash__startup_fail',
      result: 'fixed',
      diagnosis: 'Service auto-recovered',
    });

    const row = db.raw.prepare('SELECT * FROM heal_reports WHERE report_id = ?').get(reportId) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.state).toBe('resolved');
    expect(row?.error_class).toBe('service_crash__startup_fail');
    expect(row?.error_type).toBe('service_crash');
  });
});

// ---------------------------------------------------------------------------
// 8. handleHealEscalate → state='escalated'
// ---------------------------------------------------------------------------

describe('handleHealEscalate', () => {
  it('transitions state to escalated', () => {
    const db = makeDb();

    const reportId = randomUUID();
    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count)
      VALUES (?, 'crash__boom', 'crash', 'attempt_2', 2)
    `).run(reportId);

    handleHealEscalate(db, {
      reportId,
      errorClass: 'crash__boom',
      result: 'escalate',
      diagnosis: 'Tests failed in worktree',
    });

    const row = db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get(reportId) as { state: string };
    expect(row.state).toBe('escalated');
  });
});

// ---------------------------------------------------------------------------
// 9. getActiveReportForClass
// ---------------------------------------------------------------------------

describe('getActiveReportForClass', () => {
  it('returns null when no active report exists', () => {
    const db = makeDb();

    const result = getActiveReportForClass(db, 'crash__nonexistent');
    expect(result).toBeNull();
  });

  it('returns the active row when one exists', () => {
    const db = makeDb();

    const reportId = randomUUID();
    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count)
      VALUES (?, 'crash__boom', 'crash', 'attempt_1', 1)
    `).run(reportId);

    const result = getActiveReportForClass(db, 'crash__boom');
    expect(result).not.toBeNull();
    expect(result?.report_id).toBe(reportId);
    expect(result?.state).toBe('attempt_1');
  });

  it('returns null for a resolved report (not active)', () => {
    const db = makeDb();

    const reportId = randomUUID();
    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, resolved_at)
      VALUES (?, 'crash__boom', 'crash', 'resolved', 1, datetime('now'))
    `).run(reportId);

    const result = getActiveReportForClass(db, 'crash__boom');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10 & 11. dequeueNextReport
// ---------------------------------------------------------------------------

describe('dequeueNextReport', () => {
  it('returns oldest queued report and transitions it to attempt_1', () => {
    const db = makeDb();

    const r1 = randomUUID();
    const r2 = randomUUID();
    // Insert older one first, then newer one
    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, created_at)
      VALUES (?, 'crash__a', 'crash', 'queued', 1, datetime('now', '-5 minutes'))
    `).run(r1);
    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, created_at)
      VALUES (?, 'crash__b', 'crash', 'queued', 1, datetime('now'))
    `).run(r2);

    const dequeued = dequeueNextReport(db);
    expect(dequeued).not.toBeNull();
    expect(dequeued?.report_id).toBe(r1);

    // Verify the DB row transitioned to attempt_1
    const row = db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get(r1) as { state: string };
    expect(row.state).toBe('attempt_1');

    // r2 remains queued
    const r2Row = db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get(r2) as { state: string };
    expect(r2Row.state).toBe('queued');
  });

  it('returns null when nothing is queued', () => {
    const db = makeDb();

    const result = dequeueNextReport(db);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 12 & 13. checkGlobalValve
// ---------------------------------------------------------------------------

describe('checkGlobalValve', () => {
  it('returns true when under the limit', () => {
    const db = makeDb();

    // Insert 4 non-queued reports within the last hour (limit is 5)
    for (let i = 0; i < 4; i++) {
      db.raw.prepare(`
        INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count)
        VALUES (?, 'crash__x${i}', 'crash', 'attempt_1', 1)
      `).run(randomUUID());
    }

    expect(checkGlobalValve(db)).toBe(true);
  });

  it('returns false at the limit', () => {
    const db = makeDb();

    // Insert exactly GLOBAL_VALVE_LIMIT (5) non-queued reports within the last hour
    for (let i = 0; i < 5; i++) {
      db.raw.prepare(`
        INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count)
        VALUES (?, 'crash__y${i}', 'crash', 'attempt_1', 1)
      `).run(randomUUID());
    }

    expect(checkGlobalValve(db)).toBe(false);
  });

  it('does not count queued reports toward the valve limit', () => {
    const db = makeDb();

    // Insert 5 queued reports — valve should still be open
    for (let i = 0; i < 5; i++) {
      db.raw.prepare(`
        INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count)
        VALUES (?, 'crash__z${i}', 'crash', 'queued', 1)
      `).run(randomUUID());
    }

    expect(checkGlobalValve(db)).toBe(true);
  });

  it('does not count old reports (outside the 1-hour window) toward the limit', () => {
    const db = makeDb();

    // Insert 5 reports from 2 hours ago
    for (let i = 0; i < 5; i++) {
      db.raw.prepare(`
        INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, created_at)
        VALUES (?, 'crash__old${i}', 'crash', 'attempt_1', 1, datetime('now', '-2 hours'))
      `).run(randomUUID());
    }

    expect(checkGlobalValve(db)).toBe(true);
  });
});
