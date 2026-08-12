/**
 * capability-obligation-backfill-execute — the OWNER-GATED backfill EXECUTOR
 * (candidate §4). It consumes the eligible descriptors of an APPROVED manifest
 * (see capability-obligation-backfill-manifest.ts) and appends the historical
 * obligations, idempotently, through the SAME guarded store as the runtime.
 *
 * Safety properties, all fixture-proven:
 *  - APPROVED-MANIFEST VERIFICATION (F1): the executor recomputes the manifest
 *    digest over the descriptors it is about to run and REFUSES THE WHOLE RUN if
 *    it does not equal the operator-supplied approved digest. A descriptor
 *    tampered after approval (a changed destination, source, job, or
 *    classification) changes the recomputed digest, so it cannot be executed.
 *  - REVIEWER-CLASSIFIED NON-FULFILMENT (F2): an entry is created only when the
 *    reviewer classified it `confirmed_unfulfilled` AND the persisted recovery
 *    job named by the approval (selected BY ID, never "latest by sequence")
 *    agrees on inbound/message/conversation/destination, is completed+echo, and
 *    has no sibling worker-fulfilment. The executor does NOT re-derive
 *    non-fulfilment from echo-settlement — that delivery/fulfilment conflation is
 *    the very defect this feature corrects. Echo is corroboration with VETO
 *    power; the affirmative signal is the reviewer's classification, which F1's
 *    digest binds so it cannot be added after approval. The real recovery job id
 *    is persisted as `origin_recovery_job_id` (never null).
 *  - MEDIA hash/retain/REVERIFY: media is retained (copy+fsync+rehash) and its
 *    sha256 must match the approved descriptor, else skipped.
 *  - IDEMPOTENT: an obligation already present for the (inbound, message,
 *    contract, capability) key is a no-op — a second run creates nothing.
 *  - ALL-ROW TRANSACTION: every obligation insert for the run commits in ONE
 *    transaction, so a partial backfill can never land.
 *  - ORIGINAL RECOVERY ROWS UNCHANGED: the target recovery-job rows are
 *    snapshotted before/after and proven untouched (backfill never rewrites the
 *    original failure record).
 *
 * Reviewer classification (candidate §4) — including the audio path the live
 * contract cannot represent — arrives via the descriptor's requiredCapability.
 * The owner-gated CLI (`runBackfillExecuteCli`) adds a schema guard, a
 * quiescence check, a backup precondition, an expected-state precondition, a
 * confirmation token equal to the approved digest, and dry-run-by-default.
 * Execution against a live instance DB stays owner-gated; this module is
 * exercised against fixtures.
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
  /** F1 — false means the recomputed digest did not match the approval; nothing ran. */
  digestVerified: boolean;
  recomputedDigest: string;
  created: number[];
  /** Source seqs that WOULD be created (dry-run only; empty on a confirmed run). */
  wouldCreate: number[];
  alreadyExisted: number[];
  skipped: Array<{ sourceInboundSeq: number; reason: string }>;
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

/** A message + obligation payload prepared in the async phase, inserted in the transaction. */
interface PreparedInsert {
  sourceInboundSeq: number;
  obligation: Parameters<CapabilityObligationStore['applyDecisionWithinCallerTransaction']>[0]['obligation'];
}

export async function executeBackfill(
  db: Database,
  params: {
    manifestId: string;
    /** The approved manifest digest (F1) — the executor recomputes and must match. */
    approvedDigest: string;
    eligible: readonly BackfillDescriptor[];
    mediaRoot: string;
    retentionPolicyVersion: string;
    skillName: string;
    /** preparedMediaClass used for the D1 input digest (reviewer classification). */
    mediaClassFor?: (d: BackfillDescriptor) => string | null;
    /** Preview only — run all checks but insert nothing (no media retained either). */
    dryRun?: boolean;
  },
): Promise<BackfillExecuteResult> {
  const dryRun = params.dryRun ?? false;
  const seqs = params.eligible.map((e) => e.sourceInboundSeq);
  const recoveryBefore = snapshotRecovery(db, seqs);

  // F1 — recompute the manifest digest over the descriptors we are about to run.
  const recomputedDigest = computeManifestDigest(params.manifestId, params.eligible);
  if (recomputedDigest !== params.approvedDigest) {
    return {
      digestVerified: false,
      recomputedDigest,
      created: [],
      wouldCreate: [],
      alreadyExisted: [],
      skipped: [],
      recoveryRowsUnchanged: true,
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
      !d.eligible
      || d.requiredCapability === undefined
      || d.contractVersion === undefined
      || d.sourceDigest === undefined
      || d.recoveryJobId === undefined
      || d.fulfillmentClassification === undefined
      || d.conversationKey === undefined
      || d.deliveryJid === undefined
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
      | { id: number }
      | undefined;
    if (existing !== undefined) {
      alreadyExisted.push(existing.id);
      continue;
    }
    // 3. Read the message for the obligation payload.
    const msg = msgStmt.get(d.sourceMessageId) as
      | { content: string | null; media_path: string | null; sender_jid: string; sender_name: string | null }
      | undefined;
    if (msg === undefined) {
      skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'message_not_found' });
      continue;
    }
    // 4. Media: REVERIFY against the approved descriptor. In dry-run this is a
    //    read-only hash compare (no retention); on a confirmed run it retains
    //    (copy/fsync/rehash) and the retained sha256 must match.
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
    // 5. Prepare the obligation payload for the single all-row transaction.
    const inputDigest = capabilityInputDigest({
      text: msg.content ?? '',
      preparedMediaClass: params.mediaClassFor?.(d) ?? null,
    });
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
        inputDigest,
        sourceDigest: d.sourceDigest,
        sourceToken: retainedMedia ? null : (d.sourceToken ?? null),
        retainedMedia,
        creationReason: `reviewed_backfill:${params.manifestId}`,
      },
    });
  }

  // 6. ALL-ROW TRANSACTION — every prepared insert commits atomically (or none).
  if (!dryRun && prepared.length > 0) {
    withTransaction(db, () => {
      for (const p of prepared) {
        const { obligationId } = store.applyDecisionWithinCallerTransaction({
          auditEvent: { action: 'obligation.create', actorType: 'operator', reasonCode: 'reviewed_backfill' },
          obligation: p.obligation,
        });
        if (obligationId != null) created.push(obligationId);
      }
    });
  }

  const recoveryAfter = snapshotRecovery(db, seqs);
  return {
    digestVerified: true,
    recomputedDigest,
    created,
    wouldCreate,
    alreadyExisted,
    skipped,
    recoveryRowsUnchanged: recoveryBefore === recoveryAfter,
  };
}

// ---------------------------------------------------------------------------
// Owner-gated CLI (F3). Dry-run by default. To APPLY, the operator must:
//   - point at a DB EXACTLY at the current schema (schema guard);
//   - pass a --backup-path that exists, is SQLite, and matches the target schema;
//   - pass --expect-existing N equal to the current backfill obligation count for
//     this manifest (normally 0) — catches a half-completed prior run;
//   - pass --confirm <approvedDigest>: a confirmation TOKEN that must equal the
//     recomputed manifest digest (holding the flag is not enough — the operator
//     must hold the artifact);
//   - the DB must be QUIESCENT (BEGIN IMMEDIATE succeeds — a busy/locked DB means
//     the bot is running, and the run is refused).
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

function isSqliteFile(path: string): boolean {
  const buf = readFileSync(path).subarray(0, 16);
  return buf.toString('latin1').startsWith('SQLite format 3');
}

/** Prove the DB is quiescent: BEGIN IMMEDIATE acquires the write lock only if no
 *  other connection (the bot) holds it. Busy/locked → refuse. */
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

  // Schema guard — never migrate a live DB.
  const version = schemaVersionOf(dbPath);
  if (version !== CURRENT_SCHEMA_MIGRATION) {
    io.err(`refusing: database is at schema ${version}, expected ${CURRENT_SCHEMA_MIGRATION}. This tool never migrates a live database.`);
    return 2;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    manifestId: string;
    manifestDigest: string;
    entries: BackfillDescriptor[];
  };
  const eligible = manifest.entries.filter((e) => e.eligible);

  const dryRun = confirmToken === null;
  if (!dryRun) {
    // Confirmation token must equal the approved digest (hold the artifact, not the flag).
    if (confirmToken !== manifest.manifestDigest) {
      io.err('refusing: --confirm token does not equal the manifest digest (pass the approved digest as the confirmation token).');
      return 2;
    }
    // Backup precondition — real file, SQLite, matching schema.
    if (!backupPath) {
      io.err('refusing: --backup-path is required to apply (a verified pre-run backup).');
      return 2;
    }
    let backupOk = false;
    try {
      backupOk = isSqliteFile(backupPath) && schemaVersionOf(backupPath) === CURRENT_SCHEMA_MIGRATION;
    } catch {
      backupOk = false;
    }
    if (!backupOk) {
      io.err(`refusing: --backup-path ${backupPath} is not a SQLite backup at schema ${CURRENT_SCHEMA_MIGRATION}.`);
      return 2;
    }
    // Quiescence — the DB must not be held by a running bot.
    assertQuiescent(dbPath);
  }

  const db = new Database(dbPath);
  db.open();
  try {
    // Expected-state precondition — the backfill obligations for this manifest
    // must currently equal --expect-existing (catches a half-completed prior run).
    const existingCount = Number(
      (db.raw
        .prepare("SELECT COUNT(*) AS c FROM capability_obligations WHERE creation_reason = ?")
        .get(`reviewed_backfill:${manifest.manifestId}`) as { c: number }).c,
    );
    if (existingCount !== expectExisting) {
      io.err(`refusing: expected ${expectExisting} existing backfill obligations for ${manifest.manifestId}, found ${existingCount}.`);
      return 2;
    }

    const result = await executeBackfill(db, {
      manifestId: manifest.manifestId,
      approvedDigest: manifest.manifestDigest,
      eligible,
      mediaRoot,
      retentionPolicyVersion,
      skillName,
      mediaClassFor: (d) => (d.mediaSha256 != null ? 'video' : null),
      dryRun,
    });

    if (!result.digestVerified) {
      io.err(`refusing: recomputed manifest digest ${result.recomputedDigest} != approved ${manifest.manifestDigest} (descriptors were altered after approval).`);
      return 2;
    }
    io.out(json ? JSON.stringify({ mode: dryRun ? 'dry-run' : 'confirm', runId, ...result }) : renderExecuteHuman(dryRun, runId, result));
    // Exit non-zero if anything was skipped on a confirmed run (an approved entry
    // that could not be created is an operator-visible incompleteness).
    if (!dryRun && result.skipped.length > 0) return 1;
    return 0;
  } finally {
    db.close();
  }
}

function renderExecuteHuman(dryRun: boolean, runId: string, r: BackfillExecuteResult): string {
  const lines = [
    `backfill ${dryRun ? 'DRY-RUN' : 'APPLIED'} run=${runId} — digest verified`,
    dryRun
      ? `  wouldCreate=${r.wouldCreate.length} alreadyExisted=${r.alreadyExisted.length} skipped=${r.skipped.length}`
      : `  created=${r.created.length} alreadyExisted=${r.alreadyExisted.length} skipped=${r.skipped.length} recoveryRowsUnchanged=${r.recoveryRowsUnchanged}`,
  ];
  for (const s of r.skipped) lines.push(`  skipped seq=${s.sourceInboundSeq} reason=${s.reason}`);
  if (dryRun) lines.push('DRY-RUN — nothing created. Pass --confirm <approvedDigest> with --backup-path to apply.');
  return lines.join('\n');
}

function backfillExecuteUsage(): string {
  return [
    'Usage: capability-obligation-backfill-execute --db PATH --manifest MANIFEST.json \\',
    '         --media-root DIR --retention-policy-version V --skill NAME --run-id ID \\',
    '         [--expect-existing N] [--backup-path PATH] [--confirm APPROVED_DIGEST] [--json]',
    '',
    'OWNER-GATED. Dry-run by default (runs all checks, creates nothing, retains no media).',
    'To APPLY: --confirm must equal the manifest digest, --backup-path must be a SQLite',
    'backup at the current schema, the DB must be quiescent (bot stopped), and the current',
    'backfill obligation count for this manifest must equal --expect-existing (default 0).',
    'The executor recomputes the manifest digest and refuses if descriptors were altered.',
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
