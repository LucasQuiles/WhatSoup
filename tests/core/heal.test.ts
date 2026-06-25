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

vi.mock('../../src/lib/emit-alert.ts', () => {
  const emitAlert = vi.fn(() => true);
  const clearAlertSource = vi.fn(() => true);
  return {
    emitAlert,
    emitAlertChecked: emitAlert,
    clearAlertSource,
    clearAlertSourceChecked: clearAlertSource,
  };
});

// Mock sendTracked so tests don't attempt real sends
vi.mock('../../src/core/durability.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../src/core/durability.ts');
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
import { emitAlert } from '../../src/lib/emit-alert.ts';
import { config } from '../../src/config.ts';
import {
  emitHealReport,
  handleHealComplete,
  handleHealEscalate,
  getActiveReportForClass,
  dequeueNextReport,
  reconcileStaleHealReports,
  getGlobalValveCount,
  GLOBAL_VALVE_LIMIT,
  parseHealContext,
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

    await vi.waitFor(() => {
      expect(vi.mocked(sendTracked)).toHaveBeenCalledOnce();
    });
    const [, targetJid, message] = vi.mocked(sendTracked).mock.calls[0]!;
    expect(targetJid).toBe('15559998888@s.whatsapp.net');
    expect(message).toMatch(/^\[LOOPS_HEAL\]/);
  });

  it('includes provider crash classification in Q payload and human summary', async () => {
    const db = makeDb();
    const messenger = makeMessenger();

    const reportId = emitHealReport(db, messenger, null, {
      type: 'crash',
      chatJid: '1234@s.whatsapp.net',
      exitCode: 1,
      provider: 'claude-cli',
      crashClass: 'provider_auth_required',
      stderr: 'Please run /login\nBearer [REDACTED]',
    });

    expect(reportId).not.toBeNull();
    const row = db.raw.prepare('SELECT error_class, context FROM heal_reports WHERE report_id = ?').get(reportId) as { error_class: string; context: string } | undefined;
    expect(row?.error_class).toBe('crash__provider_auth_required');
    expect(JSON.parse(row?.context ?? '{}')).toMatchObject({
      provider: 'claude-cli',
      crashClass: 'provider_auth_required',
    });

    await vi.waitFor(() => {
      expect(vi.mocked(sendTracked)).toHaveBeenCalledOnce();
    });
    const [, , message] = vi.mocked(sendTracked).mock.calls[0]!;
    const payload = JSON.parse(String(message).split('\n')[0]!.replace('[LOOPS_HEAL] ', '')) as Record<string, unknown>;
    expect(payload).toMatchObject({
      provider: 'claude-cli',
      crashClass: 'provider_auth_required',
    });
    expect(message).toContain('Provider: claude-cli');
    expect(message).toContain('Crash class: provider_auth_required');
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
    expect(result).toStrictEqual(null);
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
    expect(result).toStrictEqual(null);
  });
});

// ---------------------------------------------------------------------------
// 9b. stale active report reconciliation
// ---------------------------------------------------------------------------

describe('reconcileStaleHealReports', () => {
  it('expires old escalated reports so a restarted bot can emit the same error class again', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, created_at)
      VALUES ('stale-report', 'crash__boom', 'crash', 'escalated', 1, '2026-06-13T00:00:00.000Z')
    `).run();

    const result = reconcileStaleHealReports(db, {
      now: new Date('2026-06-13T01:00:00.000Z'),
      staleMs: 30 * 60 * 1000,
    });

    expect(result.expiredReportIds).toEqual(['stale-report']);
    expect(getActiveReportForClass(db, 'crash__boom')).toBeNull();

    const next = emitHealReport(db, messenger, null, {
      type: 'crash',
      crashClass: 'boom',
    });

    expect(next).not.toBeNull();
    const rows = db.raw.prepare(`
      SELECT report_id, state FROM heal_reports WHERE error_class = 'crash__boom'
    `).all() as Array<{ report_id: string; state: string }>;
    expect(rows).toEqual(expect.arrayContaining([
      { report_id: 'stale-report', state: 'stale_expired' },
      { report_id: next, state: 'attempt_1' },
    ]));
  });

  it('leaves fresh queued and escalated reports active', () => {
    const db = makeDb();

    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, created_at)
      VALUES
        ('fresh-queued', 'crash__queued', 'crash', 'queued', 1, '2026-06-13T00:45:00.000Z'),
        ('fresh-escalated', 'crash__escalated', 'crash', 'escalated', 1, '2026-06-13T00:45:00.000Z')
    `).run();

    const result = reconcileStaleHealReports(db, {
      now: new Date('2026-06-13T01:00:00.000Z'),
      staleMs: 30 * 60 * 1000,
    });

    expect(result.expiredReportIds).toEqual([]);
    expect(getActiveReportForClass(db, 'crash__queued')?.state).toBe('queued');
    expect(getActiveReportForClass(db, 'crash__escalated')?.state).toBe('escalated');
  });

  it('automatically reconciles stale same-class reports before suppressing an emit', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, created_at)
      VALUES ('stale-suppressor', 'crash__auto', 'crash', 'escalated', 1, '2000-01-01T00:00:00.000Z')
    `).run();

    const reportId = emitHealReport(db, messenger, null, {
      type: 'crash',
      crashClass: 'auto',
    });

    expect(reportId).not.toBeNull();
    const stale = db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get('stale-suppressor') as { state: string };
    expect(stale.state).toBe('stale_expired');
    expect(getActiveReportForClass(db, 'crash__auto')?.report_id).toBe(reportId);
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
    expect(result).toStrictEqual(null);
  });

  it('expires stale queued reports before dequeueing', () => {
    const db = makeDb();

    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, created_at)
      VALUES ('stale-queued', 'crash__queued_old', 'crash', 'queued', 1, '2000-01-01T00:00:00.000Z')
    `).run();

    const result = dequeueNextReport(db);

    expect(result).toBeNull();
    const row = db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get('stale-queued') as { state: string };
    expect(row.state).toBe('stale_expired');
  });
});

// ---------------------------------------------------------------------------
// 12 & 13. global valve count (getGlobalValveCount vs GLOBAL_VALVE_LIMIT)
// ---------------------------------------------------------------------------

describe('global valve gate', () => {
  it('returns true when under the limit', () => {
    const db = makeDb();

    // Insert 4 non-queued reports within the last hour (limit is 5)
    for (let i = 0; i < 4; i++) {
      db.raw.prepare(`
        INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count)
        VALUES (?, 'crash__x${i}', 'crash', 'attempt_1', 1)
      `).run(randomUUID());
    }

    expect(getGlobalValveCount(db) < GLOBAL_VALVE_LIMIT).toBe(true);
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

    expect(getGlobalValveCount(db) < GLOBAL_VALVE_LIMIT).toBe(false);
  });

  it('emits an operational alert when the global valve suppresses a new report', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    for (let i = 0; i < 5; i++) {
      const id = emitHealReport(db, messenger, null, {
        type: 'crash',
        stderr: `UniqueError_${randomUUID().slice(0, 8)}: valve fill ${i}`,
      });
      expect(id).not.toBeNull();
    }

    vi.mocked(sendTracked).mockClear();

    const sixth = emitHealReport(db, messenger, null, {
      type: 'crash',
      stderr: 'ValveTripError: sixth attempt',
    });

    expect(sixth).toBeNull();
    expect(vi.mocked(sendTracked)).not.toHaveBeenCalled();
    expect(vi.mocked(emitAlert)).toHaveBeenCalledOnce();
    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'WhatSoup',
      'heal_repeated_failures',
      expect.stringContaining('heal valve'),
      expect.stringContaining('ValveTripError'),
    );
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

    expect(getGlobalValveCount(db) < GLOBAL_VALVE_LIMIT).toBe(true);
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

    expect(getGlobalValveCount(db) < GLOBAL_VALVE_LIMIT).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseHealContext — guarded parse for persisted report context
// ---------------------------------------------------------------------------

describe('parseHealContext', () => {
  it('returns {} for corrupt JSON instead of throwing', () => {
    // The dequeue callers run inside timers — a throw here was a fatal
    // uncaughtException, with the report already flipped to attempt_1.
    expect(parseHealContext('{not json')).toEqual({});
  });

  it('returns {} for null and empty context', () => {
    expect(parseHealContext(null)).toEqual({});
    expect(parseHealContext('')).toEqual({});
  });

  it('returns {} for valid JSON that is not a plain object', () => {
    expect(parseHealContext('[1,2]')).toEqual({});
    expect(parseHealContext('"a string"')).toEqual({});
    expect(parseHealContext('42')).toEqual({});
    expect(parseHealContext('null')).toEqual({});
  });

  it('returns the parsed object for valid object JSON', () => {
    expect(parseHealContext('{"chatJid":"123@s.whatsapp.net","attempt":2}')).toEqual({
      chatJid: '123@s.whatsapp.net',
      attempt: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// heal.ts uncovered-branch coverage
// ---------------------------------------------------------------------------

describe('heal.ts uncovered-branch coverage', () => {
  it('falls back to the "unknown" error class when crashClass/stderr/recentLogs are all absent', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    // No crashClass, stderr, or recentLogs → normalizeErrorClass uses 'unknown'
    // and the `?? 'unknown'` final fallback (4th binary-expr operand) is hit.
    const reportId = emitHealReport(db, messenger, null, {
      type: 'degraded',
      chatJid: '15550000001@s.whatsapp.net',
    });

    expect(reportId).not.toBeNull();
    const row = db.raw.prepare('SELECT error_class FROM heal_reports WHERE report_id = ?').get(reportId) as { error_class: string };
    // Type 'degraded' + 'unknown' hint (no stderr/recentLogs/crashClass supplied)
    expect(row.error_class).toBe('degraded__unknown');
  });

  it('emits the valve alert with every optional field populated in the detail lines', async () => {
    const db = makeDb();
    const messenger = makeMessenger();

    // Fill the valve with 5 unique non-queued reports first.
    for (let i = 0; i < 5; i++) {
      emitHealReport(db, messenger, null, {
        type: 'crash',
        stderr: `ValveFill_${i}_${randomUUID().slice(0, 8)}: padding`,
      });
    }

    vi.mocked(emitAlert).mockClear();
    vi.mocked(sendTracked).mockClear();

    // 6th emit trips the valve. Supply EVERY optional field so every
    // `data.x ? \`x=${data.x}\` : null` ternary hits its truthy branch.
    const tripped = emitHealReport(db, messenger, null, {
      type: 'service_crash',
      chatJid: '1111111000000000@g.us',
      exitCode: 137,
      signal: 'SIGKILL',
      provider: 'claude-cli',
      crashClass: 'provider_auth_required',
      stderr: 'fatal: out of memory',
      recentLogs: 'line A\nline B',
    });

    // Valve suppresses the report (no DB row, no send)
    expect(tripped).toBeNull();
    expect(vi.mocked(sendTracked)).not.toHaveBeenCalled();

    // Alert fired with all detail lines present (every ternary truthy branch).
    expect(vi.mocked(emitAlert)).toHaveBeenCalledOnce();
    const detailArg = vi.mocked(emitAlert).mock.calls[0]![3];
    expect(detailArg).toMatch(/chat_jid=1111111000000000@g\.us/);
    expect(detailArg).toMatch(/exit_code=137/);
    expect(detailArg).toMatch(/signal=SIGKILL/);
    expect(detailArg).toMatch(/provider=claude-cli/);
    expect(detailArg).toMatch(/crash_class=provider_auth_required/);
    expect(detailArg).toMatch(/stderr=fatal: out of memory/);
    expect(detailArg).toMatch(/recent_logs=line A/);
  });

  it('omits the stderr detail line in the valve alert when stderr is absent', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    // Fill the valve with 5 unique non-queued reports first.
    for (let i = 0; i < 5; i++) {
      emitHealReport(db, messenger, null, {
        type: 'crash',
        stderr: `ValveFillB_${i}_${randomUUID().slice(0, 8)}: padding`,
      });
    }

    vi.mocked(emitAlert).mockClear();
    vi.mocked(sendTracked).mockClear();

    // 6th emit trips the valve with NO stderr → the stderr ternary hits its
    // falsy (null) branch and the detail line is omitted.
    const tripped = emitHealReport(db, messenger, null, {
      type: 'service_crash',
      chatJid: '1111111000000000@g.us',
      crashClass: 'startup_failed',
      recentLogs: 'boot loop detected',
    });

    expect(tripped).toBeNull();
    expect(vi.mocked(sendTracked)).not.toHaveBeenCalled();
    expect(vi.mocked(emitAlert)).toHaveBeenCalledOnce();
    const detailArg = vi.mocked(emitAlert).mock.calls[0]![3];
    // stderr line absent (falsy branch of the ternary)
    expect(detailArg).not.toMatch(/stderr=/);
    // but other present fields are still rendered
    expect(detailArg).toMatch(/crash_class=startup_failed/);
    expect(detailArg).toMatch(/recent_logs=boot loop detected/);
  });

  it('returns the reportId without sending when no Q control peer is configured', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    // Mutate the shared config mock to remove the Q peer, then restore it.
    config.controlPeers.delete('q');
    try {
      const reportId = emitHealReport(db, messenger, null, {
        type: 'crash',
        stderr: 'NoQPeer: boom',
      });

      // Report is still created with state='attempt_1' but no send happens.
      expect(reportId).not.toBeNull();
      const row = db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get(reportId) as { state: string };
      expect(row.state).toBe('attempt_1');
      expect(vi.mocked(sendTracked)).not.toHaveBeenCalled();
    } finally {
      config.controlPeers.set('q', '15559998888');
    }
  });

  it('includes signal and recentLogs lines in the human-readable heal report when present', async () => {
    const db = makeDb();
    const messenger = makeMessenger();

    emitHealReport(db, messenger, null, {
      type: 'crash',
      chatJid: '15550000001@s.whatsapp.net',
      exitCode: 1,
      signal: 'SIGTERM',
      provider: 'claude-cli',
      crashClass: 'oom_killed',
      stderr: 'Error: heap out of memory',
      recentLogs: 'log line 1\nlog line 2\nlog line 3',
    });

    await vi.waitFor(() => {
      expect(vi.mocked(sendTracked)).toHaveBeenCalledOnce();
    });

    const [, , message] = vi.mocked(sendTracked).mock.calls[0]!;
    // signal truthy branch (formatHealReport line 383)
    expect(message).toContain('Signal: SIGTERM');
    // recentLogs truthy branch (formatHealReport line 387)
    expect(message).toContain('Recent logs:');
    expect(message).toContain('log line 3');
  });
});
