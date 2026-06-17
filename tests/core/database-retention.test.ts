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
      });
      const emptyResult = {
        inboundEvents: 0,
        outboundOps: 0,
        toolCalls: 0,
        factExportQueue: 0,
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
