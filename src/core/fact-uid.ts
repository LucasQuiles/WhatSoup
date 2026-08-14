// Opaque fact identifier derivation (#2567).
//
// The legacy fact_id embeds `{chatJid}:{senderSegment}:{hash(text)}` — chat
// scope, sender scope, and a directly correlatable content digest. Everything
// that leaves the process (lease wire shape, acknowledgement API, readers,
// health) must instead use fact_uid: a per-database salted digest of the
// legacy id. The salt lives in fact_export_meta, so identical facts in
// different databases produce unrelated uids and a dictionary of candidate
// (chat, sender, text) triples cannot be correlated against exported ids.
// The legacy fact_id column remains the intra-database enqueue idempotency
// key; it must never appear on a wire or observability surface.
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const FACT_UID_SALT_KEY = 'fact_uid_salt';

export function deriveFactUid(salt: string, factId: string): string {
  const digest = createHash('sha256').update(`${salt}:${factId}`).digest('hex');
  return `fe_${digest.slice(0, 24)}`;
}

export function newFactUidSalt(): string {
  return randomBytes(16).toString('hex');
}

/** Read the persisted per-database salt; throws if migration 58 has not run. */
export function getFactUidSalt(db: DatabaseSync): string {
  const row = db
    .prepare('SELECT value FROM fact_export_meta WHERE key = ?')
    .get(FACT_UID_SALT_KEY) as { value: string } | undefined;
  if (!row) {
    throw new Error('fact_export_meta is missing the fact_uid salt (migration 59 not applied)');
  }
  return row.value;
}
