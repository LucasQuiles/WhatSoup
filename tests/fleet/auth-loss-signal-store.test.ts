import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Database, CURRENT_SCHEMA_MIGRATION } from '../../src/core/database.ts';
import { AuthLossSignalStore } from '../../src/fleet/auth-loss-signal-store.ts';

describe('AuthLossSignalStore', () => {
  let db: Database;
  let store: AuthLossSignalStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
    store = new AuthLossSignalStore(db.raw);
  });

  afterEach(() => {
    db.close();
  });

  it('migration creates the append-only auth_loss_signal table and version record', () => {
    const version = db.raw
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number };
    expect(version.version).toBe(CURRENT_SCHEMA_MIGRATION);

    const table = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_loss_signal'")
      .get();
    expect(table).toBeDefined();

    const columns = db.raw
      .prepare("PRAGMA table_info('auth_loss_signal')")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'instance',
      'host',
      'classifier',
      'reason',
      'confidence',
      'observed_at',
      'resolved_at',
      'resolved_reason',
      'created_at',
    ]);
  });

  it('records one row for a continuously flapping logged-out session', () => {
    const sample = {
      instance: 'ad-bot',
      host: 'mini10',
      classifier: 'logged_out' as const,
      reason: 'explicit_auth_loss' as const,
      confidence: 'confirmed' as const,
      observedAt: '2026-06-30T05:30:00.000Z',
    };

    const results = Array.from({ length: 8 }, () => store.record(sample));

    expect(results.filter((result) => result.inserted)).toHaveLength(1);
    expect(results.slice(1).every((result) => result.reason === 'duplicate_active_signal')).toBe(true);

    const rows = db.raw
      .prepare('SELECT instance, host, classifier, reason, confidence, observed_at FROM auth_loss_signal')
      .all();
    expect(rows).toEqual([
      {
        instance: 'ad-bot',
        host: 'mini10',
        classifier: 'logged_out',
        reason: 'explicit_auth_loss',
        confidence: 'confirmed',
        observed_at: '2026-06-30T05:30:00.000Z',
      },
    ]);
  });

  it('counts a later same-classifier outage after a stable authenticated recovery', () => {
    const first = store.record({
      instance: 'ad-bot',
      host: 'mini10',
      classifier: 'logged_out',
      reason: 'explicit_auth_loss',
      confidence: 'confirmed',
      observedAt: '2026-06-30T05:30:00.000Z',
    });

    const recovery = store.resolve({
      instance: 'ad-bot',
      classifier: 'logged_out',
      reason: 'stable_authenticated_open',
      resolvedAt: '2026-06-30T05:45:00.000Z',
    });

    const second = store.record({
      instance: 'ad-bot',
      host: 'mini10',
      classifier: 'logged_out',
      reason: 'explicit_auth_loss',
      confidence: 'confirmed',
      observedAt: '2026-06-30T06:15:00.000Z',
    });

    expect(first.inserted).toBe(true);
    expect(recovery.resolved).toBe(true);
    expect(second.inserted).toBe(true);

    const rows = db.raw
      .prepare('SELECT classifier, observed_at, resolved_at, resolved_reason FROM auth_loss_signal ORDER BY id')
      .all();
    expect(rows).toEqual([
      {
        classifier: 'logged_out',
        observed_at: '2026-06-30T05:30:00.000Z',
        resolved_at: '2026-06-30T05:45:00.000Z',
        resolved_reason: 'stable_authenticated_open',
      },
      {
        classifier: 'logged_out',
        observed_at: '2026-06-30T06:15:00.000Z',
        resolved_at: null,
        resolved_reason: null,
      },
    ]);
  });

  it('rejects raw, non-enum classifier and reason values before persistence', () => {
    expect(() => store.record({
      instance: 'ad-bot',
      host: 'mini10',
      classifier: 'loggedOut from REDACTED_JID',
      reason: 'device_removed at REDACTED_AUTH_PATH',
      confidence: 'confirmed',
      observedAt: '2026-06-30T05:30:00.000Z',
    } as never)).toThrow(/unsupported auth-loss classifier/i);

    const count = db.raw
      .prepare('SELECT COUNT(*) AS count FROM auth_loss_signal')
      .get() as { count: number };
    expect(count.count).toBe(0);
  });
});
