import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { closeOperatorCatchupRecoveryRaw } from '../../src/core/recovery-catchup-closure.ts';
import {
  openExistingWritableDatabase,
  parseCloseRecoveryArgs,
  runCloseRecoveryCatchupCli,
} from '../../scripts/close-recovery-catchup.ts';

const packageJson = JSON.parse(readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
)) as { scripts: Record<string, string> };

const tempRoots: string[] = [];

interface RecoveryFixture {
  dbPath: string;
  planId: string;
  conversationKey: string;
  sourceSeqs: number[];
  catchupSeq: number;
}

function makeTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'whatsoup-close-catchup-'));
  tempRoots.push(root);
  return root;
}

function installFixture(echoed = true): RecoveryFixture {
  const dbPath = path.join(makeTempRoot(), 'bot.db');
  const db = new Database(dbPath);
  db.open();
  const planId = 'plan-cli-closure';
  const conversationKey = 'conversation-cli-closure';
  db.raw.prepare(`
    INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
    VALUES (?, 'operator', 'operator:test', 'CLI fixture', 'test://fixture')
  `).run(planId);
  const insertSource = db.raw.prepare(`
    INSERT INTO inbound_events (
      message_id, conversation_key, chat_jid, processing_status, completed_at,
      terminal_reason, failure_class
    ) VALUES (?, ?, 'closure-cli@g.us', 'failed', datetime('now'),
              'error', 'crash_recovery')
  `);
  const sourceSeqs = ['source-one', 'source-two'].map((messageId) => Number(
    insertSource.run(messageId, conversationKey).lastInsertRowid,
  ));
  const insertPending = db.raw.prepare(`
    INSERT INTO inbound_disposition_links (
      inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
      reason, evidence_ref, actor
    ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
              'pending operator catch-up', 'test://fixture', 'operator:test')
  `);
  for (const sourceSeq of sourceSeqs) insertPending.run(sourceSeq, planId);

  const catchupSeq = Number(db.raw.prepare(`
    INSERT INTO inbound_events (
      message_id, conversation_key, chat_jid, processing_status,
      completed_at, terminal_reason
    ) VALUES ('catchup', ?, 'closure-cli@g.us', 'complete',
              datetime('now'), 'response_sent')
  `).run(conversationKey).lastInsertRowid);
  const opId = Number(db.raw.prepare(`
    INSERT INTO outbound_ops (
      conversation_key, chat_jid, op_type, payload, status,
      source_inbound_seq, is_terminal, replay_policy, echoed_at
    ) VALUES (?, 'closure-cli@g.us', 'text', '{"text":"ACK"}', ?,
              ?, 1, 'unsafe', CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END)
  `).run(
    conversationKey,
    echoed ? 'echoed' : 'submitted',
    catchupSeq,
    echoed ? 1 : 0,
  ).lastInsertRowid);
  db.raw.prepare(`
    INSERT INTO turn_terminal_records (
      scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
      logical_turn_id, manager_id, generation, attempt_kind,
      inbound_disposition, delivery_kind, delivery_op_id,
      reply_guarantee_disarmed
    ) VALUES ('per_chat', ?, 'closure-cli@g.us', ?, ?, 'catchup-turn',
              'catchup-manager', 1, 'replied', 'finalized_replied',
              ?, ?, ?)
  `).run(
    conversationKey,
    catchupSeq,
    catchupSeq,
    echoed ? 'echoed' : 'enqueued',
    opId,
    echoed ? 1 : 0,
  );
  db.close();
  return { dbPath, planId, conversationKey, sourceSeqs, catchupSeq };
}

function argsFor(fixture: RecoveryFixture, extra: string[] = []): string[] {
  return [
    '--db', fixture.dbPath,
    '--plan-id', fixture.planId,
    '--conversation-key', fixture.conversationKey,
    '--source-seqs', fixture.sourceSeqs.join(','),
    '--catchup-seq', String(fixture.catchupSeq),
    '--actor', 'operator:private',
    '--evidence-ref', 'secret://must-not-echo',
    ...extra,
  ];
}

function captureRun(argv: string[]): { exitCode: number; output: Record<string, unknown>; text: string } {
  const write = vi.spyOn(process.stdout, 'write')
    .mockImplementation((() => true) as typeof process.stdout.write);
  try {
    const exitCode = runCloseRecoveryCatchupCli(argv);
    const text = write.mock.calls.map(([chunk]) => String(chunk)).join('');
    return { exitCode, output: JSON.parse(text) as Record<string, unknown>, text };
  } finally {
    write.mockRestore();
  }
}

function closureCount(dbPath: string): number {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number((raw.prepare(`
      SELECT COUNT(*) AS count
      FROM inbound_disposition_links
      WHERE disposition = 'superseded_by_operator_catchup'
    `).get() as { count: number }).count);
  } finally {
    raw.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('close-recovery-catchup CLI', () => {
  it('is exposed through the pinned package script', () => {
    expect(packageJson.scripts['close-recovery-catchup']).toBe(
      'bash scripts/run-with-pinned-node.sh scripts/close-recovery-catchup.ts',
    );
  });

  it('parses only one occurrence of each known flag and strict positive sequences', () => {
    const fixture = installFixture();
    expect(parseCloseRecoveryArgs(argsFor(fixture))).toMatchObject({
      dbPath: fixture.dbPath,
      sourceSeqs: fixture.sourceSeqs,
      catchupSeq: fixture.catchupSeq,
      confirm: false,
    });

    expect(() => parseCloseRecoveryArgs([...argsFor(fixture), '--unknown']))
      .toThrow('Unknown argument: --unknown');
    expect(() => parseCloseRecoveryArgs([...argsFor(fixture), '--db', fixture.dbPath]))
      .toThrow('Duplicate argument: --db');
    expect(() => parseCloseRecoveryArgs([...argsFor(fixture, ['--confirm']), '--confirm']))
      .toThrow('Duplicate argument: --confirm');

    for (const invalid of ['', '0', '-1', '1.5', 'NaN', '9007199254740992']) {
      const argv = argsFor(fixture);
      argv[argv.indexOf('--catchup-seq') + 1] = invalid;
      expect(() => parseCloseRecoveryArgs(argv)).toThrow('positive safe integer');
    }
    for (const invalid of ['', '1,,2', '1,0', '1,-2', '1,1.5', '1,1']) {
      const argv = argsFor(fixture);
      argv[argv.indexOf('--source-seqs') + 1] = invalid;
      expect(() => parseCloseRecoveryArgs(argv)).toThrow(/source sequence/i);
    }
  });

  it('rejects a missing or non-regular database without creating one', () => {
    const fixture = installFixture();
    for (const extra of [[], ['--confirm']]) {
      const missing = path.join(makeTempRoot(), `typo-${extra.length}.db`);
      const missingArgs = argsFor({ ...fixture, dbPath: missing }, extra);

      expect(() => runCloseRecoveryCatchupCli(missingArgs)).toThrow('existing regular file');
      expect(existsSync(missing)).toBe(false);
    }

    const directory = makeTempRoot();
    expect(() => runCloseRecoveryCatchupCli(argsFor({ ...fixture, dbPath: directory })))
      .toThrow('existing regular file');
  });

  it('mode=rw refuses removal or replacement of the preflighted database identity', () => {
    const original = installFixture();
    const originalStat = statSync(original.dbPath);
    const expectedIdentity = { device: originalStat.dev, inode: originalStat.ino };
    const retiredPath = `${original.dbPath}.retired`;
    renameSync(original.dbPath, retiredPath);

    expect(() => openExistingWritableDatabase(original.dbPath, expectedIdentity))
      .toThrow(/unable to open database file|no longer exists/i);
    expect(existsSync(original.dbPath)).toBe(false);

    const replacement = installFixture();
    renameSync(replacement.dbPath, original.dbPath);
    expect(() => openExistingWritableDatabase(original.dbPath, expectedIdentity))
      .toThrow('Database path changed after read-only preflight');
    expect(closureCount(original.dbPath)).toBe(0);
  });

  it('validates a schema-43 proof read-only and emits a non-secret success preview', () => {
    const fixture = installFixture();

    const result = captureRun(argsFor(fixture));

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      ok: true,
      dryRun: true,
      ready: true,
      planId: fixture.planId,
      conversationKey: fixture.conversationKey,
      sourceSeqs: fixture.sourceSeqs,
      catchupSeq: fixture.catchupSeq,
      evidenceBasis: 'selected_echoed',
      wouldInsert: fixture.sourceSeqs.length,
      idempotent: false,
    });
    expect(result.text).not.toContain('operator:private');
    expect(result.text).not.toContain('secret://must-not-echo');
    expect(closureCount(fixture.dbPath)).toBe(0);
  });

  it('fails a dry run when the target lacks exact echoed delivery proof', () => {
    const fixture = installFixture(false);

    expect(() => runCloseRecoveryCatchupCli(argsFor(fixture)))
      .toThrow('echoed delivery proof');
    expect(closureCount(fixture.dbPath)).toBe(0);
  });

  it('fails a dry run unless source sequences exactly match the pending set', () => {
    const fixture = installFixture();
    const partialArgs = argsFor(fixture);
    partialArgs[partialArgs.indexOf('--source-seqs') + 1] = String(fixture.sourceSeqs[0]);

    expect(() => runCloseRecoveryCatchupCli(partialArgs)).toThrow('exactly match');
    expect(closureCount(fixture.dbPath)).toBe(0);
  });

  it('refuses the raw mutation API unless foreign-key enforcement is active', () => {
    const fixture = installFixture();
    const raw = new DatabaseSync(fixture.dbPath);
    try {
      raw.exec('PRAGMA foreign_keys = OFF');
      expect(() => closeOperatorCatchupRecoveryRaw(raw, {
        planId: fixture.planId,
        conversationKey: fixture.conversationKey,
        expectedSourceSeqs: fixture.sourceSeqs,
        catchupSeq: fixture.catchupSeq,
        actor: 'operator:private',
        evidenceRef: 'secret://must-not-echo',
      })).toThrow('foreign-key enforcement');
    } finally {
      raw.close();
    }
    expect(closureCount(fixture.dbPath)).toBe(0);
  });

  it('fails before partial closure when another file-backed writer owns the database', () => {
    const fixture = installFixture();
    const blocker = new DatabaseSync(fixture.dbPath);
    const contender = new DatabaseSync(fixture.dbPath);
    try {
      blocker.exec('BEGIN IMMEDIATE');
      contender.exec('PRAGMA foreign_keys = ON');
      contender.exec('PRAGMA busy_timeout = 1');

      expect(() => closeOperatorCatchupRecoveryRaw(contender, {
        planId: fixture.planId,
        conversationKey: fixture.conversationKey,
        expectedSourceSeqs: fixture.sourceSeqs,
        catchupSeq: fixture.catchupSeq,
        actor: 'operator:private',
        evidenceRef: 'secret://must-not-echo',
      })).toThrow(/locked/i);

      blocker.exec('ROLLBACK');
    } finally {
      try { blocker.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      blocker.close();
      contender.close();
    }
    expect(closureCount(fixture.dbPath)).toBe(0);
  });

  it('holds the writer reservation across transactional schema attestation', () => {
    const fixture = installFixture();
    const owner = new DatabaseSync(fixture.dbPath);
    const competingWriter = new DatabaseSync(fixture.dbPath);
    try {
      owner.exec('PRAGMA foreign_keys = ON');
      competingWriter.exec('PRAGMA busy_timeout = 1');

      expect(() => closeOperatorCatchupRecoveryRaw(owner, {
        planId: fixture.planId,
        conversationKey: fixture.conversationKey,
        expectedSourceSeqs: fixture.sourceSeqs,
        catchupSeq: fixture.catchupSeq,
        actor: 'operator:private',
        evidenceRef: 'secret://must-not-echo',
      }, () => {
        competingWriter.exec('DROP TRIGGER operator_catchup_closure_witness_append_only_update');
      })).toThrow(/locked/i);
    } finally {
      owner.close();
      competingWriter.close();
    }

    const check = new DatabaseSync(fixture.dbPath, { readOnly: true });
    expect(check.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'operator_catchup_closure_witness_append_only_update'
    `).get()).toEqual({ name: 'operator_catchup_closure_witness_append_only_update' });
    check.close();
    expect(closureCount(fixture.dbPath)).toBe(0);
  });

  it.each([
    ['dry run', []],
    ['confirmed run', ['--confirm']],
  ] as const)('rejects schema 42 without migrating it during a %s', (_label, extra) => {
    const fixture = installFixture();
    const raw = new DatabaseSync(fixture.dbPath);
    raw.prepare('DELETE FROM schema_migrations WHERE version = 43').run();
    raw.close();

    expect(() => runCloseRecoveryCatchupCli(argsFor(fixture, [...extra])))
      .toThrow('exact schema 43');

    const check = new DatabaseSync(fixture.dbPath, { readOnly: true });
    expect(check.prepare('SELECT version FROM schema_migrations WHERE version = 43').get())
      .toBeUndefined();
    check.close();
    expect(closureCount(fixture.dbPath)).toBe(0);
  });

  it('rejects a schema-43 receipt set whose critical DDL has drifted', () => {
    const fixture = installFixture();
    const raw = new DatabaseSync(fixture.dbPath);
    raw.exec(`
      DROP TRIGGER operator_catchup_closure_witness_append_only_update;
      CREATE TRIGGER operator_catchup_closure_witness_append_only_update
      BEFORE UPDATE ON operator_catchup_closure_witnesses
      BEGIN
        SELECT 1;
      END;
    `);
    raw.close();

    expect(() => runCloseRecoveryCatchupCli(argsFor(fixture)))
      .toThrow(/drifted.*operator_catchup_closure_witness_append_only_update/i);
    expect(closureCount(fixture.dbPath)).toBe(0);
  });

  it('revalidates and atomically closes the exact set only with --confirm', () => {
    const fixture = installFixture();

    const result = captureRun(argsFor(fixture, ['--confirm']));

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      ok: true,
      dryRun: false,
      receipt: {
        planId: fixture.planId,
        conversationKey: fixture.conversationKey,
        sourceSeqs: fixture.sourceSeqs,
        catchupSeq: fixture.catchupSeq,
        inserted: fixture.sourceSeqs.length,
        idempotent: false,
        openAfter: 0,
      },
    });
    expect(result.text).not.toContain('operator:private');
    expect(result.text).not.toContain('secret://must-not-echo');
    expect(closureCount(fixture.dbPath)).toBe(fixture.sourceSeqs.length);

    const replay = captureRun(argsFor(fixture, ['--confirm']));
    expect(replay.output).toMatchObject({
      ok: true,
      dryRun: false,
      receipt: { inserted: 0, idempotent: true, openBefore: 0, openAfter: 0 },
    });
    expect(closureCount(fixture.dbPath)).toBe(fixture.sourceSeqs.length);
  });
});
