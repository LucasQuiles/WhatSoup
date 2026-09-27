// Black-box tests for `turn-recovery-operator close-inbound`: the operator
// close for ONE open inbound left behind a final terminal record. A real
// on-disk migrated DB is seeded through the production finalize path, the
// inbound is reopened (the state an older release left), and the seeding
// connection is CLOSED before the CLI runs, so the file is quiescent. The CLI
// is driven as a child process: the dry run must be byte-for-byte read-only
// (no migration, no sidecars), and an apply must be bound to the dry run's
// digest, the same database file, and the current schema.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../src/core/database.ts';
import { DurabilityEngine } from '../../src/core/durability.ts';
import {
  toTurnFinalizationPersistence,
  toTurnRecoveryJobPersistence,
  type TurnTerminalResult,
} from '../../src/runtimes/agent/turn-terminal.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(REPO_ROOT, 'scripts/turn-recovery-operator.ts');
const CONVERSATION_KEY = '15550106666';
const DELIVERY_JID = '15550106666@s.whatsapp.net';
const MESSAGE_ID_PREFIX = 'wamid-close-cli';

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

interface InboundState {
  processing_status: string;
  terminal_reason: string | null;
  failure_class: string | null;
}

describe('turn-recovery-operator close-inbound', () => {
  let dbPath: string;
  let auditPath: string;
  const extraPaths: string[] = [];

  beforeEach(() => {
    dbPath = path.join(tmpdir(), `tro-close-${randomBytes(6).toString('hex')}.db`);
    auditPath = path.join(tmpdir(), `tro-close-audit-${randomBytes(6).toString('hex')}.jsonl`);
  });

  afterEach(() => {
    for (const base of [dbPath, ...extraPaths.splice(0)]) {
      for (const p of [base, `${base}-wal`, `${base}-shm`]) {
        if (existsSync(p)) unlinkSync(p);
      }
    }
    if (existsSync(auditPath)) unlinkSync(auditPath);
  });

  /** Seed through a real engine, then CLOSE it so the CLI sees a quiescent file. */
  function seed(fn: (db: Database, engine: DurabilityEngine) => void): void {
    const db = new Database(dbPath);
    db.open();
    try {
      fn(db, new DurabilityEngine(db));
    } finally {
      db.close();
    }
  }

  /** Test-side reads must not create sidecars either, or they would mask the CLI's. */
  function read<T>(fn: (raw: DatabaseSync) => T, file = dbPath): T {
    const url = pathToFileURL(file);
    url.searchParams.set('immutable', '1');
    const raw = new DatabaseSync(url.href, { readOnly: true });
    try {
      return fn(raw);
    } finally {
      raw.close();
    }
  }

  const inboundState = (seq: number, file = dbPath): InboundState => read((raw) => raw.prepare(
    'SELECT processing_status, terminal_reason, failure_class FROM inbound_events WHERE seq = ?',
  ).get(seq) as unknown as InboundState, file);

  const fileFacts = (file = dbPath) => ({
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    wal: existsSync(`${file}-wal`),
    shm: existsSync(`${file}-shm`),
  });

  const audit = (): Array<Record<string, unknown>> =>
    readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

  function reopen(db: Database, seq: number, status: string): void {
    db.raw.prepare(
      `UPDATE inbound_events
       SET processing_status = ?, completed_at = NULL, terminal_reason = NULL, failure_class = NULL
       WHERE seq = ?`,
    ).run(status, seq);
  }

  function identity(seq: number): TurnTerminalResult['identity'] {
    return {
      scope: 'per_chat',
      conversationKey: CONVERSATION_KEY,
      deliveryJid: DELIVERY_JID,
      inboundSeq: seq,
      logicalTurnId: `turn-${seq}`,
      managerId: 'manager-close-cli',
      generation: 1,
    };
  }

  /** Real failed_terminal finalize, then reopened; returns seq and the finalized state. */
  function seedStaleFailed(suffix: string, openStatus = 'pending'): { seq: number; finalized: InboundState } {
    let seq = 0;
    let finalized: InboundState | undefined;
    seed((db, engine) => {
      seq = engine.journalInbound(`${MESSAGE_ID_PREFIX}-${suffix}`, CONVERSATION_KEY, DELIVERY_JID, 'agent');
      engine.finalizeTurnTerminal(toTurnFinalizationPersistence({
        identity: identity(seq),
        attemptOutcome: { kind: 'failed', class: 'crash' },
        inboundDisposition: 'failed_terminal',
        deliveryEvidence: { kind: 'none' },
      }));
      finalized = db.raw.prepare(
        'SELECT processing_status, terminal_reason, failure_class FROM inbound_events WHERE seq = ?',
      ).get(seq) as unknown as InboundState;
      reopen(db, seq, openStatus);
    });
    return { seq, finalized: finalized! };
  }

  function dryRun(seq: number, file = dbPath): { status: number | null; parsed: Record<string, unknown> } {
    const res = run(['close-inbound', '--db', file, '--seq', String(seq), '--audit-file', auditPath]);
    expect(res.status, res.stderr).toBe(0);
    return { status: res.status, parsed: JSON.parse(res.stdout) as Record<string, unknown> };
  }

  it('the dry run is read-only: file bytes, migration ledger and sidecars are unchanged', () => {
    const { seq } = seedStaleFailed('dry');
    const before = fileFacts();
    const ledgerBefore = read((raw) => raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all());
    expect(before.wal || before.shm).toBe(false);

    const { parsed } = dryRun(seq);

    expect(parsed).toMatchObject({
      dryRun: true,
      wouldClose: { seq, disposition: 'failed_terminal', fromStatus: 'pending', toStatus: 'failed', failureClass: 'session_crash' },
    });
    expect(parsed.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(fileFacts()).toEqual(before);
    expect(read((raw) => raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all())).toEqual(ledgerBefore);
    expect(inboundState(seq).processing_status).toBe('pending');
    expect(audit()).toEqual([expect.objectContaining({ action: 'close-inbound', inboundSeq: seq, mode: 'dry-run', outcome: 'previewed' })]);
  });

  it('a dry run never migrates a schema-behind database, and an apply on it refuses', () => {
    const { seq } = seedStaleFailed('behind');
    // Model an older bot's database: its ledger stops one migration short.
    const writable = new DatabaseSync(dbPath);
    writable.prepare('DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)').run();
    writable.close();
    const before = fileFacts();
    const ledgerBefore = read((raw) => raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all());

    const { parsed } = dryRun(seq);
    expect(fileFacts()).toEqual(before);
    expect(read((raw) => raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all())).toEqual(ledgerBefore);

    const applied = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--apply',
      '--expect-digest', String(parsed.digest), '--audit-file', auditPath]);
    expect(applied.status).toBe(1);
    expect(applied.stderr).toContain('schema_not_current');
    expect(fileFacts()).toEqual(before);
    expect(inboundState(seq).processing_status).toBe('pending');
  });

  it('--apply requires --expect-digest and refuses a digest the dry run did not print', () => {
    const { seq } = seedStaleFailed('digest');
    const missing = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--apply', '--audit-file', auditPath]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('--expect-digest');

    const wrong = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--apply',
      '--expect-digest', 'a'.repeat(64), '--audit-file', auditPath]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('digest_mismatch');
    expect(inboundState(seq).processing_status).toBe('pending');
  });

  it('the digest is bound to the database file: a copy with identical content refuses it', () => {
    const { seq } = seedStaleFailed('copy');
    const copyPath = `${dbPath}.copy.db`;
    extraPaths.push(copyPath);
    copyFileSync(dbPath, copyPath);
    const { parsed } = dryRun(seq);

    const applied = run(['close-inbound', '--db', copyPath, '--seq', String(seq), '--apply',
      '--expect-digest', String(parsed.digest), '--audit-file', auditPath]);
    expect(applied.status).toBe(1);
    expect(applied.stderr).toContain('digest_mismatch');
    expect(inboundState(seq, copyPath).processing_status).toBe('pending');
  });

  it('an apply bound to the dry run closes exactly the status finalization applied; a rerun reports alreadyClosed', () => {
    const { seq, finalized } = seedStaleFailed('apply', 'processing');
    const { parsed } = dryRun(seq);

    const applied = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--apply',
      '--expect-digest', String(parsed.digest), '--audit-file', auditPath]);
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ applied: true, closed: { seq, fromStatus: 'processing', toStatus: 'failed' } });
    expect(inboundState(seq)).toEqual(finalized);

    const rerun = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--apply',
      '--expect-digest', String(parsed.digest), '--audit-file', auditPath]);
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(JSON.parse(rerun.stdout)).toMatchObject({ applied: false, alreadyClosed: true });
    expect(inboundState(seq)).toEqual(finalized);
    expect(audit().map((entry) => entry.outcome)).toEqual(['previewed', 'applied', 'not-applied:already-closed']);

    for (const leak of [CONVERSATION_KEY, DELIVERY_JID, MESSAGE_ID_PREFIX, `turn-${seq}`, 'manager-close-cli']) {
      expect(applied.stdout + applied.stderr + rerun.stdout + readFileSync(auditPath, 'utf8')).not.toContain(leak);
    }
  });

  it('an apply whose audit append fails after commit still reports the close, with exit 3', () => {
    const { seq, finalized } = seedStaleFailed('audit-fail', 'processing');
    const { parsed } = dryRun(seq);
    // A directory cannot be appended to, so the receipt write fails after COMMIT.
    const unwritableAudit = path.dirname(dbPath);

    const applied = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--apply',
      '--expect-digest', String(parsed.digest), '--audit-file', unwritableAudit]);

    expect(applied.status).toBe(3);
    expect(JSON.parse(applied.stdout)).toMatchObject({ applied: true, closed: { seq, toStatus: 'failed' } });
    expect(applied.stderr).toContain('audit receipt not written');
    expect(inboundState(seq)).toEqual(finalized);
  });

  it('refuses an open inbound with no terminal record', () => {
    let seq = 0;
    seed((_db, engine) => {
      seq = engine.journalInbound(`${MESSAGE_ID_PREFIX}-no-record`, CONVERSATION_KEY, DELIVERY_JID, 'agent');
    });
    const res = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--audit-file', auditPath]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('no_terminal_record');
    expect(audit()).toEqual([expect.objectContaining({ outcome: 'refused', reason: 'no_terminal_record' })]);
  });

  it('refuses a record that transferred to a recovery owner', () => {
    let seq = 0;
    seed((_db, engine) => {
      seq = engine.journalInbound(`${MESSAGE_ID_PREFIX}-transferred`, CONVERSATION_KEY, DELIVERY_JID, 'agent');
      const opId = engine.createOutboundOp({
        conversationKey: CONVERSATION_KEY,
        chatJid: DELIVERY_JID,
        opType: 'text',
        payload: JSON.stringify({ text: 'selected delivery' }),
        replayPolicy: 'unsafe',
        sourceInboundSeq: seq,
      });
      const owner = { logicalTurnId: 'turn-owner', managerId: 'manager-owner', generation: 2 };
      const result: TurnTerminalResult = {
        identity: identity(seq),
        attemptOutcome: { kind: 'failed', class: 'transient-network' },
        inboundDisposition: 'transferred_to_recovery_owner',
        deliveryEvidence: { kind: 'enqueued', opId },
      };
      engine.finalizeTurnTerminal({
        ...toTurnFinalizationPersistence(result, owner),
        recoveryJob: toTurnRecoveryJobPersistence(result, owner, {
          sourceMessageId: `${MESSAGE_ID_PREFIX}-transferred`,
          receivedAtUnixSeconds: 1_780_000_000,
          replaySafe: true,
          senderJid: '15550106667@s.whatsapp.net',
          senderName: null,
          text: 'replay text',
          isGroup: false,
        }),
      });
    });
    const res = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--audit-file', auditPath]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('non_final_disposition');
  });

  it('refuses a row with a disposition link', () => {
    const { seq } = seedStaleFailed('linked', 'processing');
    seed((db) => {
      db.raw.prepare(
        `INSERT INTO recovery_plans (plan_id, origin, actor, summary) VALUES ('plan-close-cli', 'operator', 'test', 'fixture')`,
      ).run();
      db.raw.prepare(
        `INSERT INTO inbound_disposition_links (inbound_seq, recovery_plan_id, disposition, reason, actor)
         VALUES (?, 'plan-close-cli', 'recovery_pending_operator_catchup', 'fixture', 'test')`,
      ).run(seq);
    });
    const res = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--audit-file', auditPath]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('disposition_link');
  });

  it('refuses a row already closed with a status its record does not imply', () => {
    const { seq } = seedStaleFailed('mismatch', 'processing');
    seed((db) => {
      db.raw.prepare(
        `UPDATE inbound_events SET processing_status = 'complete', completed_at = datetime('now'), terminal_reason = 'response_sent' WHERE seq = ?`,
      ).run(seq);
    });
    const res = run(['close-inbound', '--db', dbPath, '--seq', String(seq), '--audit-file', auditPath]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('closed_differently');
  });

  it('refuses an unknown seq and every malformed --seq', () => {
    seedStaleFailed('seq-shape');
    const missing = run(['close-inbound', '--db', dbPath, '--seq', '999999', '--audit-file', auditPath]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('inbound_not_found');

    for (const bad of ['0', '01', '1e3', '12abc', '1.5', ' 7']) {
      const res = run(['close-inbound', '--db', dbPath, '--seq', bad, '--audit-file', auditPath]);
      expect(res.status, bad).toBe(1);
      expect(res.stderr, bad).toContain('--seq must be a positive integer');
    }
    // A leading '-' reads as a flag, so the shared parser refuses it first.
    const negative = run(['close-inbound', '--db', dbPath, '--seq', '-1', '--audit-file', auditPath]);
    expect(negative.status).toBe(1);
    expect(negative.stderr).toContain('--seq');
  });

  it('refuses a database path that does not exist, creating nothing', () => {
    const absent = path.join(tmpdir(), `tro-close-absent-${randomBytes(6).toString('hex')}.db`);
    const res = run(['close-inbound', '--db', absent, '--seq', '1', '--audit-file', auditPath]);
    expect(res.status).toBe(1);
    expect(existsSync(absent)).toBe(false);
  });
});
