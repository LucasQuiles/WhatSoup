// src/core/lid-resolver.ts
// Unified LID ↔ phone resolution service.
//
// LAYERED DEFENSE — this is the most critical infrastructure in WhatSoup.
// Users must NEVER see raw LIDs. Mappings must be accurate, complete, and
// resilient to any single source failing.
//
// Defense layers (ordered by when they fire):
//   L1   Startup hydration    — reads Baileys auth dir lid-mapping-*_reverse.json files
//   L1.5 Lazy disk fallback   — on DB miss, re-reads a single reverse file from auth dir
//   L2   Real-time events     — lid-mapping.update (jidAliasChanged) from Baileys
//   L3   Message mining       — extract LID↔phone from msg.key.participant + participantAlt
//   L4   Group metadata mining — extract from group participant lid/phoneNumber fields
//   L5   Cross-instance sync  — fleet API endpoint for broadcasting mappings between instances
//   L6   Periodic reconciliation — scheduled sweep re-reads auth dir + cross-checks
//
// All layers converge on writeLidMapping() for mapping/history writes. The
// upsertLidMapping() wrapper also migrates orphaned access_list entries.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { createChildLogger } from '../logger.ts';
import { DOMAIN_PERSONAL, DOMAIN_GROUP, DOMAIN_LID, bareNumber, normalizeLid, isLidJid, isPnJid, isGroupJid } from './jid-constants.ts';
import type { Database } from './database.ts';
import { sqliteUtcToEpochMs } from '../lib/sqlite-time.ts';

const log = createChildLogger('lid-resolver');

// ── Unified write seam (PR-1 for #251) ──────────────────────────────────────

/**
 * Provenance label for every LID write. Mirrors the layered defense model:
 *   L1   = startup hydration
 *   L1.5 = lazy disk fallback
 *   L2   = real-time jidAliasChanged event
 *   L3   = message-key mining
 *   L4   = group-metadata mining
 *   L5   = cross-instance fleet sync
 *   L6   = periodic reconciliation
 */
export type LidWriteSource = 'L1' | 'L1.5' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';

/**
 * Conflict-resolution mode for writeLidMapping.
 *   - 'skip-if-exists':  INSERT OR IGNORE. Used by L1 hydration.
 *   - 'overwrite':       ON CONFLICT DO UPDATE unconditionally. L1.5/L2/L3/L4
 *                        (local observation is always considered current).
 *   - 'freshness-gated': ON CONFLICT DO UPDATE only when the incoming
 *                        observed_updated_at is preferred over the existing
 *                        row's updated_at. Equal timestamps converge to the
 *                        alphabetically-first phone_jid. Used by L5 to prevent
 *                        stale cross-instance imports from clobbering newer
 *                        data while keeping deterministic ties convergent.
 */
export type LidWriteMode = 'skip-if-exists' | 'overwrite' | 'freshness-gated';

export interface LidWriteOptions {
  /** Required for 'freshness-gated' mode; ignored otherwise. */
  observedUpdatedAt?: string;
  /** Source-instance name for cross-instance audit (L5). */
  sourceInstance?: string;
}

export interface LidWriteResult {
  /** True if the row was inserted or its phone_jid was changed. */
  written: boolean;
  /**
   * True if an existing row's phone_jid was changed (a real flip — distinct
   * from first-seen which is `written: true, flipped: false`).
   */
  flipped: boolean;
  /**
   * Populated when freshness-gated mode rejected the write because the
   * existing row is at least as fresh as the incoming observation.
   */
  conflict?: {
    prevPhoneJid: string;
    prevUpdatedAt: string;
  };
}

/** Retention bounds enforced after every flip: keep newest 1000 OR last 90 days, whichever first. */
const HISTORY_MAX_ROWS_PER_LID = 1000;
const HISTORY_MAX_AGE_SQL = "-90 days";

export function compareLidUpdatedAt(left: string, right: string): number {
  const leftMs = sqliteUtcToEpochMs(left);
  const rightMs = sqliteUtcToEpochMs(right);
  if (leftMs !== null && rightMs !== null) return Math.sign(leftMs - rightMs);
  if (leftMs !== null) return 1;
  if (rightMs !== null) return -1;
  return left.localeCompare(right);
}

export function isPreferredLidObservation(
  incomingPhoneJid: string,
  incomingUpdatedAt: string | undefined,
  existingPhoneJid: string,
  existingUpdatedAt: string,
): boolean {
  if (!incomingUpdatedAt) return false;
  const byFreshness = compareLidUpdatedAt(incomingUpdatedAt, existingUpdatedAt);
  if (byFreshness !== 0) return byFreshness > 0;
  return incomingPhoneJid.localeCompare(existingPhoneJid) < 0;
}

/**
 * Unified LID-mapping write seam. All seven write paths converge here.
 *
 * Behavior summary:
 *   - On insert (no prior row): writes lid_mappings; history row with
 *     prev_phone_jid=NULL.
 *   - On unchanged phone: no-op (no DB write, no history row).
 *   - On flip (different phone): updates lid_mappings; appends history row;
 *     runs retention cleanup for this LID.
 *   - Freshness-gated mode: write only if the incoming observation is fresher,
 *     or if it has the same updated_at and an alphabetically-earlier phone_jid.
 *     Otherwise returns written=false with a populated `conflict` field for
 *     caller diagnostics.
 *
 * Transaction policy: this function performs multiple SQL statements but does
 * NOT issue BEGIN/COMMIT. Callers that need cross-row atomicity must wrap
 * their batch in a transaction themselves (see importLidMappings,
 * upsertLidMapping). Callers operating inside an existing transaction (e.g.
 * lookupLidFromDisk) can call this safely.
 */
export function writeLidMapping(
  rawDb: DatabaseSync,
  lid: string,
  phoneJid: string,
  source: LidWriteSource,
  mode: LidWriteMode = 'overwrite',
  opts: LidWriteOptions = {},
): LidWriteResult {
  // Look up current row to determine flip vs first-seen vs no-op.
  const existing = rawDb
    .prepare('SELECT phone_jid, updated_at FROM lid_mappings WHERE lid = ?')
    .get(lid) as { phone_jid: string; updated_at: string } | undefined;

  if (existing && mode === 'skip-if-exists') {
    return { written: false, flipped: false };
  }

  if (existing && mode === 'freshness-gated') {
    const incoming = opts.observedUpdatedAt;
    if (existing.phone_jid === phoneJid) {
      if (incoming && compareLidUpdatedAt(incoming, existing.updated_at) > 0) {
        rawDb
          .prepare('UPDATE lid_mappings SET updated_at = ? WHERE lid = ?')
          .run(incoming, lid);
      }
      // Same phone: no history row and no imported/flip count, even if we
      // advanced freshness metadata.
      return { written: false, flipped: false };
    }

    if (!isPreferredLidObservation(phoneJid, incoming, existing.phone_jid, existing.updated_at)) {
      return {
        written: false,
        flipped: false,
        conflict: {
          prevPhoneJid: existing.phone_jid,
          prevUpdatedAt: existing.updated_at,
        },
      };
    }
  }

  if (existing && existing.phone_jid === phoneJid) {
    // No-op: same phone. No history row written.
    return { written: false, flipped: false };
  }

  // For freshness-gated writes, persist the source instance's observation time
  // so future cross-instance comparisons remain meaningful. For overwrite/local
  // writes, we mint datetime('now') from the local clock.
  const newUpdatedAt =
    mode === 'freshness-gated' && opts.observedUpdatedAt
      ? opts.observedUpdatedAt
      : null; // null means "use datetime('now')" below

  if (existing) {
    if (newUpdatedAt !== null) {
      rawDb
        .prepare('UPDATE lid_mappings SET phone_jid = ?, updated_at = ? WHERE lid = ?')
        .run(phoneJid, newUpdatedAt, lid);
    } else {
      rawDb
        .prepare("UPDATE lid_mappings SET phone_jid = ?, updated_at = datetime('now') WHERE lid = ?")
        .run(phoneJid, lid);
    }
  } else {
    if (newUpdatedAt !== null) {
      rawDb
        .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
        .run(lid, phoneJid, newUpdatedAt);
    } else {
      rawDb
        .prepare("INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, datetime('now'))")
        .run(lid, phoneJid);
    }
  }

  // Append history row.
  rawDb
    .prepare(
      `INSERT INTO lid_mappings_history
         (lid, prev_phone_jid, new_phone_jid, source, source_instance, observed_updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      lid,
      existing ? existing.phone_jid : null,
      phoneJid,
      source,
      opts.sourceInstance ?? null,
      opts.observedUpdatedAt ?? null,
    );

  // Retention cleanup: per-LID, keep newest 1000 AND only rows newer than 90 days.
  rawDb
    .prepare(
      `DELETE FROM lid_mappings_history
         WHERE lid = ?
           AND id NOT IN (
             SELECT id FROM lid_mappings_history
              WHERE lid = ?
                AND changed_at > datetime('now', ?)
              ORDER BY id DESC
              LIMIT ?
           )`,
    )
    .run(lid, lid, HISTORY_MAX_AGE_SQL, HISTORY_MAX_ROWS_PER_LID);

  return { written: true, flipped: existing !== undefined };
}

// ── L1: Startup hydration ───────────────────────────────────────────────────

/**
 * Hydrate lid_mappings from Baileys reverse-mapping files.
 * Files: auth/lid-mapping-{lid}_reverse.json → contains phone string.
 * Uses INSERT OR IGNORE so existing DB entries (from jidAliasChanged) are preserved.
 */
export function hydrateLidMappings(db: Database, authDir: string): number {
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(authDir);
  } catch {
    return 0; // auth dir doesn't exist yet
  }

  for (const entry of entries) {
    // Only process reverse mapping files: lid-mapping-{lid}_reverse.json
    const match = entry.match(/^lid-mapping-(\d+)_reverse\.json$/);
    if (!match) continue;
    const lid = match[1];
    try {
      const raw = readFileSync(join(authDir, entry), 'utf8').trim();
      const phone = JSON.parse(raw);
      if (typeof phone === 'string' && phone.length > 0) {
        // Preserve historic semantics: skip if existing row (INSERT OR IGNORE).
        const result = writeLidMapping(
          db.raw,
          lid,
          `${phone}@${DOMAIN_PERSONAL}`,
          'L1',
          'skip-if-exists',
        );
        if (result.written) count++;
        // QR-034: migrate any access_list orphan keyed under the raw LID number
        // to the resolved phone — runs whether or not the mapping was newly
        // written (the orphan row can exist even when the lid_mapping already
        // does), so a sender blocked/approved before L1 hydration learned their
        // mapping is no longer stranded under the LID key (blocklist evasion).
        migrateAccessListOrphan(db, lid, `${phone}@${DOMAIN_PERSONAL}`);
      }
    } catch {
      // Malformed file — skip
    }
  }
  return count;
}

// ── L2: Real-time event upsert ──────────────────────────────────────────────

/**
 * Upsert a single LID → phone mapping (called from jidAliasChanged / L2 events).
 *
 * Also promotes any access_list entry stored under the raw LID number to the
 * real phone number. This handles the case where a LID sender was approved
 * before their LID→phone mapping was known — the orphaned LID-based entry
 * is migrated to the correct phone-based entry.
 *
 * NOTE: This function issues its own BEGIN/COMMIT. Do NOT call it from within
 * an existing transaction on the same db handle — SQLite will throw
 * "cannot start a transaction within a transaction". If you need to batch
 * multiple upserts, use importLidMappings() or call the prepared statements directly.
 */
/**
 * Migrate an orphaned access_list entry from a raw-LID-number subject_id to the
 * resolved phone number. An access_list row is "orphaned" when a sender was
 * blocked/approved before their LID→phone mapping was known, so the row was
 * keyed under the LID-number; once the mapping resolves, the block/allow must
 * follow the identity to the phone key (else shouldRespond — which keys on the
 * resolved phone — misses it → blocklist evasion / lost approval).
 *
 * TRANSACTION-NEUTRAL (QR-034): contains NO BEGIN/COMMIT, only plain
 * SELECT/UPDATE/DELETE, so it is safe to call BOTH inside an open transaction
 * (upsertLidMapping's BEGIN, or a caller's txn for the L1.5 resolveLid path —
 * a nested BEGIN would raise "cannot start a transaction within a transaction")
 * AND standalone (L1 hydration). The caller owns the transaction boundary.
 */
export function migrateAccessListOrphan(db: Database, lid: string, phoneJid: string): void {
  const phone = bareNumber(phoneJid);
  if (!phone || phone === lid) return;

  const orphan = db.raw.prepare(
    "SELECT status FROM access_list WHERE subject_type = 'phone' AND subject_id = ?",
  ).get(lid) as { status: string } | undefined;
  if (!orphan) return;

  const existing = db.raw.prepare(
    "SELECT status FROM access_list WHERE subject_type = 'phone' AND subject_id = ?",
  ).get(phone) as { status: string } | undefined;

  if (!existing) {
    db.raw.prepare(
      "UPDATE access_list SET subject_id = ? WHERE subject_type = 'phone' AND subject_id = ?",
    ).run(phone, lid);
  } else {
    // A row already exists under the phone key. The phone-keyed decision wins,
    // EXCEPT that a block may never be silently erased by the merge (QR-106):
    // access-policy keys the blocklist on the resolved phone, so dropping a
    // blocked orphan in favour of a non-blocked phone row is blocklist evasion.
    // Deny-wins (fail-closed): if the orphan is blocked and the surviving phone
    // row is not, the block follows the identity to the phone key before the
    // orphan is dropped. (A blocked existing row already fails safe.)
    if (orphan.status === 'blocked' && existing.status !== 'blocked') {
      db.raw.prepare(
        "UPDATE access_list SET status = 'blocked' WHERE subject_type = 'phone' AND subject_id = ?",
      ).run(phone);
    }
    db.raw.prepare(
      "DELETE FROM access_list WHERE subject_type = 'phone' AND subject_id = ?",
    ).run(lid);
  }
}

export function upsertLidMapping(
  db: Database,
  lid: string,
  phoneJid: string,
  source: LidWriteSource = 'L2',
): void {
  // Atomic: mapping upsert + orphan migration must succeed or fail together.
  db.raw.exec('BEGIN');
  try {
    // Route the actual write through the unified seam so history rows are
    // captured. Default source 'L2' (jidAliasChanged) keeps overwrite
    // semantics — Baileys is authoritative for this instance at write time.
    // L3 (message mining) and L4 (group metadata) callers pass their own
    // source label for accurate audit provenance.
    writeLidMapping(db.raw, lid, phoneJid, source, 'overwrite');
    migrateAccessListOrphan(db, lid, phoneJid);
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }
}

// ── L3: Message mining ──────────────────────────────────────────────────────

/**
 * Extract LID↔phone pair from a Baileys message key's participant + participantAlt.
 *
 * When WhatsApp delivers a group message, the key may carry:
 *   - key.participant:    primary sender JID (could be LID or PN depending on group mode)
 *   - key.participantAlt: alternate form (PN if primary is LID, or vice versa)
 *
 * Returns { lid, phoneJid } if a new pair was discovered, null otherwise.
 * Callers should pass the result to upsertLidMapping().
 */
export function mineMessageKey(
  db: Database,
  participant: string | null | undefined,
  participantAlt: string | null | undefined,
): { lid: string; phoneJid: string } | null {
  if (!participant || !participantAlt) return null;

  let lidJid: string | null = null;
  let pnJid: string | null = null;

  if (isLidJid(participant) && isPnJid(participantAlt)) {
    lidJid = participant;
    pnJid = participantAlt;
  } else if (isPnJid(participant) && isLidJid(participantAlt)) {
    lidJid = participantAlt;
    pnJid = participant;
  }

  if (!lidJid || !pnJid) return null;

  const lid = normalizeLid(bareNumber(lidJid));
  const phoneJid = pnJid;

  // Quick check: is this already known? Skip DB write if so.
  const existing = resolveLid(db, lid);
  if (existing === bareNumber(phoneJid)) return null; // already mapped

  return { lid, phoneJid };
}

// ── L4: Group metadata mining ───────────────────────────────────────────────

/**
 * Extract LID↔phone pairs from group participant metadata.
 *
 * Baileys GroupParticipant includes:
 *   - id: primary JID (LID or PN depending on group addressing mode)
 *   - lid?: LID JID (when id is PN)
 *   - phoneNumber?: PN JID (when id is LID)
 *
 * Returns count of new mappings discovered and upserted.
 */
export function mineGroupParticipants(
  db: Database,
  participants: Array<{ id: string; lid?: string; phoneNumber?: string }>,
): number {
  let discovered = 0;

  for (const p of participants) {
    let lid: string | null = null;
    let pnJid: string | null = null;

    // Case 1: id is PN, lid field carries the LID
    if (isPnJid(p.id) && p.lid && isLidJid(p.lid)) {
      lid = normalizeLid(bareNumber(p.lid));
      pnJid = p.id;
    }
    // Case 2: id is LID, phoneNumber field carries the PN
    else if (isLidJid(p.id) && p.phoneNumber && isPnJid(p.phoneNumber)) {
      lid = normalizeLid(bareNumber(p.id));
      pnJid = p.phoneNumber;
    }

    if (!lid || !pnJid) continue;

    // Quick check: skip if already known
    const existing = resolveLid(db, lid);
    if (existing === bareNumber(pnJid)) continue;

    try {
      upsertLidMapping(db, lid, pnJid, 'L4');
      log.info({ lid, phoneJid: pnJid, source: 'group-metadata' }, 'L4: new LID mapping from group participant');
      discovered++;
    } catch (err) {
      log.warn({ err, lid, pnJid }, 'L4: failed to upsert group participant LID mapping');
    }
  }

  return discovered;
}

// ── L5: Cross-instance sync ─────────────────────────────────────────────────

/**
 * Cross-instance LID-mapping import (fleet sync endpoint).
 *
 * Freshness gate (#251): a mapping from another instance is only written when
 * it has a preferred observation timestamp, or when equal timestamps converge
 * to the alphabetically-first phone_jid. Non-preferred observations are
 * reported as conflicts via the return value; the caller (fleet route or
 * operator) decides what to do with them.
 *
 * Each row may carry the source-instance `updated_at` (its own observation
 * time). When provided, that value is persisted into the target row's
 * `updated_at` so future cross-instance comparisons remain meaningful.
 *
 * Returns per-row outcomes plus aggregate counts.
 */
export interface FleetMappingInput {
  lid: string;
  phone_jid: string;
  updated_at?: string;
  source_instance?: string;
}

export interface FleetMappingConflict {
  lid: string;
  incoming_phone_jid: string;
  incoming_updated_at: string | null;
  existing_phone_jid: string;
  existing_updated_at: string;
  source_instance: string | null;
}

export interface ImportLidMappingsResult {
  imported: number;
  flipped: number;
  noop: number;
  conflicts: FleetMappingConflict[];
}

export function importLidMappings(
  db: Database,
  mappings: ReadonlyArray<FleetMappingInput>,
): ImportLidMappingsResult {
  const out: ImportLidMappingsResult = {
    imported: 0,
    flipped: 0,
    noop: 0,
    conflicts: [],
  };

  // Wrap the batch in a transaction so partial failures don't leave the
  // history table inconsistent with lid_mappings.
  db.raw.exec('BEGIN');
  try {
    for (const m of mappings) {
      // Validate before writing.
      if (!m.lid || !m.phone_jid || !m.phone_jid.endsWith(`@${DOMAIN_PERSONAL}`)) continue;

      const res = writeLidMapping(
        db.raw,
        normalizeLid(m.lid),
        m.phone_jid,
        'L5',
        'freshness-gated',
        {
          observedUpdatedAt: m.updated_at,
          sourceInstance: m.source_instance,
        },
      );

      if (res.written) {
        out.imported++;
        if (res.flipped) out.flipped++;
      } else if (res.conflict) {
        out.conflicts.push({
          lid: normalizeLid(m.lid),
          incoming_phone_jid: m.phone_jid,
          incoming_updated_at: m.updated_at ?? null,
          existing_phone_jid: res.conflict.prevPhoneJid,
          existing_updated_at: res.conflict.prevUpdatedAt,
          source_instance: m.source_instance ?? null,
        });
      } else {
        out.noop++;
      }
    }
    db.raw.exec('COMMIT');
  } catch (err) {
    db.raw.exec('ROLLBACK');
    throw err;
  }

  if (out.imported > 0 || out.conflicts.length > 0) {
    log.info(
      { imported: out.imported, flipped: out.flipped, conflicts: out.conflicts.length, total: mappings.length },
      'L5: cross-instance LID sync completed',
    );
  }
  return out;
}


// ── L6: Periodic reconciliation ─────────────────────────────────────────────

/**
 * Cross-sweep state for {@link reconcileLidMappings}. The caller (main.ts)
 * creates one at startup and threads it through every scheduled sweep so L6 can
 * run incrementally instead of re-deriving the unresolved cohort from a full
 * scan of the historical `messages` table every ~30 minutes (#1781).
 *
 *   - `lastMaxPk`     — high-water mark. Only messages with `pk > lastMaxPk` are
 *     scanned for newly-appeared unresolved LIDs. `pk > ?` seeks on the INTEGER
 *     PRIMARY KEY, so cost scales with new messages since the last sweep, not
 *     with total corpus size (the old `sender_jid LIKE '%@lid'` predicate has a
 *     leading wildcard and cannot use `idx_messages_sender`, forcing a full
 *     table scan each cycle).
 *   - `knownUnresolvedLids` — the carried-forward unresolvable cohort. Members
 *     are re-checked cheaply against `lid_mappings` each sweep and dropped once
 *     a mapping exists; they are NOT re-warned. Only the per-sweep delta of
 *     genuinely-new unresolvables is warned, so the actionable signal (a new
 *     unresolvable appearing / the cohort growing) survives instead of being
 *     buried under a constant restatement of a known-permanent cohort.
 *
 * The state is intentionally in-memory: both defects in #1781 (repeated
 * full-scan cost and warn spam) are process-lifetime problems, and a restart
 * simply re-primes via a single full scan (`lastMaxPk` starts at 0).
 * Correctness never depends on this state — access-policy.ts fails closed on
 * unresolved LIDs regardless, and a permanently-unresolvable cohort is an
 * expected steady state under WhatsApp's LID privacy model.
 */
export interface LidReconcileState {
  lastMaxPk: number;
  knownUnresolvedLids: Set<string>;
}

/**
 * Reconciliation sweep: re-reads auth directory files and reports unresolved
 * LID gaps. Intended to be called on a schedule (e.g. every 30 minutes).
 *
 * When `state` is provided (production path), the scan is bounded by the
 * high-water mark and warnings are emitted only for the per-sweep delta of
 * newly-appeared unresolvable LIDs. When omitted (one-off callers / legacy
 * tests) each call behaves like a first pass: a full scan that warns the whole
 * unresolved set.
 *
 * Returns `{ hydrated, unresolvedLids, newUnresolvedLids }` where
 * `unresolvedLids` is the full current unresolvable cohort and
 * `newUnresolvedLids` is the delta warned on this sweep.
 */
export function reconcileLidMappings(
  db: Database,
  authDir: string,
  state?: LidReconcileState,
): { hydrated: number; unresolvedLids: string[]; newUnresolvedLids: string[] } {
  // Re-run L1 hydration (INSERT OR IGNORE — safe to repeat)
  const hydrated = hydrateLidMappings(db, authDir);

  // No caller state → ephemeral first-pass state (full scan, warn whole set).
  const st = state ?? { lastMaxPk: 0, knownUnresolvedLids: new Set<string>() };

  // High-water mark for THIS sweep, read up front. Rows that arrive mid-sweep
  // keep a pk > this value and are simply picked up next sweep (never skipped).
  const maxPkRow = db.raw
    .prepare('SELECT MAX(pk) AS maxPk FROM messages')
    .get() as { maxPk: number | null } | undefined;
  const currentMaxPk = maxPkRow?.maxPk ?? st.lastMaxPk;

  // (1) BOUNDED scan — only messages newer than the last sweep. `pk > ?` seeks
  // on the INTEGER PRIMARY KEY; the per-row LID extraction and NOT EXISTS check
  // are unchanged from the historical query.
  const newUnresolvedRows = db.raw.prepare(`
    SELECT DISTINCT
      CASE
        WHEN INSTR(m.sender_jid, ':') > 0 THEN SUBSTR(m.sender_jid, 1, INSTR(m.sender_jid, ':') - 1)
        WHEN INSTR(m.sender_jid, '@') > 0 THEN SUBSTR(m.sender_jid, 1, INSTR(m.sender_jid, '@') - 1)
        ELSE m.sender_jid
      END AS lid
    FROM messages m
    WHERE m.pk > ?
      AND m.sender_jid LIKE '%@lid'
      AND NOT EXISTS (
        SELECT 1 FROM lid_mappings lm
        WHERE lm.lid = CASE
          WHEN INSTR(m.sender_jid, ':') > 0 THEN SUBSTR(m.sender_jid, 1, INSTR(m.sender_jid, ':') - 1)
          WHEN INSTR(m.sender_jid, '@') > 0 THEN SUBSTR(m.sender_jid, 1, INSTR(m.sender_jid, '@') - 1)
          ELSE m.sender_jid
        END
      )
  `).all(st.lastMaxPk) as { lid: string }[];

  // (2) Re-check the carried-forward cohort: any LID that has since gained a
  // mapping (via L1–L5 or this pass's hydration) leaves the unresolvable set.
  // This is O(cohort) indexed PRIMARY-KEY lookups on lid_mappings — NOT a table
  // scan — and preserves the resolver's real job: resolvable LIDs still resolve
  // and drop out. The lookup mirrors the scan's NOT EXISTS exactly (the stored
  // entries are already the ':'/'@'-stripped lid key).
  const mappingProbe = db.raw.prepare('SELECT 1 FROM lid_mappings WHERE lid = ?');
  for (const lid of [...st.knownUnresolvedLids]) {
    if (mappingProbe.get(lid)) st.knownUnresolvedLids.delete(lid);
  }

  // (3) Delta = genuinely-new unresolvable LIDs not already tracked. Warn on the
  // delta only, so a steady known cohort stays quiet while growth is surfaced.
  const newUnresolvedLids: string[] = [];
  for (const { lid } of newUnresolvedRows) {
    if (!st.knownUnresolvedLids.has(lid)) {
      st.knownUnresolvedLids.add(lid);
      newUnresolvedLids.push(lid);
    }
  }
  st.lastMaxPk = currentMaxPk;

  if (newUnresolvedLids.length > 0) {
    log.warn(
      { count: newUnresolvedLids.length, lids: newUnresolvedLids, cohortSize: st.knownUnresolvedLids.size },
      'L6: new unresolved LIDs found during reconciliation',
    );
  }

  // Also check for LID-keyed chats that could now be migrated
  const lidChats = db.raw.prepare(
    "SELECT jid FROM chats WHERE jid LIKE '%@lid'",
  ).all() as { jid: string }[];

  for (const chat of lidChats) {
    const chatLid = normalizeLid(bareNumber(chat.jid));
    const phone = resolveLid(db, chatLid);
    if (phone) {
      // We now have a mapping — migrate the chat key
      try {
        const pnJid = `${phone}@${DOMAIN_PERSONAL}`;
        const existing = db.raw.prepare('SELECT jid FROM chats WHERE jid = ?').get(pnJid);
        if (!existing) {
          db.raw.prepare('UPDATE chats SET jid = ? WHERE jid = ?').run(pnJid, chat.jid);
          log.info({ oldJid: chat.jid, newJid: pnJid }, 'L6: migrated LID-keyed chat to phone key');
        }
      } catch (err) {
        log.warn({ err, chatJid: chat.jid }, 'L6: failed to migrate LID-keyed chat');
      }
    }
  }

  return { hydrated, unresolvedLids: [...st.knownUnresolvedLids], newUnresolvedLids };
}

// ── L1.5: Lazy disk fallback ────────────────────────────────────────────────

/**
 * Baileys auth dir registered by main.ts at startup. When set, `resolveLid`
 * falls back to reading `{authDir}/lid-mapping-{lid}_reverse.json` on DB miss
 * before giving up. This closes the gap where Baileys learns a LID↔phone pair
 * from an incoming message and writes the reverse file immediately, but the
 * L2 event (`lid-mapping.update`) hasn't fired yet or wasn't received before
 * the ingest pipeline runs its access check.
 *
 * Empty string = disabled (production uses a real path; tests typically omit).
 */
let _lidAuthDir: string = '';

/** Register the Baileys auth directory for L1.5 disk fallback. */
export function setLidAuthDir(authDir: string): void {
  _lidAuthDir = authDir ?? '';
}

/**
 * Read a single `lid-mapping-{lid}_reverse.json` file from disk and, if valid,
 * upsert the mapping into the DB. Returns the resolved phone or null.
 *
 * Used by resolveLid() as an on-miss fallback; also callable directly.
 *
 * Transaction safety: uses a single-statement INSERT...ON CONFLICT rather
 * than upsertLidMapping(), because resolveLid is called from within open
 * transactions (e.g. blocklist-sync.ts:28). A nested BEGIN would raise
 * "cannot start a transaction within a transaction". QR-034: the access_list
 * orphan-migration now ALSO runs here via the transaction-neutral
 * migrateAccessListOrphan() (no BEGIN/COMMIT, safe inside the caller's txn) —
 * previously it was skipped, so a sender blocked/approved before their LID
 * mapping was learned could silently regain access once L1.5 resolved the
 * mapping on the hot path (blocklist evasion).
 */
function lookupLidFromDisk(db: Database, lid: string): string | null {
  if (!_lidAuthDir) return null;
  // Defense-in-depth: a LID is always digits. Reject anything else before
  // interpolating it into a file path, mirroring the startup hydrate filter
  // (/^lid-mapping-(\d+)_reverse\.json$/) and preventing path traversal (#1089).
  if (!/^\d+$/.test(lid)) return null;
  const file = join(_lidAuthDir, `lid-mapping-${lid}_reverse.json`);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  let phone: unknown;
  try {
    phone = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof phone !== 'string' || phone.length === 0) return null;

  // Route through the unified seam. Safe inside a caller's transaction — the
  // seam itself does not BEGIN/COMMIT. Mode is 'overwrite' to preserve the
  // pre-existing single-statement INSERT...ON CONFLICT DO UPDATE semantics.
  try {
    writeLidMapping(db.raw, lid, `${phone}@${DOMAIN_PERSONAL}`, 'L1.5', 'overwrite');
    // QR-034: migrate any access_list orphan to the resolved phone. Transaction-
    // neutral, so safe inside the caller's open transaction (no nested BEGIN).
    migrateAccessListOrphan(db, lid, `${phone}@${DOMAIN_PERSONAL}`);
    log.info({ lid, phone }, 'L1.5 disk fallback resolved LID from reverse file');
  } catch (err) {
    log.warn({ err, lid, phone }, 'L1.5 disk fallback upsert failed');
  }
  return phone;
}

// ── Core resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a LID number to a phone number.
 *
 * Normalizes the LID first (strips colon-device suffix, e.g. '12345:67' → '12345').
 * Order: DB lookup → on-miss disk fallback (L1.5) → null.
 * Returns the phone digits (without @s.whatsapp.net suffix) or null.
 *
 * Uses a lazily-cached prepared statement to avoid re-preparing on every call.
 * Node.js is single-threaded; no locking required for the module-level cache.
 */
let _resolveLidStmt: ReturnType<typeof import('node:sqlite').DatabaseSync.prototype.prepare> | null = null;
let _resolveLidDb: Database | null = null;

export function resolveLid(db: Database, rawLid: string): string | null {
  // Normalize: strip colon-device suffix (e.g. '12345:67' → '12345')
  const lid = normalizeLid(rawLid);

  // Cache the prepared statement — invalidate if db instance changes
  if (_resolveLidDb !== db) {
    _resolveLidStmt = null;
    _resolveLidDb = db;
  }
  if (!_resolveLidStmt) {
    _resolveLidStmt = db.raw.prepare('SELECT phone_jid FROM lid_mappings WHERE lid = ?');
  }

  const row = _resolveLidStmt.get(lid) as { phone_jid: string } | undefined;
  if (row) return bareNumber(row.phone_jid);

  // L1.5: lazy disk fallback for mappings Baileys wrote after startup hydration.
  return lookupLidFromDisk(db, lid);
}

/**
 * Resolve a raw LID (or full LID JID like '12345@lid') to its full phone JID
 * (e.g. '12345@s.whatsapp.net'). Returns null if the LID is not mapped.
 *
 * Accepts both bare LID numbers and full JIDs — strips the @domain and
 * colon-device suffix before lookup.
 */
export function resolveLidToJid(db: Database, rawLid: string): string | null {
  const phone = resolveLid(db, bareNumber(rawLid));
  if (!phone) return null;
  return `${phone}@${DOMAIN_PERSONAL}`;
}

/**
 * REVERSE lookup (B27): all known LIDs whose mapping points at the given
 * phone identity. Accepts bare phone digits or a full JID (domain and
 * colon-device suffix are stripped); returns bare LID digit strings, most
 * recently updated mapping first with a deterministic lid tie-break.
 * Multiple LIDs can map to one phone — `lid` is the PK, `phone_jid` is not
 * unique. resolveLid is forward-only (lid→phone); this is its sibling for
 * phone-origin refs that need their lid alias forms (e.g. the display-name
 * ladder probing '@lid'-keyed contact/sender-name rows for a phone-keyed
 * chat). Cost note: `phone_jid` is unindexed, so this is a scan of the
 * (small, mapping-sized) lid_mappings table — fine for render-path callers,
 * not for per-message hot paths.
 *
 * The prepared statement is cached per raw handle, and a FAILED prepare
 * (absent table, mock handle) is memoized as a permanent miss — degraded
 * handles never re-prepare (the same contract chat-display-name.ts locks
 * for its own ladder statements).
 */
const _lidsForPhoneStmts = new WeakMap<DatabaseSync, StatementSync | null>();

export function resolveLidsForPhone(db: Database, rawPhone: string): string[] {
  const phone = bareNumber(rawPhone);
  if (phone === '') return [];
  let stmt = _lidsForPhoneStmts.get(db.raw);
  if (stmt === undefined) {
    try {
      stmt = db.raw.prepare(
        'SELECT lid FROM lid_mappings WHERE phone_jid = ? ORDER BY updated_at DESC, lid',
      );
    } catch {
      stmt = null;
    }
    _lidsForPhoneStmts.set(db.raw, stmt);
  }
  if (stmt === null) return [];
  const rows = stmt.all(`${phone}@${DOMAIN_PERSONAL}`) as { lid: string }[];
  return rows.map((row) => row.lid);
}

/**
 * Resolve all known LID→phone pairs. Returns a map of lid → phone digits.
 * Used by fleet API to build display labels.
 */
export function getAllLidMappings(db: Database): Map<string, string> {
  const rows = db.raw.prepare(
    'SELECT lid, phone_jid FROM lid_mappings',
  ).all() as { lid: string; phone_jid: string }[];
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.lid, bareNumber(row.phone_jid));
  }
  return map;
}

// ── Canonical JID normalization ────────────────────────────────────────────

/**
 * Normalize a chat JID to its canonical form for use as a map key.
 *
 * Canonical form:
 *   - Groups:   unchanged (e.g. `120363555555555000@g.us`)
 *   - Phone DMs: unchanged (e.g. `15555550100@s.whatsapp.net`)
 *   - LID DMs:  resolved to `phone@s.whatsapp.net` via lid_mappings if known;
 *               returned unchanged if unmapped (graceful degradation)
 *
 * NEVER throws. If the DB lookup fails or JID is unrecognized, returns input
 * unchanged — worst case is old drift behavior, never message loss.
 */
export function canonicalizeChatJid(chatJid: string, db?: Database | null): string {
  if (chatJid.endsWith(`@${DOMAIN_GROUP}`)) return chatJid;
  if (chatJid.endsWith(`@${DOMAIN_PERSONAL}`)) return chatJid;

  if (chatJid.endsWith(`@${DOMAIN_LID}`)) {
    if (!db) return chatJid;
    try {
      const resolved = resolveLidToJid(db, chatJid);
      return resolved ?? chatJid;
    } catch {
      // DB error — graceful degradation
      return chatJid;
    }
  }

  return chatJid;
}
