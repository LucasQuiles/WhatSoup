// src/core/substrate/entities.ts
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { nowUnixSec } from './time.ts';
import type {
  EntityKind, AliasKind, EntityRef, EntityRow, ObservationRow, ObservationSourceKind,
} from './types.ts';

export interface UpsertEntityArgs {
  kind: EntityKind; canonicalName: string;
  contactJid?: string | null; groupJid?: string | null;
  metadata?: Record<string, unknown>;
}

export function upsertEntity(db: DatabaseSync, args: UpsertEntityArgs): EntityRow {
  // Atomicity: the check-then-insert runs inside BEGIN IMMEDIATE so concurrent
  // writers (same process under future async refactor, or cross-process via
  // fleet orchestration) cannot interleave between the SELECT and INSERT. Node
  // + DatabaseSync is synchronous today and SQLite's write-lock already
  // serializes cross-process writes, but the explicit transaction makes the
  // invariant load-bearing — surviving any future `await` insertion into this
  // path.
  const now = nowUnixSec();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (args.contactJid) {
      const existing = db.prepare(`SELECT * FROM entities WHERE contact_jid = ?`).get(args.contactJid) as unknown as EntityRow | undefined;
      if (existing) { db.exec('COMMIT'); return existing; }
    }
    if (args.groupJid) {
      const existing = db.prepare(`SELECT * FROM entities WHERE group_jid = ?`).get(args.groupJid) as unknown as EntityRow | undefined;
      if (existing) { db.exec('COMMIT'); return existing; }
    }
    const byName = db
      .prepare(`SELECT * FROM entities WHERE kind = ? AND canonical_name = ? AND merged_into_id IS NULL`)
      .get(args.kind, args.canonicalName) as unknown as EntityRow | undefined;
    if (byName) { db.exec('COMMIT'); return byName; }

    const info = db.prepare(
      `INSERT INTO entities (kind, canonical_name, contact_jid, group_jid, created_at, updated_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(args.kind, args.canonicalName, args.contactJid ?? null, args.groupJid ?? null, now, now, JSON.stringify(args.metadata ?? {}));
    const row = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(Number(info.lastInsertRowid)) as unknown as EntityRow;
    db.exec('COMMIT');
    return row;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* best effort */ }
    throw err;
  }
}


export interface AddAliasArgs {
  entityId: number; alias: string; aliasKind: AliasKind; source?: string;
}

export function addAlias(db: DatabaseSync, args: AddAliasArgs): void {
  const now = nowUnixSec();
  try {
    db.prepare(
      `INSERT INTO entity_aliases (entity_id, alias, alias_kind, source, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(args.entityId, args.alias, args.aliasKind, args.source ?? null, now);
  } catch (err) {
    if (!/UNIQUE/i.test(String(err))) throw err;
  }
}

export function resolveEntityRef(db: DatabaseSync, ref: EntityRef): EntityRow | null {
  let row: EntityRow | undefined;
  if (ref.entityId) {
    row = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(ref.entityId) as unknown as EntityRow | undefined;
  } else if (ref.contactJid) {
    row = db.prepare(`SELECT * FROM entities WHERE contact_jid = ?`).get(ref.contactJid) as unknown as EntityRow | undefined;
  } else if (ref.groupJid) {
    row = db.prepare(`SELECT * FROM entities WHERE group_jid = ?`).get(ref.groupJid) as unknown as EntityRow | undefined;
  } else if (ref.canonicalName && ref.kind) {
    row = db.prepare(`SELECT * FROM entities WHERE kind = ? AND canonical_name = ? AND merged_into_id IS NULL`)
      .get(ref.kind, ref.canonicalName) as unknown as EntityRow | undefined;
  }
  if (!row) return null;
  // Follow merged_into_id chain with a visited set so corrupt cycles
  // (A→B→A) terminate deterministically instead of walking to depth 5
  // and returning an arbitrary entity. mergeEntities rejects writing such
  // cycles in the first place, but this guard keeps the read path correct
  // even if data is hand-edited or corrupted.
  const visited = new Set<number>([row.id]);
  while (row.merged_into_id != null && visited.size < 10) {
    if (visited.has(row.merged_into_id)) break;
    const next = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(row.merged_into_id) as unknown as EntityRow | undefined;
    if (!next) break;
    visited.add(next.id);
    row = next;
  }
  return row;
}

export interface CaptureObservationArgs {
  entityRef: EntityRef; kind: string; text: string; confidence: number;
  sourceMessagePk?: number | null; sourceKind: ObservationSourceKind;
  supersedesObservationId?: number | null;
  metadata?: Record<string, unknown>;
}

export function captureObservation(db: DatabaseSync, args: CaptureObservationArgs): ObservationRow {
  let entity = resolveEntityRef(db, args.entityRef);
  if (!entity) {
    if (!args.entityRef.canonicalName || !args.entityRef.kind) {
      throw new Error('captureObservation: entity not found and canonicalName+kind not provided for auto-create');
    }
    entity = upsertEntity(db, {
      kind: args.entityRef.kind,
      canonicalName: args.entityRef.canonicalName,
      contactJid: args.entityRef.contactJid ?? null,
      groupJid: args.entityRef.groupJid ?? null,
    });
  }
  // QR-040 (defense in depth, write side): a caller-supplied
  // supersedesObservationId may only target an observation belonging to the
  // SAME entity. Without this, a caller (e.g. the admin-gated capture_observation
  // MCP tool, or a confused-deputy agent) could capture an observation under
  // entity Y that supersedes — and thus hides — an observation belonging to a
  // DIFFERENT entity Z, poisoning Z's profile. Reject a missing or cross-entity
  // target rather than silently writing a cross-entity superseder.
  if (args.supersedesObservationId !== undefined && args.supersedesObservationId !== null) {
    const target = db.prepare(
      `SELECT entity_id FROM entity_observations WHERE id = ?`
    ).get(args.supersedesObservationId) as { entity_id: number } | undefined;
    if (!target) {
      throw new Error(`captureObservation: supersedesObservationId ${args.supersedesObservationId} not found`);
    }
    if (target.entity_id !== entity.id) {
      throw new Error(
        `captureObservation: supersedesObservationId ${args.supersedesObservationId} belongs to entity ${target.entity_id}, not the captured entity ${entity.id} (cross-entity supersede rejected)`,
      );
    }
  }
  const now = nowUnixSec();
  const info = db.prepare(
    `INSERT INTO entity_observations (
       entity_id, kind, text, confidence, source_message_pk, source_kind,
       supersedes_observation_id, created_at, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entity.id, args.kind, args.text, args.confidence,
    args.sourceMessagePk ?? null, args.sourceKind,
    args.supersedesObservationId ?? null, now,
    JSON.stringify(args.metadata ?? {}),
  );
  return db.prepare(`SELECT * FROM entity_observations WHERE id = ?`).get(Number(info.lastInsertRowid)) as unknown as ObservationRow;
}

export function forgetObservation(db: DatabaseSync, id: number, reason: string): void {
  db.prepare(`UPDATE entity_observations SET forgotten = 1, forgotten_reason = ? WHERE id = ?`).run(reason, id);
}

export function mergeEntities(db: DatabaseSync, args: { fromId: number; intoId: number }): void {
  if (args.fromId === args.intoId) throw new Error('mergeEntities: cannot merge into self');
  const into = db
    .prepare(`SELECT id, merged_into_id FROM entities WHERE id = ?`)
    .get(args.intoId) as { id: number; merged_into_id: number | null } | undefined;
  if (!into) throw new Error(`mergeEntities: intoId ${args.intoId} not found`);
  if (into.merged_into_id != null) {
    // Refuse to merge into an entity that is itself merged — prevents cycle
    // pathology and ambiguous "winner of a winner" chains. Callers should
    // resolve the terminal winner first and merge into that.
    throw new Error(
      `mergeEntities: intoId ${args.intoId} is already merged into ${into.merged_into_id}; merge into the terminal winner instead`,
    );
  }
  const from = db
    .prepare(`SELECT id FROM entities WHERE id = ?`)
    .get(args.fromId) as { id: number } | undefined;
  if (!from) throw new Error(`mergeEntities: fromId ${args.fromId} not found`);
  const now = nowUnixSec();
  db.prepare(`UPDATE entities SET merged_into_id = ?, updated_at = ? WHERE id = ?`).run(args.intoId, now, args.fromId);
}

export interface GetProfileResult {
  entity: EntityRow;
  aliases: Array<{ alias: string; alias_kind: AliasKind; source: string | null }>;
  observations: ObservationRow[];
  linkedBeadIds: number[];
}

/**
 * Merge-aware read helper: collects the winner's id plus every entity merged
 * into it (bounded walk, 5 levels deep). getProfile then unions aliases,
 * observations, and bead refs across all ids — merged-in rows are never
 * rewritten (non-destructive merge), so they must be gathered at read time.
 */
function collectMergedIds(db: DatabaseSync, winnerId: number): number[] {
  const ids = new Set<number>([winnerId]);
  for (let depth = 0; depth < 5; depth++) {
    const current = Array.from(ids);
    const placeholders = current.map(() => '?').join(',');
    const losers = db
      .prepare(`SELECT id FROM entities WHERE merged_into_id IN (${placeholders})`)
      .all(...current) as Array<{ id: number }>;
    let added = false;
    for (const l of losers) {
      if (!ids.has(l.id)) { ids.add(l.id); added = true; }
    }
    if (!added) break;
  }
  return Array.from(ids);
}

export function getProfile(db: DatabaseSync, ref: EntityRef): GetProfileResult | null {
  const entity = resolveEntityRef(db, ref);
  if (!entity) return null;
  const allIds = collectMergedIds(db, entity.id);
  const placeholders = allIds.map(() => '?').join(',');
  const aliases = db.prepare(
    `SELECT alias, alias_kind, source FROM entity_aliases
     WHERE entity_id IN (${placeholders})
     ORDER BY created_at ASC`
  ).all(...allIds) as Array<{ alias: string; alias_kind: AliasKind; source: string | null }>;
  const observations = db.prepare(
    `SELECT o.* FROM entity_observations o
     WHERE o.entity_id IN (${placeholders})
       AND o.forgotten = 0
       AND NOT EXISTS (
         SELECT 1 FROM entity_observations s
         -- QR-040: scope the supersede to the SAME entity so an observation
         -- captured under a DIFFERENT entity cannot hide this one (cross-entity
         -- memory poisoning). A superseder is only valid within its own entity.
         WHERE s.supersedes_observation_id = o.id AND s.forgotten = 0
           AND s.entity_id = o.entity_id
       )
     ORDER BY o.created_at DESC`
  ).all(...allIds) as unknown as ObservationRow[];
  const linkedBeadIds = (db.prepare(
    `SELECT DISTINCT bead_id FROM bead_entity_refs
     WHERE entity_id IN (${placeholders})
     ORDER BY bead_id DESC`
  ).all(...allIds) as Array<{ bead_id: number }>).map(r => r.bead_id);
  return { entity, aliases, observations, linkedBeadIds };
}

export interface ListEntitiesFilter { kind?: EntityKind; textMatch?: string; limit?: number; }

export function listEntities(db: DatabaseSync, f: ListEntitiesFilter = {}): EntityRow[] {
  const w: string[] = ['merged_into_id IS NULL'];
  const b: SQLInputValue[] = [];
  if (f.kind) { w.push('kind = ?'); b.push(f.kind); }
  if (f.textMatch) {
    w.push('LOWER(canonical_name) LIKE ?');
    b.push(`%${f.textMatch.toLowerCase()}%`);
  }
  const sql = `SELECT * FROM entities WHERE ${w.join(' AND ')} ORDER BY canonical_name ASC LIMIT ?`;
  b.push(f.limit ?? 200);
  return db.prepare(sql).all(...b) as unknown as EntityRow[];
}
