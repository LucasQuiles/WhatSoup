import type { Database } from '../../core/database.ts';
import { systemClock } from '../../lib/clock.ts';

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
  /**
   * The per-chat reasoning-EFFORT override for the pinned model (Slice 3).
   * NULL = no override (harness default, no `--effort` flag). A raw native
   * provider level (claude-cli: xhigh/high/medium/low). Meaningful ONLY
   * alongside a model pin — effort with no `requestedModel` is out-of-contract
   * garbage (enforced in rowToPreference), so it moves with the model-pin
   * fields above. It is part of the pin's dedup identity: re-pinning the same
   * model at a new effort is a genuine change, not a no-op refresh.
   *
   * OPTIONAL on write (unset ≡ null ≡ no override) so pre-Slice-3 writers —
   * e.g. recordRoutePreference's provider-only pin — need no change and the
   * frozen runtime.ts stays unchanged; setPreference coalesces to null.
   * ALWAYS present on read (rowToPreference populates string | null).
   */
  requestedEffort?: string | null;
  /**
   * F2a (#2121, owner decision 2026-08-04) — the transport message id of the
   * pin RECEIPT this row last produced: the message whose text promises
   * "reply keep to make it permanent". Its ONLY purpose is to authenticate a
   * reply-threaded confirmation — the widened affirmatives
   * (`confirm`/`yes`/`pin`) promote only when the inbound's
   * `quotedMessageId` equals this value, so a stray bare "yes" in an
   * unrelated reply cannot mutate routing. Bare `keep` is unaffected and
   * still promotes unthreaded.
   *
   * NULL whenever no id was attributable: a fresh pin write clears the
   * previous receipt's id, and the healthy outbound-queue path reports
   * acceptance with a null id by design (#2981 car-A), so a receipt sent
   * while a queue is live stores nothing and the widened tokens simply fall
   * through to the agent as ordinary text.
   *
   * ORTHOGONAL to the model-pin field group above, and deliberately NOT part
   * of its cross-field null-contract in rowToPreference: an INTENT pin
   * (`/model strongest`) carries no `requestedModel` yet still produces a
   * keep-promising receipt.
   *
   * OPTIONAL on write (unset ≡ null ≡ no captured receipt) so every pre-F2a
   * writer needs no change; ALWAYS present on read.
   */
  keepReceiptMessageId?: string | null;
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
    // Slice 3: reasoning-effort override for the pinned model. Nullable, no
    // default — existing rows read back NULL = "no effort override", so this
    // is a rollback-safe additive migration (new binary/old DB: column
    // absent → probe adds it; old binary/new column: the extra column is
    // simply unread).
    ['requested_effort', 'requested_effort TEXT'],
    // F2a (#2121): the pin receipt's transport message id, for reply-threaded
    // confirmation. Nullable, no default — same rollback-safe additive shape
    // as the four above: existing rows read back NULL = "no captured
    // receipt", a new binary against an old DB adds the column via this
    // probe, and an old binary against the new column simply never reads it.
    ['keep_receipt_message_id', 'keep_receipt_message_id TEXT'],
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
          requested_model, validated_provider, model_pin_verified, requested_effort, keep_receipt_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         model_pin_verified = excluded.model_pin_verified,
         requested_effort = excluded.requested_effort,
         keep_receipt_message_id = excluded.keep_receipt_message_id`,
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
      p.requestedEffort ?? null,
      // A pin write always supersedes the previous receipt: the row's old
      // receipt id must not survive to authenticate a reply threaded to a
      // receipt that no longer describes this pin.
      p.keepReceiptMessageId ?? null,
    );
}

const PREFERENCE_COLUMNS =
  `chat_jid, sender_jid, intent, requested_provider, scope, pin_strict, fallback_permitted, updated_at, expires_at,
   requested_model, validated_provider, model_pin_verified, requested_effort, keep_receipt_message_id`;

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
  requested_effort: unknown;
  keep_receipt_message_id: unknown;
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
  // Slice 3: a reasoning-effort override is a string level or null, and is
  // meaningful ONLY alongside a model pin — an effort with no requested_model
  // is out-of-contract garbage (no model to attach the override to).
  if (row.requested_effort !== null && typeof row.requested_effort !== 'string') return null;
  // F2a (#2121): the receipt id is a plain string-or-null. It is deliberately
  // absent from the model-pin null-group check below — an intent pin has no
  // requested_model yet still gets a keep-promising receipt, so folding it in
  // would map every intent-pin row to null.
  if (row.keep_receipt_message_id !== null && typeof row.keep_receipt_message_id !== 'string') return null;
  if (row.requested_model === null) {
    if (row.validated_provider !== null || row.model_pin_verified !== null || row.requested_effort !== null) return null;
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
    requestedEffort: row.requested_effort as string | null,
    keepReceiptMessageId: row.keep_receipt_message_id as string | null,
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
  now: number = systemClock.now(),
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
  now: number = systemClock.now(),
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
export function pruneExpired(db: Database, now: number = systemClock.now()): void {
  db.raw.prepare(`DELETE FROM chat_model_preference WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(now);
}

/**
 * `promoteToSticky` typed outcomes (Q-CANARY model-pin `keep` contract,
 * 2026-07-23). The DB helper owns the atomic predicate and returns one of
 * these; the runtime layer only maps the result to an event/receipt — it
 * never re-derives eligibility or re-decides the actor policy itself.
 */
export type PromoteOutcome = 'promoted' | 'already_sticky' | 'expired' | 'superseded' | 'actor_mismatch' | 'absent';

export interface PromoteToStickyResult {
  outcome: PromoteOutcome;
  /** The relevant row (post-write for `promoted`, as-read otherwise). Null
   *  for `absent`/`expired`/`superseded` — there is nothing safe to surface. */
  preference: ChatModelPreference | null;
}

/** Latest row for a chat across every sender, WITHOUT the expiry filter that
 *  getLatestChatPreference/rowToPreference apply — internal to
 *  promoteToSticky, which needs to tell "nothing was ever pinned" (absent)
 *  apart from "a pin existed but lapsed" (expired) before deciding. Never
 *  used for route resolution. */
function latestRowIncludingExpired(db: Database, chatJid: string): PreferenceRow | undefined {
  return db.raw
    .prepare(`SELECT ${PREFERENCE_COLUMNS} FROM chat_model_preference WHERE chat_jid = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(chatJid) as PreferenceRow | undefined;
}

/**
 * F2a (#2121) — record the transport message id of the pin receipt just sent
 * for this (chat, sender) row.
 *
 * `updated_at` is DELIBERATELY NOT touched. That column is the compare-and-set
 * token {@link promoteToSticky} gates its UPDATE on, and it is also the
 * ordering key for the chat-scoped last-writer-wins read (D13). Bumping it
 * here would make the very receipt a user is being invited to confirm
 * supersede its own pin — a subsequent `keep` would return `superseded`
 * instead of `promoted` — and could flip the chat's winning preference out
 * from under another sender. Writing only the id keeps both invariants.
 *
 * Idempotent and lossless: an absent row (pruned, /reset between the send and
 * this write) affects zero rows and is a no-op, never an insert.
 *
 * A1 (#2121 follow-up) — the `expires_at IS NOT NULL` clause makes "a receipt
 * id exists only on a pin that can still be promoted" a STORE invariant rather
 * than a property of who happens to call. It matters because a re-confirm of an
 * already-sticky pin still renders a keep-promising echo
 * (`renderPinPreferenceOutcome` prints "reply keep to make it permanent" on
 * every branch), so this function IS reachable with a sticky row underneath.
 * Attaching an id there would re-arm exactly the interception that clearing the
 * id at promotion exists to end. Like the absent-row case it affects zero rows
 * and is a silent no-op: the receipt has already been sent, and the widened
 * tokens simply fall through to the agent — the module's documented
 * fail-closed degrade.
 */
export function recordKeepReceiptMessageId(
  db: Database,
  chatJid: string,
  senderJid: string,
  messageId: string,
): void {
  db.raw
    .prepare(
      `UPDATE chat_model_preference SET keep_receipt_message_id = ?
       WHERE chat_jid = ? AND sender_jid = ? AND expires_at IS NOT NULL`,
    )
    .run(messageId, chatJid, senderJid);
}

/**
 * F2a (#2121) — the receipt id a reply must quote to confirm THIS chat's pin.
 *
 * Reads the id from the SAME row {@link promoteToSticky} will resolve — the
 * chat's latest row across every sender, expired rows included — rather than
 * from the confirming sender's own row. The two must agree on which pin is
 * under confirmation, or a threaded `confirm` could authenticate against one
 * sender's receipt while the promotion targets another's. Expiry and actor
 * policy stay entirely with promoteToSticky, which reports them as typed
 * outcomes; this function only answers "which receipt".
 *
 * Returns null when there is no row, or the row never captured an id.
 *
 * A STICKY winning row (`expires_at IS NULL`) always answers null, whatever the
 * column holds. The writer already refuses to stamp a sticky row and promotion
 * consumes the id, so for rows written by this version the check is redundant —
 * its job is the INSTALLED BASE. A row stamped by the previous unguarded writer
 * and since promoted still carries an id, and reading it back would let an old
 * receipt authenticate a threaded affirmative long after the pin became
 * permanent: the interception this work removes, surviving the upgrade. Deciding
 * it on READ repairs every such row without a migration and without a write,
 * and makes "a receipt id is only ever answered for a pin that can still be
 * promoted" true of the whole store rather than only of rows written since.
 */
export function getKeepReceiptMessageId(db: Database, chatJid: string): string | null {
  const raw = latestRowIncludingExpired(db, chatJid);
  if (raw && raw.expires_at === null) return null;
  const id = raw?.keep_receipt_message_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Compare-and-set promotion of the confirmed receipt (the active preference
 * row IS the receipt — no parallel pending-confirmation state) to a
 * permanent, sticky pin.
 *
 * `nowMs` is the caller's chosen eligibility instant — pass the inbound's
 * own receive time (`IncomingMessage.timestamp`), never delayed processing
 * time, so provider-queue pressure cannot turn an on-time `keep` into an
 * "expired" refusal it would not have earned at receive time.
 *
 * Actor policy: only the sender who set the chat's current winning
 * preference may confirm it (the safest match to the existing per-sender
 * write audit — GAP-CHECK's "any group member may promote" finding).
 * `confirmingSenderJid` MUST already be the canonicalized senderKey
 * (preferenceKeys) — the same form every writer stores, so this comparison
 * never false-mismatches on a LID/PN alias of the same person.
 *
 * The write is a single atomic UPDATE gated on `updated_at` matching the
 * exact row just read: if the row moved between read and write (a fresh
 * /model pin, a /reset, a second `keep`, any concurrent writer), zero rows
 * are affected and the promotion is rejected as `superseded` rather than
 * resurrecting whatever is there now. `scope='sticky'` and `expires_at=NULL`
 * are set together in the same statement — the store's own invariant
 * (`scope=sticky ⇔ expires_at IS NULL`, see the module doc above) can never
 * be split across two writes.
 *
 * A1 (#2121 follow-up): the same statement CONSUMES the receipt
 * (`keep_receipt_message_id = NULL`). A promoted pin is permanent and has
 * nothing left to confirm, so leaving its id behind only let the sticky row go
 * on authenticating replies to the receipt that made it sticky — every later
 * threaded `confirm`/`yes`/`pin` was intercepted and answered "already kept"
 * instead of reaching the agent. Cleared in the SAME atomic write, for the same
 * reason scope and expiry are: a promotion must never be observable with the
 * receipt still attached.
 */
export function promoteToSticky(
  db: Database,
  chatJid: string,
  confirmingSenderJid: string,
  nowMs: number,
): PromoteToStickyResult {
  const raw = latestRowIncludingExpired(db, chatJid);
  if (!raw) return { outcome: 'absent', preference: null };

  const isExpired = typeof raw.expires_at === 'number' && raw.expires_at <= nowMs;
  if (isExpired) return { outcome: 'expired', preference: null };

  const winning = rowToPreference(raw, nowMs);
  // A row that exists, is not expired-per-the-clause-above, yet still fails
  // shape validation is corrupt (F12 cross-field contract, wrong-typed
  // affinity, …) — rowToPreference already maps that to null. Treat it the
  // same as "nothing valid to confirm" rather than risk building a
  // ChatModelPreference from an out-of-contract row.
  if (winning === null) return { outcome: 'absent', preference: null };

  if (winning.senderJid !== confirmingSenderJid) {
    return { outcome: 'actor_mismatch', preference: winning };
  }
  if (winning.expiresAt === null) {
    return { outcome: 'already_sticky', preference: winning };
  }

  const updatedAt = systemClock.now();
  const result = db.raw
    .prepare(
      `UPDATE chat_model_preference
         SET scope = 'sticky', expires_at = NULL, updated_at = ?, keep_receipt_message_id = NULL
       WHERE chat_jid = ? AND sender_jid = ? AND updated_at = ?`,
    )
    .run(updatedAt, winning.chatJid, winning.senderJid, winning.updatedAt);
  if (result.changes !== 1) {
    return { outcome: 'superseded', preference: null };
  }
  // S4 (#2121 follow-up review): the receipt id is READ BACK from the row the
  // UPDATE just wrote, not asserted as a literal null. A literal would keep
  // reporting "consumed" even if the clause above stopped clearing it, so the
  // returned object could stay correct while the store was wrong — exactly the
  // divergence a caller rendering from this object would not survive. No
  // caller reads the field today; reading it back is what keeps that safe.
  const promotedRow = db.raw
    .prepare(`SELECT ${PREFERENCE_COLUMNS} FROM chat_model_preference WHERE chat_jid = ? AND sender_jid = ?`)
    .get(winning.chatJid, winning.senderJid) as PreferenceRow | undefined;
  const keepReceiptMessageId = typeof promotedRow?.keep_receipt_message_id === 'string'
    ? promotedRow.keep_receipt_message_id
    : null;
  return {
    outcome: 'promoted',
    preference: { ...winning, scope: 'sticky', expiresAt: null, updatedAt, keepReceiptMessageId },
  };
}
