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
