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
  capabilitySourceDigest,
  evaluateCapabilityContract,
  parseCapabilityContract,
  type CapabilityContract,
} from '../src/core/capability-contract.ts';
import { CURRENT_SCHEMA_MIGRATION } from '../src/core/database-schema-version.ts';

export interface BackfillConfirmedEntry {
  sourceInboundSeq: number;
  sourceMessageId: string;
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
    });
  }

  const eligible = entries.filter((e) => e.eligible);
  // Canonical (order-independent) digest over the eligible descriptors. It binds
  // the DESTINATION (conversationKey/deliveryJid/isGroup), the SOURCE identity
  // (sourceDigest + token/media hash+size) and the capability — so an approval
  // for a DM can never be reused for a group, and a source swap changes the
  // digest.
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
      }))
      .sort((a, b) => a.sourceInboundSeq - b.sourceInboundSeq),
  );
  return {
    manifestId: params.manifestId,
    contractVersion: params.contract.version,
    entries,
    eligibleCount: eligible.length,
    manifestDigest: createHash('sha256').update(`${params.manifestId}\n${canonical}`).digest('hex'),
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
    '--confirmed is a JSON array of {sourceInboundSeq, sourceMessageId, mediaClass?}.',
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
    lines.push(
      e.eligible
        ? `  ELIGIBLE  seq=${e.sourceInboundSeq} cap=${e.requiredCapability} media=${e.mediaPresent}`
        : `  ineligible seq=${e.sourceInboundSeq} reason=${e.reason}`,
    );
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
