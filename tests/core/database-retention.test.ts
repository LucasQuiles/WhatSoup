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
      turnRecoveryJobs: 0,
      turnTerminalRecords: 0,
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
      turnRecoveryJobs: 0,
      turnTerminalRecords: 0,
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

  it('skips outstanding recovery proof without aborting unrelated bulk deletions', () => {
    const protectedChain = insertRecoveryChain('outstanding', 'pending', 40);
    insertOldCompleteInbound('unrelated-old-in');
    db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, created_at
      ) VALUES (
        'unrelated-old-out', 'chat@g.us', 'send_message', '{}', 'echoed',
        datetime('now', '-40 days')
      )
    `).run();

    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    expect(result).toMatchObject({
      turnRecoveryJobs: 0,
      turnTerminalRecords: 0,
      inboundEvents: 1,
      outboundOps: 1,
    });
    expect(rowExists('turn_recovery_jobs', protectedChain.jobId)).toBe(true);
    expect(rowExists('turn_terminal_records', protectedChain.terminalRecordId)).toBe(true);
    expect(rowExists('inbound_events', protectedChain.inboundSeq, 'seq')).toBe(true);
    expect(rowExists('outbound_ops', protectedChain.outboundOpId)).toBe(true);
    expect(columnValues('inbound_events', 'message_id')).toEqual(['outstanding-message']);
    expect(columnValues('outbound_ops', 'conversation_key')).toEqual(['outstanding-conversation']);
  });

  it('retains unresolved retry ownership and orphaned transfer obligations', () => {
    const retryInbound = Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, received_at, processing_status
      ) VALUES ('retention-open-retry', 'retention-open-retry', 'retry@g.us',
                datetime('now', '-40 days'), 'processing')
    `).run().lastInsertRowid);
    const retryTerminal = Number(db.raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind, attempt_failure_class,
        inbound_disposition, delivery_kind, delivery_op_id,
        recovery_owner_logical_turn_id, recovery_owner_manager_id,
        recovery_owner_generation, reply_guarantee_disarmed, created_at
      ) VALUES (
        'per_chat', 'retention-open-retry', 'retry@g.us', ?, ?,
        'retry-turn', 'retry-manager', 1, 'failed', 'transient-network',
        'unfinalized_retry_owned', 'none', NULL,
        NULL, NULL, NULL, 0, datetime('now', '-40 days')
      )
    `).run(retryInbound, retryInbound).lastInsertRowid);

    const transferInbound = Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, received_at, processing_status
      ) VALUES ('retention-orphan-transfer', 'retention-orphan-transfer',
                'transfer@g.us', datetime('now', '-40 days'), 'processing')
    `).run().lastInsertRowid);
    const transferOp = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, created_at,
        source_inbound_seq, replay_policy
      ) VALUES ('retention-orphan-transfer', 'transfer@g.us', 'send_message',
                '{}', 'pending', datetime('now', '-40 days'), ?, 'unsafe')
    `).run(transferInbound).lastInsertRowid);
    const transferTerminal = Number(db.raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind, attempt_failure_class,
        inbound_disposition, delivery_kind, delivery_op_id,
        recovery_owner_logical_turn_id, recovery_owner_manager_id,
        recovery_owner_generation, reply_guarantee_disarmed, created_at
      ) VALUES (
        'per_chat', 'retention-orphan-transfer', 'transfer@g.us', ?, ?,
        'transfer-turn', 'transfer-manager', 1, 'failed', 'transient-network',
        'transferred_to_recovery_owner', 'enqueued', ?,
        'recovery-turn', 'recovery-manager', 2, 0, datetime('now', '-40 days')
      )
    `).run(transferInbound, transferInbound, transferOp).lastInsertRowid);

    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    expect(result.turnTerminalRecords).toBe(0);
    expect(rowExists('turn_terminal_records', retryTerminal)).toBe(true);
    expect(rowExists('turn_terminal_records', transferTerminal)).toBe(true);
    expect(rowExists('inbound_events', retryInbound, 'seq')).toBe(true);
    expect(rowExists('inbound_events', transferInbound, 'seq')).toBe(true);
    expect(rowExists('outbound_ops', transferOp)).toBe(true);
  });

  it('prunes old completed recovery chains job then terminal then proof while retaining recent audit', () => {
    const old = insertRecoveryChain('old-completed', 'completed', 40);
    const recent = insertRecoveryChain('recent-completed', 'completed', 5, 40);
    db.raw.exec(`
      CREATE TABLE retention_delete_order (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL
      );
      CREATE TRIGGER retention_log_recovery_job
      AFTER DELETE ON turn_recovery_jobs
      BEGIN
        INSERT INTO retention_delete_order (kind) VALUES ('job');
      END;
      CREATE TRIGGER retention_log_terminal_record
      AFTER DELETE ON turn_terminal_records
      BEGIN
        INSERT INTO retention_delete_order (kind) VALUES ('terminal');
      END;
      CREATE TRIGGER retention_log_inbound
      AFTER DELETE ON inbound_events
      BEGIN
        INSERT INTO retention_delete_order (kind) VALUES ('inbound');
      END;
      CREATE TRIGGER retention_log_outbound
      AFTER DELETE ON outbound_ops
      BEGIN
        INSERT INTO retention_delete_order (kind) VALUES ('outbound');
      END;
    `);

    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    expect(result).toMatchObject({
      turnRecoveryJobs: 1,
      turnTerminalRecords: 1,
      inboundEvents: 1,
      outboundOps: 1,
    });
    for (const [table, id, idColumn] of [
      ['turn_recovery_jobs', old.jobId, 'id'],
      ['turn_terminal_records', old.terminalRecordId, 'id'],
      ['inbound_events', old.inboundSeq, 'seq'],
      ['outbound_ops', old.outboundOpId, 'id'],
    ] as const) {
      expect(rowExists(table, id, idColumn)).toBe(false);
    }
    for (const [table, id, idColumn] of [
      ['turn_recovery_jobs', recent.jobId, 'id'],
      ['turn_terminal_records', recent.terminalRecordId, 'id'],
      ['inbound_events', recent.inboundSeq, 'seq'],
      ['outbound_ops', recent.outboundOpId, 'id'],
    ] as const) {
      expect(rowExists(table, id, idColumn)).toBe(true);
    }
    const deletionOrder = db.raw.prepare(`
      SELECT kind
        FROM retention_delete_order
       ORDER BY seq
    `).all() as Array<{ kind: string }>;
    expect(deletionOrder.map((row) => row.kind)).toEqual([
      'job',
      'terminal',
      'inbound',
      'outbound',
    ]);
  });

  it('retains a completed recovery chain when its source terminal proof is corrupt', () => {
    const reopened = insertRecoveryChain('reopened-completed', 'completed', 40);
    const safelyTerminal = insertRecoveryChain('still-terminal-completed', 'completed', 40);
    db.raw.exec('DROP TRIGGER turn_recovery_completed_source_stays_terminal');
    db.raw.prepare(`
      UPDATE inbound_events
         SET processing_status = 'processing',
             completed_at = NULL,
             terminal_reason = NULL
       WHERE seq = ?
    `).run(reopened.inboundSeq);

    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    expect(result).toMatchObject({
      turnRecoveryJobs: 1,
      turnTerminalRecords: 1,
      inboundEvents: 1,
      outboundOps: 1,
    });
    for (const [table, id, idColumn] of [
      ['turn_recovery_jobs', reopened.jobId, 'id'],
      ['turn_terminal_records', reopened.terminalRecordId, 'id'],
      ['inbound_events', reopened.inboundSeq, 'seq'],
      ['outbound_ops', reopened.outboundOpId, 'id'],
    ] as const) {
      expect(rowExists(table, id, idColumn)).toBe(true);
    }
    for (const [table, id, idColumn] of [
      ['turn_recovery_jobs', safelyTerminal.jobId, 'id'],
      ['turn_terminal_records', safelyTerminal.terminalRecordId, 'id'],
      ['inbound_events', safelyTerminal.inboundSeq, 'seq'],
      ['outbound_ops', safelyTerminal.outboundOpId, 'id'],
    ] as const) {
      expect(rowExists(table, id, idColumn)).toBe(false);
    }
  });

  it('rolls back the full ordered cleanup when a terminal record cannot be pruned', () => {
    const chain = insertRecoveryChain('rollback', 'completed', 40);
    insertOldCompleteInbound('rollback-unrelated-in');
    db.raw.exec(`
      CREATE TRIGGER deny_retention_terminal_delete
      BEFORE DELETE ON turn_terminal_records
      WHEN OLD.id = ${chain.terminalRecordId}
      BEGIN
        SELECT RAISE(ABORT, 'terminal retention denied');
      END;
    `);

    expect(() => runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION))
      .toThrow('terminal retention denied');

    expect(rowExists('turn_recovery_jobs', chain.jobId)).toBe(true);
    expect(rowExists('turn_terminal_records', chain.terminalRecordId)).toBe(true);
    expect(rowExists('inbound_events', chain.inboundSeq, 'seq')).toBe(true);
    expect(rowExists('outbound_ops', chain.outboundOpId)).toBe(true);
    expect(columnValues('inbound_events', 'message_id')).toEqual([
      'rollback-message',
      'rollback-unrelated-in',
    ]);
  });

  it('timer runs immediate and periodic cleanup, then stops idempotently', async () => {
    vi.useFakeTimers();
    try {
      const timer = new DatabaseRetentionTimer(db, {
        intervalMs: 1_000,
        terminalDurabilityDays: 30,
        exportedFactDays: 30,
        metricsHourlyDays: 180,
        decryptionFailureDays: 30,
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
        decryptionFailureDays: 30,
      });
      const emptyResult = {
        turnRecoveryJobs: 0,
        turnTerminalRecords: 0,
        inboundEvents: 0,
        outboundOps: 0,
        toolCalls: 0,
        factExportQueue: 0,
        metricsHourly: 0,
        decryptionFailures: 0,
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

  function rowExists(tableName: string, id: number, idColumn = 'id'): boolean {
    return db.raw.prepare(
      `SELECT 1 FROM ${tableName} WHERE ${idColumn} = ?`,
    ).get(id) !== undefined;
  }

  function insertRecoveryChain(
    key: string,
    state: 'pending' | 'completed',
    jobAgeDays: number,
    proofAgeDays = jobAgeDays,
  ): {
    inboundSeq: number;
    outboundOpId: number;
    terminalRecordId: number;
    jobId: number;
  } {
    const jobTimestamp = timestampDaysAgo(jobAgeDays);
    const proofTimestamp = timestampDaysAgo(proofAgeDays);
    const conversationKey = `${key}-conversation`;
    const chatJid = `${key}@g.us`;
    const messageId = `${key}-message`;
    const inboundSeq = Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, received_at,
        processing_status, completed_at
      ) VALUES (?, ?, ?, ?, 'complete', ?)
    `).run(messageId, conversationKey, chatJid, proofTimestamp, proofTimestamp).lastInsertRowid);
    const outboundOpId = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, created_at,
        source_inbound_seq, is_terminal
      ) VALUES (?, ?, 'send_message', '{}', 'pending', ?, ?, 1)
    `).run(conversationKey, chatJid, proofTimestamp, inboundSeq).lastInsertRowid);
    const terminalRecordId = Number(db.raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid,
        inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation,
        attempt_kind, inbound_disposition, delivery_kind, delivery_op_id,
        recovery_owner_logical_turn_id, recovery_owner_manager_id,
        recovery_owner_generation, reply_guarantee_disarmed, created_at
      ) VALUES (
        'per_chat', ?, ?, ?, ?,
        ?, ?, 1,
        'failed', 'transferred_to_recovery_owner', 'enqueued', ?,
        ?, ?, 2, 0, ?
      )
    `).run(
      conversationKey,
      chatJid,
      inboundSeq,
      inboundSeq,
      `${key}-source-turn`,
      `${key}-source-manager`,
      outboundOpId,
      `${key}-owner-turn`,
      `${key}-owner-manager`,
      proofTimestamp,
    ).lastInsertRowid);
    const completed = state === 'completed';
    if (completed) {
      db.raw.prepare(`
        UPDATE outbound_ops
        SET status = 'echoed', echoed_at = ?
        WHERE id = ?
      `).run(proofTimestamp, outboundOpId);
    }
    const jobId = Number(db.raw.prepare(`
      INSERT INTO turn_recovery_jobs (
        terminal_record_id, scope, conversation_key, delivery_jid,
        source_inbound_seq, source_inbound_seq_key,
        source_logical_turn_id, source_manager_id, source_generation,
        source_message_id,
        owner_logical_turn_id, owner_manager_id, owner_generation,
        assigned_owner_logical_turn_id, assigned_owner_manager_id,
        assigned_owner_generation,
        replay_safe, sender_jid, replay_text, is_group,
        state, attempt_count, claim_epoch, claim_token,
        claim_expires_at, next_attempt_at, created_at, updated_at,
        claimed_at, completed_at, completion_kind, completion_proof_id
      ) VALUES (
        ?, 'per_chat', ?, ?,
        ?, ?, ?, ?, 1, ?,
        ?, ?, 2, ?, ?, 2,
        1, ?, ?, 0,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      terminalRecordId,
      conversationKey,
      chatJid,
      inboundSeq,
      inboundSeq,
      `${key}-source-turn`,
      `${key}-source-manager`,
      messageId,
      `${key}-owner-turn`,
      `${key}-owner-manager`,
      `${key}-owner-turn`,
      `${key}-owner-manager`,
      `${key}-sender@s.whatsapp.net`,
      `${key} replay payload`,
      state,
      completed ? 1 : 0,
      completed ? 1 : 0,
      completed ? `${key}-claim` : null,
      completed ? jobTimestamp : null,
      jobTimestamp,
      jobTimestamp,
      jobTimestamp,
      completed ? jobTimestamp : null,
      completed ? jobTimestamp : null,
      completed ? 'worker' : null,
      completed ? `${key}-completion-proof` : null,
    ).lastInsertRowid);
    db.raw.prepare(`
      UPDATE outbound_ops
         SET status = 'echoed', echoed_at = ?
       WHERE id = ?
    `).run(proofTimestamp, outboundOpId);
    return { inboundSeq, outboundOpId, terminalRecordId, jobId };
  }

  function timestampDaysAgo(days: number): string {
    return (db.raw.prepare(
      `SELECT datetime('now', ?) AS value`,
    ).get(`-${days} days`) as { value: string }).value;
  }

  function insertOldCompleteInbound(messageId: string): void {
    db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status, completed_at)
      VALUES (?, 'c1', 'chat@g.us', 'complete', datetime('now', '-40 days'))
    `).run(messageId);
  }
});
