import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  DEFAULT_DATABASE_RETENTION,
  DatabaseRetentionTimer,
  runDatabaseRetention,
} from '../../src/core/database-retention.ts';

describe('database retention', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.open();
  });

  afterEach(() => {
    db.close();
  });

  it('deletes old terminal durability rows and exported facts', () => {
    db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status, completed_at)
      VALUES ('old-in', 'c1', 'chat@g.us', 'complete', datetime('now', '-40 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status, completed_at)
      VALUES ('young-in', 'c1', 'chat@g.us', 'complete', datetime('now', '-5 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO outbound_ops (conversation_key, chat_jid, op_type, payload, status, created_at)
      VALUES ('old-out', 'chat@g.us', 'send_message', '{}', 'echoed', datetime('now', '-40 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO outbound_ops (conversation_key, chat_jid, op_type, payload, status, created_at)
      VALUES ('young-out', 'chat@g.us', 'send_message', '{}', 'echoed', datetime('now', '-5 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO tool_calls (conversation_key, tool_name, tool_input, status, replay_policy, completed_at)
      VALUES ('old-tool', 'search_messages', '{}', 'complete', 'safe', datetime('now', '-40 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO tool_calls (conversation_key, tool_name, tool_input, status, replay_policy, completed_at)
      VALUES ('young-tool', 'search_messages', '{}', 'complete', 'safe', datetime('now', '-5 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO fact_export_queue (fact_id, chat_jid, payload_json, status, created_at, exported_at)
      VALUES ('fact-old', 'chat@g.us', '{}', 'exported', datetime('now', '-45 days'), datetime('now', '-40 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO fact_export_queue (fact_id, chat_jid, payload_json, status, created_at, exported_at)
      VALUES ('fact-young', 'chat@g.us', '{}', 'exported', datetime('now', '-6 days'), datetime('now', '-5 days'))
    `).run();

    const result = runDatabaseRetention(db, {
      ...DEFAULT_DATABASE_RETENTION,
      terminalDurabilityDays: 30,
      exportedFactDays: 30,
    });

    expect(result).toEqual({
      inboundEvents: 1,
      outboundOps: 1,
      toolCalls: 1,
      factExportQueue: 1,
      metricsHourly: 0,
      decryptionFailures: 0,
    });
    expect(rowCount('inbound_events')).toBe(1);
    expect(rowCount('outbound_ops')).toBe(1);
    expect(rowCount('tool_calls')).toBe(1);
    expect(rowCount('fact_export_queue')).toBe(1);
    expect(columnValues('inbound_events', 'message_id')).toEqual(['young-in']);
    expect(columnValues('outbound_ops', 'conversation_key')).toEqual(['young-out']);
    expect(columnValues('tool_calls', 'conversation_key')).toEqual(['young-tool']);
    expect(columnValues('fact_export_queue', 'fact_id')).toEqual(['fact-young']);
  });

  it('prunes metrics_hourly buckets older than the retention window, preserving recent ones (#1108)', () => {
    // metrics-collector writes bucket = start.toISOString(); reproduce that format.
    const isoAgo = (mod: string): string =>
      (db.raw.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now', ?) AS b`).get(mod) as { b: string }).b;
    const oldBucket = isoAgo('-200 days'); // beyond the 180d window → pruned
    const insideBucket = isoAgo('-179 days'); // just inside the window → kept (no read-floor regression)
    const recentBucket = isoAgo('-5 days'); // within the 30d reader range → kept
    const insert = db.raw.prepare(
      `INSERT INTO metrics_hourly (bucket, metric, value) VALUES (?, 'messages_in', ?)`,
    );
    insert.run(oldBucket, 5);
    insert.run(insideBucket, 7);
    insert.run(recentBucket, 3);

    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    expect(result.metricsHourly).toBe(1);
    expect(rowCount('metrics_hourly')).toBe(2);
    expect(columnValues('metrics_hourly', 'bucket').sort()).toEqual(
      [insideBucket, recentBucket].sort(),
    );
  });

  it('QR-066: prunes stale decryption_failures by last_seen_at, preserving a still-recurring one', () => {
    // Stale (no activity in 40 days) — must be reaped.
    db.raw.prepare(`
      INSERT INTO decryption_failures (message_id, chat_jid, conversation_key, sender_jid, error_message, raw_key, last_seen_at)
      VALUES ('old-df', 'chat@g.us', 'c1', 's1@s.whatsapp.net', 'err', '{}', datetime('now', '-40 days'))
    `).run();
    // Still recurring (seen recently) — must be preserved even though created long ago.
    db.raw.prepare(`
      INSERT INTO decryption_failures (message_id, chat_jid, conversation_key, sender_jid, error_message, raw_key, created_at, last_seen_at)
      VALUES ('hot-df', 'chat@g.us', 'c1', 's1@s.whatsapp.net', 'err', '{}', datetime('now', '-90 days'), datetime('now', '-1 days'))
    `).run();

    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    expect(result.decryptionFailures).toBe(1);
    expect(rowCount('decryption_failures')).toBe(1);
    expect(columnValues('decryption_failures', 'message_id')).toEqual(['hot-df']);
  });

  it('prunes a malformed/unparseable bucket rather than leaking it forever (#1108 hardening)', () => {
    // datetime('not-a-date') → NULL, and `NULL < cutoff` is falsy, so a junk
    // bucket would otherwise NEVER be pruned — the exact unbounded-growth leak
    // the retention prevents, inverted for bad data. Junk buckets are unreadable
    // (the dashboard reader compares ISO strings), so pruning them is correct.
    const isoAgo = (mod: string): string =>
      (db.raw.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now', ?) AS b`).get(mod) as { b: string }).b;
    const insert = db.raw.prepare(
      `INSERT INTO metrics_hourly (bucket, metric, value) VALUES (?, 'messages_in', ?)`,
    );
    insert.run('not-a-date', 1); // malformed → must be pruned, not leaked
    insert.run('', 2); // empty-string bucket → also unparseable
    insert.run(isoAgo('-5 days'), 3); // valid recent → kept

    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    expect(result.metricsHourly).toBe(2);
    expect(rowCount('metrics_hourly')).toBe(1);
    expect(columnValues('metrics_hourly', 'value')).toEqual([3]);
  });

  it('keeps a bucket exactly at the retention boundary (strict <) (#1108 hardening)', () => {
    const exactCutoff = (db.raw
      .prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now', '-180 days') AS b`)
      .get() as { b: string }).b;
    db.raw.prepare(
      `INSERT INTO metrics_hourly (bucket, metric, value) VALUES (?, 'messages_in', 9)`,
    ).run(exactCutoff);

    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    // `datetime(bucket) < datetime('now','-180 days')` is false at exact equality → kept.
    expect(result.metricsHourly).toBe(0);
    expect(rowCount('metrics_hourly')).toBe(1);
  });

  it('preserves recoverable and unexported rows regardless of age', () => {
    db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status, received_at)
      VALUES ('pending-in', 'c1', 'chat@g.us', 'processing', datetime('now', '-60 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status, received_at)
      VALUES ('turn-done-in', 'c1', 'chat@g.us', 'turn_done', datetime('now', '-60 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO outbound_ops (conversation_key, chat_jid, op_type, payload, status, created_at)
      VALUES ('c1', 'chat@g.us', 'send_message', '{}', 'submitted', datetime('now', '-60 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO outbound_ops (conversation_key, chat_jid, op_type, payload, status, created_at)
      VALUES ('c1', 'chat@g.us', 'send_message', '{}', 'maybe_sent', datetime('now', '-60 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO tool_calls (conversation_key, tool_name, tool_input, status, replay_policy, created_at)
      VALUES ('c1', 'send_message', '{}', 'pending', 'unsafe', datetime('now', '-60 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO tool_calls (conversation_key, tool_name, tool_input, status, replay_policy, created_at)
      VALUES ('c1', 'send_message', '{}', 'executing', 'unsafe', datetime('now', '-60 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO fact_export_queue (fact_id, chat_jid, payload_json, status, created_at)
      VALUES ('fact-pending', 'chat@g.us', '{}', 'pending', datetime('now', '-60 days'))
    `).run();

    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    expect(result).toEqual({
      inboundEvents: 0,
      outboundOps: 0,
      toolCalls: 0,
      factExportQueue: 0,
      metricsHourly: 0,
      decryptionFailures: 0,
    });
    expect(rowCount('inbound_events')).toBe(2);
    expect(rowCount('outbound_ops')).toBe(2);
    expect(rowCount('tool_calls')).toBe(2);
    expect(rowCount('fact_export_queue')).toBe(1);
    expect(columnValues('inbound_events', 'message_id')).toEqual(['pending-in', 'turn-done-in']);
    expect(columnValues('outbound_ops', 'status')).toEqual(['maybe_sent', 'submitted']);
    expect(columnValues('tool_calls', 'status')).toEqual(['executing', 'pending']);
    expect(columnValues('fact_export_queue', 'fact_id')).toEqual(['fact-pending']);
  });

  it('timer runs immediate and periodic cleanup, then stops idempotently', async () => {
    vi.useFakeTimers();
    try {
      const timer = new DatabaseRetentionTimer(db, {
        intervalMs: 1_000,
        terminalDurabilityDays: 30,
        exportedFactDays: 30,
        metricsHourlyDays: 180,
      });

      insertOldCompleteInbound('immediate-in');
      timer.start();
      timer.start();
      await Promise.resolve();
      expect(rowCount('inbound_events')).toBe(0);

      insertOldCompleteInbound('periodic-in');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(rowCount('inbound_events')).toBe(0);

      insertOldCompleteInbound('stopped-in');
      timer.stop();
      timer.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(rowCount('inbound_events')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('timer handles immediate and periodic cleanup failures and keeps scheduling', async () => {
    vi.useFakeTimers();
    try {
      const timer = new DatabaseRetentionTimer(db, {
        intervalMs: 1_000,
        terminalDurabilityDays: 30,
        exportedFactDays: 30,
        metricsHourlyDays: 180,
      });
      const emptyResult = {
        inboundEvents: 0,
        outboundOps: 0,
        toolCalls: 0,
        factExportQueue: 0,
        metricsHourly: 0,
      };
      const runSpy = vi.spyOn(timer, 'runCleanup')
        .mockRejectedValueOnce(new Error('immediate-retention-failed'))
        .mockRejectedValueOnce(new Error('periodic-retention-failed'))
        .mockResolvedValueOnce(emptyResult);

      timer.start();
      await Promise.resolve();
      expect(runSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      expect(runSpy).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      expect(runSpy).toHaveBeenCalledTimes(3);

      timer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  function rowCount(tableName: string): number {
    const row = db.raw.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
    return row.count;
  }

  function columnValues(tableName: string, columnName: string): string[] {
    const rows = db.raw.prepare(`
      SELECT ${columnName} AS value
        FROM ${tableName}
       ORDER BY ${columnName}
    `).all() as Array<{ value: string }>;
    return rows.map((row) => row.value);
  }

  function insertOldCompleteInbound(messageId: string): void {
    db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status, completed_at)
      VALUES (?, 'c1', 'chat@g.us', 'complete', datetime('now', '-40 days'))
    `).run(messageId);
  }
});
