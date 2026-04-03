// src/core/lid-resolver.ts
// Unified LID ↔ phone resolution service.
//
// Single source of truth for LID-to-phone mappings. Hydrates from Baileys
// filesystem files at startup, stays current via jidAliasChanged events,
// and backs all resolution through the lid_mappings SQLite table.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './database.ts';

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
        stmt.run(lid, `${phone}@s.whatsapp.net`);
        count++;
      }
    } catch {
      // Malformed file — skip
    }
  }
  return count;
}

/**
 * Upsert a single LID → phone mapping (called from jidAliasChanged).
 *
 * Also promotes any access_list entry stored under the raw LID number to the
 * real phone number. This handles the case where a LID sender was approved
 * before their LID→phone mapping was known — the orphaned LID-based entry
 * is migrated to the correct phone-based entry.
 */
export function upsertLidMapping(db: Database, lid: string, phoneJid: string): void {
  db.raw.prepare(
    `INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(lid) DO UPDATE SET phone_jid = excluded.phone_jid, updated_at = datetime('now')`,
  ).run(lid, phoneJid);

  // Migrate orphaned access_list entries: if the LID number was stored as a
  // phone entry (because resolution wasn't available when the sender was
  // approved), update it to the real phone number.
  const phone = phoneJid.split('@')[0];
  if (phone && phone !== lid) {
    const orphan = db.raw.prepare(
      "SELECT status FROM access_list WHERE subject_type = 'phone' AND subject_id = ?",
    ).get(lid) as { status: string } | undefined;

    if (orphan) {
      // Check if the real phone already has an entry
      const existing = db.raw.prepare(
        "SELECT status FROM access_list WHERE subject_type = 'phone' AND subject_id = ?",
      ).get(phone) as { status: string } | undefined;

      if (!existing) {
        // Migrate: update the LID entry to the real phone
        db.raw.prepare(
          "UPDATE access_list SET subject_id = ? WHERE subject_type = 'phone' AND subject_id = ?",
        ).run(phone, lid);
      } else {
        // Real phone entry already exists — just delete the orphan
        db.raw.prepare(
          "DELETE FROM access_list WHERE subject_type = 'phone' AND subject_id = ?",
        ).run(lid);
      }
    }
  }
}

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
  const colonIdx = rawLid.indexOf(':');
  const lid = colonIdx >= 0 ? rawLid.slice(0, colonIdx) : rawLid;

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
  return row.phone_jid.split('@')[0];
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
    map.set(row.lid, row.phone_jid.split('@')[0]);
  }
  return map;
}
