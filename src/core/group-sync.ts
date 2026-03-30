// src/core/group-sync.ts
// Persist groups.upsert and groups.update Baileys events to the groups table.

import type { Database } from './database.ts';

export interface GroupMetadata {
  id: string;
  subject?: string;
  desc?: string;
  owner?: string;
  creation?: number;
  participants?: Array<unknown>;
  restrict?: boolean;
  announce?: boolean;
}

/**
 * Upsert full group metadata from a groups.upsert event.
 * Uses INSERT OR REPLACE so every field is refreshed on re-delivery.
 */
export function handleGroupsUpsert(db: Database, groups: GroupMetadata[]): void {
  const stmt = db.raw.prepare(`
    INSERT INTO groups (jid, subject, description, owner, creation_time, participant_count, restrict_mode, announce_mode, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(jid) DO UPDATE SET
      subject           = COALESCE(excluded.subject, subject),
      description       = COALESCE(excluded.description, description),
      owner             = COALESCE(excluded.owner, owner),
      creation_time     = COALESCE(excluded.creation_time, creation_time),
      participant_count = COALESCE(excluded.participant_count, participant_count),
      restrict_mode     = excluded.restrict_mode,
      announce_mode     = excluded.announce_mode,
      updated_at        = datetime('now')
  `);

  for (const g of groups) {
    stmt.run(
      g.id,
      g.subject ?? null,
      g.desc ?? null,
      g.owner ?? null,
      g.creation ?? null,
      g.participants != null ? g.participants.length : null,
      g.restrict ? 1 : 0,
      g.announce ? 1 : 0,
    );
  }
}

/**
 * Apply partial updates from a groups.update event.
 * Only non-undefined fields are written; absent fields are left as-is.
 */
export function handleGroupsUpdate(db: Database, updates: Array<Partial<GroupMetadata> & { id: string }>): void {
  for (const u of updates) {
    // Build SET clauses for fields that are actually present in the update
    const setClauses: string[] = ["updated_at = datetime('now')"];
    const values: Array<string | number | null> = [];

    if (u.subject !== undefined) {
      setClauses.push('subject = ?');
      values.push(u.subject ?? null);
    }
    if (u.desc !== undefined) {
      setClauses.push('description = ?');
      values.push(u.desc ?? null);
    }
    if (u.owner !== undefined) {
      setClauses.push('owner = ?');
      values.push(u.owner ?? null);
    }
    if (u.restrict !== undefined) {
      setClauses.push('restrict_mode = ?');
      values.push(u.restrict ? 1 : 0);
    }
    if (u.announce !== undefined) {
      setClauses.push('announce_mode = ?');
      values.push(u.announce ? 1 : 0);
    }
    if (u.participants !== undefined) {
      setClauses.push('participant_count = ?');
      values.push(u.participants != null ? u.participants.length : null);
    }

    if (setClauses.length === 1) {
      // Only updated_at — still worth touching the row to record activity
    }

    values.push(u.id);

    db.raw
      .prepare(`UPDATE groups SET ${setClauses.join(', ')} WHERE jid = ?`)
      .run(...values);
  }
}
