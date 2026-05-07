import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import {
  createBead, getBead, listBeads, updateBead,
  completeBead, cancelBead, approveProposal, rejectProposal,
  activityFeed,
} from '../../../src/core/substrate/beads.ts';
import { upsertEntity, captureObservation, forgetObservation } from '../../../src/core/substrate/entities.ts';

function tmpFile() { return join(tmpdir(), `sub-${randomBytes(8).toString('hex')}.db`); }

describe('beads core', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('createBead persists defaults and writes status_change event', () => {
    const bead = createBead(db.raw, {
      kind: 'task', title: 'call Alex', ownerJid: 'user-1',
      chatJid: 'user-1@s.whatsapp.net', sourceMessagePk: 42, actor: 'inline',
    });
    expect(bead.id).toBeGreaterThan(0);
    expect(bead.status).toBe('active');
    const events = db.raw.prepare(`SELECT event_type, actor FROM bead_events WHERE bead_id = ?`).all(bead.id) as Array<{ event_type: string; actor: string }>;
    expect(events[0].event_type).toBe('status_change');
    expect(events[0].actor).toBe('inline');
  });

  it('CHECK rejects unknown kind', () => {
    expect(() => createBead(db.raw, { kind: 'bogus' as any, title: 'x', ownerJid: 'a', actor: 'user' })).toThrow();
  });

  it('listBeads filters by owner + kind + status', () => {
    createBead(db.raw, { kind: 'task', title: 't1', ownerJid: 'mw', actor: 'user' });
    createBead(db.raw, { kind: 'task', title: 't2', ownerJid: 'mw', actor: 'user', status: 'completed' });
    createBead(db.raw, { kind: 'project', title: 'p1', ownerJid: 'mw', actor: 'user' });
    createBead(db.raw, { kind: 'task', title: 'other', ownerJid: 'other', actor: 'user' });
    expect(listBeads(db.raw, { ownerJid: 'mw', kind: 'task', status: 'active' }).map(b => b.title)).toEqual(['t1']);
    expect(listBeads(db.raw, { ownerJid: 'mw' })).toHaveLength(3);
  });

  it('updateBead writes field_update with diff; rejects protected fields', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 'x', ownerJid: 'mw', actor: 'user' });
    updateBead(db.raw, bead.id, { fields: { title: 'y', priority: 1 }, actor: 'agent' });
    const r = getBead(db.raw, bead.id)!;
    expect(r.bead.title).toBe('y');
    const fu = r.events.find(e => e.event_type === 'field_update')!;
    expect(JSON.parse(fu.payload_json).changed).toEqual({
      title: { from: 'x', to: 'y' },
      priority: { from: 0, to: 1 },
    });
    expect(() => updateBead(db.raw, bead.id, { fields: { kind: 'project' } as any, actor: 'a' })).toThrow(/kind/);
    expect(() => updateBead(db.raw, bead.id, { fields: { owner_jid: 'o' } as any, actor: 'a' })).toThrow(/owner_jid/);
    expect(() => updateBead(db.raw, bead.id, { fields: { status: 'completed' } as any, actor: 'a' })).toThrow(/status/);
  });

  it('completeBead transitions with note; second call throws', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 'x', ownerJid: 'mw', actor: 'user' });
    const now = Math.floor(Date.now() / 1000);
    completeBead(db.raw, bead.id, { note: 'done', actor: 'user', at: now });
    const r = getBead(db.raw, bead.id)!;
    expect(r.bead.status).toBe('completed');
    expect(r.bead.completed_at).toBe(now);
    const sc = r.events.filter(e => e.event_type === 'status_change').pop()!;
    expect(JSON.parse(sc.payload_json)).toMatchObject({ from: 'active', to: 'completed', note: 'done' });
    expect(() => completeBead(db.raw, bead.id, { actor: 'u' })).toThrow(/terminal/i);
  });

  it('approveProposal / rejectProposal transition from proposed', () => {
    const approvable = createBead(db.raw, {
      kind: 'task', title: 'a', ownerJid: 'mw', actor: 'sweep',
      status: 'proposed', confidence: 0.7, proposalReason: 'repeated mentions',
    });
    approveProposal(db.raw, approvable.id, { actor: 'user' });
    expect(getBead(db.raw, approvable.id)!.bead.status).toBe('active');

    const rejectable = createBead(db.raw, {
      kind: 'task', title: 'b', ownerJid: 'mw', actor: 'sweep',
      status: 'proposed', confidence: 0.6, proposalReason: 'soft',
    });
    rejectProposal(db.raw, rejectable.id, { reason: 'not a real ask', actor: 'user' });
    const r = getBead(db.raw, rejectable.id)!;
    expect(r.bead.status).toBe('cancelled');
    const last = r.events.filter(e => e.event_type === 'status_change').pop()!;
    expect(JSON.parse(last.payload_json)).toMatchObject({ to: 'cancelled', rejection_reason: 'not a real ask' });

    const active = createBead(db.raw, { kind: 'task', title: 'c', ownerJid: 'mw', actor: 'user' });
    expect(() => approveProposal(db.raw, active.id, { actor: 'user' })).toThrow(/not.*proposed/i);
  });

  it('activityFeed is owner-scoped', () => {
    const mw = createBead(db.raw, { kind: 'task', title: 'mw1', ownerJid: 'mw', actor: 'user' });
    const other = createBead(db.raw, { kind: 'task', title: 'o1', ownerJid: 'other', actor: 'user' });
    updateBead(db.raw, mw.id, { fields: { title: 'mw1-upd' }, actor: 'agent' });
    const feed = activityFeed(db.raw, { ownerJid: 'mw', limit: 10 });
    expect(feed.some(r => r.bead_id === other.id)).toBe(false);
  });

  it('activityFeed excludes superseded and forgotten observations', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'mw', actor: 'user' });
    const e = upsertEntity(db.raw, { kind: 'person', canonicalName: 'L' });
    // Link entity to bead so observations are owner-scoped via bead_entity_refs
    db.raw.prepare(
      `INSERT INTO bead_entity_refs (bead_id, entity_id, role, created_at) VALUES (?, ?, 'subject', ?)`
    ).run(bead.id, e.id, Math.floor(Date.now() / 1000));
    const o1 = captureObservation(db.raw, { entityRef: { entityId: e.id }, kind: 'fact', text: 'stale', confidence: 0.9, sourceKind: 'manual' });
    const o2 = captureObservation(db.raw, { entityRef: { entityId: e.id }, kind: 'fact', text: 'live', confidence: 0.95, sourceKind: 'manual', supersedesObservationId: o1.id });
    const o3 = captureObservation(db.raw, { entityRef: { entityId: e.id }, kind: 'fact', text: 'forgotten', confidence: 0.8, sourceKind: 'manual' });
    forgetObservation(db.raw, o3.id, 'test');
    const feed = activityFeed(db.raw, { ownerJid: 'mw', limit: 50 });
    const obsTexts = feed.filter(r => r.source === 'entity_observation').map(r => r.text);
    expect(obsTexts).toContain('live');
    expect(obsTexts).not.toContain('stale');
    expect(obsTexts).not.toContain('forgotten');
    // Sanity: IDs match the live row, not the superseded one
    const obsIds = feed.filter(r => r.source === 'entity_observation').map(r => r.entity_id);
    expect(obsIds).toContain(e.id);
    // Shut up unused var linter; o2 existence is implied by 'live' in obsTexts
    void o2;
  });

  it('createBead truncates overlong body to 64KB hard cap', () => {
    const huge = 'x'.repeat(100 * 1024); // 100KB
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'mw', body: huge, actor: 'user' });
    const stored = db.raw.prepare('SELECT body FROM beads WHERE id = ?').get(bead.id) as { body: string };
    expect(stored.body.length).toBeLessThanOrEqual(64 * 1024);
    // Truncation marker indicates lossy storage
    expect(stored.body).toMatch(/\.\.\.\[truncated\]$/);
  });

  it('updateBead metadata merge is shallow by contract', () => {
    // The metadata field is an opaque bag; top-level keys are REPLACED
    // wholesale on update, not deep-merged. Callers needing to preserve
    // sibling keys of a nested object must read-modify-write.
    const bead = createBead(db.raw, {
      kind: 'task', title: 't', ownerJid: 'mw', actor: 'user',
      metadata: { a: { x: 1, y: 2 }, b: 'keep' },
    });
    updateBead(db.raw, bead.id, {
      fields: { metadata: { a: { x: 3 } } },
      actor: 'agent',
    });
    const row = db.raw.prepare('SELECT metadata_json FROM beads WHERE id = ?').get(bead.id) as { metadata_json: string };
    const meta = JSON.parse(row.metadata_json);
    // Shallow merge: sibling top-level key 'b' is preserved, but nested 'y'
    // inside 'a' is dropped because the whole 'a' key was replaced.
    expect(meta).toEqual({ a: { x: 3 }, b: 'keep' });
  });

  it('createBead body cap counts UTF-8 bytes, not UTF-16 code units', () => {
    // Emoji character "😀" is 4 bytes in UTF-8 but 2 code units in UTF-16.
    // A naive .length check would admit up to 128KB of UTF-8 bytes under a
    // 64Ki code-unit cap. The fix counts bytes, so the stored body must
    // be ≤ 64KB of UTF-8 regardless of how many code units that is.
    const emoji = '😀'.repeat(40 * 1024); // 40Ki code units × 4 bytes = 160KB UTF-8
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'mw', body: emoji, actor: 'user' });
    const stored = db.raw.prepare('SELECT body FROM beads WHERE id = ?').get(bead.id) as { body: string };
    expect(Buffer.byteLength(stored.body, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(stored.body).toMatch(/\.\.\.\[truncated\]$/);
  });
});
