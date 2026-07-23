import type { Database } from '../../core/database.ts';

/**
 * Per-sender chat model preference store (schema v2 — owner-approved PR-plan,
 * 2026-07-04). A preference steers which provider/model REASONS for a sender's
 * turns; it never carries tool, mutation, or authority state (capability-
 * preserved routing: changing model route never changes capability).
 *
 * Keying is the composite (chat_jid, sender_jid) — never chat-wide — so the
 * PRIMARY KEY and every WRITE (setPreference/recordRoutePreference) stay
 * per-sender: each pin durably records who set it, and the row-per-sender
 * shape is retained as the D13a audit trail. The store itself is key-agnostic:
 * callers MUST pass the canonical keys from preference-keys.ts (conversation
 * identity + normalized sender), never raw wire JIDs, which alias under
 * LID↔PN resolution. Rows are ephemeral by default: `expires_at` is set for
 * this_thread scope and NULL only for sticky (explicit-confirmation) pins;
 * expired rows are both ignored on read and DELETED by pruneExpired.
 *
 * READ is chat-scoped, last-writer-wins (D13/D13a, 2026-07-20, zero
 * destructive migration): `getLatestChatPreference` and `clearChatPreference`
 * collapse the per-sender rows into one chat-wide view at the runtime layer —
 * the newest non-expired row across every sender in the chat wins, and a
 * clear removes the whole conversation's rows. `getPreference`/
 * `clearPreference` keep their original per-sender contract unchanged (still
 * used by the write-dedup check and exported for callers that need exact
 * (chat, sender) semantics).
 */

const PREFERENCE_INTENTS = [
  'auto',
  'fastest',
  'strongest',
  'safe_read_only',
  'provider_specific',
] as const;
// Union + validator Set derive from ONE source (C2) so they cannot drift.
export type PreferenceIntent = (typeof PREFERENCE_INTENTS)[number];

export type PreferenceScope = 'this_thread' | 'sticky';

export interface ChatModelPreference {
  chatJid: string;
  senderJid: string;
  intent: PreferenceIntent;
  /** Only for provider_specific — the explicitly pinned provider id. */
  requestedProvider: string | null;
  scope: PreferenceScope;
  /** Strict pins never silently fall back (zero silent paths). */
  pinStrict: boolean;
  /** Sender granted fallback for their pin ("use fallback"). */
  fallbackPermitted: boolean;
  updatedAt: number; // epoch ms
  /** NULL only for sticky scope; this_thread rows always carry a TTL. */
  expiresAt: number | null;
  /**
   * The per-chat MODEL pin (Q 2026-07-20, provider-qualified). NULL when no
   * model is pinned. A model id is only meaningful relative to a resolved
   * harness, so it is stored WITH the provider it was validated against and a
   * verified bit — the three move together:
   *   - `requestedModel`   — the pinned model id (NULL = no model pin);
   *   - `validatedProvider`— the provider the pin was validated against; NULL =
   *     UNVALIDATED (legacy/never-checked) — re-validate on first resolution,
   *     never treat NULL as "validated against whatever is current" (that would
   *     launder a stale row past the check);
   *   - `modelPinVerified` — true once the id was found in that provider's
   *     catalogue; false = accepted UNVERIFIED during a catalogue outage
   *     (fail-open is a DEFERRAL, so it is re-validated on the next OK read).
   */
  requestedModel: string | null;
  validatedProvider: string | null;
  modelPinVerified: boolean | null;
}

const INTENTS: ReadonlySet<string> = new Set<string>(PREFERENCE_INTENTS);
const SCOPES: ReadonlySet<string> = new Set(['this_thread', 'sticky']);

/** Ensure the per-sender preference table exists, including the model-pin
 *  columns. Idempotent. */
export function ensureChatPreferenceSchema(db: Database): void {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS chat_model_preference (
      chat_jid           TEXT NOT NULL,
      sender_jid         TEXT NOT NULL,
      intent             TEXT NOT NULL,
      requested_provider TEXT,
      scope              TEXT NOT NULL DEFAULT 'this_thread',
      pin_strict         INTEGER NOT NULL DEFAULT 1,
      fallback_permitted INTEGER NOT NULL DEFAULT 0,
      updated_at         INTEGER NOT NULL,
      expires_at         INTEGER,
      PRIMARY KEY (chat_jid, sender_jid)
    )
  `);
  // Model-pin columns (2026-07-20). CREATE IF NOT EXISTS is a no-op against a
  // legacy table, so probe each column and add it when absent (deterministic —
  // no blanket catch that could mask a real DDL failure). All three are
  // nullable with no default: existing rows read back NULL = "no model pin",
  // and a model pin with NULL validated_provider is UNVALIDATED, never blessed
  // as current (Q migration rule).
  for (const [name, ddl] of [
    ['requested_model', 'requested_model TEXT'],
    ['validated_provider', 'validated_provider TEXT'],
    ['model_pin_verified', 'model_pin_verified INTEGER'],
  ] as const) {
    const present = db.raw
      .prepare(`SELECT 1 AS present FROM pragma_table_info('chat_model_preference') WHERE name = ?`)
      .get(name);
    if (!present) db.raw.exec(`ALTER TABLE chat_model_preference ADD COLUMN ${ddl}`);
  }
}

/** Persist (or replace) a sender's preference. Idempotent upsert — repeated
 *  identical writes converge to one row (retry/dedup safety). */
export function setPreference(db: Database, p: ChatModelPreference): void {
  db.raw
    .prepare(
      `INSERT INTO chat_model_preference
         (chat_jid, sender_jid, intent, requested_provider, scope, pin_strict, fallback_permitted, updated_at, expires_at,
          requested_model, validated_provider, model_pin_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_jid, sender_jid) DO UPDATE SET
         intent = excluded.intent,
         requested_provider = excluded.requested_provider,
         scope = excluded.scope,
         pin_strict = excluded.pin_strict,
         fallback_permitted = excluded.fallback_permitted,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at,
         requested_model = excluded.requested_model,
         validated_provider = excluded.validated_provider,
         model_pin_verified = excluded.model_pin_verified`,
    )
    .run(
      p.chatJid,
      p.senderJid,
      p.intent,
      p.requestedProvider,
      p.scope,
      p.pinStrict ? 1 : 0,
      p.fallbackPermitted ? 1 : 0,
      p.updatedAt,
      p.expiresAt,
      p.requestedModel,
      p.validatedProvider,
      p.modelPinVerified === null ? null : p.modelPinVerified ? 1 : 0,
    );
}

const PREFERENCE_COLUMNS =
  `chat_jid, sender_jid, intent, requested_provider, scope, pin_strict, fallback_permitted, updated_at, expires_at,
   requested_model, validated_provider, model_pin_verified`;

interface PreferenceRow {
  chat_jid: unknown;
  sender_jid: unknown;
  intent: unknown;
  requested_provider: unknown;
  scope: unknown;
  pin_strict: unknown;
  fallback_permitted: unknown;
  updated_at: unknown;
  expires_at: unknown;
  requested_model: unknown;
  validated_provider: unknown;
  model_pin_verified: unknown;
}

/**
 * Row → object mapping + fail-safe validation, shared by every reader
 * (getPreference, getLatestChatPreference). SQLite affinity means a
 * corrupted row can hold wrong-typed or out-of-contract values; any such row
 * maps to null (treated as "no preference" — the safe default route) rather
 * than propagating garbage into route resolution. Validation mirrors
 * fallback-state-db.
 *
 * chatJid/senderJid are read FROM THE ROW, not a caller-supplied arg — this
 * is what lets getLatestChatPreference (which selects by chat only) report
 * the row's real sender_jid as the D13a audit trail. For getPreference,
 * which queries by exact (chat_jid, sender_jid), row.chat_jid/row.sender_jid
 * are always equal to the args it queried with, so this is behavior-
 * preserving there.
 */
function rowToPreference(row: PreferenceRow, now: number): ChatModelPreference | null {
  if (typeof row.chat_jid !== 'string' || typeof row.sender_jid !== 'string') return null;
  if (typeof row.intent !== 'string' || !INTENTS.has(row.intent)) return null;
  if (typeof row.scope !== 'string' || !SCOPES.has(row.scope)) return null;
  if (row.requested_provider !== null && typeof row.requested_provider !== 'string') return null;
  // Cross-field contract (F12): requested_provider exists ONLY for
  // provider_specific — a pin with no provider (or a provider on a
  // non-pin intent) is out-of-contract garbage, not a preference.
  if (row.intent === 'provider_specific' && typeof row.requested_provider !== 'string') return null;
  if (row.intent !== 'provider_specific' && row.requested_provider !== null) return null;
  if (typeof row.updated_at !== 'number') return null;
  if (row.expires_at !== null && typeof row.expires_at !== 'number') return null;
  if (row.pin_strict !== 0 && row.pin_strict !== 1) return null;
  if (row.fallback_permitted !== 0 && row.fallback_permitted !== 1) return null;
  if (row.expires_at !== null && row.expires_at <= now) return null;
  // Model-pin fields + their cross-field contract. The three move together: a
  // pin (requested_model set) carries a verified bit, and NO model pin means no
  // provider context or verification state. A NULL validated_provider on a live
  // pin is legal (= UNVALIDATED, re-validated on resolution); the invalid state
  // is a verification/context without a model to attach it to.
  if (row.requested_model !== null && typeof row.requested_model !== 'string') return null;
  if (row.validated_provider !== null && typeof row.validated_provider !== 'string') return null;
  if (row.model_pin_verified !== null && row.model_pin_verified !== 0 && row.model_pin_verified !== 1) return null;
  if (row.requested_model === null) {
    if (row.validated_provider !== null || row.model_pin_verified !== null) return null;
  } else if (row.model_pin_verified === null) {
    return null; // a live model pin must carry a verified/unverified bit
  }
  return {
    chatJid: row.chat_jid,
    senderJid: row.sender_jid,
    intent: row.intent as PreferenceIntent,
    requestedProvider: row.requested_provider as string | null,
    scope: row.scope as PreferenceScope,
    pinStrict: row.pin_strict === 1,
    fallbackPermitted: row.fallback_permitted === 1,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at as number | null,
    requestedModel: row.requested_model as string | null,
    validatedProvider: row.validated_provider as string | null,
    modelPinVerified: row.model_pin_verified === null ? null : row.model_pin_verified === 1,
  };
}

/**
 * Load one sender's preference, or null when absent, expired, or corrupt.
 * Exact (chat_jid, sender_jid) match — never chat-wide.
 */
export function getPreference(
  db: Database,
  chatJid: string,
  senderJid: string,
  now: number = Date.now(),
): ChatModelPreference | null {
  const row = db.raw
    .prepare(`SELECT ${PREFERENCE_COLUMNS} FROM chat_model_preference WHERE chat_jid = ? AND sender_jid = ?`)
    .get(chatJid, senderJid) as PreferenceRow | undefined;
  return row ? rowToPreference(row, now) : null;
}

/**
 * Load the LATEST non-expired preference for a chat, across every sender
 * (D13/D13a read-collapse — chat-scoped, last-writer-wins). The per-sender
 * rows underneath are unchanged; this is a READ view over them. The
 * returned senderJid comes from the winning row itself — the real sender
 * who set the active pin — which is the D13a audit trail, for free.
 */
export function getLatestChatPreference(
  db: Database,
  chatJid: string,
  now: number = Date.now(),
): ChatModelPreference | null {
  const row = db.raw
    .prepare(
      `SELECT ${PREFERENCE_COLUMNS} FROM chat_model_preference
       WHERE chat_jid = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(chatJid, now) as PreferenceRow | undefined;
  // Belt and suspenders: the SQL predicate above already excludes expired
  // rows, but rowToPreference's `expires_at <= now` check is the authority
  // (same boundary, same semantics as getPreference) — it runs regardless.
  return row ? rowToPreference(row, now) : null;
}

/** Remove one sender's preference (`/reset`). Idempotent — clearing an
 *  absent row is a no-op, so a doubled /reset cannot error or spam. */
export function clearPreference(db: Database, chatJid: string, senderJid: string): void {
  db.raw
    .prepare(`DELETE FROM chat_model_preference WHERE chat_jid = ? AND sender_jid = ?`)
    .run(chatJid, senderJid);
}

/** Remove EVERY sender's preference for a chat (D13 chat-scoped clear,
 *  pairs with getLatestChatPreference's chat-scoped read) — a reset clears
 *  the conversation's active pin regardless of who set it. Idempotent. */
export function clearChatPreference(db: Database, chatJid: string): void {
  db.raw.prepare(`DELETE FROM chat_model_preference WHERE chat_jid = ?`).run(chatJid);
}

/** Delete (not merely ignore) every expired row. Sticky rows (expires_at
 *  NULL) are never pruned — they clear only via /reset. */
export function pruneExpired(db: Database, now: number = Date.now()): void {
  db.raw.prepare(`DELETE FROM chat_model_preference WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(now);
}
