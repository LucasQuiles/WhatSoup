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
import { withTransaction } from '../src/core/db-tx.ts';
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
    for (const r of stmt.all(seq) as RecoverySnapshotRow[]) rows.push(r);
  }
  return JSON.stringify(rows);
}

interface PreparedInsert {
  sourceInboundSeq: number;
  obligation: Parameters<CapabilityObligationStore['applyDecisionWithinCallerTransaction']>[0]['obligation'];
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
    /** Invoked at the START of the commit transaction (F5) — throw to abort with rollback. */
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

  for (const d of params.eligible) {
    if (
      !d.eligible || d.requiredCapability === undefined || d.contractVersion === undefined
      || d.sourceDigest === undefined || d.recoveryJobId === undefined || d.fulfillmentClassification === undefined
      || d.conversationKey === undefined || d.deliveryJid === undefined || d.inputDigest === undefined
    ) {
      skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'descriptor_not_eligible' });
      continue;
    }
    // 1. F2 — prove prior non-fulfilment against the EXACT reviewer-classified job.
    const recoveryReason = classifyRecoveryFulfillment(db.raw, {
      recoveryJobId: d.recoveryJobId,
      sourceInboundSeq: d.sourceInboundSeq,
      sourceMessageId: d.sourceMessageId,
      conversationKey: d.conversationKey,
      deliveryJid: d.deliveryJid,
      classification: d.fulfillmentClassification,
    });
    if (recoveryReason !== null) {
      skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: recoveryReason });
      continue;
    }
    // 2. Idempotency: an obligation for this key already exists → no-op.
    const existing = existsStmt.get(d.sourceInboundSeq, d.sourceMessageId, d.contractVersion, d.requiredCapability) as
      | { id: number } | undefined;
    if (existing !== undefined) {
      alreadyExisted.push(existing.id);
      continue;
    }
    // 3. Read the CURRENT message.
    const msg = msgStmt.get(d.sourceMessageId) as
      | { content: string | null; media_path: string | null; sender_jid: string; sender_name: string | null }
      | undefined;
    if (msg === undefined) {
      skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'message_not_found' });
      continue;
    }
    // 4. F3 — RE-VERIFY the input digest against the CURRENT message. A post-approval
    //    edit to the replayed instruction changes the digest and is refused.
    const currentInputDigest = capabilityInputDigest({ text: msg.content ?? '', preparedMediaClass: d.preparedMediaClass ?? null });
    if (currentInputDigest !== d.inputDigest) {
      skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'input_reverify_failed' });
      continue;
    }
    // 5. Media: REVERIFY against the approved descriptor. Dry-run is a read-only
    //    hash compare (no retention); a confirmed run retains (copy/fsync/rehash).
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

  // F2/r10 — TRUE ATOMICITY over the approved set. If any approved entry hard-failed,
  // commit NOTHING (a partial backfill is never acceptable). alreadyExisted is an
  // idempotent no-op and does not block.
  if (!dryRun && skipped.length > 0) {
    return {
      digestVerified: true, recomputedDigest, created: [], wouldCreate, alreadyExisted, skipped,
      abortedForSkips: true, recoveryRowsUnchanged: recoveryBefore === snapshotRecovery(db, seqs),
    };
  }

  if (!dryRun && prepared.length > 0) {
    withTransaction(db, () => {
      // F5 — concurrent-write re-check inside the commit transaction.
      params.preCommitAssert?.();
      for (const p of prepared) {
        const { obligationId } = store.applyDecisionWithinCallerTransaction({
          auditEvent: { action: 'obligation.create', actorType: 'operator', reasonCode: 'reviewed_backfill' },
          obligation: p.obligation,
        });
        if (obligationId != null) created.push(obligationId);
      }
    });
  }

  return {
    digestVerified: true, recomputedDigest, created, wouldCreate, alreadyExisted, skipped,
    abortedForSkips: false, recoveryRowsUnchanged: recoveryBefore === snapshotRecovery(db, seqs),
  };
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

/** sha256 of the main db file only — stable across a read-only connection's transient -wal. */
function mainFileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isSqliteFile(path: string): boolean {
  return readFileSync(path).subarray(0, 16).toString('latin1').startsWith('SQLite format 3');
}

/** Point-in-time quiescence: BEGIN IMMEDIATE acquires the write lock only if no
 *  other connection (the bot) holds it. Busy/locked → refuse. NOTE: this detects
 *  a current writer; it does NOT prove the bot process is stopped. */
function assertQuiescent(dbPath: string): void {
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
  let mainBefore = '';

  if (!dryRun) {
    if (confirmToken !== manifest.manifestDigest) {
      io.err('refusing: --confirm token does not equal the manifest digest (pass the approved digest as the confirmation token).');
      return 2;
    }
    if (!backupPath) {
      io.err('refusing: --backup-path is required to apply (a verified pre-run backup).');
      return 2;
    }
    // F5 — acquire the quiescence lock FIRST, THEN bind the backup to the target
    // by file-set hash. Ordering matters: comparing before the lock races the target.
    assertQuiescent(dbPath);
    let backupOk = false;
    try {
      backupOk = isSqliteFile(backupPath)
        && schemaVersionOf(backupPath) === CURRENT_SCHEMA_MIGRATION
        && dbFileSetHash(backupPath) === dbFileSetHash(dbPath);
    } catch {
      backupOk = false;
    }
    if (!backupOk) {
      io.err(`refusing: --backup-path is not a byte-exact SQLite backup of the target at schema ${CURRENT_SCHEMA_MIGRATION} `
        + '(the backup must be a current snapshot of THIS database). NOTE: this binds the backup and detects a '
        + 'concurrent writer, but does NOT prove the bot process is stopped — that stays operator-attested.');
      return 2;
    }
    mainBefore = mainFileHash(dbPath);
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
        preCommitAssert: dryRun ? undefined : () => {
          if (mainFileHash(dbPath) !== mainBefore) {
            throw new Error('target changed since backup — concurrent write detected; aborting before commit.');
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
