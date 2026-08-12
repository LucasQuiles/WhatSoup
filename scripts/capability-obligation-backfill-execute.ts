/**
 * capability-obligation-backfill-execute — the OWNER-GATED backfill EXECUTOR
 * (candidate §4). It consumes the eligible descriptors of an APPROVED manifest
 * (see capability-obligation-backfill-manifest.ts) and appends the historical
 * obligations, idempotently, through the SAME guarded store as the runtime.
 *
 * Safety properties, all fixture-proven:
 *  - PRIOR NON-FULFILLMENT proof: an entry is created only when its inbound has
 *    a completed recovery job settled `completion_kind='echo'` — the exact
 *    delivery-vs-fulfilment defect signature (jobs 456/489/493). Anything else
 *    is skipped, reported.
 *  - MEDIA hash/retain/REVERIFY: media is retained (copy+fsync+rehash) and its
 *    sha256 must match the approved descriptor, else skipped.
 *  - IDEMPOTENT: an obligation already present for the (inbound, message,
 *    contract, capability) key is a no-op — a second run creates nothing.
 *  - ORIGINAL RECOVERY ROWS UNCHANGED: the target recovery-job rows are
 *    snapshotted before/after and proven untouched (backfill never rewrites the
 *    original failure record).
 *
 * Reviewer classification (candidate §4) — including the audio path the live
 * contract cannot represent — arrives via the descriptor's requiredCapability.
 * Execution against a live instance DB stays owner-gated; this module is
 * exercised against fixtures.
 */
import { capabilityInputDigest } from '../src/core/capability-contract.ts';
import { CapabilityObligationStore } from '../src/core/capability-obligation-store.ts';
import type { Database } from '../src/core/database.ts';
import { withTransaction } from '../src/core/db-tx.ts';
import { retainMediaForObligation } from '../src/core/obligation-media-retention.ts';
import type { BackfillDescriptor } from './capability-obligation-backfill-manifest.ts';

export interface BackfillExecuteResult {
  created: number[];
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

export async function executeBackfill(
  db: Database,
  params: {
    manifestId: string;
    eligible: readonly BackfillDescriptor[];
    mediaRoot: string;
    retentionPolicyVersion: string;
    skillName: string;
    /** preparedMediaClass used for the D1 input digest (reviewer classification). */
    mediaClassFor?: (d: BackfillDescriptor) => string | null;
  },
): Promise<BackfillExecuteResult> {
  const store = new CapabilityObligationStore(db);
  const seqs = params.eligible.map((e) => e.sourceInboundSeq);
  const recoveryBefore = snapshotRecovery(db, seqs);

  const created: number[] = [];
  const alreadyExisted: number[] = [];
  const skipped: Array<{ sourceInboundSeq: number; reason: string }> = [];

  const jobStmt = db.raw.prepare(
    "SELECT state, completion_kind FROM turn_recovery_jobs WHERE source_inbound_seq = ? ORDER BY id DESC LIMIT 1",
  );
  const msgStmt = db.raw.prepare(
    'SELECT content, media_path, sender_jid, sender_name FROM messages WHERE message_id = ? ORDER BY pk DESC LIMIT 1',
  );
  const existsStmt = db.raw.prepare(
    `SELECT id FROM capability_obligations
     WHERE source_inbound_seq = ? AND source_message_id = ? AND contract_version = ? AND required_capability = ?`,
  );

  for (const d of params.eligible) {
    if (!d.eligible || d.requiredCapability === undefined || d.contractVersion === undefined || d.sourceDigest === undefined) {
      skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'descriptor_not_eligible' });
      continue;
    }
    // 1. Prove prior non-fulfilment: a completed, echo-settled recovery job.
    const job = jobStmt.get(d.sourceInboundSeq) as { state: string; completion_kind: string | null } | undefined;
    if (job === undefined || job.state !== 'completed' || job.completion_kind !== 'echo') {
      skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'not_proven_echo_unfulfilled' });
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
    // 4. Media: retain (copy/fsync/rehash) and REVERIFY against the approved descriptor.
    let retainedMedia: { path: string; sha256: string; bytes: number; policyVersion: string } | null = null;
    if (d.mediaSha256 != null) {
      if (msg.media_path == null) {
        skipped.push({ sourceInboundSeq: d.sourceInboundSeq, reason: 'media_path_missing' });
        continue;
      }
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
    // 5. Append the obligation through the guarded store.
    const inputDigest = capabilityInputDigest({
      text: msg.content ?? '',
      preparedMediaClass: params.mediaClassFor?.(d) ?? null,
    });
    let obligationId: number | null = null;
    withTransaction(db, () => {
      obligationId = store.applyDecisionWithinCallerTransaction({
        auditEvent: { action: 'obligation.create', actorType: 'operator', reasonCode: 'reviewed_backfill' },
        obligation: {
          sourceInboundSeq: d.sourceInboundSeq,
          sourceMessageId: d.sourceMessageId,
          conversationKey: d.conversationKey!,
          deliveryJid: d.deliveryJid!,
          senderJid: msg.sender_jid,
          senderName: msg.sender_name,
          isGroup: d.isGroup ?? false,
          groupName: d.isGroup ? d.deliveryJid! : null,
          scope: 'per_chat',
          originRecoveryJobId: null,
          replayText: retainedMedia ? (msg.content && msg.content.length > 0 ? msg.content : '[retained media]') : (msg.content ?? ''),
          contentTypeHint: retainedMedia ? 'media' : 'text',
          contractVersion: d.contractVersion!,
          requiredCapability: d.requiredCapability!,
          capabilityParams: JSON.stringify({ skill: params.skillName }),
          inputDigest,
          sourceDigest: d.sourceDigest!,
          sourceToken: retainedMedia ? null : (d.sourceToken ?? null),
          retainedMedia,
          creationReason: `reviewed_backfill:${params.manifestId}`,
        },
      }).obligationId;
    });
    if (obligationId != null) created.push(obligationId);
  }

  const recoveryAfter = snapshotRecovery(db, seqs);
  return { created, alreadyExisted, skipped, recoveryRowsUnchanged: recoveryBefore === recoveryAfter };
}
