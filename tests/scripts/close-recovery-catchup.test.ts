import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { closeOperatorCatchupRecoveryRaw } from '../../src/core/recovery-catchup-closure.ts';
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
