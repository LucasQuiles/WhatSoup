import { z } from 'zod';
import type { Database } from '../../core/database.ts';

/**
 * Per-sender command-surface preference store (W1-T9a). GENERALIZES the
 * proven chat-preference-db.ts route-preference mechanism — same composite
 * (chat_jid, sender_jid) PK, same fail-safe read validation ladder, same
 * idempotent upsert, same SELF-MANAGED schema (inline CREATE TABLE IF NOT
 * EXISTS + its own versioning; NOT a numbered global migration). Callers MUST
 * pass canonical keys from preference-keys.ts (never raw wire JIDs, which
 * alias under LID↔PN resolution), exactly as chat-preference-db.ts requires.
 *
 * KEY DESIGN (structural, not runtime-checked — spec §R3c): UserSurfacePrefs
 * carries ONLY narrowing/cosmetic fields. There is NO "enable" field, so a
 * user CANNOT widen past instance policy — no mechanism exists to do so. The
 * security axes (gate/venue/visibility) are NOT in this shape; they flow only
 * from the T1 command-registry catalog (command-registry.ts). This store is
 * pure persistence — it does not know about, validate against, or reference
 * the catalog; resolution semantics live in command-surface-config.ts (T9b).
 */

export interface UserSurfacePrefs {
  /** Command names the sender chose to hide (narrow-only). An unknown/non-
   *  catalog name is stored harmlessly — resolution (T9b) ignores names that
   *  don't match a catalog entry. */
  readonly hidden?: readonly string[];
  readonly verbosity?: 'terse' | 'normal';
  readonly locale?: string;
  /** cmd -> {opt: default}. */
  readonly optionDefaults?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Ensure the per-sender command-surface prefs table exists. Idempotent —
 *  safe to call on a virgin db (lazy creation) or a db that already has the
 *  table (re-open across connections/process restarts). */
export function ensureCommandSurfacePrefsSchema(db: Database): void {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS command_surface_prefs (
      chat_jid    TEXT NOT NULL,
      sender_jid  TEXT NOT NULL,
      prefs_json  TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (chat_jid, sender_jid)
    )
  `);
}

/**
 * Shape schema for UserSurfacePrefs. All fields optional (additive-only
 * contract); unknown top-level keys are stripped (default z.object() strip
 * mode), matching the previous ladder's "ignored, forward-compatible"
 * handling. `satisfies` pins the schema output to the exported type at
 * compile time.
 *
 * One documented behavior delta vs. the previous typeof ladder (same class
 * as the #2857/tranche-2 precedents): z.object() rejects a top-level value
 * whose `typeof` is `'object'` but is not itself a plain object — e.g. a
 * Date or Map — where the ladder's `typeof value !== 'object'` check
 * accepted such host objects (finding no matching own properties on them,
 * it returned `{}`). This is pinned as a trap case below; the guard's only
 * production input is JSON.parse output, which can never produce a Date or
 * Map.
 */
const SurfacePrefsShapeSchema = z.object({
  hidden: z.array(z.string()).optional(),
  verbosity: z.enum(['terse', 'normal']).optional(),
  locale: z.string().optional(),
  optionDefaults: z.record(z.string(), z.record(z.string(), z.string())).optional(),
}) satisfies z.ZodType<UserSurfacePrefs>;

/**
 * Fail-safe shape validation for a decoded prefs value. Mirrors
 * chat-preference-db.ts getPreference's validation ladder: SQLite affinity
 * (and hand-edited/legacy rows) can carry wrong-typed or out-of-contract
 * data; any such value is rejected wholesale (returns null — "no prefs",
 * the safe default) rather than propagating garbage into surface resolution.
 * Unknown top-level keys are ignored (forward-compatible), matching how the
 * type itself is additive-only.
 */
function validateSurfacePrefsShape(value: unknown): UserSurfacePrefs | null {
  const result = SurfacePrefsShapeSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** Persist (or replace) a sender's command-surface prefs. Idempotent upsert
 *  — repeated identical writes converge to one row. */
export function setSurfacePrefs(
  db: Database,
  chatJid: string,
  senderJid: string,
  prefs: UserSurfacePrefs,
  now: number = Date.now(),
): void {
  db.raw
    .prepare(
      `INSERT INTO command_surface_prefs (chat_jid, sender_jid, prefs_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_jid, sender_jid) DO UPDATE SET
         prefs_json = excluded.prefs_json,
         updated_at = excluded.updated_at`,
    )
    .run(chatJid, senderJid, JSON.stringify(prefs), now);
}

/**
 * Load one sender's command-surface prefs, or null when absent or corrupt.
 * Fail-safe: a row that fails JSON.parse or shape validation reads back as
 * null (treated as "no prefs" — instance policy alone applies) rather than
 * propagating garbage into resolveCommandSurface.
 */
export function getSurfacePrefs(db: Database, chatJid: string, senderJid: string): UserSurfacePrefs | null {
  const row = db.raw
    .prepare(`SELECT prefs_json FROM command_surface_prefs WHERE chat_jid = ? AND sender_jid = ?`)
    .get(chatJid, senderJid) as { prefs_json: unknown } | undefined;
  if (!row) return null;
  if (typeof row.prefs_json !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.prefs_json);
  } catch {
    return null;
  }
  return validateSurfacePrefsShape(parsed);
}

/** Remove one sender's command-surface prefs. Idempotent — clearing an
 *  absent row is a no-op. */
export function clearSurfacePrefs(db: Database, chatJid: string, senderJid: string): void {
  db.raw.prepare(`DELETE FROM command_surface_prefs WHERE chat_jid = ? AND sender_jid = ?`).run(chatJid, senderJid);
}
