import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectOperatorCatchupCandidates } from '../../src/core/recovery-catchup-closure.ts';
import { OrphanTransferSettler } from '../../src/core/turn-recovery-orphan-settle.ts';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine, sendTrackedWithReceipt as sendTracked } from '../../src/core/durability.ts';
import { resolveOperatorCatchup, inspectOperatorCatchupResolution } from '../../src/core/operator-catchup-resolution.ts';
import { DEFAULT_DATABASE_RETENTION, runDatabaseRetention } from '../../src/core/database-retention.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

describe('operator catch-up schema upgrade', () => {
  const tmp = trackTmpDirs('operator-catchup-upgrade-');
  const originalRows = (raw: DatabaseSync) => ({
    inbound: raw.prepare('SELECT * FROM inbound_events').all(),
    outbound: raw.prepare('SELECT * FROM outbound_ops').all(),
    plans: raw.prepare('SELECT * FROM recovery_plans').all(),
    links: raw.prepare('SELECT * FROM inbound_disposition_links').all(),
  });

  function populatedSchema68() {
    const path = join(tmp.make('schema68'), 'bot.db');
    const db = new Database(path);
    db.open();
    try {
      const engine = new DurabilityEngine(db);
      const jid = '15550000003@s.whatsapp.net';
      const seq = engine.journalInbound('unanswered-request', '15550000003', jid, 'agent');
      engine.markInboundFailed(seq);
      db.raw.exec(`INSERT INTO recovery_plans (plan_id, origin, actor, summary)
        VALUES ('upgrade-plan', 'operator', 'operator:test', 'Unresolved request')`);
      db.raw.prepare(`INSERT INTO inbound_disposition_links
        (inbound_seq, recovery_plan_id, disposition, reason, actor)
        VALUES (?, 'upgrade-plan', 'recovery_pending_operator_catchup', 'No reply', 'operator:test')`).run(seq);
      const op = engine.createOutboundOp({
        conversationKey: '15550000003', chatJid: jid, opType: 'text',
        payload: '{"text":"Uncertain response"}', replayPolicy: 'unsafe', sourceInboundSeq: seq,
      });
      engine.markSending(op);
      engine.markMaybeSent(op, 'ambiguous transport');
      for (const { name } of db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'operator_catchup_resolution_%'").all() as Array<{ name: string }>) {
        db.raw.exec(`DROP TRIGGER ${name}`);
      }
      db.raw.exec(`
        DROP TABLE operator_catchup_resolutions;
        DELETE FROM schema_migrations WHERE version = 69;
      `);
      expect(db.raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 68 });
      return { path, before: originalRows(db.raw) };
    } finally {
      db.close();
    }
  }

  it('inspects pending catch-ups and orphan transfers on a read-only schema-68 database', () => {
    const { path, before } = populatedSchema68();
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
      const selected = selectOperatorCatchupCandidates(raw, 10);
      expect(selected).toEqual([{ planId: 'upgrade-plan', conversationKey: '15550000003',
        chatJid: '15550000003@s.whatsapp.net', sourceSeqs: [1], catchupSeq: null }]);
      const settler = new OrphanTransferSettler(raw);
      expect(settler.orphanTerminalIds()).toEqual([]);
      expect(settler.evaluate(999)).toMatchObject({ verdict: 'refused', reason: 'terminal_not_found' });
      expect(originalRows(raw)).toEqual(before);
    } finally { raw.close(); }
  });

  it('upgrades populated schema 68 without resolving or rewriting ambiguous original work', () => {
    const { path, before } = populatedSchema68();
    const upgraded = new Database(path);
    try {
      upgraded.open();
      expect(upgraded.raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 69 });
      expect(originalRows(upgraded.raw)).toEqual(before);
      expect(upgraded.raw.prepare('SELECT * FROM operator_catchup_resolutions').all()).toEqual([]);
      expect(new DurabilityEngine(upgraded).getTurnRecoverySupervisorCounts().openRecoveries).toBe(1);
    } finally {
      upgraded.close();
    }
  });

  it('rolls back partial migration DDL and leaves schema 68 and its evidence intact', () => {
    const { path, before } = populatedSchema68();
    const exec = DatabaseSync.prototype.exec;
    const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes('CREATE TRIGGER operator_catchup_resolution_no_delete')) {
        throw new Error('injected migration DDL failure');
      }
      return exec.call(this, sql);
    });
    const upgraded = new Database(path);
    try {
      expect(() => upgraded.open()).toThrow('Migration 69 failed');
    } finally {
      fault.mockRestore();
      upgraded.close();
    }
    const raw = new DatabaseSync(path);
    try {
      expect(originalRows(raw)).toEqual(before);
      expect(raw.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toEqual({ version: 68 });
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'operator_catchup_resolution%'").all())
        .toEqual([]);
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      raw.close();
    }
  });
});

describe('bound operator catch-up resolution', () => {
  let db: Database;
  let engine: DurabilityEngine;
  let seq: number;
  const jid = '15550000003@s.whatsapp.net';
  const binding = () => ({ planId: 'pending-plan', sourceSeq: seq, actor: 'operator:test', evidenceRef: 'test://approved-response' });
  const resolution = (opId: number) => ({ ...binding(), opId, evidenceRef: 'test://original-result-received', originalFulfillmentConfirmed: true });
  const messenger = { sendMessage: async () => ({ waMessageId: 'WA_CATCHUP' }), sendMedia: async () => ({ waMessageId: null }) };

  beforeEach(() => {
    db = new Database(':memory:'); db.open(); engine = new DurabilityEngine(db);
    seq = engine.journalInbound('original-request', '15550000003', jid, 'agent');
    db.raw.prepare("UPDATE inbound_events SET processing_status = 'failed', received_at = datetime('now', '-120 days') WHERE seq = ?").run(seq);
    db.raw.exec(`INSERT INTO recovery_plans (plan_id, origin, actor, summary)
      VALUES ('pending-plan', 'operator', 'operator:test', 'Pending original request')`);
    db.raw.prepare(`INSERT INTO inbound_disposition_links
      (inbound_seq, recovery_plan_id, disposition, reason, actor, created_at)
      VALUES (?, 'pending-plan', 'recovery_pending_operator_catchup', 'No reply', 'operator:test', datetime('now', '-120 days'))`).run(seq);
  });
  afterEach(() => db.close());

  async function send(echo = true): Promise<number> {
    const id = await sendTracked(messenger, jid, 'The requested result', engine, {
      replayPolicy: 'unsafe', caller: 'health', operatorCatchup: binding(),
    });
    expect(id).toBeTypeOf('number');
    if (echo) engine.markEchoed(id!);
    return id!;
  }

  it('closes only with bound echo and explicit original fulfillment, retaining the original failure', async () => {
    const opId = await send();
    expect(engine.getTurnRecoverySupervisorCounts().openRecoveries).toBe(1);
    expect(inspectOperatorCatchupResolution(db.raw, resolution(opId))).toMatchObject({ opId, sourceSeq: seq, idempotent: false });
    expect(resolveOperatorCatchup(db.raw, resolution(opId))).toMatchObject({ inserted: 1 });
    expect(resolveOperatorCatchup(db.raw, resolution(opId))).toMatchObject({ inserted: 0, idempotent: true });
    expect(engine.getTurnRecoverySupervisorCounts().openRecoveries).toBe(0);
    expect(db.raw.prepare('SELECT processing_status FROM inbound_events WHERE seq = ?').get(seq)).toEqual({ processing_status: 'failed' });
  });

  it('keeps delivery and original fulfillment separate', async () => {
    const opId = await send();
    expect(() => resolveOperatorCatchup(db.raw, { ...resolution(opId), originalFulfillmentConfirmed: false }))
      .toThrow('Original request fulfillment must be confirmed');
    expect(engine.getTurnRecoverySupervisorCounts().openRecoveries).toBe(1);
  });

  it('rejects submission without echo', async () => {
    const opId = await send(false);
    expect(() => resolveOperatorCatchup(db.raw, resolution(opId))).toThrow('bound echoed');
  });

  it('rejects a new send after an ambiguous first attempt without resetting its evidence', async () => {
    const failed = { ...messenger, sendMessage: async () => { throw new Error('uncertain transport'); } };
    await expect(sendTracked(failed, jid, 'The requested result', engine, {
      replayPolicy: 'unsafe', caller: 'health', operatorCatchup: binding(),
    })).rejects.toThrow('uncertain transport');
    const before = db.raw.prepare('SELECT * FROM outbound_ops').all();
    await expect(send()).rejects.toThrow('already has a bound operation');
    expect(db.raw.prepare('SELECT * FROM outbound_ops').all()).toEqual(before);
  });

  it('rejects another chat before any provider submission or durable operation', async () => {
    await expect(sendTracked(messenger, '15550000004@s.whatsapp.net', 'result', engine, {
      replayPolicy: 'unsafe', caller: 'health', operatorCatchup: binding(),
    })).rejects.toThrow('pending plan, request and conversation');
    expect(db.raw.prepare('SELECT id FROM outbound_ops').all()).toEqual([]);
  });

  it('rejects an unrelated ordinary echoed operation and another plan', async () => {
    const opId = await sendTracked(messenger, jid, 'Unrelated answer', engine, { replayPolicy: 'unsafe', sourceInboundSeq: seq });
    engine.markEchoed(opId!);
    expect(() => resolveOperatorCatchup(db.raw, resolution(opId!))).toThrow('bound echoed');
    const boundId = await send();
    expect(() => resolveOperatorCatchup(db.raw, { ...resolution(boundId), planId: 'other-plan' })).toThrow('bound echoed');
  });

  it('retains the exact proof and rejects a changed idempotent replay', async () => {
    const opId = await send();
    resolveOperatorCatchup(db.raw, resolution(opId));
    expect(() => engine.markEchoed(opId)).not.toThrow();
    expect(() => resolveOperatorCatchup(db.raw, { ...resolution(opId), evidenceRef: 'test://changed' })).toThrow('different evidence');
    expect(() => db.raw.prepare("UPDATE outbound_ops SET status = 'failed_permanent' WHERE id = ?").run(opId)).toThrow();
    expect(() => db.raw.prepare('DELETE FROM outbound_ops WHERE id = ?').run(opId)).toThrow();
    expect(() => db.raw.exec('DELETE FROM operator_catchup_resolutions')).toThrow();
  });

  it.each(['INSERT OR REPLACE', 'REPLACE'])('rejects %s attempts to replace a resolution', async (insert) => {
    const opId = await send();
    resolveOperatorCatchup(db.raw, resolution(opId));
    const before = db.raw.prepare('SELECT * FROM operator_catchup_resolutions').all();
    expect(() => db.raw.prepare(`${insert} INTO operator_catchup_resolutions
      (recovery_plan_id, source_seq, outbound_op_id, actor, evidence_ref)
      VALUES ('pending-plan', ?, ?, 'other-operator', 'test://different')`).run(seq, opId)).toThrow();
    expect(db.raw.prepare('SELECT * FROM operator_catchup_resolutions').all()).toEqual(before);
  });

  it('retains aged proof while pruning an unrelated expired operation', async () => {
    const opId = await send();
    db.raw.prepare(`UPDATE outbound_ops SET created_at = datetime('now', '-110 days'),
      submitted_at = datetime('now', '-110 days'), echoed_at = datetime('now', '-110 days') WHERE id = ?`).run(opId);
    resolveOperatorCatchup(db.raw, resolution(opId));
    const other = engine.createOutboundOp({ conversationKey: 'other', chatJid: 'other@g.us', opType: 'text', payload: '{"text":"old"}', replayPolicy: 'safe' });
    engine.markSending(other); engine.markSubmitted(other, 'WA_OLD'); engine.markEchoed(other);
    db.raw.prepare("UPDATE outbound_ops SET created_at = datetime('now', '-110 days') WHERE id = ?").run(other);
    expect(() => runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION)).not.toThrow();
    expect(db.raw.prepare('SELECT id FROM outbound_ops WHERE id = ?').get(opId)).toBeDefined();
    expect(db.raw.prepare('SELECT id FROM outbound_ops WHERE id = ?').get(other)).toBeUndefined();
  });

  it('fails closed after proof schema drift', async () => {
    const opId = await send();
    db.raw.exec('DROP TRIGGER operator_catchup_resolution_validate');
    expect(() => resolveOperatorCatchup(db.raw, resolution(opId))).toThrow('schema drift');
    expect(db.raw.prepare('SELECT * FROM operator_catchup_resolutions').all()).toEqual([]);
  });

  it.each(['echoed', 'failed_permanent'])('retains unresolved %s attempts and their duplicate-send barrier', async (status) => {
    const opId = await send();
    db.raw.prepare(`UPDATE outbound_ops SET status = ?, created_at = datetime('now', '-110 days'),
      submitted_at = datetime('now', '-110 days'), echoed_at = datetime('now', '-110 days') WHERE id = ?`).run(status, opId);
    runDatabaseRetention(db, DEFAULT_DATABASE_RETENTION);
    expect(db.raw.prepare('SELECT id FROM outbound_ops WHERE id = ?').get(opId)).toBeDefined();
    await expect(send()).rejects.toThrow('already has a bound operation');
    expect(engine.getTurnRecoverySupervisorCounts().openRecoveries).toBe(1);
  });
});
