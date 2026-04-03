// src/core/lid-resolver.ts
// Unified LID ↔ phone resolution service.
//
// LAYERED DEFENSE — this is the most critical infrastructure in WhatSoup.
// Users must NEVER see raw LIDs. Mappings must be accurate, complete, and
// resilient to any single source failing.
//
// Defense layers (ordered by when they fire):
//   L1  Startup hydration     — reads Baileys auth dir lid-mapping-*_reverse.json files
//   L2  Real-time events      — lid-mapping.update (jidAliasChanged) from Baileys
//   L3  Message mining        — extract LID↔phone from msg.key.participant + participantAlt
//   L4  Group metadata mining — extract from group participant lid/phoneNumber fields
//   L5  Cross-instance sync   — fleet API endpoint for broadcasting mappings between instances
//   L6  Periodic reconciliation — scheduled sweep re-reads auth dir + cross-checks
//
// All layers converge on upsertLidMapping() which atomically writes the
// lid_mappings table AND migrates orphaned access_list entries.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createChildLogger } from '../logger.ts';
import { DOMAIN_PERSONAL, bareNumber, normalizeLid, isLidJid, isPnJid } from './jid-constants.ts';
import type { Database } from './database.ts';

const log = createChildLogger('lid-resolver');

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

  const stmt = db.raw.prepare(
    `INSERT OR IGNORE INTO lid_mappings (lid, phone_jid, updated_at)
     VALUES (?, ?, datetime('now'))`,
  );

  for (const entry of entries) {
    // Only process reverse mapping files: lid-mapping-{lid}_reverse.json
    const match = entry.match(/^lid-mapping-(\d+)_reverse\.json$/);
    if (!match) continue;
    const lid = match[1];
    try {
      const raw = readFileSync(join(authDir, entry), 'utf8').trim();
      const phone = JSON.parse(raw);
      if (typeof phone === 'string' && phone.length > 0) {
        stmt.run(lid, `${phone}@${DOMAIN_PERSONAL}`);
        count++;
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
export function upsertLidMapping(db: Database, lid: string, phoneJid: string): void {
  // Atomic: mapping upsert + orphan migration must succeed or fail together.
  db.raw.exec('BEGIN');
  try {
    db.raw.prepare(
      `INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(lid) DO UPDATE SET phone_jid = excluded.phone_jid, updated_at = datetime('now')`,
    ).run(lid, phoneJid);

    // Migrate orphaned access_list entries: if the LID number was stored as a
    // phone entry (because resolution wasn't available when the sender was
    // approved), update it to the real phone number.
    const phone = bareNumber(phoneJid);
    if (phone && phone !== lid) {
      const orphan = db.raw.prepare(
        "SELECT status FROM access_list WHERE subject_type = 'phone' AND subject_id = ?",
      ).get(lid) as { status: string } | undefined;

      if (orphan) {
        const existing = db.raw.prepare(
          "SELECT status FROM access_list WHERE subject_type = 'phone' AND subject_id = ?",
        ).get(phone) as { status: string } | undefined;

        if (!existing) {
          db.raw.prepare(
            "UPDATE access_list SET subject_id = ? WHERE subject_type = 'phone' AND subject_id = ?",
          ).run(phone, lid);
        } else {
          db.raw.prepare(
            "DELETE FROM access_list WHERE subject_type = 'phone' AND subject_id = ?",
          ).run(lid);
        }
      }
    }
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
      upsertLidMapping(db, lid, pnJid);
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
 * Import LID mappings from another instance (used by fleet sync endpoint).
 * Uses INSERT OR IGNORE — existing mappings are preserved (newest wins via L2).
 * Returns count of new mappings imported.
 */
export function importLidMappings(
  db: Database,
  mappings: Array<{ lid: string; phone_jid: string }>,
): number {
  const stmt = db.raw.prepare(
    `INSERT OR IGNORE INTO lid_mappings (lid, phone_jid, updated_at)
     VALUES (?, ?, datetime('now'))`,
  );

  let imported = 0;
  for (const { lid, phone_jid } of mappings) {
    // Validate before inserting
    if (!lid || !phone_jid || !phone_jid.endsWith(`@${DOMAIN_PERSONAL}`)) continue;
    const result = stmt.run(normalizeLid(lid), phone_jid);
    if ((result as any).changes > 0) imported++;
  }

  if (imported > 0) {
    log.info({ imported, total: mappings.length }, 'L5: cross-instance LID sync completed');
  }
  return imported;
}

/**
 * Export all LID mappings for cross-instance sync.
 * Returns array suitable for importLidMappings() on the receiving end.
 */
export function exportLidMappings(db: Database): Array<{ lid: string; phone_jid: string }> {
  return db.raw.prepare(
    'SELECT lid, phone_jid FROM lid_mappings',
  ).all() as Array<{ lid: string; phone_jid: string }>;
}

// ── L6: Periodic reconciliation ─────────────────────────────────────────────

/**
 * Full reconciliation sweep: re-reads auth directory files and reports gaps.
 * Intended to be called on a schedule (e.g. every 30 minutes).
 *
 * Returns { hydrated, unresolvedLids } where unresolvedLids are LIDs seen in
 * the messages table that have no mapping in lid_mappings.
 */
export function reconcileLidMappings(
  db: Database,
  authDir: string,
): { hydrated: number; unresolvedLids: string[] } {
  // Re-run L1 hydration (INSERT OR IGNORE — safe to repeat)
  const hydrated = hydrateLidMappings(db, authDir);

  // Find LIDs in messages table that have no mapping
  const unresolvedRows = db.raw.prepare(`
    SELECT DISTINCT
      CASE
        WHEN INSTR(m.sender_jid, ':') > 0 THEN SUBSTR(m.sender_jid, 1, INSTR(m.sender_jid, ':') - 1)
        WHEN INSTR(m.sender_jid, '@') > 0 THEN SUBSTR(m.sender_jid, 1, INSTR(m.sender_jid, '@') - 1)
        ELSE m.sender_jid
      END AS lid
    FROM messages m
    WHERE m.sender_jid LIKE '%@lid'
      AND NOT EXISTS (
        SELECT 1 FROM lid_mappings lm
        WHERE lm.lid = CASE
          WHEN INSTR(m.sender_jid, ':') > 0 THEN SUBSTR(m.sender_jid, 1, INSTR(m.sender_jid, ':') - 1)
          WHEN INSTR(m.sender_jid, '@') > 0 THEN SUBSTR(m.sender_jid, 1, INSTR(m.sender_jid, '@') - 1)
          ELSE m.sender_jid
        END
      )
  `).all() as { lid: string }[];

  const lids = unresolvedRows.map(r => r.lid);

  if (lids.length > 0) {
    log.warn({ count: lids.length, lids }, 'L6: unresolved LIDs found during reconciliation');
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

  return { hydrated, unresolvedLids: lids };
}

// ── Core resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a LID number to a phone number via the DB.
 * Normalizes the LID first (strips colon-device suffix, e.g. '12345:67' → '12345').
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
  if (!row) return null;
  return bareNumber(row.phone_jid);
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
