/**
 * capability-obligation-backfill-manifest — generate the reviewer-confirmed
 * BACKFILL MANIFEST (candidate §4): a digest-addressed list of the historical
 * obligations that WOULD be reprocessed, for owner approval.
 *
 * This tool is READ-ONLY and produces an approval ARTIFACT. It does NOT insert
 * backfill obligations and does NOT drain anything. Actual backfill creation and
 * every drain (DM or group) is a separately owner-gated step that consumes an
 * APPROVED manifest — execution is not implemented here by design.
 *
 * Only reviewer-confirmed entries are eligible: the caller supplies the
 * confirmed source identities (candidate §4 classifies evidence as
 * confirmed-unfulfilled / conflicting / inconclusive; only confirmed is
 * eligible). For each entry the generator reads the persisted inbound + message,
 * evaluates the instance contract, and emits an eligible descriptor OR an
 * ineligible entry WITH a reason — never a silent drop. The manifest digest is
 * the sha256 of the canonical eligible descriptors, so an approval binds to
 * exactly this set.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import {
  capabilityInputDigest,
  capabilitySourceDigest,
  evaluateCapabilityContract,
  parseCapabilityContract,
  type CapabilityContract,
} from '../src/core/capability-contract.ts';
import { CURRENT_SCHEMA_MIGRATION } from '../src/core/database-schema-version.ts';

/**
 * Reviewer fulfillment classification (candidate §4). ONLY `confirmed_unfulfilled`
 * is eligible for backfill; `conflicting`/`inconclusive` are reported ineligible.
 * This is the REVIEWER's determination — the executor does NOT re-derive
 * non-fulfillment from echo-settlement (that conflation is the very defect this
 * feature corrects). Echo-settlement is corroborated with VETO power (a job that
 * is not completed+echo, or that has a sibling worker-fulfilment, cannot be
 * confirmed), but the affirmative "unfulfilled" signal comes from the reviewer,
 * and it is bound into the manifest digest so it cannot be added after approval.
 */
export type FulfillmentClassification = 'confirmed_unfulfilled' | 'conflicting' | 'inconclusive';

export interface BackfillConfirmedEntry {
  sourceInboundSeq: number;
  sourceMessageId: string;
  /**
   * The EXACT recovery job the reviewer classified (candidate §4). The manifest
   * binds this job id; the executor selects the job BY ID (never "latest by
   * sequence") and verifies its inbound/message/conversation/destination all
   * agree before any mutation.
   */
  recoveryJobId: number;
  /** Reviewer's fulfilment determination — only `confirmed_unfulfilled` is eligible. */
  fulfillmentClassification: FulfillmentClassification;
  /**
   * The reviewer's EVIDENCE MATRIX artifact (candidate §4) — the file holding the
   * transcript, tool/delivery receipts, and later-turn review the classification
   * rests on. REQUIRED (F4/r12): the generator RECOMPUTES its sha256 from this file
   * and binds THAT into the manifest digest, so the approval is tied to a real,
   * re-readable artifact rather than an asserted string. Absent ⇒ ineligible
   * (`evidence_artifact_required`); unreadable ⇒ `evidence_artifact_unreadable`.
   */
  evidenceMatrixPath?: string;
  /**
   * OPTIONAL cross-check: the reviewer's expected sha256 of the artifact. When
   * supplied it must equal the hash recomputed from `evidenceMatrixPath`, else the
   * entry is ineligible (`evidence_digest_mismatch`). The recomputed hash — never a
   * supplied string — is what the manifest digest binds.
   */
  evidenceMatrixDigest?: string;
  /** Reviewer media classification when the source is media ('document' | 'video'). */
  mediaClass?: string | null;
  /**
   * REVIEWER capability override (candidate §4). Backfill is reviewer-driven,
   * so an entry the live contract cannot classify — notably audio (excluded
   * from the contract BY CONSTRUCTION), the incident-7795 shape — is still
   * eligible when the reviewer supplies the capability here. It bypasses
   * `evaluateCapabilityContract` for THIS entry only.
   */
  reviewerCapability?: string;
}

export interface BackfillDescriptor {
  sourceInboundSeq: number;
  sourceMessageId: string;
  eligible: boolean;
  /** Ineligibility reason (null when eligible) — reported, never silently dropped. */
  reason: string | null;
  /** How the capability was classified: the live contract, or a reviewer override. */
  classifiedBy?: 'contract' | 'reviewer';
  conversationKey?: string;
  deliveryJid?: string;
  isGroup?: boolean;
  requiredCapability?: string;
  contractVersion?: string;
  sourceToken?: string | null;
  /** sha256 the D6 receipt must reproduce (media sha256, or sha256 of the source token). */
  sourceDigest?: string;
  mediaSha256?: string | null;
  mediaBytes?: number | null;
  /** The exact reviewer-classified recovery job (F2) — bound into the digest. */
  recoveryJobId?: number;
  /** Reviewer's fulfilment determination (F2) — only confirmed_unfulfilled is eligible. */
  fulfillmentClassification?: FulfillmentClassification;
  /** The media class used for the D1 input digest (F3) — bound, and the executor reuses it. */
  preparedMediaClass?: string | null;
  /**
   * capabilityInputDigest over (message text + preparedMediaClass) at approval
   * time (F3). Bound into the manifest digest and RE-VERIFIED by the executor
   * against the current message, so a WhatsApp edit to the replayed instruction
   * after approval cannot execute under a still-valid digest.
   */
  inputDigest?: string;
  /** sha256 of the reviewer's evidence matrix (F6) — bound into the digest. */
  evidenceMatrixDigest?: string;
}

/** Read surface for the recovery-job fulfilment check (a subset of BackfillReadDb). */
export interface RecoveryFulfillmentReadDb {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/**
 * Corroborate a reviewer's `confirmed_unfulfilled` classification against the
 * PERSISTED recovery record (F2). This is the veto: the reviewer's determination
 * is the affirmative signal, but a job that does not exist, does not agree on
 * inbound/message/conversation/destination, is not completed+echo, or has a
 * sibling WORKER fulfilment for the same inbound cannot be confirmed. Echo is
 * corroboration, never the proof of non-fulfilment.
 *
 * Returns `null` when the job is confirmable, or a reason string otherwise.
 * Shared by the manifest generator (approval artifact) and the executor
 * (defense-in-depth at the mutation point), so both agree byte-for-byte.
 */
export function classifyRecoveryFulfillment(
  db: RecoveryFulfillmentReadDb,
  bind: {
    recoveryJobId: number;
    sourceInboundSeq: number;
    sourceMessageId: string;
    conversationKey: string;
    deliveryJid: string;
    classification: FulfillmentClassification;
  },
): string | null {
  if (bind.classification !== 'confirmed_unfulfilled') return 'fulfillment_not_confirmed';
  const job = db
    .prepare(
      'SELECT source_inbound_seq, source_message_id, conversation_key, delivery_jid, state, completion_kind '
      + 'FROM turn_recovery_jobs WHERE id = ?',
    )
    .get(bind.recoveryJobId) as
    | { source_inbound_seq: number; source_message_id: string; conversation_key: string; delivery_jid: string; state: string; completion_kind: string | null }
    | undefined;
  if (job === undefined) return 'recovery_job_not_found';
  if (
    job.source_inbound_seq !== bind.sourceInboundSeq
    || job.source_message_id !== bind.sourceMessageId
    || job.conversation_key !== bind.conversationKey
    || job.delivery_jid !== bind.deliveryJid
  ) {
    return 'recovery_job_binding_mismatch';
  }
  if (job.state !== 'completed' || job.completion_kind !== 'echo') return 'recovery_job_not_echo_settled';
  // No later/sibling WORKER fulfilment for the same inbound — a worker-settled job
  // means the request WAS actually served, so it must not be backfilled.
  const worker = db
    .prepare(
      "SELECT COUNT(*) AS c FROM turn_recovery_jobs WHERE source_inbound_seq = ? AND state = 'completed' AND completion_kind = 'worker'",
    )
    .get(bind.sourceInboundSeq) as { c: number };
  if (worker.c > 0) return 'later_fulfillment_found';
  return null;
}

/**
 * Canonical, order-independent manifest digest over the eligible descriptors. It
 * binds the DESTINATION (conversationKey/deliveryJid/isGroup), the SOURCE identity
 * (sourceDigest + token/media hash+size), the capability, the exact recovery job,
 * AND the reviewer's fulfilment classification — so an approval for a DM can
 * never be reused for a group, a source swap changes the digest, and the
 * classification cannot be altered after approval. The EXECUTOR recomputes this
 * over the descriptors it is about to run and refuses on mismatch (F1).
 */
export function computeManifestDigest(manifestId: string, eligible: readonly BackfillDescriptor[]): string {
  const canonical = JSON.stringify(
    eligible
      .map((e) => ({
        sourceInboundSeq: e.sourceInboundSeq,
        sourceMessageId: e.sourceMessageId,
        conversationKey: e.conversationKey,
        deliveryJid: e.deliveryJid,
        isGroup: e.isGroup,
        classifiedBy: e.classifiedBy,
        requiredCapability: e.requiredCapability,
        contractVersion: e.contractVersion,
        sourceToken: e.sourceToken,
        sourceDigest: e.sourceDigest,
        mediaSha256: e.mediaSha256,
        mediaBytes: e.mediaBytes,
        recoveryJobId: e.recoveryJobId,
        fulfillmentClassification: e.fulfillmentClassification,
        preparedMediaClass: e.preparedMediaClass,
        inputDigest: e.inputDigest,
        evidenceMatrixDigest: e.evidenceMatrixDigest,
      }))
      .sort((a, b) => a.sourceInboundSeq - b.sourceInboundSeq),
  );
  return createHash('sha256').update(`${manifestId}\n${canonical}`).digest('hex');
}

export interface BackfillManifest {
  manifestId: string;
  contractVersion: string;
  entries: BackfillDescriptor[];
  eligibleCount: number;
  /** sha256 of the canonical eligible descriptors — the approval binds to this. */
  manifestDigest: string;
}

/** Minimal read surface — a raw better-sqlite3-ish handle or Database.raw. */
export interface BackfillReadDb {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

export function generateBackfillManifest(
  db: BackfillReadDb,
  params: { manifestId: string; contract: CapabilityContract; confirmed: readonly BackfillConfirmedEntry[] },
): BackfillManifest {
  const inboundStmt = db.prepare(
    'SELECT seq, message_id, conversation_key, chat_jid FROM inbound_events WHERE seq = ?',
  );
  const messageStmt = db.prepare(
    'SELECT content, media_path, is_from_me FROM messages WHERE message_id = ? ORDER BY pk DESC LIMIT 1',
  );

  const entries: BackfillDescriptor[] = [];
  for (const c of params.confirmed) {
    const base: BackfillDescriptor = {
      sourceInboundSeq: c.sourceInboundSeq,
      sourceMessageId: c.sourceMessageId,
      eligible: false,
      reason: null,
    };
    const inbound = inboundStmt.get(c.sourceInboundSeq) as
      | { seq: number; message_id: string; conversation_key: string; chat_jid: string }
      | undefined;
    if (inbound === undefined) {
      entries.push({ ...base, reason: 'inbound_not_found' });
      continue;
    }
    if (inbound.message_id !== c.sourceMessageId) {
      entries.push({ ...base, reason: 'inbound_message_id_mismatch' });
      continue;
    }
    const message = messageStmt.get(c.sourceMessageId) as
      | { content: string | null; media_path: string | null; is_from_me: number }
      | undefined;
    if (message === undefined) {
      entries.push({ ...base, reason: 'message_not_found' });
      continue;
    }
    if (message.is_from_me === 1) {
      entries.push({ ...base, reason: 'message_is_outbound' });
      continue;
    }

    // Classify: reviewer override (candidate §4 — the audio path the contract
    // cannot represent) OR the live contract.
    let requiredCapability: string;
    let classifiedBy: 'contract' | 'reviewer';
    let contractSourceToken: string | null = null;
    if (c.reviewerCapability !== undefined) {
      requiredCapability = c.reviewerCapability;
      classifiedBy = 'reviewer';
    } else {
      const decision = evaluateCapabilityContract(params.contract, {
        text: message.content ?? '',
        preparedMediaClass: c.mediaClass ?? null,
      });
      if (decision.outcome !== 'match') {
        entries.push({ ...base, reason: `contract_${decision.outcome}` });
        continue;
      }
      requiredCapability = decision.capability;
      classifiedBy = 'contract';
      contractSourceToken = decision.sourceToken;
    }

    // Bind the exact source identity: media obligations hash the media bytes;
    // token obligations hash the canonical source token.
    let sourceToken: string | null;
    let sourceDigest: string;
    let mediaSha256: string | null = null;
    let mediaBytes: number | null = null;
    if (message.media_path !== null) {
      let buf: Buffer;
      try {
        buf = readFileSync(message.media_path);
        statSync(message.media_path); // presence/regular-file probe
      } catch {
        entries.push({ ...base, reason: 'media_unavailable' });
        continue;
      }
      mediaSha256 = createHash('sha256').update(buf).digest('hex');
      mediaBytes = buf.length;
      sourceToken = null;
      sourceDigest = capabilitySourceDigest(null, mediaSha256);
    } else {
      // A reviewer override is only for media the contract cannot represent.
      if (classifiedBy === 'reviewer') {
        entries.push({ ...base, reason: 'reviewer_override_requires_media' });
        continue;
      }
      if (contractSourceToken === null) {
        entries.push({ ...base, reason: 'no_source_token' });
        continue;
      }
      sourceToken = contractSourceToken;
      sourceDigest = capabilitySourceDigest(sourceToken, null);
    }

    // F2 — bind and corroborate the EXACT reviewer-classified recovery job (run
    // LAST so contract/source ineligibility reports independently). Only a
    // reviewer `confirmed_unfulfilled` whose persisted job agrees on
    // inbound/message/conversation/destination, is completed+echo, and has no
    // sibling worker-fulfilment is eligible. Echo has veto power, not proof power.
    const recoveryReason = classifyRecoveryFulfillment(db, {
      recoveryJobId: c.recoveryJobId,
      sourceInboundSeq: c.sourceInboundSeq,
      sourceMessageId: c.sourceMessageId,
      conversationKey: inbound.conversation_key,
      deliveryJid: inbound.chat_jid,
      classification: c.fulfillmentClassification,
    });
    if (recoveryReason !== null) {
      entries.push({ ...base, reason: recoveryReason });
      continue;
    }

    // F4/r12 — the evidence-matrix digest is ALWAYS recomputed from a readable
    // artifact; a bare 64-hex string is no longer accepted (the r10/r12 gap: an
    // asserted hash proves nothing about a real evidence file). Three distinct,
    // fail-closed reasons: no path supplied, path unreadable, or a supplied digest
    // that disagrees with the recomputed one.
    if (c.evidenceMatrixPath === undefined) {
      entries.push({ ...base, reason: 'evidence_artifact_required' });
      continue;
    }
    let evidenceMatrixDigest: string;
    try {
      evidenceMatrixDigest = createHash('sha256').update(readFileSync(c.evidenceMatrixPath)).digest('hex');
    } catch {
      entries.push({ ...base, reason: 'evidence_artifact_unreadable' });
      continue;
    }
    if (c.evidenceMatrixDigest !== undefined && c.evidenceMatrixDigest !== evidenceMatrixDigest) {
      entries.push({ ...base, reason: 'evidence_digest_mismatch' });
      continue;
    }

    // F3 — bind the actual replay payload: the media class the executor will use,
    // and the input digest over (message text + that class). The executor
    // re-verifies this against the CURRENT message, so a post-approval edit fails.
    const preparedMediaClass = mediaSha256 !== null ? (c.mediaClass ?? null) : null;
    const inputDigest = capabilityInputDigest({ text: message.content ?? '', preparedMediaClass });

    entries.push({
      ...base,
      eligible: true,
      classifiedBy,
      conversationKey: inbound.conversation_key,
      deliveryJid: inbound.chat_jid,
      isGroup: inbound.chat_jid.endsWith('@g.us'),
      requiredCapability,
      contractVersion: params.contract.version,
      sourceToken,
      sourceDigest,
      mediaSha256,
      mediaBytes,
      recoveryJobId: c.recoveryJobId,
      fulfillmentClassification: c.fulfillmentClassification,
      preparedMediaClass,
      inputDigest,
      evidenceMatrixDigest,
    });
  }

  const eligible = entries.filter((e) => e.eligible);
  return {
    manifestId: params.manifestId,
    contractVersion: params.contract.version,
    entries,
    eligibleCount: eligible.length,
    manifestDigest: computeManifestDigest(params.manifestId, eligible),
  };
}

function assertSchemaCurrent(dbPath: string): void {
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    let version = 0;
    try {
      version = Number((raw.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/no such table/i.test(message)) throw new Error(`could not read schema version from ${dbPath}: ${message}`);
      version = 0;
    }
    if (version !== CURRENT_SCHEMA_MIGRATION) {
      throw new Error(`refusing to operate: database is at schema ${version}, expected ${CURRENT_SCHEMA_MIGRATION}. This tool never migrates a live database.`);
    }
  } finally {
    raw.close();
  }
}

function usage(): string {
  return [
    'Usage: capability-obligation-backfill-manifest --db PATH --manifest-id ID \\',
    '         --contract CONTRACT.json --confirmed CONFIRMED.json [--json]',
    '',
    'READ-ONLY. Emits the reviewer-confirmed backfill manifest for owner approval.',
    'It NEVER inserts obligations or drains; backfill creation + drains are',
    'separately owner-gated steps that consume an APPROVED manifest.',
    '--confirmed is a JSON array of {sourceInboundSeq, sourceMessageId,',
    '  recoveryJobId, fulfillmentClassification, evidenceMatrixDigest,',
    '  mediaClass?, reviewerCapability?}. Only',
    '  fulfillmentClassification="confirmed_unfulfilled" is eligible; the digest',
    '  binds destination + source + job + classification + evidence + input digest.',
  ].join('\n');
}

export function runBackfillManifestCli(argv: readonly string[], out: (line: string) => void): number {
  const flags = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]!;
    if (t === '--json') { json = true; continue; }
    if (t === '--help') { out(usage()); return 0; }
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${t} requires a value`);
    flags.set(t, v);
    i += 1;
  }
  const dbPath = flags.get('--db');
  const manifestId = flags.get('--manifest-id');
  const contractPath = flags.get('--contract');
  const confirmedPath = flags.get('--confirmed');
  if (!dbPath || !manifestId || !contractPath || !confirmedPath) {
    throw new Error(`missing required flag.\n${usage()}`);
  }
  assertSchemaCurrent(dbPath);
  const contract = parseCapabilityContract(JSON.parse(readFileSync(contractPath, 'utf8')));
  const confirmed = JSON.parse(readFileSync(confirmedPath, 'utf8')) as BackfillConfirmedEntry[];
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const manifest = generateBackfillManifest(raw as unknown as BackfillReadDb, { manifestId, contract, confirmed });
    out(json ? JSON.stringify(manifest, null, 2) : renderHuman(manifest));
    return 0;
  } finally {
    raw.close();
  }
}

function renderHuman(m: BackfillManifest): string {
  const lines = [
    `manifest ${m.manifestId} (contract ${m.contractVersion}) — ${m.eligibleCount}/${m.entries.length} eligible`,
    `digest ${m.manifestDigest}`,
  ];
  for (const e of m.entries) {
    if (e.eligible) {
      // Print exactly what the digest binds, so the approver SEES the
      // destination / job / classification / source the approval commits to —
      // "destination-bound" must be visible, not just cryptographic.
      const src = e.mediaSha256 !== null && e.mediaSha256 !== undefined
        ? `media:${e.mediaSha256.slice(0, 12)}(${e.mediaBytes}B)`
        : `token:${e.sourceToken}`;
      lines.push(
        `  ELIGIBLE  seq=${e.sourceInboundSeq} dest=${e.deliveryJid}${e.isGroup ? '(group)' : '(dm)'} `
        + `job=${e.recoveryJobId} class=${e.fulfillmentClassification} cap=${e.requiredCapability} `
        + `by=${e.classifiedBy} ${src} srcDigest=${e.sourceDigest?.slice(0, 12)} `
        + `inputDigest=${e.inputDigest?.slice(0, 12)} evidence=${e.evidenceMatrixDigest?.slice(0, 12)}`,
      );
    } else {
      lines.push(`  ineligible seq=${e.sourceInboundSeq} reason=${e.reason}`);
    }
  }
  lines.push('NOTE: read-only manifest. Backfill creation and drains are separately owner-gated.');
  return lines.join('\n');
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    process.exitCode = runBackfillManifestCli(process.argv.slice(2), (line) => process.stdout.write(`${line}\n`));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
