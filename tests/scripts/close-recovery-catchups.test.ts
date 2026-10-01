import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { Database } from '../../src/core/database.ts';
import {
  loadOrCreateRedactionSalt,
  redactFingerprint,
} from '../../scripts/close-recovery-catchup.ts';
import {
  BATCH_CLOSURE_EXIT,
  parseBatchClosureArgs,
  runBatchClosure,
  runBatchClosureCli,
} from '../../scripts/close-recovery-catchups.ts';

const packageJson = JSON.parse(readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
)) as { scripts: Record<string, string> };

const tmp = trackTmpDirs('whatsoup-close-batch-');

// Distinctive seq values so a raw-identifier canary on output is meaningful.
const SEQ_BASE = 910_001;
const ACTOR = 'operator:batch-private';
const EVIDENCE = 'secret://batch-evidence-must-not-echo';

interface GroupFixture {
  planId: string;
  conversationKey: string;
  chat: string;
  sourceSeqs: number[];
  catchupSeq: number | null;
}

function insertGroup(
  db: Database,
  options: { index: number; delivered: boolean },
): GroupFixture {
  const planId = `plan-batch-${options.index}`;
  const conversationKey = `conversation-batch-${options.index}`;
  const chat = `batch-${options.index}@g.us`;
  const base = SEQ_BASE + options.index * 1_000;
  db.raw.prepare(`
    INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
    VALUES (?, 'operator', 'operator:test', 'batch fixture', 'test://fixture')
  `).run(planId);
  const sourceSeqs = [base, base + 1];
  for (const seq of sourceSeqs) {
    db.raw.prepare(`
      INSERT INTO inbound_events (
        seq, message_id, conversation_key, chat_jid, processing_status, completed_at,
        terminal_reason, failure_class
      ) VALUES (?, ?, ?, ?, 'failed', datetime('now'), 'error', 'crash_recovery')
    `).run(seq, `${planId}-source-${seq}`, conversationKey, chat);
    db.raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                'pending operator catch-up', 'test://fixture', 'operator:test')
    `).run(seq, planId);
  }
  const catchupSeq = base + 100;
  db.raw.prepare(`
    INSERT INTO inbound_events (
      seq, message_id, conversation_key, chat_jid, processing_status,
      completed_at, terminal_reason
    ) VALUES (?, ?, ?, ?, 'complete', datetime('now'), 'response_sent')
  `).run(catchupSeq, `${planId}-catchup`, conversationKey, chat);
  const opId = Number(db.raw.prepare(`
    INSERT INTO outbound_ops (
      conversation_key, chat_jid, op_type, payload, status,
      source_inbound_seq, is_terminal, replay_policy, echoed_at
    ) VALUES (?, ?, 'text', '{"text":"ACK"}', ?, ?, 1, 'unsafe',
              CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END)
  `).run(
    conversationKey,
    chat,
    options.delivered ? 'echoed' : 'submitted',
    catchupSeq,
    options.delivered ? 1 : 0,
  ).lastInsertRowid);
  db.raw.prepare(`
    INSERT INTO turn_terminal_records (
      scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
      logical_turn_id, manager_id, generation, attempt_kind,
      inbound_disposition, delivery_kind, delivery_op_id,
      reply_guarantee_disarmed
    ) VALUES ('per_chat', ?, ?, ?, ?, ?, 'catchup-manager', 1, 'replied',
              'finalized_replied', ?, ?, ?)
  `).run(
    conversationKey,
    chat,
    catchupSeq,
    catchupSeq,
    `${planId}-turn`,
    options.delivered ? 'echoed' : 'enqueued',
    opId,
    options.delivered ? 1 : 0,
  );
  return { planId, conversationKey, chat, sourceSeqs, catchupSeq: options.delivered ? catchupSeq : null };
}

/** Two closable groups and one with no delivered catch-up yet. */
function installFixture(): { dbPath: string; root: string; groups: GroupFixture[] } {
  const root = tmp.make('db');
  const dbPath = path.join(root, 'bot.db');
  const db = new Database(dbPath);
  db.open();
  const groups = [
    insertGroup(db, { index: 1, delivered: true }),
    insertGroup(db, { index: 2, delivered: true }),
    insertGroup(db, { index: 3, delivered: false }),
  ];
  db.close();
  return { dbPath, root, groups };
}

function linkCounts(dbPath: string): { pending: number; closed: number } {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const count = (disposition: string): number => Number((raw.prepare(`
      SELECT COUNT(*) AS count FROM inbound_disposition_links WHERE disposition = ?
    `).get(disposition) as { count: number }).count);
    return { pending: count('recovery_pending_operator_catchup'), closed: count('superseded_by_operator_catchup') };
  } finally {
    raw.close();
  }
}

function closureActors(dbPath: string): Array<{ actor: string; evidence_ref: string }> {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return raw.prepare(`
      SELECT actor, evidence_ref FROM inbound_disposition_links
      WHERE disposition = 'superseded_by_operator_catchup'
    `).all() as Array<{ actor: string; evidence_ref: string }>;
  } finally {
    raw.close();
  }
}

async function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runBatchClosureCli(argv, {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { code, stdout, stderr };
}

function baseArgs(dbPath: string): string[] {
  return ['--db', dbPath, '--actor', ACTOR, '--evidence-ref', EVIDENCE];
}

describe('close-recovery-catchups argument parsing', () => {
  it('registers the npm script on the pinned-node runner', () => {
    expect(packageJson.scripts['close-recovery-catchups'])
      .toBe('bash scripts/run-with-pinned-node.sh scripts/close-recovery-catchups.ts');
  });

  it('defaults to a dry run with the reconciler group limit', () => {
    const args = parseBatchClosureArgs(baseArgs('/abs/bot.db'));
    expect(args).toMatchObject({ confirm: false, backupDir: null, groupLimit: 50 });
  });

  it('refuses --confirm without --backup-dir', () => {
    expect(() => parseBatchClosureArgs([...baseArgs('/abs/bot.db'), '--confirm']))
      .toThrow(/--confirm requires --backup-dir/);
  });

  it('refuses a relative backup dir, an unknown flag, a missing actor, and a bad limit', () => {
    expect(() => parseBatchClosureArgs([...baseArgs('/abs/bot.db'), '--confirm', '--backup-dir', 'rel']))
      .toThrow(/absolute/);
    expect(() => parseBatchClosureArgs([...baseArgs('/abs/bot.db'), '--source-seqs', '1']))
      .toThrow(/Unknown argument/);
    expect(() => parseBatchClosureArgs(['--db', '/abs/bot.db', '--evidence-ref', EVIDENCE]))
      .toThrow(/--actor is required/);
    expect(() => parseBatchClosureArgs([...baseArgs('/abs/bot.db'), '--group-limit', '0']))
      .toThrow(/positive safe integer/);
  });

  it('exits 2 on a usage error without touching any database', async () => {
    const result = await runCli(['--db', '/abs/bot.db']);
    expect(result.code).toBe(BATCH_CLOSURE_EXIT.usage);
    expect(result.stdout).toBe('');
  });
});

describe('close-recovery-catchups against a real schema database', () => {
  it('dry run proves every candidate group and changes no disposition rows', async () => {
    const fixture = installFixture();
    const before = linkCounts(fixture.dbPath);

    const result = await runCli(baseArgs(fixture.dbPath));

    expect(result.code).toBe(BATCH_CLOSURE_EXIT.ok);
    const report = JSON.parse(result.stdout) as {
      dryRun: boolean;
      summary: Record<string, number>;
      groups: Array<Record<string, unknown>>;
    };
    expect(report.dryRun).toBe(true);
    expect(report.summary).toMatchObject({ examined: 3, ready: 2, closed: 0, skipped: 1, errors: 0 });
    expect(report.groups.map((group) => group.status)).toEqual(['ready', 'ready', 'skipped']);
    expect(report.groups[2]).toMatchObject({ reason: 'no_catchup_candidate', catchupSeqFingerprint: null });
    expect(linkCounts(fixture.dbPath)).toEqual(before);
  });

  it('prints fingerprints the single-group command would print, never raw identifiers', async () => {
    const fixture = installFixture();
    const result = await runCli(baseArgs(fixture.dbPath));
    const report = JSON.parse(result.stdout) as { groups: Array<Record<string, unknown>> };
    const salt = loadOrCreateRedactionSalt(fixture.dbPath);
    const [first] = fixture.groups;
    expect(report.groups[0]).toMatchObject({
      planFingerprint: redactFingerprint(salt, 'plan', first!.planId),
      conversationFingerprint: redactFingerprint(salt, 'conversation', first!.conversationKey),
      catchupSeqFingerprint: redactFingerprint(salt, 'catchup-seq', first!.catchupSeq!),
      nSourceSeqs: 2,
    });
    for (const group of fixture.groups) {
      for (const secret of [group.planId, group.conversationKey, group.chat, ...group.sourceSeqs.map(String)]) {
        expect(result.stdout).not.toContain(secret);
      }
      if (group.catchupSeq !== null) expect(result.stdout).not.toContain(String(group.catchupSeq));
    }
    expect(result.stdout).not.toContain(ACTOR);
    expect(result.stdout).not.toContain(EVIDENCE);
  });

  it('confirm backs up first, closes the proven groups with the operator actor and evidence, and leaves the rest pending', async () => {
    const fixture = installFixture();
    const backupDir = path.join(fixture.root, 'backups');

    const result = await runCli([...baseArgs(fixture.dbPath), '--confirm', '--backup-dir', backupDir]);

    expect(result.code).toBe(BATCH_CLOSURE_EXIT.ok);
    const report = JSON.parse(result.stdout) as {
      dryRun: boolean;
      backup: { path: string; quickCheck: string };
      summary: Record<string, number>;
      groups: Array<Record<string, unknown>>;
    };
    expect(report.dryRun).toBe(false);
    expect(report.summary).toMatchObject({ closed: 2, skipped: 1, linksClosed: 4, errors: 0 });
    expect(report.groups.map((group) => group.status)).toEqual(['closed', 'closed', 'skipped']);
    expect(linkCounts(fixture.dbPath)).toEqual({ pending: 6, closed: 4 });
    expect(closureActors(fixture.dbPath)).toEqual(Array(4).fill({ actor: ACTOR, evidence_ref: EVIDENCE }));

    // Backup-before-mutate: the backup exists, is private, verified, and holds
    // the ORIGINAL state (no closures), so it was taken before the first write.
    expect(report.backup.quickCheck).toBe('ok');
    expect(path.dirname(report.backup.path)).toBe(backupDir);
    expect(statSync(report.backup.path).mode & 0o777).toBe(0o600);
    expect(linkCounts(report.backup.path)).toEqual({ pending: 6, closed: 0 });
  });

  it('is idempotent: a second confirm finds nothing left to close and changes nothing', async () => {
    const fixture = installFixture();
    const backupDir = path.join(fixture.root, 'backups');
    await runBatchClosure({ ...parseBatchClosureArgs([...baseArgs(fixture.dbPath), '--confirm', '--backup-dir', backupDir]) },
      () => new Date('2026-01-01T00:00:00Z'));
    const afterFirst = linkCounts(fixture.dbPath);

    const second = await runBatchClosure(
      parseBatchClosureArgs([...baseArgs(fixture.dbPath), '--confirm', '--backup-dir', backupDir]),
      () => new Date('2026-01-01T00:01:00Z'),
    );

    expect(second.summary).toMatchObject({ examined: 1, closed: 0, skipped: 1, linksClosed: 0 });
    expect(linkCounts(fixture.dbPath)).toEqual(afterFirst);
    expect(readdirSync(backupDir)).toHaveLength(2);
  });

  it('refuses to overwrite an existing backup and closes nothing when the backup cannot be taken', async () => {
    const fixture = installFixture();
    const backupDir = path.join(fixture.root, 'backups');
    const clock = (): Date => new Date('2026-01-01T00:00:00Z');
    const args = parseBatchClosureArgs([...baseArgs(fixture.dbPath), '--confirm', '--backup-dir', backupDir]);
    // The first run occupies the backup name for this timestamp; a second run
    // against a fresh database at the same timestamp must refuse at the backup.
    await runBatchClosure(args, clock);
    const fresh = installFixture();
    const freshArgs = { ...args, dbPath: fresh.dbPath };
    const before = linkCounts(fresh.dbPath);

    await expect(runBatchClosure(freshArgs, clock)).rejects.toThrow(/backup destination already exists/);
    expect(linkCounts(fresh.dbPath)).toEqual(before);
  });

  it('respects the group limit the same way the reconciler does', async () => {
    const fixture = installFixture();
    const report = await runBatchClosure(parseBatchClosureArgs([...baseArgs(fixture.dbPath), '--group-limit', '1']));
    expect(report.summary).toMatchObject({ examined: 1, ready: 1 });
  });

  it('does not create a backup directory on a dry run', async () => {
    const fixture = installFixture();
    const backupDir = path.join(fixture.root, 'backups');
    await runCli([...baseArgs(fixture.dbPath), '--backup-dir', backupDir]);
    expect(existsSync(backupDir)).toBe(false);
  });
});
