/**
 * capability-obligation-backfill-execute — the OWNER-GATED backfill EXECUTOR
 * (candidate §4). It consumes the eligible descriptors of an APPROVED manifest
 * (see capability-obligation-backfill-manifest.ts) and appends the historical
 * obligations, idempotently, through the SAME guarded store as the runtime.
 *
 * Safety properties, all fixture-proven:
 *  - APPROVED-MANIFEST VERIFICATION (F1/r9): the executor recomputes the manifest
 *    digest over the descriptors it is about to run and REFUSES THE WHOLE RUN if
 *    it does not equal the operator-supplied approved digest.
 *  - REVIEWER-CLASSIFIED NON-FULFILMENT (F2/r9): an entry is created only when the
 *    reviewer classified it `confirmed_unfulfilled` AND the persisted recovery
 *    job named by the approval (selected BY ID) agrees on
 *    inbound/message/conversation/destination, is completed+echo, and has no
 *    sibling worker-fulfilment. Echo is corroboration with VETO power; the real
 *    recovery job id is persisted as `origin_recovery_job_id` (never null).
 *  - REPLAY-PAYLOAD BINDING (F3/r10): the manifest binds the input digest
 *    (message text + prepared media class) at approval time; the executor
 *    RE-COMPUTES it from the CURRENT message and skips on mismatch, so a WhatsApp
 *    edit to the replayed instruction after approval cannot execute.
 *  - MEDIA hash/retain/REVERIFY: media is retained (copy+fsync+rehash) and its
 *    sha256 must match the approved descriptor, else skipped.
 *  - IDEMPOTENT: an obligation already present for the (inbound, message,
 *    contract, capability) key is a no-op — a second run creates nothing.
 *  - TRUE ATOMICITY (F2/r10): validation is a first pass; if ANY approved entry
 *    hard-fails (recovery/media/input reverify), the run commits NOTHING — no
 *    partial backfill. Only when every approved entry prepares cleanly does the
 *    single all-row transaction commit.
 *  - ORIGINAL RECOVERY ROWS UNCHANGED: the target recovery-job rows are
 *    snapshotted before/after and proven untouched.
 *
 * The owner-gated CLI (`runBackfillExecuteCli`) adds a schema guard, a
 * quiescence lock, a backup precondition BOUND to the target (file-set hash
 * equality, lock acquired first), an expected-state precondition, a confirmation
 * token equal to the approved digest, a pre-commit concurrent-write re-check, and
 * dry-run-by-default. Execution against a live instance DB stays owner-gated.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { capabilityInputDigest } from '../src/core/capability-contract.ts';
import { CapabilityObligationStore } from '../src/core/capability-obligation-store.ts';
import { Database } from '../src/core/database.ts';
import { CURRENT_SCHEMA_MIGRATION } from '../src/core/database-schema-version.ts';
import { retainMediaForObligation } from '../src/core/obligation-media-retention.ts';
import {
  classifyRecoveryFulfillment,
  computeManifestDigest,
  type BackfillDescriptor,
} from './capability-obligation-backfill-manifest.ts';

export interface BackfillExecuteResult {
  /** false means the recomputed digest did not match the approval; nothing ran. */
  digestVerified: boolean;
  recomputedDigest: string;
  created: number[];
  /** Source seqs that WOULD be created (dry-run only; empty on a confirmed run). */
  wouldCreate: number[];
  alreadyExisted: number[];
  skipped: Array<{ sourceInboundSeq: number; reason: string }>;
  /** True when the run was aborted BEFORE committing because an approved entry hard-failed. */
  abortedForSkips: boolean;
  recoveryRowsUnchanged: boolean;
}

interface RecoverySnapshotRow {
  source_inbound_seq: number;
  state: string;
  completion_kind: string | null;
  completion_proof_id: string | null;
}

function snapshotRecovery(db: Database, seqs: readonly number[]): string {
  const rows: RecoverySnapshotRow[] = [];
  const stmt = db.raw.prepare(
    'SELECT source_inbound_seq, state, completion_kind, completion_proof_id FROM turn_recovery_jobs WHERE source_inbound_seq = ? ORDER BY id ASC',
  );
  for (const seq of [...seqs].sort((a, b) => a - b)) {
    for (const r of stmt.all(seq) as unknown as RecoverySnapshotRow[]) rows.push(r);
  }
  return JSON.stringify(rows);
}

interface RecoveryBind {
  recoveryJobId: number;
  sourceInboundSeq: number;
  sourceMessageId: string;
  conversationKey: string;
  deliveryJid: string;
  classification: NonNullable<BackfillDescriptor['fulfillmentClassification']>;
}
interface PreparedInsert {
  sourceInboundSeq: number;
  bind: RecoveryBind;
  contractVersion: string;
  requiredCapability: string;
  // NonNullable: prepared[] entries ALWAYS carry an obligation (built unconditionally in
  // STAGE A below), so the under-lock re-check and the insert may read it without a guard.
  obligation: NonNullable<Parameters<CapabilityObligationStore['applyDecisionWithinCallerTransaction']>[0]['obligation']>;
}

export async function executeBackfill(
  db: Database,
  params: {
    manifestId: string;
    /** The approved manifest digest — the executor recomputes and must match. */
    approvedDigest: string;
    eligible: readonly BackfillDescriptor[];
    mediaRoot: string;
    retentionPolicyVersion: string;
    skillName: string;
    /** Preview only — run all checks but insert nothing (no media retained either). */
    dryRun?: boolean;
    /** F1 — invoked INSIDE the write lock before commit; throw to abort with rollback. */
    preCommitAssert?: () => void;
  },
): Promise<BackfillExecuteResult> {
  const dryRun = params.dryRun ?? false;
  const seqs = params.eligible.map((e) => e.sourceInboundSeq);
  const recoveryBefore = snapshotRecovery(db, seqs);

  const recomputedDigest = computeManifestDigest(params.manifestId, params.eligible);
  if (recomputedDigest !== params.approvedDigest) {
    return {
      digestVerified: false, recomputedDigest, created: [], wouldCreate: [], alreadyExisted: [],
      skipped: [], abortedForSkips: false, recoveryRowsUnchanged: true,
    };
  }

  const store = new CapabilityObligationStore(db);
  const created: number[] = [];
  const wouldCreate: number[] = [];
  const alreadyExisted: number[] = [];
  const skipped: Array<{ sourceInboundSeq: number; reason: string }> = [];
  const prepared: PreparedInsert[] = [];

  const msgStmt = db.raw.prepare(
    'SELECT content, media_path, sender_jid, sender_name FROM messages WHERE message_id = ? ORDER BY pk DESC LIMIT 1',
  );
  const existsStmt = db.raw.prepare(
    `SELECT id FROM capability_obligations
     WHERE source_inbound_seq = ? AND source_message_id = ? AND contract_version = ? AND required_capability = ?`,
  );
  const done = (abortedForSkips: boolean): BackfillExecuteResult => ({
    digestVerified: true, recomputedDigest, created, wouldCreate, alreadyExisted, skipped,
    abortedForSkips, recoveryRowsUnchanged: recoveryBefore === snapshotRecovery(db, seqs),
  });

  // ---- STAGE A (UNLOCKED, async): validate, retain+reverify media, build prepared[].
  // The recovery/idempotency reads here are a first pass (for reporting + dry-run);
  // they are RE-RUN authoritatively inside the lock in stage C.
  for (const d of params.eligible) {
    if (
      !d.eligible || d.requiredCapability === undefined || d.contractVersion === undefined
      || d.sourceDigest === undefined || d.recoveryJobId === undefined || d.fulfillmentClassification === undefined
      || d.conversationKey === undefined || d.deliveryJid === undefined || d.inputDigest === undefined
    ) {
      skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'descriptor_not_eligible' });
      continue;
    }
    const bind: RecoveryBind = {
      recoveryJobId: d.recoveryJobId,
      sourceInboundSeq: d.sourceInboundSeq,
      sourceMessageId: d.sourceMessageId,
      conversationKey: d.conversationKey,
      deliveryJid: d.deliveryJid,
      classification: d.fulfillmentClassification,
    };
    const recoveryReason = classifyRecoveryFulfillment(db.raw, bind);
    if (recoveryReason !== null) {
      skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: recoveryReason });
      continue;
    }
    const existing = existsStmt.get(d.sourceInboundSeq, d.sourceMessageId, d.contractVersion, d.requiredCapability) as
      | { id: number } | undefined;
    if (existing !== undefined) {
      alreadyExisted.push(existing.id);
      continue;
    }
    const msg = msgStmt.get(d.sourceMessageId) as
      | { content: string | null; media_path: string | null; sender_jid: string; sender_name: string | null }
      | undefined;
    if (msg === undefined) {
      skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'message_not_found' });
      continue;
    }
    // F3 — RE-VERIFY the input digest against the CURRENT message.
    const currentInputDigest = capabilityInputDigest({ text: msg.content ?? '', preparedMediaClass: d.preparedMediaClass ?? null });
    if (currentInputDigest !== d.inputDigest) {
      skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'input_reverify_failed' });
      continue;
    }
    // Media: REVERIFY. Dry-run is a read-only hash compare; a confirmed run retains.
    let retainedMedia: { path: string; sha256: string; bytes: number; policyVersion: string } | null = null;
    if (d.mediaSha256 != null) {
      if (msg.media_path == null) {
        skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'media_path_missing' });
        continue;
      }
      if (dryRun) {
        let sha: string;
        try {
          sha = createHash('sha256').update(readFileSync(msg.media_path)).digest('hex');
        } catch {
          skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'media_unavailable' });
          continue;
        }
        if (sha !== d.mediaSha256) {
          skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'media_reverify_failed' });
          continue;
        }
      } else {
        let retained;
        try {
          retained = await retainMediaForObligation({ root: params.mediaRoot, policyVersion: params.retentionPolicyVersion }, msg.media_path);
        } catch {
          skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'media_retention_failed' });
          continue;
        }
        if (retained.sha256 !== d.mediaSha256) {
          skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'media_reverify_failed' });
          continue;
        }
        retainedMedia = { path: retained.path, sha256: retained.sha256, bytes: retained.bytes, policyVersion: retained.policyVersion };
      }
    }
    if (dryRun) {
      wouldCreate.push(d.sourceInboundSeq);
      continue;
    }
    prepared.push({
      sourceInboundSeq: d.sourceInboundSeq,
      bind,
      contractVersion: d.contractVersion,
      requiredCapability: d.requiredCapability,
      obligation: {
        sourceInboundSeq: d.sourceInboundSeq,
        sourceMessageId: d.sourceMessageId,
        conversationKey: d.conversationKey,
        deliveryJid: d.deliveryJid,
        senderJid: msg.sender_jid,
        senderName: msg.sender_name,
        isGroup: d.isGroup ?? false,
        groupName: d.isGroup ? d.deliveryJid : null,
        scope: 'per_chat',
        originRecoveryJobId: d.recoveryJobId,
        replayText: retainedMedia ? (msg.content && msg.content.length > 0 ? msg.content : '[retained media]') : (msg.content ?? ''),
        contentTypeHint: retainedMedia ? 'media' : 'text',
        contractVersion: d.contractVersion,
        requiredCapability: d.requiredCapability,
        capabilityParams: JSON.stringify({ skill: params.skillName }),
        inputDigest: d.inputDigest,
        sourceDigest: d.sourceDigest,
        sourceToken: retainedMedia ? null : (d.sourceToken ?? null),
        retainedMedia,
        creationReason: `reviewed_backfill:${params.manifestId}`,
      },
    });
  }

  if (dryRun) return done(false);
  // TRUE ATOMICITY — any hard skip commits NOTHING (no lock needed; nothing to write).
  if (skipped.length > 0) return done(true);
  if (prepared.length === 0) return done(false);

  // ---- STAGE B — acquire the write lock. This IS the quiescence gate: if a
  // concurrent writer holds it, BEGIN IMMEDIATE is refused (the fast-fail
  // assertQuiescent pre-check already caught the common bot-running case).
  db.raw.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    // ---- STAGE C (SYNCHRONOUS, under the lock):
    // 3a. F1 — backup-verify uses a WAL-aware file-set snapshot WHILE holding the
    //     write lock, so a concurrent WAL commit before we locked is caught and no
    //     new write can land during the critical section.
    params.preCommitAssert?.();
    // 3b. Re-run recovery + idempotency under the lock (TOCTOU): the stage-A reads
    //     are advisory; only these authoritative re-checks gate the insert.
    for (const p of prepared) {
      const recovered = classifyRecoveryFulfillment(db.raw, p.bind);
      const existsNow = existsStmt.get(p.sourceInboundSeq, p.obligation.sourceMessageId, p.contractVersion, p.requiredCapability);
      if (recovered !== null || existsNow !== undefined) {
        db.raw.exec('ROLLBACK');
        committed = true; // finally must not double-rollback
        skipped.push({ sourceInboundSeq: p.sourceInboundSeq, reason: 'state_changed_under_lock' });
        return done(true);
      }
    }
    // 3c. Inserts + commit — all-or-nothing.
    for (const p of prepared) {
      const { obligationId } = store.applyDecisionWithinCallerTransaction({
        auditEvent: { action: 'obligation.create', actorType: 'operator', reasonCode: 'reviewed_backfill' },
        obligation: p.obligation,
      });
      if (obligationId != null) created.push(obligationId);
    }
    db.raw.exec('COMMIT');
    committed = true;
  } finally {
    if (!committed) {
      try { db.raw.exec('ROLLBACK'); } catch { /* best-effort */ }
    }
  }

  return done(false);
}

// ---------------------------------------------------------------------------
// Owner-gated CLI (F3/r9 + F5/r10). Dry-run by default.
// ---------------------------------------------------------------------------

export interface BackfillExecuteIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

function schemaVersionOf(dbPath: string): number {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    try {
      return Number((raw.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(message)) return 0;
      throw new Error(`could not read schema version from ${dbPath}: ${message}`);
    }
  } finally {
    raw.close();
  }
}

/** sha256 over the SQLite CONTENT file set (main || -wal), absent file = empty
 *  (F5, WAL-aware). `-shm` is excluded — transient shared memory, not content. */
export function dbFileSetHash(path: string): string {
  const h = createHash('sha256');
  for (const suffix of ['', '-wal']) {
    try {
      h.update(readFileSync(`${path}${suffix}`));
    } catch { /* absent component contributes nothing */ }
    h.update('\0');
  }
  return h.digest('hex');
}

function isSqliteFile(path: string): boolean {
  return readFileSync(path).subarray(0, 16).toString('latin1').startsWith('SQLite format 3');
}

/** Fast-fail quiescence PRE-CHECK: a `BEGIN IMMEDIATE` that fails immediately
 *  (busy_timeout=0) if another connection (the bot) holds the write lock. This is
 *  ergonomics only — the REAL race protection is executeBackfill holding the write
 *  lock across the whole critical section plus the WAL-aware file-set backup-verify
 *  under that lock. It detects a current writer; it does NOT prove the bot process
 *  is stopped (operator-attested). */
function assertQuiescent(dbPath: string): void {
  // A fresh DatabaseSync connection does not inherit the app's busy-timeout, so
  // BEGIN IMMEDIATE fails immediately when the write lock is held (no PRAGMA needed).
  const raw = new DatabaseSync(dbPath);
  try {
    raw.exec('BEGIN IMMEDIATE');
    raw.exec('ROLLBACK');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`refusing to operate: database is busy/locked (is the bot running?): ${message}`);
  } finally {
    raw.close();
  }
}

export async function runBackfillExecuteCli(argv: readonly string[], io: BackfillExecuteIo): Promise<number> {
  const flags = new Map<string, string>();
  let confirmToken: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    if (t === '--json') { json = true; continue; }
    if (t === '--help') { io.out(backfillExecuteUsage()); return 0; }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${t} requires a value`);
    if (t === '--confirm') confirmToken = v;
    else flags.set(t, v);
    i += 1;
  }
  const dbPath = flags.get('--db');
  const manifestPath = flags.get('--manifest');
  const mediaRoot = flags.get('--media-root');
  const retentionPolicyVersion = flags.get('--retention-policy-version');
  const skillName = flags.get('--skill');
  const runId = flags.get('--run-id');
  const backupPath = flags.get('--backup-path');
  const expectExistingRaw = flags.get('--expect-existing') ?? '0';
  if (!dbPath || !manifestPath || !mediaRoot || !retentionPolicyVersion || !skillName || !runId) {
    throw new Error(`missing required flag.\n${backfillExecuteUsage()}`);
  }
  if (!/^\d+$/.test(expectExistingRaw)) throw new Error('--expect-existing must be a non-negative integer');
  const expectExisting = Number(expectExistingRaw);

  const version = schemaVersionOf(dbPath);
  if (version !== CURRENT_SCHEMA_MIGRATION) {
    io.err(`refusing: database is at schema ${version}, expected ${CURRENT_SCHEMA_MIGRATION}. This tool never migrates a live database.`);
    return 2;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    manifestId: string; manifestDigest: string; entries: BackfillDescriptor[];
  };
  const eligible = manifest.entries.filter((e) => e.eligible);
  const dryRun = confirmToken === null;
  let backupFileSetHash = '';

  if (!dryRun) {
    if (confirmToken !== manifest.manifestDigest) {
      io.err('refusing: --confirm token does not equal the manifest digest (pass the approved digest as the confirmation token).');
      return 2;
    }
    if (!backupPath) {
      io.err('refusing: --backup-path is required to apply (a verified pre-run backup).');
      return 2;
    }
    // Fast-fail quiescence signal (ergonomics). The AUTHORITATIVE race protection
    // is executeBackfill holding BEGIN IMMEDIATE across the critical section plus
    // the WAL-aware file-set backup-verify UNDER that lock (preCommitAssert below).
    assertQuiescent(dbPath);
    // Validate the backup is a real SQLite file at the current schema (fail fast);
    // the byte-exact FILE-SET match to the target is checked under the lock.
    let backupValid = false;
    try {
      backupValid = isSqliteFile(backupPath) && schemaVersionOf(backupPath) === CURRENT_SCHEMA_MIGRATION;
    } catch {
      backupValid = false;
    }
    if (!backupValid) {
      io.err(`refusing: --backup-path is not a SQLite backup at schema ${CURRENT_SCHEMA_MIGRATION}.`);
      return 2;
    }
    backupFileSetHash = dbFileSetHash(backupPath);
  }

  const db = new Database(dbPath);
  db.open();
  try {
    const existingCount = Number(
      (db.raw.prepare('SELECT COUNT(*) AS c FROM capability_obligations WHERE creation_reason = ?')
        .get(`reviewed_backfill:${manifest.manifestId}`) as { c: number }).c,
    );
    if (existingCount !== expectExisting) {
      io.err(`refusing: expected ${expectExisting} existing backfill obligations for ${manifest.manifestId}, found ${existingCount}.`);
      return 2;
    }

    let result: BackfillExecuteResult;
    try {
      result = await executeBackfill(db, {
        manifestId: manifest.manifestId,
        approvedDigest: manifest.manifestDigest,
        eligible,
        mediaRoot,
        retentionPolicyVersion,
        skillName,
        dryRun,
        // F1 — runs UNDER the write lock: a WAL-aware file-set comparison to the
        // approved backup. Catches a concurrent WAL/main commit that landed since
        // the backup was taken (main-only hashing would miss a WAL-only write).
        preCommitAssert: dryRun ? undefined : () => {
          if (dbFileSetHash(dbPath) !== backupFileSetHash) {
            throw new Error('the target file-set does not match the --backup-path — not a byte-exact SQLite backup of the target, '
              + 'or the target changed since the backup (a concurrent WAL/main write). This binds the backup and detects a concurrent '
              + 'writer, but does NOT prove the bot process is stopped — that stays operator-attested.');
          }
        },
      });
    } catch (err) {
      io.err(`refusing: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }

    if (!result.digestVerified) {
      io.err(`refusing: recomputed manifest digest ${result.recomputedDigest} != approved ${manifest.manifestDigest} (descriptors were altered after approval).`);
      return 2;
    }
    io.out(json ? JSON.stringify({ mode: dryRun ? 'dry-run' : 'confirm', runId, ...result }) : renderExecuteHuman(dryRun, runId, result));
    if (!dryRun && result.abortedForSkips) return 1;
    if (!dryRun && result.skipped.length > 0) return 1;
    return 0;
  } finally {
    db.close();
  }
}

function renderExecuteHuman(dryRun: boolean, runId: string, r: BackfillExecuteResult): string {
  const lines = [
    `backfill ${dryRun ? 'DRY-RUN' : r.abortedForSkips ? 'ABORTED (no partial backfill)' : 'APPLIED'} run=${runId} — digest verified`,
    dryRun
      ? `  wouldCreate=${r.wouldCreate.length} alreadyExisted=${r.alreadyExisted.length} skipped=${r.skipped.length}`
      : `  created=${r.created.length} alreadyExisted=${r.alreadyExisted.length} skipped=${r.skipped.length} recoveryRowsUnchanged=${r.recoveryRowsUnchanged}`,
  ];
  for (const s of r.skipped) lines.push(`  skipped seq=${s.sourceInboundSeq} reason=${s.reason}`);
  if (r.abortedForSkips) lines.push('ABORTED — an approved entry could not be created, so the whole run was rolled back (all-or-nothing). Fix and re-run.');
  else if (dryRun) lines.push('DRY-RUN — nothing created. Pass --confirm <approvedDigest> with --backup-path to apply.');
  return lines.join('\n');
}

function backfillExecuteUsage(): string {
  return [
    'Usage: capability-obligation-backfill-execute --db PATH --manifest MANIFEST.json \\',
    '         --media-root DIR --retention-policy-version V --skill NAME --run-id ID \\',
    '         [--expect-existing N] [--backup-path PATH] [--confirm APPROVED_DIGEST] [--json]',
    '',
    'OWNER-GATED. Dry-run by default (runs all checks, creates nothing, retains no media).',
    'To APPLY: --confirm must equal the manifest digest; the DB must be quiescent (a current',
    'writer is refused — this does NOT prove the bot process is stopped, which is operator-',
    'attested); --backup-path must be a byte-exact SQLite file-set snapshot of THE TARGET at',
    'the current schema; the current backfill count for this manifest must equal --expect-existing.',
    'The run is all-or-nothing: if any approved entry hard-fails, NOTHING is committed.',
  ].join('\n');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runBackfillExecuteCli(process.argv.slice(2), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  })
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
