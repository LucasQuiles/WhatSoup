import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  DEFAULT_DATABASE_RETENTION,
  DatabaseRetentionTimer,
  runDatabaseRetention,
} from '../../src/core/database-retention.ts';
import { closeOperatorCatchupRecovery } from '../../src/core/recovery-catchup-closure.ts';

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
      messages: 0,
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

  // #1445 QR-012: messages/receipts retention unification. `messages` was
  // pruned via a standalone main.ts setInterval calling deleteOldMessages()
  // directly, entirely outside this module's sweep. This folds that prune
  // (and its orphan-receipts cleanup, #1772) into runDatabaseRetention so
  // ALL retention runs through one SSOT, with no change to the effective
  // 30-day default or the orphan-receipts behavior.
  it('prunes old messages and their orphaned receipts via the unified sweep (#1445 QR-012)', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oldTs = nowSec - 31 * 86400; // 31 days ago — beyond a 30-day window
    const youngTs = nowSec - 5 * 86400; // 5 days ago — inside the window

    db.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, timestamp)
      VALUES ('chat@g.us', 'c1', 'sender@s.whatsapp.net', 'old-msg', 'aged out', ?)
    `).run(oldTs);
    db.raw.prepare(`
      INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, timestamp)
      VALUES ('chat@g.us', 'c1', 'sender@s.whatsapp.net', 'young-msg', 'still live', ?)
    `).run(youngTs);
    // Receipt for the aged-out message — orphaned once the message is pruned.
    db.raw.prepare(`
      INSERT INTO receipts (message_id, recipient_jid, type)
      VALUES ('old-msg', 'recipient@s.whatsapp.net', 'read')
    `).run();
    // Receipt for the still-live message — must survive regardless of its own age.
    db.raw.prepare(`
      INSERT INTO receipts (message_id, recipient_jid, type, timestamp)
      VALUES ('young-msg', 'recipient@s.whatsapp.net', 'read', datetime('now', '-400 days'))
    `).run();

    const result = runDatabaseRetention(db, {
      ...DEFAULT_DATABASE_RETENTION,
      messageRetentionDays: 30,
    });

    expect(result.messages).toBe(1);
    expect(rowCount('messages')).toBe(1);
    expect(columnValues('messages', 'message_id')).toEqual(['young-msg']);
    expect(rowCount('receipts')).toBe(1);
    expect(columnValues('receipts', 'message_id')).toEqual(['young-msg']);
  });

  // #1445 QR-012 guard: main.ts used to run messages/receipts retention from
  // a standalone 60s-delayed startup setTimeout plus its own branch inside
  // the daily setInterval, both calling deleteOldMessages() directly and
  // entirely bypassing this module. Both are retired in favor of the single
  // unified sweep above; this is a structural (source-text) check rather
  // than a mocked-timer assertion, per the "testable without brittle
  // mocking" constraint — it fails loudly if the standalone path is ever
  // reintroduced, without depending on main.ts's large mocked test harness.
  it('main.ts no longer imports or calls deleteOldMessages directly (#1445 QR-012)', () => {
    const source = readFileSync('src/main.ts', 'utf8');

    // Not imported from core/messages.ts and not called anywhere (a comment
    // may still reference the retired function by name for context, which
    // this deliberately allows — only the import and call sites are banned).
    expect(source).not.toMatch(/import\s*\{[^}]*\bdeleteOldMessages\b/);
    expect(source).not.toContain('deleteOldMessages(db,');
    // The config knob the retired path read must still reach the unified
    // sweep, or a custom-configured retention window would silently revert
    // to the hardcoded 30-day default.
    expect(source).toContain('messageRetentionDays: config.retentionDays');
  });

  // #1787 mandatory coupling: adding the 'error' terminal status to tool_calls
  // without adding it to this same retention IN-list would leak every failed
  // tool call past retention forever (under-deletion, the inverse of #1772).
  it('deletes old error-status tool_calls rows, same schedule as complete (#1787 retention coupling)', () => {
    db.raw.prepare(`
      INSERT INTO tool_calls (conversation_key, tool_name, tool_input, status, replay_policy, completed_at)
      VALUES ('old-error-tool', 'send_message', '{}', 'error', 'unsafe', datetime('now', '-40 days'))
    `).run();
    db.raw.prepare(`
      INSERT INTO tool_calls (conversation_key, tool_name, tool_input, status, replay_policy, completed_at)
      VALUES ('young-error-tool', 'send_message', '{}', 'error', 'unsafe', datetime('now', '-5 days'))
    `).run();

    const result = runDatabaseRetention(db, {
      ...DEFAULT_DATABASE_RETENTION,
      terminalDurabilityDays: 30,
    });

    expect(result.toolCalls).toBe(1);
    expect(rowCount('tool_calls')).toBe(1);
    expect(columnValues('tool_calls', 'conversation_key')).toEqual(['young-error-tool']);
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
      messages: 0,
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

  it('preserves catch-up and corroboration proof while pruning unrelated eligible rows', () => {
    db.raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
      VALUES ('retention-plan', 'pre_connect_recovery', 'system:test',
              'retention fixture', 'test://retention')
    `).run();
    const pendingSeq = Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, received_at,
        processing_status, completed_at, terminal_reason, failure_class
      ) VALUES ('retention-pending-link', 'retention-proof', 'proof@g.us',
                datetime('now', '-40 days'), 'failed', datetime('now', '-40 days'),
                'error', 'crash_recovery')
    `).run().lastInsertRowid);
    db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, 'retention-plan', 'recovery_pending_operator_catchup', NULL,
                'crash recovery', 'test://retention', 'system:test')
    `).run(pendingSeq);

    const answeredSeq = Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, received_at,
        processing_status, completed_at, terminal_reason
      ) VALUES ('retention-corroborated', 'retention-proof', 'proof@g.us',
                datetime('now', '-40 days'), 'complete', datetime('now', '-40 days'),
                'response_sent')
    `).run().lastInsertRowid);
    const selectedOp = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, created_at,
        source_inbound_seq, is_terminal, replay_policy
      ) VALUES ('retention-proof', 'proof@g.us', 'text', '{"text":"selected"}',
                'maybe_sent', datetime('now', '-40 days'), ?, 1, 'unsafe')
    `).run(answeredSeq).lastInsertRowid);
    const corroboratingOp = Number(db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, created_at,
        echoed_at, source_inbound_seq, replay_policy
      ) VALUES ('retention-proof', 'proof@g.us', 'text', '{"text":"later"}',
                'echoed', datetime('now', '-40 days'), datetime('now', '-40 days'),
                ?, 'unsafe')
    `).run(answeredSeq).lastInsertRowid);
    const terminalRecord = Number(db.raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, delivery_op_id,
        reply_guarantee_disarmed, created_at
      ) VALUES ('per_chat', 'retention-proof', 'proof@g.us', ?, ?,
                'retention-turn', 'retention-manager', 1, 'replied',
                'finalized_replied', 'delivery_unknown', ?, 0,
                datetime('now', '-40 days'))
    `).run(answeredSeq, answeredSeq, selectedOp).lastInsertRowid);
    db.raw.prepare(`
      INSERT INTO turn_delivery_corroboration (
        terminal_record_id, corroborating_op_id, basis, actor, evidence_ref
      ) VALUES (?, ?, 'same_source_later_echoed_op', 'reconciler:test',
                'test://retention')
    `).run(terminalRecord, corroboratingOp);

    insertOldCompleteInbound('retention-unrelated-in');
    db.raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status, created_at
      ) VALUES ('retention-unrelated-out', 'proof@g.us', 'text', '{}',
                'echoed', datetime('now', '-40 days'))
    `).run();

    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    expect(result).toMatchObject({ inboundEvents: 1, outboundOps: 1, turnTerminalRecords: 0 });
    expect(rowExists('inbound_events', pendingSeq, 'seq')).toBe(true);
    expect(rowExists('inbound_events', answeredSeq, 'seq')).toBe(true);
    expect(rowExists('turn_terminal_records', terminalRecord)).toBe(true);
    expect(rowExists('outbound_ops', selectedOp)).toBe(true);
    expect(rowExists('outbound_ops', corroboratingOp)).toBe(true);
  });

  it('retains a witnessed recovery job without blocking unrelated completed-chain pruning', () => {
    db.raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary)
      VALUES ('retention-witness-plan', 'operator', 'operator:test', 'witness retention')
    `).run();
    const sourceSeq = Number(db.raw.prepare(`
      INSERT INTO inbound_events (
        message_id, conversation_key, chat_jid, received_at,
        processing_status, completed_at, terminal_reason, failure_class
      ) VALUES ('retention-witness-source', 'witnessed-completed-conversation',
                'witnessed-completed@g.us', datetime('now', '-41 days'),
                'failed', datetime('now', '-41 days'), 'error', 'crash_recovery')
    `).run().lastInsertRowid);
    db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, 'retention-witness-plan', 'recovery_pending_operator_catchup', NULL,
                'pending catch-up', 'test://retention-witness', 'operator:test')
    `).run(sourceSeq);
    const witnessed = insertRecoveryChain('witnessed-completed', 'completed', 40);
    db.raw.prepare(`
      UPDATE inbound_events SET terminal_reason = 'response_echoed' WHERE seq = ?
    `).run(witnessed.inboundSeq);
    db.raw.prepare(`
      UPDATE outbound_ops
      SET submitted_at = created_at, wa_message_id = 'wa-retention-witness'
      WHERE id = ?
    `).run(witnessed.outboundOpId);
    db.raw.prepare(`
      UPDATE turn_recovery_jobs
      SET claim_token = ?, completion_kind = 'echo', completion_proof_id = ?
      WHERE id = ?
    `).run(
      `echo-delivery:${witnessed.outboundOpId}`,
      `outbound-op:${witnessed.outboundOpId}`,
      witnessed.jobId,
    );
    closeOperatorCatchupRecovery(db, {
      planId: 'retention-witness-plan',
      conversationKey: 'witnessed-completed-conversation',
      expectedSourceSeqs: [sourceSeq],
      catchupSeq: witnessed.inboundSeq,
      actor: 'operator:test',
      evidenceRef: 'test://retention-witness',
    });
    const unrelated = insertRecoveryChain('unrelated-completed', 'completed', 40);

    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);

    expect(result).toMatchObject({
      turnRecoveryJobs: 1,
      turnTerminalRecords: 1,
      inboundEvents: 1,
      outboundOps: 1,
    });
    for (const [table, id, idColumn] of [
      ['turn_recovery_jobs', witnessed.jobId, 'id'],
      ['turn_terminal_records', witnessed.terminalRecordId, 'id'],
      ['inbound_events', witnessed.inboundSeq, 'seq'],
      ['outbound_ops', witnessed.outboundOpId, 'id'],
    ] as const) {
      expect(rowExists(table, id, idColumn)).toBe(true);
    }
    for (const [table, id, idColumn] of [
      ['turn_recovery_jobs', unrelated.jobId, 'id'],
      ['turn_terminal_records', unrelated.terminalRecordId, 'id'],
      ['inbound_events', unrelated.inboundSeq, 'seq'],
      ['outbound_ops', unrelated.outboundOpId, 'id'],
    ] as const) {
      expect(rowExists(table, id, idColumn)).toBe(false);
    }
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
        messageRetentionDays: 30,
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
        messageRetentionDays: 30,
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
        messages: 0,
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

  // Landed from preserve/wave8-coverage-20260715 (wave 8 branch-coverage
  // extension). The three configs below had `messageRetentionDays` added
  // (matching DEFAULT_DATABASE_RETENTION) since main's DatabaseRetentionConfig
  // made that field required after this suite was originally written.
  it('custom exportedFactDays reduces retention window', () => {
    db.raw.prepare(`
      INSERT INTO fact_export_queue (fact_id, chat_jid, payload_json, status, created_at, exported_at)
      VALUES ('18d-old', 'chat@g.us', '{}', 'exported', datetime('now', '-20 days'), datetime('now', '-18 days'))
    `).run();

    const result = runDatabaseRetention(db, {
      intervalMs: 1000,
      terminalDurabilityDays: 30,
      exportedFactDays: 15,
      metricsHourlyDays: 180,
      decryptionFailureDays: 7,
      messageRetentionDays: 30,
    });
    expect(result.factExportQueue).toBe(1);
  });

  it('daysModifier fractional days floor correctly', () => {
    db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status, completed_at)
      VALUES ('test', 'c1', 'chat@g.us', 'complete', datetime('now', '-2 days'))
    `).run();
    const result = runDatabaseRetention(db, {
      intervalMs: 1000,
      terminalDurabilityDays: 0.5,
      exportedFactDays: 30,
      metricsHourlyDays: 180,
      decryptionFailureDays: 30,
      messageRetentionDays: 30,
    });
    expect(result.inboundEvents).toBe(1);
  });

  it('negative days clamps to 1 day minimum', () => {
    db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status, completed_at)
      VALUES ('recent', 'c1', 'chat@g.us', 'complete', datetime('now', '-2 hours'))
    `).run();
    const result = runDatabaseRetention(db, {
      intervalMs: 1000,
      terminalDurabilityDays: -10,
      exportedFactDays: 30,
      metricsHourlyDays: 180,
      decryptionFailureDays: 30,
      messageRetentionDays: 30,
    });
    expect(result.inboundEvents).toBe(0);
  });

  it('changes() converts bigint to number', () => {
    db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status, completed_at)
      VALUES ('old', 'c1', 'chat@g.us', 'complete', datetime('now', '-40 days'))
    `).run();
    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);
    expect(typeof result.inboundEvents).toBe('number');
  });

  it('timer does not double-start', async () => {
    vi.useFakeTimers();
    try {
      const timer = new DatabaseRetentionTimer(db, {
        intervalMs: 100,
        terminalDurabilityDays: 30,
        exportedFactDays: 30,
        metricsHourlyDays: 180,
        decryptionFailureDays: 30,
        messageRetentionDays: 30,
      });
      insertOldCompleteInbound('old-in');
      timer.start();
      timer.start();
      await Promise.resolve();
      expect(rowCount('inbound_events')).toBe(0);
      timer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('timer stop is idempotent', () => {
    const timer = new DatabaseRetentionTimer(db, DEFAULT_DATABASE_RETENTION);
    expect(() => {
      timer.stop();
      timer.stop();
    }).not.toThrow();
  });

  it('empty database returns all zeros', () => {
    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);
    expect(result.inboundEvents).toBe(0);
    expect(result.outboundOps).toBe(0);
    expect(result.toolCalls).toBe(0);
  });

  it('zero deletions when data within retention window', () => {
    const now = db.raw.prepare("SELECT datetime('now') AS ts").get() as { ts: string };
    db.raw.prepare(`
      INSERT INTO inbound_events (message_id, conversation_key, chat_jid, processing_status, received_at)
      VALUES ('young', 'c1', 'chat@g.us', 'processing', ?)
    `).run(now.ts);
    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);
    expect(result.inboundEvents).toBe(0);
  });

  it('prunes metrics_hourly with empty-string malformed bucket', () => {
    db.raw.prepare(`INSERT INTO metrics_hourly (bucket, metric, value) VALUES ('', 'm', 1)`).run();
    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);
    expect(result.metricsHourly).toBe(1);
  });

  it('keeps decryption_failures at exact boundary (strict <)', () => {
    const cutoff = (db.raw.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%S.000Z', 'now', '-30 days') AS b`).get() as { b: string }).b;
    db.raw.prepare(`
      INSERT INTO decryption_failures (message_id, chat_jid, conversation_key, sender_jid, error_message, raw_key, last_seen_at)
      VALUES ('df', 'chat@g.us', 'c1', 's@s.whatsapp.net', 'e', '{}', ?)
    `).run(cutoff);
    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);
    expect(result.decryptionFailures).toBe(0);
  });

  it('retains queued fact exports regardless of age', () => {
    db.raw.prepare(`
      INSERT INTO fact_export_queue (fact_id, chat_jid, payload_json, status, created_at)
      VALUES ('f', 'chat@g.us', '{}', 'queued', datetime('now', '-100 days'))
    `).run();
    const result = runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);
    expect(result.factExportQueue).toBe(0);
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
