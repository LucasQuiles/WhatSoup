import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { assertCanonicalSchema43 } from '../../src/core/database-migration-43.ts';

const MAX_RECEIPTS = 200;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CONTENT_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'source',
  'manifestId',
  'evidenceRef',
  'destination',
  'receipts',
]);
const DESTINATION_KEYS = new Set(['conversationKey', 'channelFingerprint']);
const RECEIPT_KEYS = new Set([
  'ordinal',
  'messageId',
  'sentAt',
  'senderFingerprint',
  'contentHash',
  'contentType',
]);

export type ContinuityReceiptClassification =
  | 'present_answered'
  | 'present_unanswered'
  | 'observed_not_admitted'
  | 'absent'
  | 'ambiguous';

export type ContinuityReceiptAction =
  | 'none'
  | 'existing_inbound_recovery'
  | 'operator_catchup'
  | 'manual_review';

export interface ContinuityManifestReceipt {
  ordinal: number;
  messageId: string;
  sentAt: number;
  senderFingerprint: string;
  contentHash: string;
  contentType: string;
}

export interface ContinuityManifest {
  schemaVersion: 1;
  source: 'independent_participant_history';
  manifestId: string;
  evidenceRef: string;
  destination: {
    conversationKey: string;
    channelFingerprint: string;
  };
  receipts: ContinuityManifestReceipt[];
}

export interface ContinuityReceiptAudit {
  ordinal: number;
  classification: ContinuityReceiptClassification;
  action: ContinuityReceiptAction;
}

export interface ContinuityManifestAudit {
  state: 'clear' | 'continuity_gap_detected' | 'continuity_ambiguous';
  counts: {
    total: number;
    present: number;
    answered: number;
    unanswered: number;
    missing: number;
    ambiguous: number;
    replayRequired: number;
  };
  receipts: ContinuityReceiptAudit[];
}

interface MessageReceiptRow {
  conversation_key: string;
  chat_jid: string;
  sender_jid: string;
  content: string | null;
  content_text: string | null;
  content_type: string;
  timestamp: number;
}

interface InboundReceiptRow {
  seq: number;
  conversation_key: string;
  chat_jid: string;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields`);
  const missing = [...allowed].filter((key) => !Object.hasOwn(record, key));
  if (missing.length > 0) throw new Error(`${label} is missing required fields`);
}

function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a nonempty string`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function parseContinuityManifest(value: unknown): ContinuityManifest {
  const root = plainRecord(value, 'Continuity manifest');
  exactKeys(root, MANIFEST_KEYS, 'Continuity manifest');
  if (root.schemaVersion !== 1) throw new Error('Unsupported continuity manifest schema version');
  if (root.source !== 'independent_participant_history') {
    throw new Error('Continuity manifest source must be independent participant history');
  }

  const destination = plainRecord(root.destination, 'Continuity manifest destination');
  exactKeys(destination, DESTINATION_KEYS, 'Continuity manifest destination');
  const receiptsValue = root.receipts;
  if (!Array.isArray(receiptsValue) || receiptsValue.length < 1) {
    throw new Error('Continuity manifest must contain at least one receipt');
  }
  if (receiptsValue.length > MAX_RECEIPTS) {
    throw new Error(`Continuity manifest exceeds ${MAX_RECEIPTS} receipts`);
  }

  const receipts = receiptsValue.map((value, index): ContinuityManifestReceipt => {
    const row = plainRecord(value, 'Continuity manifest receipt');
    exactKeys(row, RECEIPT_KEYS, 'Continuity manifest receipt');
    const ordinal = positiveSafeInteger(row.ordinal, 'Receipt ordinal');
    if (ordinal !== index + 1) {
      throw new Error('Continuity manifest receipt ordinals must be contiguous from one');
    }
    const contentType = boundedText(row.contentType, 'Receipt content type', 64);
    if (!CONTENT_TYPE_PATTERN.test(contentType)) {
      throw new Error('Receipt content type is invalid');
    }
    return {
      ordinal,
      messageId: boundedText(row.messageId, 'Receipt message ID', 2048),
      sentAt: positiveSafeInteger(row.sentAt, 'Receipt timestamp'),
      senderFingerprint: fingerprint(row.senderFingerprint, 'Receipt sender fingerprint'),
      contentHash: fingerprint(row.contentHash, 'Receipt content hash'),
      contentType,
    };
  });
  if (new Set(receipts.map((row) => row.messageId)).size !== receipts.length) {
    throw new Error('Continuity manifest contains duplicate message IDs');
  }

  return {
    schemaVersion: 1,
    source: 'independent_participant_history',
    manifestId: boundedText(root.manifestId, 'Manifest ID', 2048),
    evidenceRef: boundedText(root.evidenceRef, 'Manifest evidence reference', 8192),
    destination: {
      conversationKey: boundedText(
        destination.conversationKey,
        'Destination conversation key',
        2048,
      ),
      channelFingerprint: fingerprint(
        destination.channelFingerprint,
        'Destination channel fingerprint',
      ),
    },
    receipts,
  };
}

function classifyReceipt(
  raw: DatabaseSync,
  manifest: ContinuityManifest,
  receipt: ContinuityManifestReceipt,
): ContinuityReceiptAudit {
  const message = raw.prepare(`
    SELECT conversation_key, chat_jid, sender_jid, content, content_text,
           content_type, timestamp
    FROM messages
    WHERE message_id = ?
  `).get(receipt.messageId) as MessageReceiptRow | undefined;
  const inbound = raw.prepare(`
    SELECT seq, conversation_key, chat_jid
    FROM inbound_events
    WHERE message_id = ?
  `).get(receipt.messageId) as InboundReceiptRow | undefined;

  if (!message && !inbound) {
    return { ordinal: receipt.ordinal, classification: 'absent', action: 'operator_catchup' };
  }
  if (!message || !inbound) {
    if (
      message
      && message.conversation_key === manifest.destination.conversationKey
      && sha256(message.chat_jid) === manifest.destination.channelFingerprint
      && sha256(message.sender_jid) === receipt.senderFingerprint
      && sha256(message.content_text ?? message.content ?? '') === receipt.contentHash
      && message.content_type === receipt.contentType
      && Number(message.timestamp) === receipt.sentAt
    ) {
      return {
        ordinal: receipt.ordinal,
        classification: 'observed_not_admitted',
        action: 'operator_catchup',
      };
    }
    return { ordinal: receipt.ordinal, classification: 'ambiguous', action: 'manual_review' };
  }

  const exactMessage = (
    message.conversation_key === manifest.destination.conversationKey
    && sha256(message.chat_jid) === manifest.destination.channelFingerprint
    && sha256(message.sender_jid) === receipt.senderFingerprint
    && sha256(message.content_text ?? message.content ?? '') === receipt.contentHash
    && message.content_type === receipt.contentType
    && Number(message.timestamp) === receipt.sentAt
  );
  const exactInbound = (
    inbound.conversation_key === manifest.destination.conversationKey
    && sha256(inbound.chat_jid) === manifest.destination.channelFingerprint
  );
  if (!exactMessage || !exactInbound) {
    return { ordinal: receipt.ordinal, classification: 'ambiguous', action: 'manual_review' };
  }

  const replyProof = raw.prepare(`
    SELECT 1 AS present
    FROM operator_catchup_delivery_proofs
    WHERE target_seq = ?
      AND conversation_key = ?
      AND chat_jid = ?
    LIMIT 1
  `).get(
    inbound.seq,
    inbound.conversation_key,
    inbound.chat_jid,
  );
  if (replyProof) {
    return { ordinal: receipt.ordinal, classification: 'present_answered', action: 'none' };
  }
  return {
    ordinal: receipt.ordinal,
    classification: 'present_unanswered',
    action: 'existing_inbound_recovery',
  };
}

export function auditContinuityManifest(
  raw: DatabaseSync,
  manifest: ContinuityManifest,
): ContinuityManifestAudit {
  assertCanonicalSchema43(raw);
  const receipts = manifest.receipts.map((receipt) => classifyReceipt(raw, manifest, receipt));
  const answered = receipts.filter((row) => row.classification === 'present_answered').length;
  const unanswered = receipts.filter((row) => row.classification === 'present_unanswered').length;
  const observed = receipts.filter((row) => row.classification === 'observed_not_admitted').length;
  const absent = receipts.filter((row) => row.classification === 'absent').length;
  const ambiguous = receipts.filter((row) => row.classification === 'ambiguous').length;
  const missing = observed + absent;
  const replayRequired = unanswered + missing;
  return {
    state: replayRequired > 0
      ? 'continuity_gap_detected'
      : ambiguous > 0
        ? 'continuity_ambiguous'
        : 'clear',
    counts: {
      total: receipts.length,
      present: answered + unanswered,
      answered,
      unanswered,
      missing,
      ambiguous,
      replayRequired,
    },
    receipts,
  };
}
