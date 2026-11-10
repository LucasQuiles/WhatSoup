import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  closeFailedSourceOperatorCatchupRecoveryRaw,
  closeOperatorCatchupRecoveryRaw,
} from '../../src/core/recovery-catchup-closure.ts';
import {
  classifyError,
  loadOrCreateRedactionSalt,
  openExistingWritableDatabase,
  parseCloseRecoveryArgs,
  redactFingerprint,
  runCloseRecoveryCatchupCli,
} from '../../scripts/close-recovery-catchup.ts';

const packageJson = JSON.parse(readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
)) as { scripts: Record<string, string> };

const CLI_PATH = fileURLToPath(new URL('../../scripts/close-recovery-catchup.ts', import.meta.url));

/**
 * Spawn the CLI as a real subprocess (module-invocation guard requires it —
 * the top-level `if (import.meta.url === invokedPath)` block only runs when
 * the file is the actual entrypoint, never when imported for in-process
 * calls like `runCloseRecoveryCatchupCli`). Splits stdout/stderr the same
 * way an operator's terminal would see them.
 */
function runCliSubprocess(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', CLI_PATH, ...args],
    { encoding: 'utf8' },
  );
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const tmp = trackTmpDirs('whatsoup-close-');

interface RecoveryFixture {
  dbPath: string;
  planId: string;
  conversationKey: string;
  sourceSeqs: number[];
  catchupSeq: number;
}

function makeTempRoot(): string {
  return tmp.make('catchup');
}

// Distinctive, explicitly-assigned seq base for fixture rows (inbound_events.seq
// is INTEGER PRIMARY KEY, so an explicit high value is a legal insert — SQLite's
// AUTOINCREMENT only guarantees the NEXT auto-assigned rowid exceeds any prior
// value, it does not forbid assigning one directly). Values in this range are
// large and specific enough that a `.not.toContain(String(seq))` canary on CLI
// output is actually meaningful — small ints like 1/2/3 collide constantly with
// bounded counts and hex fingerprint digits, which is why that canary was
// previously narrowed away (702546c4a) rather than restored.
const FIXTURE_SEQ_BASE = 900_001;

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
      seq, message_id, conversation_key, chat_jid, processing_status, completed_at,
      terminal_reason, failure_class
    ) VALUES (?, ?, ?, 'closure-cli@g.us', 'failed', datetime('now'),
              'error', 'crash_recovery')
  `);
  const sourceSeqs = ['source-one', 'source-two'].map((messageId, index) => {
    const seq = FIXTURE_SEQ_BASE + index;
    insertSource.run(seq, messageId, conversationKey);
    return seq;
  });
  const insertPending = db.raw.prepare(`
    INSERT INTO inbound_disposition_links (
      inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
      reason, evidence_ref, actor
    ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
              'pending operator catch-up', 'test://fixture', 'operator:test')
  `);
  for (const sourceSeq of sourceSeqs) insertPending.run(sourceSeq, planId);

  const catchupSeq = FIXTURE_SEQ_BASE + 100;
  db.raw.prepare(`
    INSERT INTO inbound_events (
      seq, message_id, conversation_key, chat_jid, processing_status,
      completed_at, terminal_reason
    ) VALUES (?, 'catchup', ?, 'closure-cli@g.us', 'complete',
              datetime('now'), 'response_sent')
  `).run(catchupSeq, conversationKey);
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

  it('validates a schema-43+ proof read-only and emits a non-secret success preview', () => {
    const fixture = installFixture();

    const schema = new DatabaseSync(fixture.dbPath, { readOnly: true });
    const latest = schema.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number;
    };
    schema.close();
    expect(latest.version).toBeGreaterThan(43);

    const result = captureRun(argsFor(fixture));
    const salt = loadOrCreateRedactionSalt(fixture.dbPath);

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      ok: true,
      dryRun: true,
      ready: true,
      planFingerprint: redactFingerprint(salt, 'plan', fixture.planId),
      conversationFingerprint: redactFingerprint(salt, 'conversation', fixture.conversationKey),
      nSourceSeqs: fixture.sourceSeqs.length,
      catchupSeqFingerprint: redactFingerprint(salt, 'catchup-seq', fixture.catchupSeq),
      evidenceBasis: 'selected_echoed',
      wouldInsert: fixture.sourceSeqs.length,
      idempotent: false,
    });
    // Issue #2457 canaries: raw private identifiers must NOT appear in stdout.
    // We check field names and known-sensitive values, not arbitrary digits
    // (which naturally appear in hex fingerprints and bounded counts).
    expect(result.text).not.toContain('operator:private');
    expect(result.text).not.toContain('secret://must-not-echo');
    expect(result.text).not.toContain(fixture.planId);
    expect(result.text).not.toContain(fixture.conversationKey);
    expect(result.text).not.toContain('"planId"');
    expect(result.text).not.toContain('"conversationKey"');
    expect(result.text).not.toContain('"catchupSeq"');
    expect(result.text).not.toContain('"sourceSeqs"');
    expect(result.text).not.toContain('"terminalRecordId"');
    expect(result.text).not.toContain('"selectedOpId"');
    expect(result.text).not.toContain('"recoveryJobId"');
    expect(result.text).not.toContain('"completionProofId"');
    // Raw value-absence canaries: fixture seqs are seeded at FIXTURE_SEQ_BASE
    // (>=900001), distinctive enough that this is a meaningful check rather
    // than a guaranteed false positive against bounded counts/hex digits.
    expect(result.text).not.toContain(String(fixture.catchupSeq));
    expect(result.text).not.toContain(String(fixture.sourceSeqs[0]));
    expect(result.text).not.toContain(String(fixture.sourceSeqs[1]));
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
      .toThrow('schema 43+ receipts');

    const check = new DatabaseSync(fixture.dbPath, { readOnly: true });
    expect(check.prepare('SELECT version FROM schema_migrations WHERE version = 43').get())
      .toBeUndefined();
    check.close();
    expect(closureCount(fixture.dbPath)).toBe(0);
  });

  it('rejects a gap in post-43 migration receipts without closing recovery', () => {
    const fixture = installFixture();
    const raw = new DatabaseSync(fixture.dbPath);
    const latest = Number((raw.prepare(`
      SELECT MAX(version) AS version FROM schema_migrations
    `).get() as { version: number }).version);
    expect(latest).toBeGreaterThan(43);
    raw.prepare('DELETE FROM schema_migrations WHERE version = ?').run(latest);
    raw.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(latest + 1);
    raw.close();

    expect(() => runCloseRecoveryCatchupCli(argsFor(fixture)))
      .toThrow('schema 43+ receipts');
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
    const salt = loadOrCreateRedactionSalt(fixture.dbPath);

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      ok: true,
      dryRun: false,
      receipt: {
        planFingerprint: redactFingerprint(salt, 'plan', fixture.planId),
        conversationFingerprint: redactFingerprint(salt, 'conversation', fixture.conversationKey),
        nSourceSeqs: fixture.sourceSeqs.length,
        catchupSeqFingerprint: redactFingerprint(salt, 'catchup-seq', fixture.catchupSeq),
        inserted: fixture.sourceSeqs.length,
        idempotent: false,
        openAfter: 0,
      },
    });
    // Issue #2457 canaries: raw private identifiers must NOT appear in stdout.
    expect(result.text).not.toContain('operator:private');
    expect(result.text).not.toContain('secret://must-not-echo');
    expect(result.text).not.toContain(fixture.planId);
    expect(result.text).not.toContain(fixture.conversationKey);
    expect(result.text).not.toContain('"planId"');
    expect(result.text).not.toContain('"conversationKey"');
    expect(result.text).not.toContain('"catchupSeq"');
    expect(result.text).not.toContain('"sourceSeqs"');
    expect(result.text).not.toContain('"terminalRecordId"');
    expect(result.text).not.toContain('"selectedOpId"');
    expect(result.text).not.toContain('"recoveryJobId"');
    expect(result.text).not.toContain('"completionProofId"');
    // Raw value-absence canaries (see FIXTURE_SEQ_BASE comment above).
    expect(result.text).not.toContain(String(fixture.catchupSeq));
    expect(result.text).not.toContain(String(fixture.sourceSeqs[0]));
    expect(result.text).not.toContain(String(fixture.sourceSeqs[1]));
    expect(closureCount(fixture.dbPath)).toBe(fixture.sourceSeqs.length);

    const replay = captureRun(argsFor(fixture, ['--confirm']));
    expect(replay.output).toMatchObject({
      ok: true,
      dryRun: false,
      receipt: { inserted: 0, idempotent: true, openBefore: 0, openAfter: 0 },
    });
    // Replay must also be redacted.
    expect(replay.text).not.toContain(fixture.planId);
    expect(replay.text).not.toContain(fixture.conversationKey);
    expect(replay.text).not.toContain(String(fixture.catchupSeq));
    expect(replay.text).not.toContain(String(fixture.sourceSeqs[0]));
    expect(replay.text).not.toContain(String(fixture.sourceSeqs[1]));
    expect(closureCount(fixture.dbPath)).toBe(fixture.sourceSeqs.length);
  });

  // FIX 2(b): pin the EXACT allowlisted key set (not just a `.toMatchObject`
  // subset check above, which would silently pass if an extra undocumented
  // field leaked into the output). publicInspection()/publicReceipt() are
  // unexported internals; this pins the equivalent, more faithful contract —
  // the CLI's actual JSON output an operator or downstream tool observes.
  it('pins the exact dry-run inspection key set — no undocumented field can leak in (M4)', () => {
    const fixture = installFixture();
    const result = captureRun(argsFor(fixture));

    expect(Object.keys(result.output).sort()).toEqual([
      'catchupSeqFingerprint',
      'conversationFingerprint',
      'dryRun',
      'evidenceBasis',
      'idempotent',
      'nSourceSeqs',
      'ok',
      'openAfter',
      'openBefore',
      'planFingerprint',
      'ready',
      'wouldInsert',
    ]);
  });

  it('pins the exact confirmed-receipt key set — no undocumented field can leak in (M4)', () => {
    const fixture = installFixture();
    const result = captureRun(argsFor(fixture, ['--confirm']));

    expect(Object.keys(result.output).sort()).toEqual(['dryRun', 'ok', 'receipt']);
    expect(Object.keys(result.output['receipt'] as Record<string, unknown>).sort()).toEqual([
      'catchupSeqFingerprint',
      'conversationFingerprint',
      'evidenceBasis',
      'idempotent',
      'inserted',
      'nSourceSeqs',
      'openAfter',
      'openBefore',
      'planFingerprint',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Issue #2457: redaction fingerprint properties.
// ─────────────────────────────────────────────────────────────────────────
describe('redactFingerprint (issue #2457 redaction layer)', () => {
  const saltA = Buffer.from('a'.repeat(64), 'hex'); // 32 bytes
  const saltB = Buffer.from('b'.repeat(64), 'hex'); // 32 bytes, distinct from saltA

  it('is deterministic: same salt + domain + value always produces the same handle', () => {
    const a = redactFingerprint(saltA, 'plan', 'secret-plan-id-123');
    const b = redactFingerprint(saltA, 'plan', 'secret-plan-id-123');
    expect(a).toBe(b);
  });

  it('is domain-separated: same value in different domains produces different handles', () => {
    const planFp = redactFingerprint(saltA, 'plan', 'shared-text');
    const convFp = redactFingerprint(saltA, 'conversation', 'shared-text');
    expect(planFp).not.toBe(convFp);
  });

  it('is salt-separated: two different salts produce different handles for the identical domain+value', () => {
    const fpA = redactFingerprint(saltA, 'plan', 'same-value');
    const fpB = redactFingerprint(saltB, 'plan', 'same-value');
    expect(fpA).not.toBe(fpB);
  });

  it('produces a 12-character hex handle', () => {
    expect(redactFingerprint(saltA, 'plan', 'x')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('does not leak the raw value in the fingerprint', () => {
    const fp = redactFingerprint(saltA, 'plan', 'SUPER_SECRET_PLAN_ID_LEAK');
    expect(fp).not.toContain('SUPER');
    expect(fp).not.toContain('SECRET');
    expect(fp).not.toContain('PLAN');
    expect(fp).not.toContain('LEAK');
  });

  it('produces different handles for different values in the same domain', () => {
    const a = redactFingerprint(saltA, 'plan', 'plan-A');
    const b = redactFingerprint(saltA, 'plan', 'plan-B');
    expect(a).not.toBe(b);
  });

  it('works with numeric values (catchup sequences)', () => {
    expect(redactFingerprint(saltA, 'catchup-seq', 42)).toMatch(/^[0-9a-f]{12}$/);
    expect(redactFingerprint(saltA, 'catchup-seq', 42)).toBe(redactFingerprint(saltA, 'catchup-seq', 42));
  });

  // ── The actual security property (issue #2457's stated defect) ──────────
  it('is NOT recoverable by offline enumeration of the small catchup-seq preimage space', () => {
    // Simulates an attacker who captured only a fingerprint from CLI output
    // and knows catch-up sequences are small, plausible integers — exactly
    // the enumeration attack #2457 exists to defeat. This helper is the OLD
    // algorithm this fix replaces: plain domain-separated SHA-256, no
    // per-database key. If the CLI's real output can be matched by brute
    // force with THIS helper, the fingerprint is reversible without the
    // salt file — the exact defect this fix closes.
    function unsaltedFingerprint(domain: string, value: number): string {
      return createHash('sha256').update(`${domain}:`).update(String(value)).digest('hex').slice(0, 12);
    }

    const fixture = installFixture();
    const result = captureRun(argsFor(fixture));
    const catchupSeqFingerprint = result.output['catchupSeqFingerprint'] as string;

    // Enumerate a window that CONTAINS the real seeded value (FIXTURE_SEQ_BASE
    // + 100) — if the CLI were still using the unsalted algorithm, this would
    // find it immediately. With the HMAC salt, the same fingerprint cannot be
    // reproduced by this offline attacker who lacks the salt file.
    let recovered: number | undefined;
    for (let candidate = FIXTURE_SEQ_BASE; candidate <= FIXTURE_SEQ_BASE + 200; candidate += 1) {
      if (unsaltedFingerprint('catchup-seq', candidate) === catchupSeqFingerprint) {
        recovered = candidate;
        break;
      }
    }
    expect(recovered).toBeUndefined();
    // Positive proof alongside the negative one: the CLI's real fingerprint
    // is exactly the HMAC of the true value under the salt file it created —
    // this isn't merely "unmatched by the attacker's guesses", it is the
    // documented keyed algorithm applied to the real seeded seq.
    const salt = loadOrCreateRedactionSalt(fixture.dbPath);
    expect(catchupSeqFingerprint).toBe(redactFingerprint(salt, 'catchup-seq', fixture.catchupSeq));
  });

  // ── Salt file lifecycle ──────────────────────────────────────────────────
  it('creates a 32-byte salt file mode 0600 adjacent to the database on first use', () => {
    const fixture = installFixture();
    const saltPath = `${fixture.dbPath}.redaction-salt`;
    expect(existsSync(saltPath)).toBe(false);

    const salt = loadOrCreateRedactionSalt(fixture.dbPath);

    expect(salt).toHaveLength(32);
    expect(existsSync(saltPath)).toBe(true);
    expect(statSync(saltPath).mode & 0o777).toBe(0o600);
  });

  it('reuses an existing salt file rather than regenerating it', () => {
    const fixture = installFixture();
    const first = loadOrCreateRedactionSalt(fixture.dbPath);
    const second = loadOrCreateRedactionSalt(fixture.dbPath);

    expect(second.equals(first)).toBe(true);
  });

  it('produces stable fingerprints across separate CLI invocations against the same database', () => {
    const fixture = installFixture();
    const first = captureRun(argsFor(fixture));
    const second = captureRun(argsFor(fixture));

    expect(second.output['planFingerprint']).toBe(first.output['planFingerprint']);
    expect(second.output['conversationFingerprint']).toBe(first.output['conversationFingerprint']);
    expect(second.output['catchupSeqFingerprint']).toBe(first.output['catchupSeqFingerprint']);
  });

  it('produces DIFFERENT fingerprints for the identical value across two databases (two salt files)', () => {
    const fixtureOne = installFixture();
    const fixtureTwo = installFixture();
    // Both fixtures use the same hardcoded planId/conversationKey text —
    // installFixture() is deterministic — so any difference in fingerprint
    // is attributable ONLY to the two databases' independent salt files.
    expect(fixtureOne.planId).toBe(fixtureTwo.planId);

    const saltOne = loadOrCreateRedactionSalt(fixtureOne.dbPath);
    const saltTwo = loadOrCreateRedactionSalt(fixtureTwo.dbPath);
    expect(saltOne.equals(saltTwo)).toBe(false);

    const fpOne = redactFingerprint(saltOne, 'plan', fixtureOne.planId);
    const fpTwo = redactFingerprint(saltTwo, 'plan', fixtureTwo.planId);
    expect(fpOne).not.toBe(fpTwo);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FIX 3: subprocess-level error path — the top-level module-invocation guard
// (`if (import.meta.url === invokedPath)`) only runs when the file is the
// real process entrypoint, never when imported for in-process calls like
// `runCloseRecoveryCatchupCli` above. It needs a real subprocess to exercise.
// ─────────────────────────────────────────────────────────────────────────
describe('CLI subprocess error path (module-invocation guard)', () => {
  it('emits a bounded invalid_proof errorCode with a real correlation and no raw identifiers in stderr', () => {
    const fixture = installFixture(false); // no echoed delivery proof

    const result = runCliSubprocess(argsFor(fixture));
    const salt = loadOrCreateRedactionSalt(fixture.dbPath);

    expect(result.code).toBe(1);
    const jsonLine = result.stderr.trim().split('\n').at(-1)!;
    const parsed = JSON.parse(jsonLine) as {
      ok: boolean;
      errorCode: string;
      correlation?: { planFingerprint: string; conversationFingerprint: string };
    };
    expect(Object.keys(parsed).sort()).toEqual(['correlation', 'errorCode', 'ok']);
    expect(parsed.ok).toBe(false);
    expect(parsed.errorCode).toBe('invalid_proof');
    // Correlation is the REAL plan/conversation fingerprint (same salt, same
    // algorithm the dry-run/receipt output uses) — not junk.
    expect(parsed.correlation?.planFingerprint).toBe(redactFingerprint(salt, 'plan', fixture.planId));
    expect(parsed.correlation?.conversationFingerprint).toBe(
      redactFingerprint(salt, 'conversation', fixture.conversationKey),
    );
    // The static message for this path ("Catch-up reply must have echoed
    // delivery proof") never interpolates plan/conversation/actor/evidence —
    // safe to assert across the FULL stderr output, not just the JSON line.
    expect(result.stderr).not.toContain('operator:private');
    expect(result.stderr).not.toContain('secret://must-not-echo');
    expect(result.stderr).not.toContain(fixture.planId);
    expect(result.stderr).not.toContain(fixture.conversationKey);
    expect(result.stderr).not.toContain(String(fixture.catchupSeq));
    expect(result.stderr).not.toContain(String(fixture.sourceSeqs[0]));
    // FIX 3c: the raw message IS expected to appear, printed as its own
    // non-JSON line for operator debuggability (the prior comment claiming
    // it "stays in scrollback" was false — it was never printed anywhere).
    expect(result.stderr).toContain('Catch-up reply must have echoed delivery proof');
    expect(closureCount(fixture.dbPath)).toBe(0);
  });

  it('emits a bounded busy_writer errorCode when another writer holds the database', () => {
    const fixture = installFixture();
    const blocker = new DatabaseSync(fixture.dbPath);
    let result: { code: number; stdout: string; stderr: string };
    try {
      blocker.exec('BEGIN IMMEDIATE');
      // SQLITE_BUSY_TIMEOUT_PRAGMA is a fixed 5000ms — the subprocess must
      // exhaust that wait before reporting busy_writer (see the extended
      // test timeout below).
      result = runCliSubprocess(argsFor(fixture, ['--confirm']));
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    const salt = loadOrCreateRedactionSalt(fixture.dbPath);

    expect(result.code).toBe(1);
    const jsonLine = result.stderr.trim().split('\n').at(-1)!;
    const parsed = JSON.parse(jsonLine) as {
      ok: boolean;
      errorCode: string;
      correlation?: { planFingerprint: string; conversationFingerprint: string };
    };
    expect(Object.keys(parsed).sort()).toEqual(['correlation', 'errorCode', 'ok']);
    expect(parsed.ok).toBe(false);
    expect(parsed.errorCode).toBe('busy_writer');
    expect(parsed.correlation?.planFingerprint).toBe(redactFingerprint(salt, 'plan', fixture.planId));
    // "database is locked" never interpolates private data — safe to assert
    // across the full stderr output.
    expect(result.stderr).not.toContain('operator:private');
    expect(result.stderr).not.toContain('secret://must-not-echo');
    expect(result.stderr).not.toContain(fixture.planId);
    expect(result.stderr).not.toContain(fixture.conversationKey);
    expect(result.stderr).toMatch(/locked/i);
    expect(closureCount(fixture.dbPath)).toBe(0);
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────
// classifyError: direct unit coverage of the full matcher table (the two
// subprocess tests above only exercise invalid_proof and busy_writer end to
// end; this covers the remaining branches — changed_evidence, changed_file,
// io, invalid_args, and unknown — plus the errcode-based sqlite detection).
// PINNING tests: classifyError already exists and is already correct by the
// time these are written (same implementation the subprocess tests above
// drove RED-then-GREEN), so there is no separate RED state here.
// ─────────────────────────────────────────────────────────────────────────
describe('classifyError (bounded error-code taxonomy)', () => {
  it.each([
    ['Recovery plan ID is required', 'invalid_args'],
    ['Unknown argument: --bogus', 'invalid_args'],
    ['Duplicate argument: --db', 'invalid_args'],
    ['Source sequence must be a positive safe integer', 'invalid_args'],
    ['Source sequence set contains duplicates', 'invalid_args'],
    ['Expected source sequence set is required', 'invalid_args'],
    ['Expected source sequence set contains duplicates', 'invalid_args'],
    ['Recovery evidence reference exceeds 8192 bytes', 'invalid_args'],
    ['Usage: close-recovery-catchup --db PATH ...', 'invalid_args'],
    ['Database must include canonical schema 43 receipts', 'invalid_proof'],
    ['Database must include contiguous schema 43+ receipts (migrations 1 through current)', 'invalid_proof'],
    ['canonical schema 43 receipt is missing', 'invalid_proof'],
    ['canonical schema 43 objects are missing or drifted: operator_catchup_closure_witness_append_only_update', 'invalid_proof'],
    ['Recovery plan does not exist', 'invalid_proof'],
    ['Expected source sequences must exactly match the pending recovery set', 'invalid_proof'],
    ['Catch-up sequence must be later than every source sequence', 'invalid_proof'],
    ['Closed recovery lacks its exact durable proof witness', 'invalid_proof'],
    ['Catch-up inbound does not exist in the recovery conversation', 'invalid_proof'],
    ['Catch-up inbound must be complete', 'invalid_proof'],
    ['Catch-up reply must have echoed delivery proof', 'invalid_proof'],
    ['Catch-up closure did not resolve the exact recovery set', 'invalid_proof'],
    ['Catch-up closure did not persist its exact proof witness', 'invalid_proof'],
    ['Recovery was already closed against a different catch-up or evidence', 'changed_evidence'],
    ['Database path changed after read-only preflight', 'changed_file'],
    ['database is locked', 'busy_writer'],
    ['database table is locked', 'busy_writer'],
    ['Database path must be an existing regular file: /tmp/typo.db', 'io'],
    ['unable to open database file', 'io'],
    ['some unrecognized message text', 'unknown'],
  ] as const)('classifies %j as %s', (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });

  it('classifies via node:sqlite .errcode when present, ahead of message text', () => {
    // SQLITE_BUSY / SQLITE_LOCKED — real node:sqlite errors carry these
    // exact fields (verified empirically: constructor.name is "Error",
    // .code is the string 'ERR_SQLITE_ERROR', .errcode is the numeric
    // SQLite result code).
    expect(classifyError(Object.assign(new Error('database is locked'), {
      code: 'ERR_SQLITE_ERROR', errcode: 5,
    }))).toBe('busy_writer');
    expect(classifyError(Object.assign(new Error('database table is locked'), {
      code: 'ERR_SQLITE_ERROR', errcode: 6,
    }))).toBe('busy_writer');
    // SQLITE_CANTOPEN
    expect(classifyError(Object.assign(new Error('unable to open database file'), {
      code: 'ERR_SQLITE_ERROR', errcode: 14,
    }))).toBe('io');
  });

  it('falls back to unknown for a non-Error thrown value', () => {
    expect(classifyError('a bare string throw')).toBe('unknown');
    expect(classifyError({ unrelated: true })).toBe('unknown');
    expect(classifyError(undefined)).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #3903 failed-source mode: an inbound that ended processing_status='failed'
// with a failed_terminal record and no delivery never receives a
// recovery_pending_operator_catchup link (startup recovery writes those for
// open rows only), so the plain closure cannot close it. --failed-source
// creates the operator plan and pending link and performs the existing
// closure in one writer transaction, without touching the source rows.
// ─────────────────────────────────────────────────────────────────────────
const FAILED_SOURCE_SEQ = 910_001;
const FAILED_CATCHUP_SEQ = 910_050;
const FAILED_CHAT = 'failed-source@g.us';
const FAILED_CONVERSATION = 'conversation-failed-source';
const FAILED_PLAN = 'plan-failed-source';
const FAILED_ACTOR = 'operator:failed-source';
const FAILED_EVIDENCE = 'evidence://failed-source/catchup';

type SourceTerminalShape =
  | 'failed_none'
  | 'none'
  | 'failed_with_delivery'
  | 'disarmed'
  | 'operator_cancelled'
  | 'second_record';

interface FailedSourceRowsOptions {
  status?: 'failed' | 'complete' | 'processing';
  conversationKey?: string;
  chatJid?: string;
  terminal?: SourceTerminalShape;
  /** attempt_failure_class of a non-cancelled failure; defaults to 'session_crash'. */
  attemptFailureClass?: string;
}

/** One source inbound and its terminal record(s), shaped like a crashed turn by default. */
function insertFailedSourceRows(
  raw: DatabaseSync,
  seq: number,
  options: FailedSourceRowsOptions = {},
): void {
  const {
    status = 'failed',
    conversationKey = FAILED_CONVERSATION,
    chatJid = FAILED_CHAT,
    terminal = 'failed_none',
    attemptFailureClass = 'session_crash',
  } = options;
  raw.prepare(`
    INSERT INTO inbound_events (
      seq, message_id, conversation_key, chat_jid, processing_status, completed_at,
      terminal_reason, failure_class
    ) VALUES (?, ?, ?, ?, ?,
              CASE WHEN ? = 'processing' THEN NULL ELSE datetime('now') END,
              CASE WHEN ? = 'failed' THEN 'error' WHEN ? = 'complete' THEN 'response_sent' ELSE NULL END,
              CASE WHEN ? = 'failed' THEN 'session_crash' ELSE NULL END)
  `).run(seq, `failed-source-${seq}`, conversationKey, chatJid, status, status, status, status, status);
  if (terminal === 'none') return;

  // The schema's turn_terminal_disarm_evidence CHECK allows a disarmed
  // failed_terminal only with echoed delivery, so 'disarmed' carries one.
  const deliveredStatus = terminal === 'failed_with_delivery'
    ? 'submitted'
    : terminal === 'disarmed' ? 'echoed' : null;
  let deliveryOpId: number | null = null;
  if (deliveredStatus !== null) {
    deliveryOpId = Number(raw.prepare(`
      INSERT INTO outbound_ops (
        conversation_key, chat_jid, op_type, payload, status,
        source_inbound_seq, is_terminal, replay_policy
      ) VALUES (?, ?, 'text', '{"text":"partial"}', ?, ?, 1, 'unsafe')
    `).run(conversationKey, chatJid, deliveredStatus, seq).lastInsertRowid);
  }
  raw.prepare(`
    INSERT INTO turn_terminal_records (
      scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
      logical_turn_id, manager_id, generation, attempt_kind, attempt_failure_class,
      inbound_disposition, delivery_kind, delivery_op_id, reply_guarantee_disarmed
    ) VALUES ('per_chat', ?, ?, ?, ?, ?, 'failed-manager', 1,
              'failed', ?, 'failed_terminal', ?, ?, ?)
  `).run(
    conversationKey,
    chatJid,
    seq,
    seq,
    `failed-turn-${seq}`,
    terminal === 'operator_cancelled' ? 'operator_cancelled' : attemptFailureClass,
    terminal === 'failed_with_delivery' ? 'flushed' : terminal === 'disarmed' ? 'echoed' : 'none',
    deliveryOpId,
    terminal === 'disarmed' ? 1 : 0,
  );
  if (terminal === 'second_record') {
    raw.prepare(`
      INSERT INTO turn_terminal_records (
        scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
        logical_turn_id, manager_id, generation, attempt_kind,
        inbound_disposition, delivery_kind, reply_guarantee_disarmed
      ) VALUES ('per_chat', ?, ?, ?, ?, ?, 'second-manager', 1,
                'initial', 'finalized_no_reply_policy', 'none', 0)
    `).run(conversationKey, chatJid, seq, seq, `second-turn-${seq}`);
  }
}

interface FailedSourceFixtureOptions {
  sourceStatus?: 'failed' | 'complete' | 'processing';
  sourceConversationKey?: string;
  sourceChatJid?: string;
  sourceTerminal?: SourceTerminalShape;
  sourceAttemptFailureClass?: string;
  /** Further sources in the closure set, each with its own shape. */
  extraSources?: Array<{ seq: number } & FailedSourceRowsOptions>;
  catchupStatus?: 'complete' | 'processing';
  catchupConversationKey?: string;
  echoed?: boolean;
}

interface FailedSourceFixture {
  dbPath: string;
  planId: string;
  conversationKey: string;
  sourceSeq: number;
  sourceSeqs: number[];
  catchupSeq: number;
}

function installFailedSourceFixture(options: FailedSourceFixtureOptions = {}): FailedSourceFixture {
  const {
    sourceStatus = 'failed',
    sourceConversationKey = FAILED_CONVERSATION,
    sourceChatJid = FAILED_CHAT,
    sourceTerminal = 'failed_none',
    sourceAttemptFailureClass = 'session_crash',
    extraSources = [],
    catchupStatus = 'complete',
    catchupConversationKey = FAILED_CONVERSATION,
    echoed = true,
  } = options;
  const dbPath = path.join(makeTempRoot(), 'bot.db');
  const db = new Database(dbPath);
  db.open();
  insertFailedSourceRows(db.raw, FAILED_SOURCE_SEQ, {
    status: sourceStatus,
    conversationKey: sourceConversationKey,
    chatJid: sourceChatJid,
    terminal: sourceTerminal,
    attemptFailureClass: sourceAttemptFailureClass,
  });
  for (const { seq, ...sourceOptions } of extraSources) {
    insertFailedSourceRows(db.raw, seq, sourceOptions);
  }

  db.raw.prepare(`
    INSERT INTO inbound_events (
      seq, message_id, conversation_key, chat_jid, processing_status,
      completed_at, terminal_reason
    ) VALUES (?, 'failed-source-catchup', ?, ?, ?,
              CASE WHEN ? = 'complete' THEN datetime('now') ELSE NULL END,
              CASE WHEN ? = 'complete' THEN 'response_sent' ELSE NULL END)
  `).run(FAILED_CATCHUP_SEQ, catchupConversationKey, FAILED_CHAT, catchupStatus, catchupStatus, catchupStatus);
  const opId = Number(db.raw.prepare(`
    INSERT INTO outbound_ops (
      conversation_key, chat_jid, op_type, payload, status,
      source_inbound_seq, is_terminal, replay_policy, echoed_at
    ) VALUES (?, ?, 'text', '{"text":"continued"}', ?,
              ?, 1, 'unsafe', CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END)
  `).run(
    catchupConversationKey,
    FAILED_CHAT,
    echoed ? 'echoed' : 'submitted',
    FAILED_CATCHUP_SEQ,
    echoed ? 1 : 0,
  ).lastInsertRowid);
  db.raw.prepare(`
    INSERT INTO turn_terminal_records (
      scope, conversation_key, delivery_jid, inbound_seq, inbound_seq_key,
      logical_turn_id, manager_id, generation, attempt_kind,
      inbound_disposition, delivery_kind, delivery_op_id,
      reply_guarantee_disarmed
    ) VALUES ('per_chat', ?, ?, ?, ?, 'catchup-turn', 'catchup-manager', 1,
              'replied', 'finalized_replied', ?, ?, ?)
  `).run(
    catchupConversationKey,
    FAILED_CHAT,
    FAILED_CATCHUP_SEQ,
    FAILED_CATCHUP_SEQ,
    echoed ? 'echoed' : 'enqueued',
    opId,
    echoed ? 1 : 0,
  );
  db.close();
  return {
    dbPath,
    planId: FAILED_PLAN,
    conversationKey: FAILED_CONVERSATION,
    sourceSeq: FAILED_SOURCE_SEQ,
    sourceSeqs: [FAILED_SOURCE_SEQ, ...extraSources.map(({ seq }) => seq)],
    catchupSeq: FAILED_CATCHUP_SEQ,
  };
}

function failedSourceArgs(
  fixture: FailedSourceFixture,
  extra: readonly string[] = [],
  overrides: { planId?: string; catchupSeq?: number; evidenceRef?: string } = {},
): string[] {
  return [
    '--db', fixture.dbPath,
    '--plan-id', overrides.planId ?? fixture.planId,
    '--conversation-key', fixture.conversationKey,
    '--source-seqs', fixture.sourceSeqs.join(','),
    '--catchup-seq', String(overrides.catchupSeq ?? fixture.catchupSeq),
    '--actor', FAILED_ACTOR,
    '--evidence-ref', overrides.evidenceRef ?? FAILED_EVIDENCE,
    '--failed-source',
    ...extra,
  ];
}

function failedSourceParams(
  fixture: FailedSourceFixture,
  overrides: { planId?: string } = {},
): Parameters<typeof closeFailedSourceOperatorCatchupRecoveryRaw>[1] {
  return {
    planId: overrides.planId ?? fixture.planId,
    conversationKey: fixture.conversationKey,
    expectedSourceSeqs: fixture.sourceSeqs,
    catchupSeq: fixture.catchupSeq,
    actor: FAILED_ACTOR,
    evidenceRef: FAILED_EVIDENCE,
  };
}

interface RecoveryStateSnapshot {
  plans: number;
  pending: number;
  closures: number;
  witnesses: number;
  recoveryJobs: number;
  outboundOps: number;
  sourceRows: unknown[];
  sourceTerminals: unknown[];
  sourceRecoveryJobs: unknown[];
  sourceOutboundOps: unknown[];
}

/** Row counts plus every row that belongs to the fixture's source set. */
function recoveryState(fixture: FailedSourceFixture): RecoveryStateSnapshot {
  const raw = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    const count = (sql: string): number => Number((raw.prepare(sql).get() as { count: number }).count);
    const seqs = fixture.sourceSeqs;
    const placeholders = seqs.map(() => '?').join(', ');
    const rows = (sql: string): unknown[] => raw.prepare(sql).all(...seqs);
    return {
      plans: count('SELECT COUNT(*) AS count FROM recovery_plans'),
      pending: count(`SELECT COUNT(*) AS count FROM inbound_disposition_links
                      WHERE disposition = 'recovery_pending_operator_catchup'`),
      closures: count(`SELECT COUNT(*) AS count FROM inbound_disposition_links
                       WHERE disposition = 'superseded_by_operator_catchup'`),
      witnesses: count('SELECT COUNT(*) AS count FROM operator_catchup_closure_witnesses'),
      recoveryJobs: count('SELECT COUNT(*) AS count FROM turn_recovery_jobs'),
      outboundOps: count('SELECT COUNT(*) AS count FROM outbound_ops'),
      sourceRows: rows(`SELECT * FROM inbound_events WHERE seq IN (${placeholders}) ORDER BY seq`),
      sourceTerminals: rows(`
        SELECT * FROM turn_terminal_records WHERE inbound_seq_key IN (${placeholders}) ORDER BY id
      `),
      sourceRecoveryJobs: rows(`
        SELECT * FROM turn_recovery_jobs WHERE source_inbound_seq IN (${placeholders}) ORDER BY id
      `),
      sourceOutboundOps: rows(`
        SELECT * FROM outbound_ops WHERE source_inbound_seq IN (${placeholders}) ORDER BY id
      `),
    };
  } finally {
    raw.close();
  }
}

function withWritableFixture(fixture: FailedSourceFixture, write: (raw: DatabaseSync) => void): void {
  const raw = new DatabaseSync(fixture.dbPath);
  try {
    raw.exec('PRAGMA foreign_keys = ON');
    write(raw);
  } finally {
    raw.close();
  }
}

/** A pending recovery job owning the source's reply, keyed to its terminal record. */
function insertPendingRecoveryJob(raw: DatabaseSync, seq: number): void {
  const changes = Number(raw.prepare(`
    INSERT INTO turn_recovery_jobs (
      terminal_record_id, scope, conversation_key, delivery_jid,
      source_inbound_seq, source_inbound_seq_key,
      source_logical_turn_id, source_manager_id, source_generation, source_message_id,
      owner_logical_turn_id, owner_manager_id, owner_generation,
      assigned_owner_logical_turn_id, assigned_owner_manager_id, assigned_owner_generation,
      replay_safe, sender_jid, replay_text, is_group, state
    )
    SELECT t.id, t.scope, t.conversation_key, t.delivery_jid,
           t.inbound_seq, t.inbound_seq,
           t.logical_turn_id, t.manager_id, t.generation, i.message_id,
           'owner-turn', 'owner-manager', 1,
           'owner-turn', 'owner-manager', 1,
           1, 'sender@s.whatsapp.net', 'replay text', 1, 'pending'
    FROM turn_terminal_records t
    JOIN inbound_events i ON i.seq = t.inbound_seq
    WHERE t.inbound_seq_key = ?
  `).run(seq).changes);
  expect(changes).toBe(1);
}

/**
 * Make the failed source the catch-up target of an earlier recovery. The
 * closure trigger admits only a complete, delivered target, so the trigger is
 * set aside and restored from its exact stored DDL. The link then has no
 * closure witness (a witness needs a delivery proof, which a failed target
 * cannot have), so the canonical schema-43 attestation rejects the database
 * before the failed-source guard is reached.
 */
function insertLinkSupersededBySource(raw: DatabaseSync, seq: number): void {
  const earlierSeq = seq - 1;
  insertFailedSourceRows(raw, earlierSeq);
  raw.prepare(`
    INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
    VALUES ('plan-earlier', 'operator', 'operator:earlier', 'earlier recovery', 'test://earlier')
  `).run();
  raw.prepare(`
    INSERT INTO inbound_disposition_links (
      inbound_seq, recovery_plan_id, disposition, superseded_by_seq, reason, evidence_ref, actor
    ) VALUES (?, 'plan-earlier', 'recovery_pending_operator_catchup', NULL,
              'earlier pending', 'test://earlier', 'operator:earlier')
  `).run(earlierSeq);
  const trigger = raw.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'trigger' AND name = 'inbound_disposition_closure_validate_insert'
  `).get() as { sql: string };
  raw.exec('DROP TRIGGER inbound_disposition_closure_validate_insert');
  try {
    raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq, reason, evidence_ref, actor
      ) VALUES (?, 'plan-earlier', 'superseded_by_operator_catchup', ?,
                'legacy closure', 'test://earlier', 'operator:earlier')
    `).run(earlierSeq, seq);
  } finally {
    raw.exec(trigger.sql);
  }
}

function insertForeignPendingLink(dbPath: string, sourceSeq: number, planId: string): void {
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('PRAGMA foreign_keys = ON');
    raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
      VALUES (?, 'post_connect_recovery', 'durability_recovery', 'startup', 'recovery_run:1')
    `).run(planId);
    raw.prepare(`
      INSERT INTO inbound_disposition_links (
        inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
        reason, evidence_ref, actor
      ) VALUES (?, ?, 'recovery_pending_operator_catchup', NULL,
                'startup pending', 'recovery_run:1', 'durability_recovery')
    `).run(sourceSeq, planId);
  } finally {
    raw.close();
  }
}

describe('close-recovery-catchup --failed-source (#3903)', () => {
  it('parses --failed-source once as a boolean mode flag', () => {
    const fixture = installFailedSourceFixture();
    expect(parseCloseRecoveryArgs(failedSourceArgs(fixture))).toMatchObject({
      failedSource: true,
      confirm: false,
    });
    const plainArgs = failedSourceArgs(fixture).filter((arg) => arg !== '--failed-source');
    expect(parseCloseRecoveryArgs(plainArgs)).toMatchObject({ failedSource: false });
    expect(() => parseCloseRecoveryArgs([...failedSourceArgs(fixture), '--failed-source']))
      .toThrow('Duplicate argument: --failed-source');
  });

  it('without --failed-source a failed source that has no pending link stays refused', () => {
    const fixture = installFailedSourceFixture();
    const before = recoveryState(fixture);
    const argv = failedSourceArgs(fixture, ['--confirm']).filter((arg) => arg !== '--failed-source');

    expect(() => runCloseRecoveryCatchupCli(argv)).toThrow('Recovery plan does not exist');
    expect(recoveryState(fixture)).toEqual(before);
  });

  it('dry run validates the failed source and the catch-up proof and writes nothing', () => {
    const fixture = installFailedSourceFixture();
    const before = recoveryState(fixture);

    const result = captureRun(failedSourceArgs(fixture));

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      ok: true,
      dryRun: true,
      ready: true,
      nSourceSeqs: 1,
      evidenceBasis: 'selected_echoed',
      wouldInsert: 1,
      idempotent: false,
      openAfter: 0,
    });
    expect(result.text).not.toContain(FAILED_EVIDENCE);
    expect(result.text).not.toContain(String(fixture.sourceSeq));
    expect(recoveryState(fixture)).toEqual(before);
  });

  it('confirm creates exactly one plan, one pending link and one closure and preserves the source rows', () => {
    const fixture = installFailedSourceFixture();
    const before = recoveryState(fixture);
    expect(before).toMatchObject({ plans: 0, pending: 0, closures: 0, witnesses: 0 });

    const result = captureRun(failedSourceArgs(fixture, ['--confirm']));

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      ok: true,
      dryRun: false,
      receipt: { nSourceSeqs: 1, inserted: 1, idempotent: false, openAfter: 0 },
    });
    const after = recoveryState(fixture);
    expect(after).toMatchObject({
      plans: 1,
      pending: 1,
      closures: 1,
      witnesses: 1,
      outboundOps: before.outboundOps,
    });
    // The original failure, its failure class and its attempt record are untouched.
    expect(after.sourceRows).toHaveLength(1);
    expect(after.sourceRows).toEqual(before.sourceRows);
    expect(after.sourceTerminals).toEqual(before.sourceTerminals);
    expect(after.sourceTerminals).toHaveLength(1);
    expect(after.sourceRecoveryJobs).toEqual(before.sourceRecoveryJobs);
    expect(after.sourceOutboundOps).toEqual(before.sourceOutboundOps);

    const raw = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      expect(raw.prepare(`
        SELECT plan_id, origin, actor, evidence_ref FROM recovery_plans
      `).get()).toEqual({
        plan_id: FAILED_PLAN,
        origin: 'operator',
        actor: FAILED_ACTOR,
        evidence_ref: FAILED_EVIDENCE,
      });
      expect(raw.prepare(`
        SELECT inbound_seq, recovery_plan_id, disposition, superseded_by_seq, actor, evidence_ref
        FROM inbound_disposition_links ORDER BY id
      `).all()).toEqual([
        {
          inbound_seq: fixture.sourceSeq,
          recovery_plan_id: FAILED_PLAN,
          disposition: 'recovery_pending_operator_catchup',
          superseded_by_seq: null,
          actor: FAILED_ACTOR,
          evidence_ref: FAILED_EVIDENCE,
        },
        {
          inbound_seq: fixture.sourceSeq,
          recovery_plan_id: FAILED_PLAN,
          disposition: 'superseded_by_operator_catchup',
          superseded_by_seq: fixture.catchupSeq,
          actor: FAILED_ACTOR,
          evidence_ref: FAILED_EVIDENCE,
        },
      ]);
    } finally {
      raw.close();
    }
  });

  it('duplicate: the same confirmed request twice is an idempotent no-op', () => {
    const fixture = installFailedSourceFixture();
    captureRun(failedSourceArgs(fixture, ['--confirm']));
    const afterFirst = recoveryState(fixture);

    const dryReplay = captureRun(failedSourceArgs(fixture));
    expect(dryReplay.output).toMatchObject({ ready: true, wouldInsert: 0, idempotent: true });
    const replay = captureRun(failedSourceArgs(fixture, ['--confirm']));

    expect(replay.output).toMatchObject({
      ok: true,
      dryRun: false,
      receipt: { inserted: 0, idempotent: true, openAfter: 0 },
    });
    expect(recoveryState(fixture)).toEqual(afterFirst);
  });

  it.each([
    ['a different evidence ref', { evidenceRef: 'evidence://failed-source/other' }],
    ['a different catch-up seq', { catchupSeq: FAILED_CATCHUP_SEQ + 1 }],
  ] as const)('changed evidence: a rerun with %s after closure is refused', (_label, overrides) => {
    const fixture = installFailedSourceFixture();
    captureRun(failedSourceArgs(fixture, ['--confirm']));
    const afterFirst = recoveryState(fixture);

    for (const extra of [[], ['--confirm']]) {
      expect(() => runCloseRecoveryCatchupCli(failedSourceArgs(fixture, extra, overrides)))
        .toThrow('Recovery was already closed against a different catch-up or evidence');
    }
    expect(recoveryState(fixture)).toEqual(afterFirst);
  });

  it('changed plan: a second plan for an already-closed failed source is refused', () => {
    const fixture = installFailedSourceFixture();
    captureRun(failedSourceArgs(fixture, ['--confirm']));
    const afterFirst = recoveryState(fixture);

    expect(() => runCloseRecoveryCatchupCli(
      failedSourceArgs(fixture, ['--confirm'], { planId: 'plan-failed-source-second' }),
    )).toThrow('Failed source inbound already has a disposition link');
    expect(recoveryState(fixture)).toEqual(afterFirst);
  });

  it('changed plan: a plan ID that already names another recovery is refused', () => {
    const fixture = installFailedSourceFixture();
    const raw = new DatabaseSync(fixture.dbPath);
    raw.prepare(`
      INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
      VALUES (?, 'operator', 'operator:other', 'unrelated plan', 'test://other')
    `).run(fixture.planId);
    raw.close();
    const before = recoveryState(fixture);

    for (const extra of [[], ['--confirm']]) {
      expect(() => runCloseRecoveryCatchupCli(failedSourceArgs(fixture, extra)))
        .toThrow('Failed-source recovery plan already exists');
    }
    expect(recoveryState(fixture)).toEqual(before);
  });

  it.each([
    [
      'the source in another conversation',
      { sourceConversationKey: 'conversation-other' },
      'Failed source inbound does not exist in the recovery conversation',
    ],
    [
      'the catch-up in another conversation',
      { catchupConversationKey: 'conversation-other' },
      'Catch-up inbound does not exist in the recovery conversation',
    ],
    [
      'the source in another chat of the same conversation',
      { sourceChatJid: 'other-chat@g.us' },
      'Failed source inbound must share the catch-up chat',
    ],
  ] as const)('wrong chat: refuses %s', (_label, options, message) => {
    const fixture = installFailedSourceFixture(options);
    const before = recoveryState(fixture);

    for (const extra of [[], ['--confirm']]) {
      expect(() => runCloseRecoveryCatchupCli(failedSourceArgs(fixture, extra))).toThrow(message);
    }
    expect(recoveryState(fixture)).toEqual(before);
  });

  it.each([
    ['a complete source', { sourceStatus: 'complete' }, 'Failed source inbound must be failed'],
    ['a processing source', { sourceStatus: 'processing' }, 'Failed source inbound must be failed'],
    [
      'a failed source with no terminal record',
      { sourceTerminal: 'none' },
      'Failed source inbound must have exactly one armed, undelivered failed terminal record',
    ],
    [
      'a failed source whose terminal record carries a delivery',
      { sourceTerminal: 'failed_with_delivery' },
      'Failed source inbound must have exactly one armed, undelivered failed terminal record',
    ],
    ['a catch-up that is not complete', { catchupStatus: 'processing' }, 'Catch-up inbound must be complete'],
  ] as const)('wrong target: refuses %s', (_label, options, message) => {
    const fixture = installFailedSourceFixture(options);
    const before = recoveryState(fixture);

    for (const extra of [[], ['--confirm']]) {
      expect(() => runCloseRecoveryCatchupCli(failedSourceArgs(fixture, extra))).toThrow(message);
    }
    expect(recoveryState(fixture)).toEqual(before);
  });

  it('missing echo: refuses a catch-up whose reply was not echoed', () => {
    const fixture = installFailedSourceFixture({ echoed: false });
    const before = recoveryState(fixture);

    for (const extra of [[], ['--confirm']]) {
      expect(() => runCloseRecoveryCatchupCli(failedSourceArgs(fixture, extra)))
        .toThrow('Catch-up reply must have echoed delivery proof');
    }
    expect(recoveryState(fixture)).toEqual(before);
  });

  const NOT_A_NOTICE_MESSAGE =
    'Failed source inbound has an outbound op that is not an echoed registered failure notice';
  const ACK_MISMATCH_MESSAGE =
    'Delivered-op acknowledgements must match the delivered failure-notice ops exactly';
  const TERMINAL_DEBT_MESSAGE =
    'Failed source inbound must have exactly one armed, undelivered failed terminal record';

  it.each([
    [
      'a source with a pending turn recovery job',
      {},
      (raw: DatabaseSync) => insertPendingRecoveryJob(raw, FAILED_SOURCE_SEQ),
      'Failed source inbound has a turn recovery job',
    ],
    ['a source with a second terminal record', { sourceTerminal: 'second_record' }, null, TERMINAL_DEBT_MESSAGE],
    ['a source whose failed terminal is disarmed', { sourceTerminal: 'disarmed' }, null, TERMINAL_DEBT_MESSAGE],
    ['an operator-cancelled failure', { sourceTerminal: 'operator_cancelled' }, null, TERMINAL_DEBT_MESSAGE],
    [
      // Unreachable on a canonical schema-43 database: the attestation refuses
      // an unwitnessed closure first. The guard's superseded_by_seq clause is
      // kept for parity with TerminalRecordInboundCloser.selectLinked.
      'a source that is already another recovery\'s catch-up target',
      {},
      (raw: DatabaseSync) => insertLinkSupersededBySource(raw, FAILED_SOURCE_SEQ),
      'has an unwitnessed closure',
    ],
  ] as const)('source guard: refuses %s', (_label, options, mutate, message) => {
    const fixture = installFailedSourceFixture(options);
    if (mutate) withWritableFixture(fixture, mutate);
    const before = recoveryState(fixture);

    for (const extra of [[], ['--confirm']]) {
      expect(() => runCloseRecoveryCatchupCli(failedSourceArgs(fixture, extra))).toThrow(message);
    }
    expect(recoveryState(fixture)).toEqual(before);
  });

  // ── Delivered source ops (#3903 lead corrections) ────────────────────────
  // Any source op not proven unsent (status other than failed_permanent) is
  // delivered-or-in-flight evidence. It closes only as an echoed, non-terminal
  // text op whose payload hash is a registered failure notice, acknowledged by
  // the keyed fingerprint the dry run lists. is_terminal = 1 marks a delivered
  // answer (markTerminal, chat runtime), never a notice. Ops are written
  // through the real DurabilityEngine API; raw op ids and payload hashes never
  // reach stdout (#2457).

  // Loaded at run time so a missing registry fails only the tests that use it.
  type FailureNotices = typeof import('../../src/core/agent-failure-notices.ts');
  let failureNotices: FailureNotices | undefined;
  beforeAll(async () => {
    try {
      failureNotices = await import('../../src/core/agent-failure-notices.ts');
    } catch {
      failureNotices = undefined;
    }
  });
  function notices(): FailureNotices {
    if (failureNotices === undefined) throw new Error('failure-notice registry is not available');
    return failureNotices;
  }

  /**
   * Seed outbound_ops so API-created ops get distinctive ids (>= 970001); a
   * small id would collide with counts and hex digits in a stdout canary.
   */
  const OP_ID_FLOOR = 970_000;
  function withDurability(fixture: FailedSourceFixture, use: (durability: DurabilityEngine) => void): void {
    const db = new Database(fixture.dbPath);
    db.open();
    try {
      db.raw.prepare(`
        INSERT OR IGNORE INTO outbound_ops (
          id, conversation_key, chat_jid, op_type, payload, status, is_terminal, replay_policy
        ) VALUES (?, 'unrelated', 'unrelated@g.us', 'text', '{"text":"seed"}', 'failed_permanent', 0, 'unsafe')
      `).run(OP_ID_FLOOR);
      use(new DurabilityEngine(db));
    } finally {
      db.close();
    }
  }

  type NoticeState = 'pending' | 'sending' | 'submitted' | 'maybe_sent' | 'quarantined' | 'echoed';

  /** Create a text op for the source and drive it to `state` through the API. */
  function sendSourceText(
    durability: DurabilityEngine,
    text: string,
    options: { isTerminal?: boolean; state?: NoticeState } = {},
  ): number {
    const state = options.state ?? 'echoed';
    const id = durability.createOutboundOp({
      conversationKey: FAILED_CONVERSATION,
      chatJid: FAILED_CHAT,
      opType: 'text',
      payload: JSON.stringify({ text }),
      replayPolicy: 'unsafe',
      sourceInboundSeq: FAILED_SOURCE_SEQ,
      isTerminal: options.isTerminal,
    });
    if (state === 'pending') return id;
    durability.markSending(id);
    if (state === 'sending') return id;
    durability.markSubmitted(id, `wa-${id}`);
    if (state === 'maybe_sent') expect(durability.markMaybeSent(id, 'send outcome unknown')).toBe(true);
    if (state === 'quarantined') expect(durability.markQuarantined(id)).toBe(true);
    if (state === 'echoed') durability.markEchoed(id);
    return id;
  }

  function opRow(fixture: FailedSourceFixture, opId: number): { payload_hash: string; status: string } {
    const raw = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      return raw.prepare('SELECT payload_hash, status FROM outbound_ops WHERE id = ?').get(opId) as {
        payload_hash: string;
        status: string;
      };
    } finally {
      raw.close();
    }
  }

  /** The fingerprint the CLI shows for an op in its current state. */
  function opFingerprint(fixture: FailedSourceFixture, opId: number): string {
    const { payload_hash: payloadHash, status } = opRow(fixture, opId);
    return redactFingerprint(
      loadOrCreateRedactionSalt(fixture.dbPath),
      'delivered-op',
      `${opId}:${payloadHash}:${status}`,
    );
  }

  function ackArgs(fingerprints: string[]): string[] {
    return fingerprints.flatMap((fingerprint) => ['--ack-delivered-op', fingerprint]);
  }

  /** Dry run that is expected not to be ready: exit 1, valid JSON on stdout. */
  function notReadyDryRun(argv: string[]): Record<string, unknown> {
    const result = captureRun(argv);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatchObject({ ok: true, dryRun: true, ready: false });
    return result.output;
  }

  it('parses repeatable --ack-delivered-op fingerprints only with --failed-source', () => {
    const fixture = installFailedSourceFixture();
    const [first, second] = ['0123456789ab', 'ba9876543210'];
    expect(parseCloseRecoveryArgs(failedSourceArgs(fixture, ackArgs([first, second]))))
      .toMatchObject({ ackedDeliveredOpFingerprints: [first, second] });
    expect(parseCloseRecoveryArgs(failedSourceArgs(fixture)))
      .toMatchObject({ ackedDeliveredOpFingerprints: [] });
    for (const invalid of ['7', `970001:${'a'.repeat(64)}`, '0123456789AB', '0123456789a', 'g123456789ab']) {
      expect(() => parseCloseRecoveryArgs(failedSourceArgs(fixture, ['--ack-delivered-op', invalid])))
        .toThrow('Delivered-op acknowledgement must be a delivered-op fingerprint');
    }
    expect(() => parseCloseRecoveryArgs(failedSourceArgs(fixture, ackArgs([first, first]))))
      .toThrow('Delivered-op acknowledgements contain duplicates');
    const plain = failedSourceArgs(fixture, ackArgs([first])).filter((arg) => arg !== '--failed-source');
    expect(() => parseCloseRecoveryArgs(plain)).toThrow('--ack-delivered-op requires --failed-source');
  });

  it('registers the stalled-operation notice by the payload hash durability stores', () => {
    const expected = createHash('sha256')
      .update(JSON.stringify({ text: notices().STALLED_OPERATION_NOTICE }))
      .digest('hex');
    // The live 363 notice op carried this payload_hash.
    expect(expected.startsWith('c513ce1d0a88')).toBe(true);
    expect([...notices().AGENT_FAILURE_NOTICE_PAYLOAD_HASHES]).toEqual([expected]);
  });

  it('dry run stdout lists a delivered op by fingerprint only, never its raw id or payload hash', () => {
    const fixture = installFailedSourceFixture();
    let opId = 0;
    withDurability(fixture, (durability) => {
      opId = sendSourceText(durability, notices().STALLED_OPERATION_NOTICE);
    });
    expect(opId).toBeGreaterThan(OP_ID_FLOOR);
    const { payload_hash: payloadHash } = opRow(fixture, opId);

    const result = captureRun(failedSourceArgs(fixture));

    expect(result.output['deliveredOps']).toEqual([{
      opFingerprint: opFingerprint(fixture, opId),
      isTerminal: false,
      status: 'echoed',
      opType: 'text',
      registeredNotice: true,
    }]);
    expect(result.text).not.toContain(String(opId));
    expect(result.text).not.toContain(payloadHash);
    expect(result.text).not.toContain(payloadHash.slice(0, 16));
    expect(result.text).not.toContain('"id"');
    expect(result.text).not.toContain('"payloadHash"');
  });

  it('363 shape: an echoed non-terminal stalled notice closes only with its exact fingerprint ack', () => {
    const fixture = installFailedSourceFixture({ sourceAttemptFailureClass: 'crash' });
    let noticeId = 0;
    withDurability(fixture, (durability) => {
      noticeId = sendSourceText(durability, notices().STALLED_OPERATION_NOTICE);
    });
    const noticeHash = opRow(fixture, noticeId).payload_hash;
    expect(notices().AGENT_FAILURE_NOTICE_PAYLOAD_HASHES.has(noticeHash)).toBe(true);
    const before = recoveryState(fixture);
    expect(before.sourceTerminals).toMatchObject([{
      inbound_disposition: 'failed_terminal',
      attempt_failure_class: 'crash',
      reply_guarantee_disarmed: 0,
      delivery_kind: 'none',
      delivery_op_id: null,
    }]);
    expect(before.sourceRecoveryJobs).toEqual([]);
    expect(before).toMatchObject({ plans: 0, pending: 0, closures: 0 });
    expect(before.sourceOutboundOps).toMatchObject([
      { id: noticeId, is_terminal: 0, status: 'echoed', op_type: 'text', payload_hash: noticeHash },
    ]);

    // Dry run without an ack lists the op and is not ready; confirm refuses.
    const dry = notReadyDryRun(failedSourceArgs(fixture));
    expect(dry).toMatchObject({ acksMatch: false });
    const listed = dry['deliveredOps'] as Array<{ opFingerprint: string }>;
    expect(listed).toHaveLength(1);
    const fingerprint = listed[0].opFingerprint;
    expect(fingerprint).toBe(opFingerprint(fixture, noticeId));
    expect(() => runCloseRecoveryCatchupCli(failedSourceArgs(fixture, ['--confirm'])))
      .toThrow(ACK_MISMATCH_MESSAGE);
    expect(recoveryState(fixture)).toEqual(before);

    const ack = ackArgs([fingerprint]);
    const readyDry = captureRun(failedSourceArgs(fixture, ack));
    expect(readyDry.exitCode).toBe(0);
    expect(readyDry.output).toMatchObject({ ready: true, acksMatch: true });
    const closed = captureRun(failedSourceArgs(fixture, [...ack, '--confirm']));
    expect(closed.output).toMatchObject({ ok: true, receipt: { inserted: 1, idempotent: false } });
    const after = recoveryState(fixture);
    expect(after).toMatchObject({ plans: 1, pending: 1, closures: 1, witnesses: 1 });
    expect(after.sourceRows).toEqual(before.sourceRows);
    expect(after.sourceTerminals).toEqual(before.sourceTerminals);
    expect(after.sourceOutboundOps).toEqual(before.sourceOutboundOps);

    // The bound op is part of the recorded evidence on plan, links and witness.
    const boundRef = `${FAILED_EVIDENCE} acked-delivered-ops=${noticeId}:${noticeHash}`;
    const raw = new DatabaseSync(fixture.dbPath, { readOnly: true });
    try {
      expect(raw.prepare('SELECT evidence_ref FROM recovery_plans').all())
        .toEqual([{ evidence_ref: boundRef }]);
      expect(raw.prepare('SELECT DISTINCT evidence_ref FROM inbound_disposition_links').all())
        .toEqual([{ evidence_ref: boundRef }]);
      expect(raw.prepare('SELECT evidence_ref FROM operator_catchup_closure_witnesses').all())
        .toEqual([{ evidence_ref: boundRef }]);
    } finally {
      raw.close();
    }

    // Exact replay is a no-op; a replay without the ack is changed evidence.
    expect(captureRun(failedSourceArgs(fixture, [...ack, '--confirm'])).output)
      .toMatchObject({ receipt: { inserted: 0, idempotent: true } });
    expect(() => runCloseRecoveryCatchupCli(failedSourceArgs(fixture, ['--confirm'])))
      .toThrow('Recovery was already closed against a different catch-up or evidence');
    expect(recoveryState(fixture)).toEqual(after);
  });

  it.each([
    ['an unknown fingerprint', 'unknown'],
    ['an extra fingerprint', 'extra'],
    ['a missing fingerprint', 'missing'],
  ] as const)('ack binding: refuses %s', (_label, shape) => {
    const fixture = installFailedSourceFixture();
    const ids: number[] = [];
    withDurability(fixture, (durability) => {
      ids.push(sendSourceText(durability, notices().STALLED_OPERATION_NOTICE));
      if (shape === 'missing') ids.push(sendSourceText(durability, notices().STALLED_OPERATION_NOTICE));
    });
    const own = opFingerprint(fixture, ids[0]);
    const acks = shape === 'unknown'
      ? ['ffffffffffff']
      : shape === 'extra'
        ? [own, 'eeeeeeeeeeee']
        : [own];
    const before = recoveryState(fixture);

    expect(notReadyDryRun(failedSourceArgs(fixture, ackArgs(acks)))).toMatchObject({ acksMatch: false });
    expect(() => runCloseRecoveryCatchupCli(failedSourceArgs(fixture, [...ackArgs(acks), '--confirm'])))
      .toThrow(ACK_MISMATCH_MESSAGE);
    expect(recoveryState(fixture)).toEqual(before);
  });

  type DeliveredOpCase = [
    label: string,
    send: (durability: DurabilityEngine) => number,
    listed: { isTerminal: boolean; status: string; registeredNotice: boolean },
  ];
  it.each<DeliveredOpCase>([
    [
      'an ordinary answer sent as a non-terminal echoed op',
      (durability: DurabilityEngine) => sendSourceText(durability, 'Here is the report you asked for.'),
      { isTerminal: false, status: 'echoed', registeredNotice: false },
    ],
    [
      'a terminal answer (createOutboundOp isTerminal) that was echoed',
      (durability: DurabilityEngine) => sendSourceText(
        durability,
        'Here is the report you asked for.',
        { isTerminal: true },
      ),
      { isTerminal: true, status: 'echoed', registeredNotice: false },
    ],
    [
      'a registered notice that markTerminal finalized as the delivered answer',
      (durability: DurabilityEngine) => {
        const id = sendSourceText(durability, notices().STALLED_OPERATION_NOTICE);
        durability.markTerminal(id);
        return id;
      },
      { isTerminal: true, status: 'echoed', registeredNotice: false },
    ],
    ...(['pending', 'sending', 'submitted', 'maybe_sent', 'quarantined'] as const).map((state): DeliveredOpCase => [
      `a registered notice still ${state}`,
      (durability: DurabilityEngine) => sendSourceText(durability, notices().STALLED_OPERATION_NOTICE, { state }),
      { isTerminal: false, status: state, registeredNotice: true },
    ]),
  ])('delivered op: refuses %s even with its exact fingerprint ack', (_label, send, listed) => {
    const fixture = installFailedSourceFixture();
    let opId = 0;
    withDurability(fixture, (durability) => {
      opId = send(durability);
    });
    const fingerprint = opFingerprint(fixture, opId);
    const before = recoveryState(fixture);
    expect(before.sourceOutboundOps).toMatchObject([{ id: opId, status: listed.status }]);
    expect(before.sourceRows).toMatchObject([{ processing_status: 'failed' }]);

    const dry = notReadyDryRun(failedSourceArgs(fixture, ackArgs([fingerprint])));
    expect(dry).toMatchObject({
      acksMatch: true,
      deliveredOps: [{ opFingerprint: fingerprint, opType: 'text', ...listed }],
    });
    expect(() => runCloseRecoveryCatchupCli(
      failedSourceArgs(fixture, [...ackArgs([fingerprint]), '--confirm']),
    )).toThrow(NOT_A_NOTICE_MESSAGE);
    expect(recoveryState(fixture)).toEqual(before);
  });

  it('transition: a notice op that changes after a ready dry run makes confirm refuse with nothing written', () => {
    // A second notice arrives (pending) after the operator's ready dry run.
    const arriving = installFailedSourceFixture();
    let echoedId = 0;
    withDurability(arriving, (durability) => {
      echoedId = sendSourceText(durability, notices().STALLED_OPERATION_NOTICE);
    });
    const echoedAck = ackArgs([opFingerprint(arriving, echoedId)]);
    expect(captureRun(failedSourceArgs(arriving, echoedAck)).output).toMatchObject({ ready: true });
    withDurability(arriving, (durability) => {
      sendSourceText(durability, notices().STALLED_OPERATION_NOTICE, { state: 'pending' });
    });
    const beforeArrivingConfirm = recoveryState(arriving);
    expect(() => runCloseRecoveryCatchupCli(failedSourceArgs(arriving, [...echoedAck, '--confirm'])))
      .toThrow(NOT_A_NOTICE_MESSAGE);
    expect(recoveryState(arriving)).toEqual(beforeArrivingConfirm);
    expect(beforeArrivingConfirm).toMatchObject({ plans: 0, pending: 0, closures: 0 });

    // The fingerprint binds status: an ack taken while the op was submitted no
    // longer matches once it is echoed, so the confirm refuses.
    const moving = installFailedSourceFixture();
    let movingId = 0;
    withDurability(moving, (durability) => {
      movingId = sendSourceText(durability, notices().STALLED_OPERATION_NOTICE, { state: 'submitted' });
    });
    const submittedAck = ackArgs([opFingerprint(moving, movingId)]);
    expect(notReadyDryRun(failedSourceArgs(moving, submittedAck))).toMatchObject({ acksMatch: true });
    withDurability(moving, (durability) => durability.markEchoed(movingId));
    const beforeMovingConfirm = recoveryState(moving);
    expect(() => runCloseRecoveryCatchupCli(failedSourceArgs(moving, [...submittedAck, '--confirm'])))
      .toThrow(ACK_MISMATCH_MESSAGE);
    expect(recoveryState(moving)).toEqual(beforeMovingConfirm);

    // A fresh dry run shows the echoed fingerprint, and that ack closes.
    const echoedNow = ackArgs([opFingerprint(moving, movingId)]);
    expect(echoedNow).not.toEqual(submittedAck);
    expect(captureRun(failedSourceArgs(moving, [...echoedNow, '--confirm'])).output)
      .toMatchObject({ ok: true, receipt: { inserted: 1 } });
  });

  it('delivered op: a failed_permanent op is proven unsent and closes without an ack', () => {
    const fixture = installFailedSourceFixture();
    withDurability(fixture, (durability) => {
      const id = durability.createOutboundOp({
        conversationKey: FAILED_CONVERSATION,
        chatJid: FAILED_CHAT,
        opType: 'text',
        payload: JSON.stringify({ text: 'Here is the report you asked for.' }),
        replayPolicy: 'unsafe',
        sourceInboundSeq: FAILED_SOURCE_SEQ,
      });
      durability.markSending(id);
      expect(durability.markFailedPermanent(id, 'provider rejected the payload')).toBe(true);
    });
    const before = recoveryState(fixture);
    expect(before.sourceOutboundOps).toMatchObject([{ status: 'failed_permanent' }]);

    const dry = captureRun(failedSourceArgs(fixture));
    expect(dry.output).toMatchObject({ ready: true, deliveredOps: [], acksMatch: true });
    const result = captureRun(failedSourceArgs(fixture, ['--confirm']));

    expect(result.output).toMatchObject({ ok: true, receipt: { inserted: 1, idempotent: false } });
    const after = recoveryState(fixture);
    expect(after).toMatchObject({ plans: 1, pending: 1, closures: 1, witnesses: 1 });
    expect(after.sourceRows).toEqual(before.sourceRows);
    expect(after.sourceTerminals).toEqual(before.sourceTerminals);
    expect(after.sourceOutboundOps).toEqual(before.sourceOutboundOps);
  });

  it('multi-source: closes two failed sources in the same chat under one plan', () => {
    const fixture = installFailedSourceFixture({ extraSources: [{ seq: FAILED_SOURCE_SEQ + 1 }] });
    const before = recoveryState(fixture);
    expect(before.sourceRows).toHaveLength(2);

    const result = captureRun(failedSourceArgs(fixture, ['--confirm']));

    expect(result.output).toMatchObject({
      ok: true,
      receipt: { nSourceSeqs: 2, inserted: 2, idempotent: false, openAfter: 0 },
    });
    const after = recoveryState(fixture);
    expect(after).toMatchObject({ plans: 1, pending: 2, closures: 2, witnesses: 1 });
    expect(after.sourceRows).toEqual(before.sourceRows);
    expect(after.sourceTerminals).toEqual(before.sourceTerminals);
    expect(after.sourceRecoveryJobs).toEqual(before.sourceRecoveryJobs);
    expect(after.sourceOutboundOps).toEqual(before.sourceOutboundOps);
  });

  it('multi-source: an invalid second source refuses the whole set with nothing written', () => {
    const fixture = installFailedSourceFixture({
      extraSources: [{ seq: FAILED_SOURCE_SEQ + 1, terminal: 'operator_cancelled' }],
    });
    const before = recoveryState(fixture);

    for (const extra of [[], ['--confirm']]) {
      expect(() => runCloseRecoveryCatchupCli(failedSourceArgs(fixture, extra)))
        .toThrow(TERMINAL_DEBT_MESSAGE);
    }
    expect(recoveryState(fixture)).toEqual(before);
    expect(before).toMatchObject({ plans: 0, pending: 0, closures: 0, witnesses: 0 });
  });

  it('race: a pending link written after a ready dry run makes confirm refuse without writes', () => {
    const fixture = installFailedSourceFixture();
    expect(captureRun(failedSourceArgs(fixture)).output).toMatchObject({ ready: true });

    insertForeignPendingLink(fixture.dbPath, fixture.sourceSeq, 'plan-startup-race');
    const beforeConfirm = recoveryState(fixture);

    expect(() => runCloseRecoveryCatchupCli(failedSourceArgs(fixture, ['--confirm'])))
      .toThrow('Failed source inbound already has a disposition link');
    expect(recoveryState(fixture)).toEqual(beforeConfirm);
    expect(beforeConfirm).toMatchObject({ plans: 1, pending: 1, closures: 0 });
  });

  it('race: the write transaction re-checks the source after taking the writer reservation', () => {
    const fixture = installFailedSourceFixture();
    const before = recoveryState(fixture);
    const raw = new DatabaseSync(fixture.dbPath);
    try {
      raw.exec('PRAGMA foreign_keys = ON');
      expect(() => closeFailedSourceOperatorCatchupRecoveryRaw(
        raw,
        failedSourceParams(fixture),
        (transactionRaw) => {
          // A conflicting link lands after any earlier inspection but before
          // the in-transaction inspection.
          transactionRaw.prepare(`
            INSERT INTO recovery_plans (plan_id, origin, actor, summary, evidence_ref)
            VALUES ('plan-in-flight', 'operator', 'operator:other', 'in flight', 'test://race')
          `).run();
          transactionRaw.prepare(`
            INSERT INTO inbound_disposition_links (
              inbound_seq, recovery_plan_id, disposition, superseded_by_seq,
              reason, evidence_ref, actor
            ) VALUES (?, 'plan-in-flight', 'recovery_pending_operator_catchup', NULL,
                      'in flight', 'test://race', 'operator:other')
          `).run(fixture.sourceSeq);
        },
      )).toThrow('Failed source inbound already has a disposition link');
    } finally {
      raw.close();
    }
    // All or nothing: the refused transaction leaves no plan or link behind.
    expect(recoveryState(fixture)).toEqual(before);
  });

  it('race: of two concurrent closures for one failed source exactly one plan wins', () => {
    const fixture = installFailedSourceFixture();
    const first = new DatabaseSync(fixture.dbPath);
    const second = new DatabaseSync(fixture.dbPath);
    try {
      for (const connection of [first, second]) {
        connection.exec('PRAGMA foreign_keys = ON');
        connection.exec('PRAGMA busy_timeout = 1000');
      }
      const winner = closeFailedSourceOperatorCatchupRecoveryRaw(first, failedSourceParams(fixture));
      expect(winner).toMatchObject({ inserted: 1, idempotent: false });
      const afterWinner = recoveryState(fixture);

      expect(() => closeFailedSourceOperatorCatchupRecoveryRaw(
        second,
        failedSourceParams(fixture, { planId: 'plan-failed-source-loser' }),
      )).toThrow('Failed source inbound already has a disposition link');
      expect(closeFailedSourceOperatorCatchupRecoveryRaw(second, failedSourceParams(fixture)))
        .toMatchObject({ inserted: 0, idempotent: true });
      expect(recoveryState(fixture)).toEqual(afterWinner);
      expect(afterWinner).toMatchObject({ plans: 1, pending: 1, closures: 1, witnesses: 1 });
    } finally {
      first.close();
      second.close();
    }
  });

  it('refuses the failed-source mutation unless foreign-key enforcement is active', () => {
    const fixture = installFailedSourceFixture();
    const before = recoveryState(fixture);
    const raw = new DatabaseSync(fixture.dbPath);
    try {
      raw.exec('PRAGMA foreign_keys = OFF');
      expect(() => closeFailedSourceOperatorCatchupRecoveryRaw(raw, failedSourceParams(fixture)))
        .toThrow('foreign-key enforcement');
    } finally {
      raw.close();
    }
    expect(recoveryState(fixture)).toEqual(before);
  });

  it.each([
    ['Failed source inbound does not exist in the recovery conversation', 'invalid_proof'],
    ['Failed source inbound must be failed', 'invalid_proof'],
    ['Failed source inbound must share the catch-up chat', 'invalid_proof'],
    ['Failed source inbound must have exactly one armed, undelivered failed terminal record', 'invalid_proof'],
    ['Failed source inbound has a turn recovery job', 'invalid_proof'],
    ['Failed source inbound has an outbound op that is not an echoed registered failure notice', 'invalid_proof'],
    ['Delivered-op acknowledgements must match the delivered failure-notice ops exactly', 'invalid_proof'],
    ['Delivered-op acknowledgement must be a delivered-op fingerprint', 'invalid_args'],
    ['Delivered-op acknowledgements require a fingerprint function', 'invalid_args'],
    ['Delivered-op acknowledgements contain duplicates', 'invalid_args'],
    ['--ack-delivered-op requires --failed-source', 'invalid_args'],
    ['Failed source inbound already has a disposition link', 'invalid_proof'],
    ['Failed-source recovery plan already exists', 'invalid_proof'],
  ] as const)('classifies %j as %s', (message, expected) => {
    expect(classifyError(new Error(message))).toBe(expected);
  });
});
