/**
 * Tests for src/core/heal.ts — circuit breaker state machine and heal report management.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// heal.ts's own logger ('heal') is a stable shared instance so the latch tests
// can assert the per-report warn keeps firing while the alert is suppressed.
// Every other component keeps a fresh throwaway logger per call — otherwise
// unrelated warn/info calls (e.g. database.ts) would pollute mockHealLogger.
const mockHealLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: (component: string) =>
    component === 'heal'
      ? mockHealLogger
      : { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
import type { AutomaticHealReportInput } from '../../src/core/heal-evidence.ts';
import {
  emitHealReport,
  handleHealComplete,
  handleHealEscalate,
  getActiveReportForClass,
  getControlPeerWiring,
  dequeueNextReport,
  reconcileStaleHealReports,
  resetDeliveryUnavailableLatch,
  getGlobalValveCount,
  GLOBAL_VALVE_LIMIT,
  parseHealContext,
  checkDegradationSignals,
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

const distinctCrashClasses = [
  'provider_usage_limit',
  'provider_rate_limit',
  'provider_server_error',
  'provider_timeout',
  'provider_network_error',
  'provider_auth_required',
  'provider_binary_missing',
  'provider_permission_denied',
] as const;

function distinctCrash(index: number) {
  return { type: 'crash' as const, crashClass: distinctCrashClasses[index]! };
}

function unsafeReporterInput(value: Record<string, unknown>): AutomaticHealReportInput {
  return value as unknown as AutomaticHealReportInput;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The delivery-unavailable latch is per-process module state — re-arm it so
  // no-peer tests are order-independent.
  resetDeliveryUnavailableLatch();
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
      termination: 'exit_or_signal',
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
      crashClass: 'provider_unknown',
    });

    expect(first).not.toBeNull();

    // Same error hint → same error class → should suppress
    const second = emitHealReport(db, messenger, null, {
      type: 'crash',
      crashClass: 'provider_unknown',
    });

    expect(second).toBeNull();

    // Only one row in DB
    const count = (db.raw.prepare('SELECT COUNT(*) as cnt FROM heal_reports').get() as { cnt: number }).cnt;
    expect(count).toBe(1);

    // #1754 regression: the two identical crashes must coalesce into ONE incident
    // with attempt_count=2 — not silently no-op the duplicate occurrence.
    const row = db.raw.prepare('SELECT attempt_count FROM heal_reports WHERE report_id = ?').get(first) as { attempt_count: number };
    expect(row.attempt_count).toBe(2);
  });

  // 2b. #1754 dedup key drift: unclassified crash-class fallback must be stable,
  // mirroring the fixed-first-line pattern already used for type='degraded'.
  it('coalesces repeated unclassified/signal-less crashes into one incident instead of drifting on raw stderr', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    // A bounded termination category stays stable even when the runtime has no
    // registered crash class.
    const first = emitHealReport(db, messenger, null, {
      type: 'crash',
      termination: 'exit_or_signal',
    });
    expect(first).not.toBeNull();

    const second = emitHealReport(db, messenger, null, {
      type: 'crash',
      termination: 'exit_or_signal',
    });
    expect(second).toBeNull();

    const count = (db.raw.prepare('SELECT COUNT(*) as cnt FROM heal_reports').get() as { cnt: number }).cnt;
    expect(count).toBe(1);
  });

  it('coalesces an active pre-V1 row when its persisted class is already bounded', () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const canary = 'HEAL_LEGACY_ACTIVE_CONTEXT_CANARY_DO_NOT_LEAK';
    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, context)
      VALUES ('legacy-active', 'crash__provider_auth_required', 'crash', 'attempt_1', 1, ?)
    `).run(JSON.stringify({ stderr: canary }));

    const reportId = emitHealReport(db, messenger, null, {
      type: 'crash',
      crashClass: 'provider_auth_required',
    });

    expect(reportId).toBeNull();
    const row = db.raw.prepare('SELECT attempt_count FROM heal_reports WHERE report_id = ?').get('legacy-active') as { attempt_count: number };
    expect(row.attempt_count).toBe(2);
    expect(JSON.stringify(mockHealLogger.debug.mock.calls)).not.toContain(canary);
  });

  // 3. emitHealReport queues when activeControlReportId is set
  it('creates report with state=queued when activeControlReportId is provided', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    const reportId = emitHealReport(
      db,
      messenger,
      null,
      { type: 'degraded' },
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
    });

    await vi.waitFor(() => {
      expect(vi.mocked(sendTracked)).toHaveBeenCalledOnce();
    });
    const [, targetJid, message] = vi.mocked(sendTracked).mock.calls[0]!;
    expect(targetJid).toBe('15559998888@s.whatsapp.net');
    expect(message).toMatch(/^\[LOOPS_HEAL\]/);
  });

  it('persists and transmits only the projected provider classification', async () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const canary = 'HEAL_REPORT_CANARY_DO_NOT_LEAK';

    const reportId = emitHealReport(db, messenger, null, unsafeReporterInput({
      type: 'crash',
      chatJid: `chat-${canary}`,
      exitCode: 1,
      signal: canary,
      provider: canary,
      crashClass: 'provider_auth_required',
      stderr: canary,
      recentLogs: canary,
    }));

    expect(reportId).not.toBeNull();
    const row = db.raw.prepare('SELECT error_class, origin_chat_jid, context FROM heal_reports WHERE report_id = ?').get(reportId) as { error_class: string; origin_chat_jid: string | null; context: string } | undefined;
    expect(row?.error_class).toBe('crash__provider_auth_required');
    expect(row?.origin_chat_jid).toBeNull();
    expect(row?.context).not.toContain(canary);
    expect(JSON.parse(row?.context ?? '{}')).toMatchObject({
      schemaVersion: 1,
      source: 'automatic_crash_reporter',
      cause: 'provider_auth_required',
      action: 'reauthenticate_provider',
    });

    await vi.waitFor(() => {
      expect(vi.mocked(sendTracked)).toHaveBeenCalledOnce();
    });
    const [, , message] = vi.mocked(sendTracked).mock.calls[0]!;
    const payload = JSON.parse(String(message).split('\n')[0]!.replace('[LOOPS_HEAL] ', '')) as Record<string, unknown>;
    expect(payload).toMatchObject({
      errorClass: 'crash__provider_auth_required',
      evidence: {
        schemaVersion: 1,
        source: 'automatic_crash_reporter',
        cause: 'provider_auth_required',
        action: 'reauthenticate_provider',
      },
    });
    expect(message).toContain('Cause: provider_auth_required');
    expect(message).not.toContain(canary);
    expect(JSON.stringify(mockHealLogger.info.mock.calls)).not.toContain(canary);
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
      VALUES ('stale-report', 'crash__provider_auth_required', 'crash', 'escalated', 1, '2026-06-13T00:00:00.000Z')
    `).run();

    const result = reconcileStaleHealReports(db, {
      now: new Date('2026-06-13T01:00:00.000Z'),
      staleMs: 30 * 60 * 1000,
    });

    expect(result.expiredReportIds).toEqual(['stale-report']);
    expect(getActiveReportForClass(db, 'crash__provider_auth_required')).toBeNull();

    const next = emitHealReport(db, messenger, null, {
      type: 'crash',
      crashClass: 'provider_auth_required',
    });

    expect(next).not.toBeNull();
    const rows = db.raw.prepare(`
      SELECT report_id, state FROM heal_reports WHERE error_class = 'crash__provider_auth_required'
    `).all() as Array<{ report_id: string; state: string }>;
    expect(rows).toEqual(expect.arrayContaining([
      { report_id: 'stale-report', state: 'stale_expired' },
      { report_id: next, state: 'attempt_1' },
    ]));
  });

  it('does not stamp resolved_at on stale-expired rows — resolution requires a positive HEAL_COMPLETE signal, not a 30m timer race (#1754)', () => {
    const db = makeDb();

    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, created_at)
      VALUES ('stale-unresolved', 'crash__unresolved', 'crash', 'attempt_1', 1, '2026-06-13T00:00:00.000Z')
    `).run();

    reconcileStaleHealReports(db, {
      now: new Date('2026-06-13T01:00:00.000Z'),
      staleMs: 30 * 60 * 1000,
    });

    const row = db.raw.prepare(`
      SELECT state, resolved_at FROM heal_reports WHERE report_id = 'stale-unresolved'
    `).get() as { state: string; resolved_at: string | null };
    expect(row).toEqual({ state: 'stale_expired', resolved_at: null });
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
      VALUES ('stale-suppressor', 'crash__provider_timeout', 'crash', 'escalated', 1, '2000-01-01T00:00:00.000Z')
    `).run();

    const reportId = emitHealReport(db, messenger, null, {
      type: 'crash',
      crashClass: 'provider_timeout',
    });

    expect(reportId).not.toBeNull();
    const stale = db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get('stale-suppressor') as { state: string };
    expect(stale.state).toBe('stale_expired');
    expect(getActiveReportForClass(db, 'crash__provider_timeout')?.report_id).toBe(reportId);
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

  it('does not return or log a legacy queued error class', () => {
    const db = makeDb();
    const canary = 'HEAL_LEGACY_QUEUED_CLASS_CANARY_DO_NOT_LEAK';
    db.raw.prepare(`
      INSERT INTO heal_reports (report_id, error_class, error_type, state, attempt_count, context)
      VALUES (?, ?, 'crash', 'queued', 1, ?)
    `).run(
      'legacy-queued',
      `crash__${canary}`,
      JSON.stringify({ stderr: canary }),
    );

    const dequeued = dequeueNextReport(db);

    expect(dequeued?.error_class).toBe('service_crash__legacy_unclassified');
    expect(JSON.stringify(mockHealLogger.info.mock.calls)).not.toContain(canary);
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
      const id = emitHealReport(db, messenger, null, distinctCrash(i));
      expect(id).not.toBeNull();
    }

    vi.mocked(sendTracked).mockClear();

    const sixth = emitHealReport(db, messenger, null, distinctCrash(5));

    expect(sixth).toBeNull();
    expect(vi.mocked(sendTracked)).not.toHaveBeenCalled();
    expect(vi.mocked(emitAlert)).toHaveBeenCalledOnce();
    expect(vi.mocked(emitAlert)).toHaveBeenCalledWith(
      'WhatSoup',
      'heal_repeated_failures',
      expect.stringContaining('heal valve'),
      expect.stringContaining('cause=provider_auth_required'),
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
  const legacyProjection = {
    schemaVersion: 1,
    type: 'service_crash',
    source: 'legacy_unclassified',
    cause: 'legacy_unclassified',
    stage: 'unknown',
    impact: 'unknown',
    evidenceCoverage: 'legacy_context_rejected',
    counts: { occurrences: 1 },
    action: 'investigate_legacy_report',
    correlation: 'heal:v1:legacy_unclassified',
  };

  it('returns a bounded legacy envelope for corrupt JSON instead of throwing', () => {
    expect(parseHealContext('{not json')).toEqual(legacyProjection);
  });

  it('returns a bounded legacy envelope for null and empty context', () => {
    expect(parseHealContext(null)).toEqual(legacyProjection);
    expect(parseHealContext('')).toEqual(legacyProjection);
  });

  it('returns a bounded legacy envelope for non-V1 JSON', () => {
    expect(parseHealContext('[1,2]')).toEqual(legacyProjection);
    expect(parseHealContext('"a string"')).toEqual(legacyProjection);
    expect(parseHealContext('42')).toEqual(legacyProjection);
    expect(parseHealContext('null')).toEqual(legacyProjection);
    expect(parseHealContext('{"chatJid":"HEAL_CONTEXT_CANARY"}')).toEqual(legacyProjection);
  });

  it('returns a valid stored V1 envelope unchanged', () => {
    const evidence = {
      schemaVersion: 1,
      type: 'crash',
      source: 'automatic_crash_reporter',
      cause: 'provider_auth_required',
      stage: 'provider_session',
      impact: 'single_session',
      evidenceCoverage: 'crash_classified',
      counts: { occurrences: 1 },
      action: 'reauthenticate_provider',
      correlation: 'heal:v1:crash:provider_auth_required',
    };
    expect(parseHealContext(JSON.stringify(evidence))).toEqual(evidence);
  });
});

// ---------------------------------------------------------------------------
// heal.ts uncovered-branch coverage
// ---------------------------------------------------------------------------

describe('heal.ts uncovered-branch coverage', () => {
  it('uses the bounded degradation error class without persisting a chat identity', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    const reportId = emitHealReport(db, messenger, null, unsafeReporterInput({
      type: 'degraded',
      chatJid: 'HEAL_DEGRADATION_CANARY_DO_NOT_LEAK',
    }));

    expect(reportId).not.toBeNull();
    const row = db.raw.prepare('SELECT error_class, origin_chat_jid, context FROM heal_reports WHERE report_id = ?').get(reportId) as { error_class: string; origin_chat_jid: string | null; context: string };
    expect(row.error_class).toBe('degraded__decryption_failure_threshold');
    expect(row.origin_chat_jid).toBeNull();
    expect(row.context).not.toContain('HEAL_DEGRADATION_CANARY_DO_NOT_LEAK');
  });

  it('emits a closed V1 valve alert even when the source input is content-bearing', async () => {
    const db = makeDb();
    const messenger = makeMessenger();

    const canary = 'HEAL_VALVE_CANARY_DO_NOT_LEAK';
    for (let i = 0; i < 5; i++) {
      emitHealReport(db, messenger, null, distinctCrash(i));
    }

    vi.mocked(emitAlert).mockClear();
    vi.mocked(sendTracked).mockClear();

    const tripped = emitHealReport(db, messenger, null, unsafeReporterInput({
      type: 'service_crash',
      chatJid: canary,
      exitCode: 137,
      signal: canary,
      provider: canary,
      crashClass: 'provider_auth_required',
      stderr: canary,
      recentLogs: canary,
    }));

    // Valve suppresses the report (no DB row, no send)
    expect(tripped).toBeNull();
    expect(vi.mocked(sendTracked)).not.toHaveBeenCalled();

    expect(vi.mocked(emitAlert)).toHaveBeenCalledOnce();
    const detailArg = vi.mocked(emitAlert).mock.calls[0]![3] as string;
    expect(detailArg).toMatch(/schema_version=1/);
    expect(detailArg).toMatch(/cause=service_crash/);
    expect(detailArg).toMatch(/action=investigate_service/);
    expect(detailArg).not.toContain(canary);
  });

  it('keeps V1 valve evidence bounded when crash diagnostics are absent', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    for (let i = 0; i < 5; i++) {
      emitHealReport(db, messenger, null, distinctCrash(i));
    }

    vi.mocked(emitAlert).mockClear();
    vi.mocked(sendTracked).mockClear();

    const tripped = emitHealReport(db, messenger, null, unsafeReporterInput({
      type: 'service_crash',
      recentLogs: 'HEAL_ABSENT_DIAGNOSTIC_CANARY_DO_NOT_LEAK',
    }));

    expect(tripped).toBeNull();
    expect(vi.mocked(sendTracked)).not.toHaveBeenCalled();
    expect(vi.mocked(emitAlert)).toHaveBeenCalledOnce();
    const detailArg = vi.mocked(emitAlert).mock.calls[0]![3];
    expect(detailArg).not.toMatch(/stderr=/);
    expect(detailArg).toMatch(/cause=service_crash/);
    expect(detailArg).not.toContain('HEAL_ABSENT_DIAGNOSTIC_CANARY_DO_NOT_LEAK');
  });

  it('routes the report through the BOT ERRORS fallback sink when no Q control peer is configured (#1754)', () => {
    const db = makeDb();
    const messenger = makeMessenger();
    const canary = 'HEAL_NO_PEER_CANARY_DO_NOT_LEAK';

    // Mutate the shared config mock to remove the Q peer, then restore it.
    config.controlPeers.delete('q');
    try {
      const reportId = emitHealReport(db, messenger, null, unsafeReporterInput({
        type: 'crash',
        chatJid: canary,
        provider: canary,
        crashClass: 'provider_auth_required',
        stderr: canary,
        recentLogs: canary,
      }));

      // Report is still created with state='attempt_1' but no direct send happens.
      expect(reportId).not.toBeNull();
      const row = db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get(reportId) as { state: string };
      expect(row.state).toBe('attempt_1');
      expect(vi.mocked(sendTracked)).not.toHaveBeenCalled();

      // Telemetry delivery must be guaranteed-or-alerted, never warn-and-drop: the
      // report must still reach BOT ERRORS via the durable-outbox fallback.
      expect(vi.mocked(emitAlert)).toHaveBeenCalledOnce();
      const [instance, source, summary] = vi.mocked(emitAlert).mock.calls[0]!;
      expect(instance).toBe(config.botName);
      expect(source).not.toBe('heal_repeated_failures'); // distinct from the valve alert
      expect(summary).toContain(reportId);
      const evidence = vi.mocked(emitAlert).mock.calls[0]![3] as string;
      expect(evidence).toContain('cause=provider_auth_required');
      expect(evidence).not.toContain(canary);
    } finally {
      config.controlPeers.set('q', '15559998888');
    }
  });

  it('does not promise an automatic retry/cooldown that never actually happens (#1754)', async () => {
    const db = makeDb();
    const messenger = makeMessenger();

    emitHealReport(db, messenger, null, {
      type: 'crash',
      crashClass: 'provider_unknown',
    });

    await vi.waitFor(() => {
      expect(vi.mocked(sendTracked)).toHaveBeenCalledOnce();
    });

    const [, , message] = vi.mocked(sendTracked).mock.calls[0]!;
    // No writer ever sets cooldown_until or advances state on a timed retry —
    // the message must not claim a "5m cooldown" / "attempt N of 2" mechanism
    // that does not exist.
    expect(message).not.toMatch(/cooldown/i);
    expect(message).not.toMatch(/\battempt \d+ of \d+\b/i);
  });

  it('uses the safe V1 summary when source crash diagnostics are present', async () => {
    const db = makeDb();
    const messenger = makeMessenger();

    emitHealReport(db, messenger, null, unsafeReporterInput({
      type: 'crash',
      chatJid: 'HEAL_HUMAN_SUMMARY_CANARY_DO_NOT_LEAK',
      exitCode: 1,
      signal: 'HEAL_HUMAN_SUMMARY_CANARY_DO_NOT_LEAK',
      provider: 'HEAL_HUMAN_SUMMARY_CANARY_DO_NOT_LEAK',
      crashClass: 'provider_auth_required',
      stderr: 'HEAL_HUMAN_SUMMARY_CANARY_DO_NOT_LEAK',
      recentLogs: 'HEAL_HUMAN_SUMMARY_CANARY_DO_NOT_LEAK',
    }));

    await vi.waitFor(() => {
      expect(vi.mocked(sendTracked)).toHaveBeenCalledOnce();
    });

    const [, , message] = vi.mocked(sendTracked).mock.calls[0]!;
    expect(message).toContain('Cause: provider_auth_required');
    expect(message).toContain('Recommended action: reauthenticate_provider');
    expect(message).not.toContain('HEAL_HUMAN_SUMMARY_CANARY_DO_NOT_LEAK');
  });
});

// ---------------------------------------------------------------------------
// heal_delivery_unavailable latch — a missing Q control peer is persistent
// CONFIG STATE, not a per-report event: config.controlPeers is built once at
// module load, so once absent it stays absent for the process lifetime. The
// critical must fire ONCE per process; every report still gets its row and
// per-report warn (the #1754 guaranteed-or-alerted routing is unchanged).
// ---------------------------------------------------------------------------

describe('heal_delivery_unavailable latch', () => {
  beforeEach(() => {
    config.controlPeers.delete('q');
  });

  afterEach(() => {
    config.controlPeers.set('q', '15559998888');
  });

  it('emits the critical once across consecutive distinct-class no-peer reports, still creating and fallback-routing every report', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    const first = emitHealReport(db, messenger, null, distinctCrash(0));
    const second = emitHealReport(db, messenger, null, distinctCrash(1));

    // Both reports are still created and fallback-routed exactly as before —
    // only the alert spam latches.
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    for (const id of [first, second]) {
      const row = db.raw.prepare('SELECT state FROM heal_reports WHERE report_id = ?').get(id) as { state: string };
      expect(row.state).toBe('attempt_1');
    }
    expect(vi.mocked(sendTracked)).not.toHaveBeenCalled();

    // ONE critical for the config state, not one per report.
    expect(vi.mocked(emitAlert)).toHaveBeenCalledOnce();
    const [, source, summary] = vi.mocked(emitAlert).mock.calls[0]!;
    expect(source).toBe('heal_delivery_unavailable');
    expect(summary).toContain(first);
  });

  it('logs the per-report warn for every no-peer report, including latched ones', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    emitHealReport(db, messenger, null, distinctCrash(0));
    emitHealReport(db, messenger, null, distinctCrash(1));

    const warns = mockHealLogger.warn.mock.calls.filter(
      (call) => String(call[1]).includes('no Q control peer configured'),
    );
    expect(warns).toHaveLength(2);
  });

  it('points the first alert at the latch and the health counter field', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    emitHealReport(db, messenger, null, distinctCrash(0));

    expect(vi.mocked(emitAlert)).toHaveBeenCalledOnce();
    const evidence = vi.mocked(emitAlert).mock.calls[0]![3] as string;
    expect(evidence).toMatch(/latched/);
    expect(evidence).toMatch(/control_peer\.suppressed_unavailable_alerts/);
  });

  it('counts suppressed occurrences in the control-peer wiring state', () => {
    const db = makeDb();
    const messenger = makeMessenger();

    expect(getControlPeerWiring()).toEqual({ configured: false, suppressedUnavailableAlerts: 0 });

    // First no-peer report alerts; it is not itself "suppressed".
    emitHealReport(db, messenger, null, distinctCrash(0));
    expect(getControlPeerWiring()).toEqual({ configured: false, suppressedUnavailableAlerts: 0 });

    emitHealReport(db, messenger, null, distinctCrash(1));
    emitHealReport(db, messenger, null, distinctCrash(2));
    expect(getControlPeerWiring()).toEqual({ configured: false, suppressedUnavailableAlerts: 2 });
  });

  it('with a configured peer: no alert, no suppression counting, configured:true', () => {
    const db = makeDb();
    const messenger = makeMessenger();
    config.controlPeers.set('q', '15559998888');

    const reportId = emitHealReport(db, messenger, null, distinctCrash(0));

    expect(reportId).not.toBeNull();
    expect(vi.mocked(emitAlert)).not.toHaveBeenCalled();
    expect(getControlPeerWiring()).toEqual({ configured: true, suppressedUnavailableAlerts: 0 });
  });
});

// ---------------------------------------------------------------------------
// checkDegradationSignals — #1788: the query compared a Z-form (toISOString)
// cutoff against the space-form `decryption_failures.created_at` column with a
// raw TEXT `>`, so same-UTC-day rows sorted below the cutoff regardless of
// their actual time (byte 11 is ' ' 0x20 in the column vs 'T' 0x54 in the
// cutoff). The detector was therefore dead code except in the seconds after
// UTC midnight.
// ---------------------------------------------------------------------------

describe('checkDegradationSignals (#1788 timestamp compare)', () => {
  function insertFailure(db: Database, opts: {
    id: string;
    senderJid: string;
    createdAt: string;
    resolved?: 0 | 1;
  }): void {
    db.raw.prepare(`
      INSERT INTO decryption_failures
        (message_id, chat_jid, conversation_key, sender_jid, error_message, raw_key, resolved, created_at)
      VALUES (?, ?, ?, ?, 'MAC verification failed', 'raw-key-blob', ?, ?)
    `).run(opts.id, `${opts.senderJid}@s.whatsapp.net`, `${opts.senderJid}@s.whatsapp.net`, `${opts.senderJid}@s.whatsapp.net`, opts.resolved ?? 0, opts.createdAt);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires on same-UTC-day failures inside the 5-minute window (space-form vs toISOString cutoff)', () => {
    // "now" is mid-afternoon UTC, so the 5-minute cutoff built by
    // toISOString() shares the same YYYY-MM-DD date prefix as the space-form
    // rows below — exactly the byte-11 collision (' ' vs 'T') #1788 describes.
    vi.setSystemTime(new Date('2026-07-14T15:00:00.000Z'));
    const db = makeDb();
    const messenger = makeMessenger();

    // 5 failures from the same sender, 4 minutes ago (after the 5-minute
    // cutoff of 14:55:00, same UTC day) — must be selected.
    for (let i = 0; i < 5; i++) {
      insertFailure(db, {
        id: `same-day-${i}`,
        senderJid: '15551234000',
        createdAt: '2026-07-14 14:56:00',
      });
    }

    checkDegradationSignals(db, messenger, null, null);

    const reports = db.raw.prepare(`SELECT error_type FROM heal_reports WHERE error_type = 'degraded'`).all();
    // Pre-fix: raw TEXT `>` sorts '2026-07-14 14:56:00' below
    // '2026-07-14T14:55:00.000Z' (byte 11 ' ' < 'T'), so the query returns
    // zero rows and emitHealReport is never called. Post-fix: datetime()
    // normalizes both sides and the row is correctly newer than cutoff.
    expect(reports).toHaveLength(1);
  });

  it('does not fire on failures from a prior UTC day, confirming the datetime() wrap did not invert direction', () => {
    vi.setSystemTime(new Date('2026-07-14T15:00:00.000Z'));
    const db = makeDb();
    const messenger = makeMessenger();

    // 5 failures from yesterday — genuinely older than the 5-minute cutoff,
    // on a different calendar day. Must stay excluded both before and after
    // the fix; this guards against the datetime() wrap accidentally widening
    // the match instead of just correcting the same-day byte compare.
    for (let i = 0; i < 5; i++) {
      insertFailure(db, {
        id: `yesterday-${i}`,
        senderJid: '15559990000',
        createdAt: '2026-07-13 10:00:00',
      });
    }

    checkDegradationSignals(db, messenger, null, null);

    const reports = db.raw.prepare(`SELECT error_type FROM heal_reports WHERE error_type = 'degraded'`).all();
    expect(reports).toHaveLength(0);
  });

  it('does not fire on a same-day sender whose failures are all before the 5-minute cutoff', () => {
    vi.setSystemTime(new Date('2026-07-14T15:00:00.000Z'));
    const db = makeDb();
    const messenger = makeMessenger();

    // 6 minutes ago — same UTC day, but genuinely before the 14:55:00 cutoff.
    // Confirms the fix doesn't flip a should-exclude same-day row to included.
    for (let i = 0; i < 5; i++) {
      insertFailure(db, {
        id: `too-old-same-day-${i}`,
        senderJid: '15558880000',
        createdAt: '2026-07-14 14:54:00',
      });
    }

    checkDegradationSignals(db, messenger, null, null);

    const reports = db.raw.prepare(`SELECT error_type FROM heal_reports WHERE error_type = 'degraded'`).all();
    expect(reports).toHaveLength(0);
  });
});
