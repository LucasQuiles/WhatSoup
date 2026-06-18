import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import {
  upsertEntity, addAlias, captureObservation, forgetObservation,
  mergeEntities, getProfile, listEntities, resolveEntityRef,
} from '../../../src/core/substrate/entities.ts';

function tmpFile() { return join(tmpdir(), `sub-${randomBytes(8).toString('hex')}.db`); }

describe('entities core', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('upsertEntity is idempotent by (kind, canonical_name)', () => {
    const a = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Alex' });
    const b = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Alex' });
    expect(a.id).toBe(b.id);
  });

  it('upsertEntity with contact_jid collapses duplicates to same row', () => {
    const a = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Alex', contactJid: '1@s' });
    const b = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Al',  contactJid: '1@s' });
    expect(b.id).toBe(a.id);
  });

  it('addAlias dedupes', () => {
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Alex' });
    addAlias(db.raw, { entityId: e.id, alias: 'alex-email-token', aliasKind: 'email', source: 'manual' });
    addAlias(db.raw, { entityId: e.id, alias: 'alex-email-token', aliasKind: 'email', source: 'manual' });
    expect(db.raw.prepare('SELECT * FROM entity_aliases WHERE entity_id = ?').all(e.id)).toHaveLength(1);
  });

  it('captureObservation + supersedes', () => {
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Alex' });
    const o1 = captureObservation(db.raw, { entityRef: { entityId: e.id }, kind: 'contact_info', text: 'lives in NYC', confidence: 0.9, sourceKind: 'manual' });
    const o2 = captureObservation(db.raw, { entityRef: { entityId: e.id }, kind: 'contact_info', text: 'lives in SF', confidence: 0.95, sourceKind: 'manual', supersedesObservationId: o1.id });
    const profile = getProfile(db.raw, { entityId: e.id });
    expect(profile?.observations.map(o => o.id)).toEqual([o2.id]);
  });

  it('captureObservation auto-creates entity from canonicalName', () => {
    const o = captureObservation(db.raw, {
      entityRef: { canonicalName: 'Deploy Redo', kind: 'project' },
      kind: 'note', text: 'target Q3', confidence: 0.8, sourceKind: 'manual',
    });
    const rows = db.raw.prepare(`SELECT * FROM entities WHERE canonical_name='Deploy Redo'`).all();
    expect(rows).toHaveLength(1);
    expect(o.entity_id).toBe((rows[0] as { id: number }).id);
  });

  it('forgetObservation tombstones with reason', () => {
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'X' });
    const o = captureObservation(db.raw, { entityRef: { entityId: e.id }, kind: 'fact', text: 'wrong', confidence: 1.0, sourceKind: 'manual' });
    forgetObservation(db.raw, o.id, 'user retract');
    const row = db.raw.prepare('SELECT forgotten, forgotten_reason FROM entity_observations WHERE id = ?').get(o.id) as { forgotten: number; forgotten_reason: string };
    expect(row.forgotten).toBe(1);
    expect(row.forgotten_reason).toBe('user retract');
    expect(getProfile(db.raw, { entityId: e.id })?.observations).toHaveLength(0);
  });

  it('mergeEntities redirects getProfile from loser to winner', () => {
    const a = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Alex A' });
    const b = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Alex B' });
    captureObservation(db.raw, { entityRef: { entityId: a.id }, kind: 'fact', text: 'fact A', confidence: 0.9, sourceKind: 'manual' });
    captureObservation(db.raw, { entityRef: { entityId: b.id }, kind: 'fact', text: 'fact B', confidence: 0.9, sourceKind: 'manual' });
    mergeEntities(db.raw, { fromId: b.id, intoId: a.id });
    const profile = getProfile(db.raw, { entityId: b.id });
    expect(profile?.entity.id).toBe(a.id);
    expect(profile?.observations.length).toBe(2);
  });

  it('resolveEntityRef looks up by contact_jid', () => {
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Z', contactJid: '55@s' });
    expect(resolveEntityRef(db.raw, { contactJid: '55@s' })?.id).toBe(e.id);
  });

  it('listEntities filters by kind + text_match', () => {
    upsertEntity(db.raw, { kind: 'person', canonicalName: 'Alice' });
    upsertEntity(db.raw, { kind: 'person', canonicalName: 'Bob' });
    upsertEntity(db.raw, { kind: 'org',    canonicalName: 'Acme' });
    expect(listEntities(db.raw, { kind: 'person' }).map(e => e.canonical_name).sort()).toEqual(['Alice','Bob']);
    expect(listEntities(db.raw, { textMatch: 'ali' }).map(e => e.canonical_name)).toEqual(['Alice']);
  });

  it('mergeEntities rejects merging into an already-merged entity', () => {
    const a = upsertEntity(db.raw, { kind: 'person', canonicalName: 'A' });
    const b = upsertEntity(db.raw, { kind: 'person', canonicalName: 'B' });
    const c = upsertEntity(db.raw, { kind: 'person', canonicalName: 'C' });
    mergeEntities(db.raw, { fromId: b.id, intoId: a.id });
    expect(() => mergeEntities(db.raw, { fromId: c.id, intoId: b.id })).toThrow(/already merged/i);
  });

  it('resolveEntityRef handles corrupt cycles without infinite loop', () => {
    // Create a pathological cycle via raw SQL (mergeEntities will prevent this
    // after the fix, but if data is corrupted or hand-edited, getProfile must
    // still terminate deterministically).
    const a = upsertEntity(db.raw, { kind: 'person', canonicalName: 'CycleA' });
    const b = upsertEntity(db.raw, { kind: 'person', canonicalName: 'CycleB' });
    db.raw.prepare('UPDATE entities SET merged_into_id = ? WHERE id = ?').run(b.id, a.id);
    db.raw.prepare('UPDATE entities SET merged_into_id = ? WHERE id = ?').run(a.id, b.id);
    const profile = getProfile(db.raw, { entityId: a.id });
    expect(profile).not.toBeNull();
    expect([a.id, b.id]).toContain(profile!.entity.id);
  });
});

describe('entities.ts uncovered-branch coverage', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('resolveEntityRef resolves by group_jid and returns null when absent', () => {
    const e = upsertEntity(db.raw, { kind: 'project', canonicalName: 'Group Proj', groupJid: '1555XXXXXXX-group@s.whatsapp.net' });
    // second upsert with the same group_jid collapses to existing row (line 31)
    const dup = upsertEntity(db.raw, { kind: 'project', canonicalName: 'Dup', groupJid: '1555XXXXXXX-group@s.whatsapp.net' });
    expect(dup.id).toBe(e.id);
    // groupJid lookup branch (line 75)
    const hit = resolveEntityRef(db.raw, { groupJid: '1555XXXXXXX-group@s.whatsapp.net' });
    expect(hit?.id).toBe(e.id);
    // groupJid branch taken but no match -> null
    expect(resolveEntityRef(db.raw, { groupJid: '1555YYYYYYY-group@s.whatsapp.net' })).toBeNull();
  });

  it('resolveEntityRef returns the original row when merged_into_id points at a missing row', () => {
    // line 90 break: row.merged_into_id != null but the referenced row is gone.
    // Disable FK enforcement for this setup so we can leave a dangling pointer.
    const a = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Dangling' });
    db.raw.exec('PRAGMA foreign_keys = OFF');
    db.raw.prepare('UPDATE entities SET merged_into_id = ? WHERE id = ?').run(999999, a.id);
    db.raw.exec('PRAGMA foreign_keys = ON');
    const resolved = resolveEntityRef(db.raw, { entityId: a.id });
    expect(resolved?.id).toBe(a.id);
  });

  it('resolveEntityRef resolves by canonicalName+kind and returns null for empty ref', () => {
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Named One' });
    // canonicalName + kind branch
    expect(resolveEntityRef(db.raw, { canonicalName: 'Named One', kind: 'person' })?.id).toBe(e.id);
    // no discriminator supplied at all -> null (falls through all branches)
    expect(resolveEntityRef(db.raw, {})).toBeNull();
  });

  it('captureObservation throws when entity missing and canonicalName+kind absent', () => {
    // line 108 throw path: entityId points at nothing, no auto-create fields
    expect(() => captureObservation(db.raw, {
      entityRef: { entityId: 999999 },
      kind: 'note', text: 'x', confidence: 0.5, sourceKind: 'manual',
    })).toThrow(/entity not found/);
    // also exercises the contactJid-only miss path inside resolveEntityRef
    expect(() => captureObservation(db.raw, {
      entityRef: { contactJid: '1555ZZZZZZZ@s.whatsapp.net' },
      kind: 'note', text: 'x', confidence: 0.5, sourceKind: 'manual',
    })).toThrow(/entity not found/);
  });

  it('getProfile surfaces linked bead ids across merged entities', () => {
    const winner = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Winner' });
    const loser = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Loser' });
    // Insert a bead row to satisfy FK, then link it to both entities.
    const now = Math.floor(Date.now() / 1000);
    const beadInfo = db.raw.prepare(
      `INSERT INTO beads (kind, status, title, owner_jid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('task', 'active', 'linked bead', '1555OOOOOOO@s.whatsapp.net', now, now);
    const beadId = Number(beadInfo.lastInsertRowid);
    db.raw.prepare(
      `INSERT INTO bead_entity_refs (bead_id, entity_id, role, created_at) VALUES (?, ?, ?, ?)`
    ).run(beadId, winner.id, 'owner', now);
    db.raw.prepare(
      `INSERT INTO bead_entity_refs (bead_id, entity_id, role, created_at) VALUES (?, ?, ?, ?)`
    ).run(beadId, loser.id, 'mentioned', now);
    mergeEntities(db.raw, { fromId: loser.id, intoId: winner.id });
    const profile = getProfile(db.raw, { entityId: winner.id });
    expect(profile?.linkedBeadIds).toEqual([beadId]); // line 212 + dedup
  });

  it('upsertEntity rolls back and rethrows on INSERT failure (invalid kind)', () => {
    // Invalid kind violates the entities CHECK constraint; the catch block runs
    // ROLLBACK (best-effort) then rethrows — covering lines 46-47.
    expect(() => upsertEntity(db.raw, { kind: 'bogus_kind' as never, canonicalName: 'Boom' })).toThrow(/CHECK constraint failed/);
    // DB is still usable after the rollback (transaction was closed).
    const ok = upsertEntity(db.raw, { kind: 'person', canonicalName: 'After Rollback' });
    expect(ok.canonical_name).toBe('After Rollback');
  });

  it('addAlias rethrows non-UNIQUE errors', () => {
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Alias Host' });
    // entity_id has FK + NOT NULL; an invalid entity_id violates FK -> non-UNIQUE error path (line 64).
    expect(() => addAlias(db.raw, { entityId: 999999, alias: 'orphan', aliasKind: 'nickname', source: 'manual' })).toThrow(/FOREIGN KEY constraint failed/);
    // sanity: the failed insert did not create a row
    expect(db.raw.prepare('SELECT * FROM entity_aliases WHERE alias = ?').all('orphan')).toEqual([]);
  });

  it('mergeEntities rejects self-merge and missing intoId/fromId', () => {
    const a = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Solo' });
    // self-merge (line 137)
    expect(() => mergeEntities(db.raw, { fromId: a.id, intoId: a.id })).toThrow(/cannot merge into self/);
    // intoId not found (line 141)
    expect(() => mergeEntities(db.raw, { fromId: a.id, intoId: 999999 })).toThrow(/not found/);
    // fromId not found (line 153)
    expect(() => mergeEntities(db.raw, { fromId: 999998, intoId: a.id })).toThrow(/not found/);
  });

  it('upsertEntity merges by canonicalName when jids are absent and preserves metadata', () => {
    const a = upsertEntity(db.raw, { kind: 'org', canonicalName: 'Acme Corp', metadata: { tier: 'gold' } });
    const b = upsertEntity(db.raw, { kind: 'org', canonicalName: 'Acme Corp' });
    expect(b.id).toBe(a.id); // byName branch (line 33-36)
    // metadata persisted to the existing row
    const meta = db.raw.prepare('SELECT metadata_json FROM entities WHERE id = ?').get(a.id) as { metadata_json: string };
    expect(JSON.parse(meta.metadata_json)).toMatchObject({ tier: 'gold' });
  });

  it('listEntities applies default limit and orders by canonical_name', () => {
    upsertEntity(db.raw, { kind: 'person', canonicalName: 'Zara' });
    upsertEntity(db.raw, { kind: 'person', canonicalName: 'Amy' });
    const all = listEntities(db.raw, {});
    expect(all.map(e => e.canonical_name)).toEqual(['Amy', 'Zara']); // default-limit branch
    // explicit limit truncates
    expect(listEntities(db.raw, { limit: 1 })).toHaveLength(1);
  });

  it('getProfile returns null for an unresolved entity ref', () => {
    // line 190 branch
    expect(getProfile(db.raw, { entityId: 888888 })).toBeNull();
  });

  it('addAlias defaults source to null when omitted', () => {
    // line 62 `args.source ?? null`
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'Sourceless' });
    addAlias(db.raw, { entityId: e.id, alias: 'nick', aliasKind: 'nickname' });
    const row = db.raw.prepare('SELECT source FROM entity_aliases WHERE entity_id = ?').get(e.id) as { source: string | null };
    expect(row).toEqual({ source: null });
  });
});
