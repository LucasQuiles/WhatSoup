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
 */
export function upsertLidMapping(db: Database, lid: string, phoneJid: string): void {
  db.raw.prepare(
    `INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(lid) DO UPDATE SET phone_jid = excluded.phone_jid, updated_at = datetime('now')`,
  ).run(lid, phoneJid);
}

/**
 * Resolve a LID number to a phone number via the DB.
 * Returns the phone digits (without @s.whatsapp.net suffix) or null.
 */
export function resolveLid(db: Database, lid: string): string | null {
  const row = db.raw.prepare(
    'SELECT phone_jid FROM lid_mappings WHERE lid = ?',
  ).get(lid) as { phone_jid: string } | undefined;
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
