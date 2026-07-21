import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { createBead, getBead, updateBead } from '../../src/core/substrate/beads.ts';
import {
  CLASSIFIER_VERSION,
  HASH_CHUNK_BYTES,
  applyInlineProposalCleanup,
  hashCleanupFile,
  planInlineProposalCleanup,
  rollbackInlineProposalCleanup,
  parseCleanupArgs,
  runCleanupCli,
  verifyInlineProposalCleanup,
  type CleanupManifest,
} from '../../scripts/inline-proposal-cleanup.ts';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'inline-cleanup-'));
  roots.push(root);
  const dbPath = join(root, 'bot.db');
  const artifactDir = join(root, 'artifacts');
  mkdirSync(artifactDir, { mode: 0o700 });
  const db = new Database(dbPath);
  db.open();
  const invalid = createBead(db.raw, {
    kind: 'task', status: 'proposed', title: 'invalid', body: 'We should schedule this eventually',
    ownerJid: 'owner', actor: 'inline', sourceMessagePk: 101,
    proposalReason: 'inline imperative: schedule', reviewByAt: 1,
  });
  const valid = createBead(db.raw, {
    kind: 'task', status: 'proposed', title: 'valid', body: 'schedule release review',
    ownerJid: 'owner', actor: 'inline', sourceMessagePk: 102,
    proposalReason: 'inline imperative: schedule', reviewByAt: 1,
  });
  createBead(db.raw, {
    kind: 'task', status: 'proposed', title: 'manual', body: 'We should schedule manually',
    ownerJid: 'owner', actor: 'user', proposalReason: 'manual', reviewByAt: 1,
  });
  db.close();
  return { root, dbPath, artifactDir, invalid, valid };
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readManifest(path: string): CleanupManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as CleanupManifest;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('inline proposal cleanup protocol', () => {
  it('plans a private body-free snapshot without changing the source database', async () => {
    const f = fixture();
    const before = hash(f.dbPath);
    const companionBefore = [`${f.dbPath}-wal`, `${f.dbPath}-shm`].map((path) => ({
      exists: existsSync(path), hash: existsSync(path) ? hash(path) : null,
    }));
    const result = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });

    expect(hash(f.dbPath)).toBe(before);
    expect([`${f.dbPath}-wal`, `${f.dbPath}-shm`].map((path) => ({
      exists: existsSync(path), hash: existsSync(path) ? hash(path) : null,
    }))).toEqual(companionBefore);
    expect(result.manifest.candidates.map((candidate) => candidate.id)).toEqual([f.invalid.id]);
    expect(result.manifest.retainedValid.admittedInline).toBe(1);
    expect(JSON.stringify(result.manifest)).not.toContain('We should schedule');
    expect(statSync(result.manifestPath).mode & 0o777).toBe(0o600);
    expect(statSync(result.snapshotPath).mode & 0o777).toBe(0o600);
  });

  it('captures an active WAL/SHM pair consistently without changing source bytes', async () => {
    const f = fixture();
    const raw = new DatabaseSync(f.dbPath);
    raw.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    const walOnly = createBead(raw, {
      kind: 'task', status: 'proposed', title: 'wal-only', body: 'discussion about scheduling',
      ownerJid: 'owner', actor: 'inline', sourceMessagePk: 103,
      proposalReason: 'inline imperative: schedule', reviewByAt: 1,
    });
    const sourcePaths = [f.dbPath, `${f.dbPath}-wal`, `${f.dbPath}-shm`];
    expect(sourcePaths.every(existsSync)).toBe(true);
    const before = sourcePaths.map(hash);
    const shmBefore = statSync(`${f.dbPath}-shm`);
    const result = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    expect(result.manifest.candidates.map((candidate) => candidate.id)).toContain(walOnly.id);
    expect(result.manifest.database.wal.present).toBe(true);
    expect(result.manifest.database.shm.present).toBe(true);
    expect(sourcePaths.slice(0, 2).map(hash)).toEqual(before.slice(0, 2));
    expect(statSync(`${f.dbPath}-shm`).size).toBe(shmBefore.size);
    expect(statSync(`${f.dbPath}-shm`).mode & 0o777).toBe(shmBefore.mode & 0o777);
    expect(existsSync(join(f.artifactDir, 'source-wal.provenance'))).toBe(true);
    expect(existsSync(join(f.artifactDir, 'source-shm.provenance'))).toBe(true);
    expect(existsSync(join(f.artifactDir, 'database-snapshot.db-wal'))).toBe(false);
    expect(existsSync(join(f.artifactDir, 'database-snapshot.db-shm'))).toBe(false);
    raw.close();
  });

  it('rejects ambiguous sources, unknown classifier versions, and incomplete WAL pairs', async () => {
    const ambiguous = fixture();
    const raw = new DatabaseSync(ambiguous.dbPath);
    raw.prepare(`INSERT INTO bead_events
      (bead_id, event_type, payload_json, actor, source_message_pk, created_at)
      VALUES (?, 'status_change', ?, 'inline', ?, ?)`)
      .run(ambiguous.invalid.id, JSON.stringify({ from: null, to: 'proposed' }), 101, 1);
    raw.close();
    await expect(planInlineProposalCleanup({ dbPath: ambiguous.dbPath, artifactDir: ambiguous.artifactDir }))
      .rejects.toThrow(/ambiguous source/i);

    const unknown = fixture();
    await expect(planInlineProposalCleanup({
      dbPath: unknown.dbPath, artifactDir: unknown.artifactDir, classifierVersion: 'future-v9',
    })).rejects.toThrow(/unknown classifier/i);

    const companions = fixture();
    writeFileSync(`${companions.dbPath}-wal`, 'partial');
    await expect(planInlineProposalCleanup({ dbPath: companions.dbPath, artifactDir: companions.artifactDir }))
      .rejects.toThrow(/WAL.*SHM|companion/i);
  });

  it('rejects a second canonical origin event even when its actor is not inline', async () => {
    const f = fixture();
    const raw = new DatabaseSync(f.dbPath);
    raw.prepare(`INSERT INTO bead_events
      (bead_id, event_type, payload_json, actor, source_message_pk, created_at)
      VALUES (?, 'status_change', ?, 'repair-tool', ?, ?)`)
      .run(f.invalid.id, JSON.stringify({ from: null, to: 'proposed' }), 101, 1);
    raw.close();
    await expect(planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir }))
      .rejects.toThrow(/ambiguous source/i);
  });

  it('applies atomically, verifies exact counts and backup readability, then rolls back', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    const applied = await applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    expect(applied.affectedCount).toBe(1);
    expect(statSync(applied.backupPath).mode & 0o777).toBe(0o600);

    const raw = new DatabaseSync(f.dbPath);
    expect(getBead(raw, f.invalid.id)!.bead.status).toBe('cancelled');
    expect(getBead(raw, f.valid.id)!.bead.status).toBe('proposed');
    raw.close();

    const verified = await verifyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    expect(verified.integrity).toBe('ok');
    expect(verified.cleanupEventCount).toBe(1);
    expect(statSync(verified.receiptPath).mode & 0o777).toBe(0o600);

    const rolledBack = await rollbackInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    expect(rolledBack.restoredCount).toBe(1);
    const check = new DatabaseSync(f.dbPath);
    expect(getBead(check, f.invalid.id)!.bead.status).toBe('proposed');
    check.close();
  });

  it('fails on stale fingerprints and under-lock row/body drift without partial cleanup', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    const raw = new DatabaseSync(f.dbPath);
    raw.prepare('UPDATE beads SET body = ?, updated_at = updated_at + 1 WHERE id = ?')
      .run('schedule now-valid', f.invalid.id);
    raw.close();
    await expect(applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath }))
      .rejects.toThrow(/fingerprint|drift/i);
    const check = new DatabaseSync(f.dbPath);
    expect(getBead(check, f.invalid.id)!.bead.status).toBe('proposed');
    check.close();
  });

  it('detects an unrelated commit between backup and A5 write-lock acquisition', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    await expect(applyInlineProposalCleanup({
      dbPath: f.dbPath,
      manifestPath: plan.manifestPath,
      testOnlyAfterFingerprint: () => {
        const racer = new DatabaseSync(f.dbPath);
        racer.prepare(`INSERT INTO sweep_runs
          (run_id, started_at, proposed_count, updated_count, completed_count, observation_count, metadata_json)
          VALUES ('race', 1, 0, 0, 0, 0, '{}')`).run();
        racer.close();
      },
    })).rejects.toThrow(/changed between backup.*write lock/i);
    const check = new DatabaseSync(f.dbPath);
    expect(getBead(check, f.invalid.id)!.bead.status).toBe('proposed');
    expect(check.prepare(`SELECT COUNT(*) AS count FROM bead_events WHERE actor='inline-proposal-cleanup'`).get())
      .toEqual({ count: 0 });
    check.close();
  });

  it('rejects a DELETE-journal database path swap after fingerprinting', async () => {
    const f = fixture();
    const journal = new DatabaseSync(f.dbPath);
    journal.exec('PRAGMA journal_mode=DELETE');
    journal.close();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    const replacement = join(f.root, 'replacement.db');
    const retired = join(f.root, 'retired.db');
    copyFileSync(f.dbPath, replacement);

    await expect(applyInlineProposalCleanup({
      dbPath: f.dbPath,
      manifestPath: plan.manifestPath,
      testOnlyAfterFingerprint: () => {
        renameSync(f.dbPath, retired);
        renameSync(replacement, f.dbPath);
      },
    })).rejects.toThrow(/identity|changed|replaced/i);

    const current = new DatabaseSync(f.dbPath, { readOnly: true });
    expect(getBead(current, f.invalid.id)!.bead.status).toBe('proposed');
    current.close();
  });

  it('rejects a DELETE-journal database path swap injected under the write lock', async () => {
    const f = fixture();
    const journal = new DatabaseSync(f.dbPath);
    journal.exec('PRAGMA journal_mode=DELETE');
    journal.close();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    const replacement = join(f.root, 'under-lock-replacement.db');
    const retired = join(f.root, 'under-lock-retired.db');
    copyFileSync(f.dbPath, replacement);

    await expect(applyInlineProposalCleanup({
      dbPath: f.dbPath,
      manifestPath: plan.manifestPath,
      testOnlyUnderLockFault: () => {
        renameSync(f.dbPath, retired);
        renameSync(replacement, f.dbPath);
      },
    })).rejects.toThrow(/identity|changed|replaced/i);

    expect(existsSync(join(f.artifactDir, 'apply-receipt.json'))).toBe(false);
    const current = new DatabaseSync(f.dbPath, { readOnly: true });
    expect(getBead(current, f.invalid.id)!.bead.status).toBe('proposed');
    current.close();
    const original = new DatabaseSync(retired, { readOnly: true });
    expect(getBead(original, f.invalid.id)!.bead.status).toBe('proposed');
    original.close();
  });

  it('does not publish an apply receipt after a post-commit database path swap', async () => {
    const f = fixture();
    const journal = new DatabaseSync(f.dbPath);
    journal.exec('PRAGMA journal_mode=DELETE');
    journal.close();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    const replacement = join(f.root, 'post-commit-replacement.db');
    const retired = join(f.root, 'post-commit-retired.db');
    copyFileSync(f.dbPath, replacement);

    await expect(applyInlineProposalCleanup({
      dbPath: f.dbPath,
      manifestPath: plan.manifestPath,
      testOnlyAfterMutation: () => {
        renameSync(f.dbPath, retired);
        renameSync(replacement, f.dbPath);
      },
    })).rejects.toThrow(/identity|changed|replaced/i);

    expect(existsSync(join(f.artifactDir, 'apply-receipt.json'))).toBe(false);
    const current = new DatabaseSync(f.dbPath, { readOnly: true });
    expect(getBead(current, f.invalid.id)!.bead.status).toBe('proposed');
    current.close();
    const original = new DatabaseSync(retired, { readOnly: true });
    expect(getBead(original, f.invalid.id)!.bead.status).toBe('cancelled');
    original.close();
  });

  it('rejects a DELETE-journal database path swap injected under the rollback write lock', async () => {
    const f = fixture();
    const journal = new DatabaseSync(f.dbPath);
    journal.exec('PRAGMA journal_mode=DELETE');
    journal.close();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    await applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    const replacement = join(f.root, 'rollback-under-lock-replacement.db');
    const retired = join(f.root, 'rollback-under-lock-retired.db');
    copyFileSync(f.dbPath, replacement);

    await expect(rollbackInlineProposalCleanup({
      dbPath: f.dbPath,
      manifestPath: plan.manifestPath,
      testOnlyUnderLockFault: () => {
        renameSync(f.dbPath, retired);
        renameSync(replacement, f.dbPath);
      },
    })).rejects.toThrow(/identity|changed|replaced/i);

    expect(existsSync(join(f.artifactDir, 'rollback-receipt.json'))).toBe(false);
    for (const path of [f.dbPath, retired]) {
      const raw = new DatabaseSync(path, { readOnly: true });
      expect(getBead(raw, f.invalid.id)!.bead.status).toBe('cancelled');
      raw.close();
    }
  });

  it('does not publish a rollback receipt after a post-commit database path swap', async () => {
    const f = fixture();
    const journal = new DatabaseSync(f.dbPath);
    journal.exec('PRAGMA journal_mode=DELETE');
    journal.close();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    await applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    const replacement = join(f.root, 'rollback-post-commit-replacement.db');
    const retired = join(f.root, 'rollback-post-commit-retired.db');
    copyFileSync(f.dbPath, replacement);

    await expect(rollbackInlineProposalCleanup({
      dbPath: f.dbPath,
      manifestPath: plan.manifestPath,
      testOnlyAfterMutation: () => {
        renameSync(f.dbPath, retired);
        renameSync(replacement, f.dbPath);
      },
    })).rejects.toThrow(/identity|changed|replaced/i);

    expect(existsSync(join(f.artifactDir, 'rollback-receipt.json'))).toBe(false);
    const current = new DatabaseSync(f.dbPath, { readOnly: true });
    expect(getBead(current, f.invalid.id)!.bead.status).toBe('cancelled');
    current.close();
    const original = new DatabaseSync(retired, { readOnly: true });
    expect(getBead(original, f.invalid.id)!.bead.status).toBe('proposed');
    original.close();
  });

  it('detects an unrelated commit that occurs during the online backup', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    await expect(applyInlineProposalCleanup({
      dbPath: f.dbPath,
      manifestPath: plan.manifestPath,
      testOnlyDuringFingerprint: () => {
        const racer = new DatabaseSync(f.dbPath);
        racer.prepare(`INSERT INTO sweep_runs
          (run_id, started_at, proposed_count, updated_count, completed_count, observation_count, metadata_json)
          VALUES ('backup-race', 1, 0, 0, 0, 0, '{}')`).run();
        racer.close();
      },
    })).rejects.toThrow(/changed while.*backup/i);
    const check = new DatabaseSync(f.dbPath);
    expect(getBead(check, f.invalid.id)!.bead.status).toBe('proposed');
    check.close();
  });

  it('makes repeated apply and rollback idempotent', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    const first = await applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    const second = await applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    expect(second.receiptPath).toBe(first.receiptPath);
    expect(second.replayed).toBe(true);
    const rollback = await rollbackInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    const replay = await rollbackInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    expect(replay.receiptPath).toBe(rollback.receiptPath);
    expect(replay.replayed).toBe(true);
  });

  it('allows unrelated live writes but rejects target-row drift during receipt replay', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    await applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    const raw = new DatabaseSync(f.dbPath);
    raw.prepare('UPDATE beads SET title = ? WHERE id = ?').run('unattested later edit', f.valid.id);
    raw.close();
    const replay = await applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    expect(replay.replayed).toBe(true);
    const targetEdit = new DatabaseSync(f.dbPath);
    targetEdit.prepare('UPDATE beads SET title = ? WHERE id = ?').run('candidate later edit', f.invalid.id);
    targetEdit.close();
    await expect(applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath }))
      .rejects.toThrow(/drift|review/i);
  });

  it('recovers apply and rollback receipts after commit-then-artifact failures', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    await expect(applyInlineProposalCleanup({
      dbPath: f.dbPath, manifestPath: plan.manifestPath, testOnlyFault: 'apply-receipt',
    })).rejects.toThrow(/apply receipt/i);
    expect(existsSync(join(f.artifactDir, 'apply-receipt.json'))).toBe(false);
    const recoveredApply = await applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    expect(recoveredApply.replayed).toBe(true);
    expect(recoveredApply.affectedCount).toBe(1);

    await expect(rollbackInlineProposalCleanup({
      dbPath: f.dbPath, manifestPath: plan.manifestPath, testOnlyFault: 'rollback-receipt',
    })).rejects.toThrow(/rollback receipt/i);
    expect(existsSync(join(f.artifactDir, 'rollback-receipt.json'))).toBe(false);
    const recoveredRollback = await rollbackInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    expect(recoveredRollback.replayed).toBe(true);
    expect(recoveredRollback.restoredCount).toBe(1);
  });

  it('blocks rollback after a later edit', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    await applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath });
    const raw = new DatabaseSync(f.dbPath);
    updateBead(raw, f.invalid.id, { fields: { title: 'human edit' }, actor: 'human' });
    raw.close();
    await expect(rollbackInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath }))
      .rejects.toThrow(/later edit|review/i);
  });

  it('fails closed while another writer holds the database', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    const blocker = new DatabaseSync(f.dbPath);
    blocker.exec('BEGIN IMMEDIATE');
    try {
      await expect(applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath }))
        .rejects.toThrow(/busy|locked/i);
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
  });

  it('fails closed on a read-only database', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    chmodSync(f.dbPath, 0o400);
    try {
      await expect(applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath }))
        .rejects.toThrow(/readonly|read-only|permission/i);
    } finally {
      chmodSync(f.dbPath, 0o600);
    }
  });

  it('aborts before mutation when the recoverable backup cannot be created or read', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    mkdirSync(join(f.artifactDir, 'pre-apply-backup.db'), { mode: 0o700 });
    await expect(applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath }))
      .rejects.toThrow(/backup|readable|exists/i);
    const raw = new DatabaseSync(f.dbPath);
    expect(getBead(raw, f.invalid.id)!.bead.status).toBe('proposed');
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM bead_events WHERE actor='inline-proposal-cleanup'`).get())
      .toEqual({ count: 0 });
    raw.close();
  });

  it('publishes the final recoverable backup before the pre-lock hook and mutation', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    let inspected = false;
    await applyInlineProposalCleanup({
      dbPath: f.dbPath,
      manifestPath: plan.manifestPath,
      testOnlyAfterFingerprint: () => {
        const backupPath = join(f.artifactDir, 'pre-apply-backup.db');
        expect(existsSync(backupPath)).toBe(true);
        const backup = new DatabaseSync(backupPath, { readOnly: true });
        expect(getBead(backup, f.invalid.id)!.bead.status).toBe('proposed');
        backup.close();
        const source = new DatabaseSync(f.dbPath, { readOnly: true });
        expect(getBead(source, f.invalid.id)!.bead.status).toBe('proposed');
        source.close();
        inspected = true;
      },
    });
    expect(inspected).toBe(true);
    const implementation = readFileSync(new URL('../../scripts/inline-proposal-cleanup.ts', import.meta.url), 'utf8');
    expect(implementation).toContain('backupConnection(observer, paths.backup');
  });

  it('fails the whole batch deterministically on SQLITE_FULL', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    const before = new DatabaseSync(f.dbPath, { readOnly: true });
    const eventCount = before.prepare('SELECT COUNT(*) AS count FROM bead_events').get();
    before.close();
    await expect(applyInlineProposalCleanup({
      dbPath: f.dbPath,
      manifestPath: plan.manifestPath,
      testOnlyUnderLockFault: (raw) => {
        const pageCount = (raw.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
        raw.exec(`PRAGMA max_page_count=${pageCount}`);
        const insert = raw.prepare(`INSERT INTO bead_events
          (bead_id, event_type, payload_json, actor, source_message_pk, created_at)
          VALUES (?, 'full_probe', ?, 'fault-fixture', NULL, 1)`);
        for (let index = 0; index < 10_000; index += 1) {
          insert.run(f.invalid.id, 'x'.repeat(3000));
        }
        throw new Error('SQLITE_FULL fault fixture did not fill the database');
      },
    }))
      .rejects.toThrow(/full/i);
    const check = new DatabaseSync(f.dbPath, { readOnly: true });
    expect(getBead(check, f.invalid.id)!.bead.status).toBe('proposed');
    expect(check.prepare('SELECT COUNT(*) AS count FROM bead_events').get()).toEqual(eventCount);
    check.close();
  });

  it('cleans only invocation-owned plan artifacts after publication faults and permits retry', async () => {
    for (const fault of ['manifest', 'companion'] as const) {
      const f = fixture();
      let holder: DatabaseSync | undefined;
      if (fault === 'companion') {
        holder = new DatabaseSync(f.dbPath);
        holder.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
        createBead(holder, {
          kind: 'task', status: 'proposed', title: 'wal', body: 'wal discussion', ownerJid: 'owner',
          actor: 'inline', sourceMessagePk: 900, proposalReason: 'inline imperative: schedule', reviewByAt: 1,
        });
      }
      await expect(planInlineProposalCleanup({
        dbPath: f.dbPath, artifactDir: f.artifactDir, testOnlyFault: fault,
      })).rejects.toThrow(/Injected/);
      expect(existsSync(join(f.artifactDir, 'manifest.json'))).toBe(false);
      expect(existsSync(join(f.artifactDir, 'database-snapshot.db'))).toBe(false);
      const retry = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
      expect(existsSync(retry.manifestPath)).toBe(true);
      holder?.close();
    }
  });

  it('detects a permissive-classifier retained-valid negative control', async () => {
    const f = fixture();
    const baseline = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    const controlDir = join(f.root, 'control');
    mkdirSync(controlDir, { mode: 0o700 });
    await expect(planInlineProposalCleanup({
      dbPath: f.dbPath,
      artifactDir: controlDir,
      expectedRetainedValid: baseline.manifest.retainedValid,
      classifierVersion: CLASSIFIER_VERSION,
      classifier: () => ({ admitted: true, verb: 'schedule', normalizedTarget: 'x', matchedText: 'x' }),
    })).rejects.toThrow(/retained-valid drift/i);
  });

  it('rejects corrupt manifests and never places bodies in any JSON artifact', async () => {
    const f = fixture();
    const plan = await planInlineProposalCleanup({ dbPath: f.dbPath, artifactDir: f.artifactDir });
    const manifest = readManifest(plan.manifestPath);
    manifest.classifierVersion = 'unknown';
    writeFileSync(plan.manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    await expect(applyInlineProposalCleanup({ dbPath: f.dbPath, manifestPath: plan.manifestPath }))
      .rejects.toThrow(/classifier|manifest/i);
    expect(existsSync(plan.manifestPath)).toBe(true);
  });

  it('dispatches all four CLI commands and fails closed with bounded body-free diagnostics', async () => {
    expect(parseCleanupArgs(['plan', '--db', 'a.db', '--artifact-dir', 'out']).command).toBe('plan');
    for (const command of ['apply', 'verify', 'rollback'] as const) {
      expect(parseCleanupArgs([command, '--db', 'a.db', '--manifest', 'manifest.json']).command).toBe(command);
    }
    expect(() => parseCleanupArgs(['destroy', '--db', 'a.db'])).toThrow(/Usage/);
    const output: string[] = [];
    const errors: string[] = [];
    const exit = await runCleanupCli(['apply', '--db', '/does/not/exist', '--manifest', '/missing'], {
      out: (text) => output.push(text), err: (text) => errors.push(text),
    });
    expect(exit).toBe(1);
    expect(output).toEqual([]);
    expect(errors.join('')).toMatch(/^inline-proposal-cleanup:/);
    expect(errors.join('').length).toBeLessThan(500);
    expect(errors.join('')).not.toContain('schedule release review');

    const oversizedErrors: string[] = [];
    const oversized = await runCleanupCli([
      'plan', '--db', join('/does/not/exist', 'x'.repeat(12_000)), '--artifact-dir', 'out',
    ], {
      out: () => undefined, err: (text) => oversizedErrors.push(text),
    });
    expect(oversized).toBe(1);
    expect(Buffer.byteLength(oversizedErrors.join(''), 'utf8')).toBeLessThanOrEqual(320);
    expect(oversizedErrors.join('')).not.toContain('x'.repeat(500));

    const syntheticToken = `g${'hp_'}${'a'.repeat(36)}`;
    const secretErrors: string[] = [];
    await runCleanupCli([
      'plan', '--db', join('/does/not/exist', syntheticToken, '2125550199'), '--artifact-dir', 'out',
    ], { out: () => undefined, err: (text) => secretErrors.push(text) });
    expect(secretErrors.join('')).not.toContain(syntheticToken);
    expect(secretErrors.join('')).not.toContain('2125550199');
  });

  it('rejects tampered apply and rollback receipts instead of replaying them', async () => {
    const applyCase = fixture();
    const applyPlan = await planInlineProposalCleanup({ dbPath: applyCase.dbPath, artifactDir: applyCase.artifactDir });
    const applied = await applyInlineProposalCleanup({ dbPath: applyCase.dbPath, manifestPath: applyPlan.manifestPath });
    writeFileSync(applied.receiptPath, `${JSON.stringify({
      ...JSON.parse(readFileSync(applied.receiptPath, 'utf8')),
      postFingerprint: '0'.repeat(64),
    })}\n`, { mode: 0o600 });
    await expect(applyInlineProposalCleanup({ dbPath: applyCase.dbPath, manifestPath: applyPlan.manifestPath }))
      .rejects.toThrow(/apply receipt/i);

    const rollbackCase = fixture();
    const rollbackPlan = await planInlineProposalCleanup({ dbPath: rollbackCase.dbPath, artifactDir: rollbackCase.artifactDir });
    await applyInlineProposalCleanup({ dbPath: rollbackCase.dbPath, manifestPath: rollbackPlan.manifestPath });
    const rolledBack = await rollbackInlineProposalCleanup({ dbPath: rollbackCase.dbPath, manifestPath: rollbackPlan.manifestPath });
    writeFileSync(rolledBack.receiptPath, `${JSON.stringify({
      ...JSON.parse(readFileSync(rolledBack.receiptPath, 'utf8')),
      postFingerprint: '0'.repeat(64),
    })}\n`, { mode: 0o600 });
    await expect(rollbackInlineProposalCleanup({ dbPath: rollbackCase.dbPath, manifestPath: rollbackPlan.manifestPath }))
      .rejects.toThrow(/rollback receipt/i);
  });

  it('hashes files larger than two chunks without whole-file buffering', () => {
    const f = fixture();
    const largePath = join(f.root, 'large.bin');
    const content = Buffer.alloc(HASH_CHUNK_BYTES * 2 + 17, 0x5a);
    writeFileSync(largePath, content, { mode: 0o600 });
    expect(hashCleanupFile(largePath)).toBe(createHash('sha256').update(content).digest('hex'));
    expect(statSync(largePath).size).toBeGreaterThan(HASH_CHUNK_BYTES * 2);
  });
});
