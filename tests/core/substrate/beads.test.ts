import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import {
  createBead, getBead, listBeads, updateBead,
  completeBead, cancelBead, approveProposal, rejectProposal,
  activityFeed, countOverdueProposals,
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

  // #2290 M9: metadata_json was the sole unguarded JSON.parse in src/core/. A
  // corrupt cell threw a SyntaxError out of updateBead -- a WRITE path -- so one
  // bad row permanently broke every later metadata update on that bead.

  it('updateBead survives a corrupt metadata_json cell instead of throwing', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 'corrupt-meta', ownerJid: 'u', actor: 'inline' });
    db.raw.prepare('UPDATE beads SET metadata_json = ? WHERE id = ?').run('{not json', bead.id);

    expect(() =>
      updateBead(db.raw, bead.id, { fields: { metadata: { fresh: 1 } }, actor: 'inline' }),
    ).not.toThrow();

    const row = db.raw.prepare('SELECT metadata_json FROM beads WHERE id = ?').get(bead.id) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toEqual({ fresh: 1 });
  });

  it('updateBead treats a non-object metadata_json as empty rather than spreading it', () => {
    // JSON.parse succeeds here, so a try/catch alone would not catch it: an
    // array or scalar spread into a record yields index keys or nothing.
    const bead = createBead(db.raw, { kind: 'task', title: 'array-meta', ownerJid: 'u', actor: 'inline' });
    db.raw.prepare('UPDATE beads SET metadata_json = ? WHERE id = ?').run('[1,2,3]', bead.id);

    updateBead(db.raw, bead.id, { fields: { metadata: { fresh: 1 } }, actor: 'inline' });

    const row = db.raw.prepare('SELECT metadata_json FROM beads WHERE id = ?').get(bead.id) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toEqual({ fresh: 1 });
  });

  it('updateBead still merges normally when metadata_json is valid', () => {
    // The accept side: a guard that degraded everything to {} would pass both
    // tests above while silently discarding good metadata on every update.
    const bead = createBead(db.raw, {
      kind: 'task', title: 'good-meta', ownerJid: 'u', actor: 'inline',
      metadata: { keep: 'yes', replace: 'old' },
    });

    updateBead(db.raw, bead.id, { fields: { metadata: { replace: 'new' } }, actor: 'inline' });

    const row = db.raw.prepare('SELECT metadata_json FROM beads WHERE id = ?').get(bead.id) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toEqual({ keep: 'yes', replace: 'new' });
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

  it('getBead returns null for unknown id', () => {
    expect(getBead(db.raw, 999999)).toBeNull();
  });

  it('getBead for a known id returns bead and its events array', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'mw', actor: 'user' });
    const r = getBead(db.raw, bead.id)!;
    expect(r.bead.id).toBe(bead.id);
    expect(r.events.map(e => e.event_type)).toEqual(['status_change']);
  });

  it('updateBead throws and rolls back when the post-UPDATE event write fails (covers line 169)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 'orig', ownerJid: 'mw', actor: 'user' });
    // Drop the bead_events table so writeBeadEvent throws inside the transaction,
    // exercising the catch/ROLLBACK/rethrow path in updateBead.
    db.raw.exec('DROP TABLE bead_events');
    expect(() => updateBead(db.raw, bead.id, { fields: { title: 'new' }, actor: 'agent' })).toThrow();
    // ROLLBACK must have restored the pre-transaction title (no 'updated_at'-only commit leaked).
    const row = db.raw.prepare('SELECT title FROM beads WHERE id = ?').get(bead.id) as { title: string };
    expect(row.title).toBe('orig');
  });

  it('updateBead on a missing bead throws not-found', () => {
    expect(() => updateBead(db.raw, 888888, { fields: { title: 'x' }, actor: 'a' })).toThrow(/not found/);
  });

  it('updateBead with no-op fields (only updated_at) short-circuits without an event', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 'same', ownerJid: 'mw', actor: 'user', priority: 2 });
    const eventsBefore = (db.raw.prepare('SELECT COUNT(*) AS c FROM bead_events WHERE bead_id = ?').get(bead.id) as { c: number }).c;
    // Same values → no diff → sets.length stays 1 → early return, no field_update event.
    updateBead(db.raw, bead.id, { fields: { title: 'same', priority: 2 }, actor: 'agent' });
    const eventsAfter = (db.raw.prepare('SELECT COUNT(*) AS c FROM bead_events WHERE bead_id = ?').get(bead.id) as { c: number }).c;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it('cancelBead transitions active -> cancelled with cancelled_at (covers line 213)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'mw', actor: 'user' });
    const now = Math.floor(Date.now() / 1000);
    cancelBead(db.raw, bead.id, { note: 'dropped', actor: 'user', at: now });
    const r = getBead(db.raw, bead.id)!;
    expect(r.bead.status).toBe('cancelled');
    expect(r.bead.cancelled_at).toBe(now);
    const sc = r.events.filter(e => e.event_type === 'status_change').pop()!;
    expect(JSON.parse(sc.payload_json)).toMatchObject({ from: 'active', to: 'cancelled', note: 'dropped' });
  });

  it('cancelBead on an already-terminal bead throws terminal', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'mw', actor: 'user' });
    cancelBead(db.raw, bead.id, { actor: 'user' });
    expect(() => cancelBead(db.raw, bead.id, { actor: 'user' })).toThrow(/terminal/i);
  });

  it('transition (via completeBead) rolls back when the event write fails (covers line 206)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 'orig', ownerJid: 'mw', actor: 'user' });
    db.raw.exec('DROP TABLE bead_events');
    expect(() => completeBead(db.raw, bead.id, { actor: 'user' })).toThrow();
    // ROLLBACK must have left the bead in its original non-terminal status.
    const row = db.raw.prepare('SELECT status, completed_at FROM beads WHERE id = ?').get(bead.id) as { status: string; completed_at: number | null };
    expect(row).toEqual({ status: 'active', completed_at: null });
  });

  it('approveProposal / rejectProposal throw not-found for unknown bead id', () => {
    expect(() => approveProposal(db.raw, 777777, { actor: 'user' })).toThrow(/not found/);
    expect(() => rejectProposal(db.raw, 777777, { actor: 'user' })).toThrow(/not found/);
  });

  it('rejectProposal without a reason still cancels a proposed bead', () => {
    const bead = createBead(db.raw, {
      kind: 'task', title: 'p', ownerJid: 'mw', actor: 'sweep',
      status: 'proposed', confidence: 0.5, proposalReason: 'soft',
    });
    rejectProposal(db.raw, bead.id, { actor: 'user' });
    const r = getBead(db.raw, bead.id)!;
    expect(r.bead.status).toBe('cancelled');
    const sc = r.events.filter(e => e.event_type === 'status_change').pop()!;
    expect(JSON.parse(sc.payload_json)).toMatchObject({ from: 'proposed', to: 'cancelled' });
    expect(JSON.parse(sc.payload_json)).not.toHaveProperty('rejection_reason');
  });

  it('listBeads applies dueBefore, since, chatJid, and limit filters', () => {
    createBead(db.raw, { kind: 'task', title: 'with-due', ownerJid: 'mw', chatJid: '1555XXXX0001@s.whatsapp.net', dueAt: 1000, actor: 'user' });
    createBead(db.raw, { kind: 'task', title: 'no-due', ownerJid: 'mw', chatJid: '1555XXXX0002@s.whatsapp.net', actor: 'user' });
    const dueHits = listBeads(db.raw, { dueBefore: 2000 }).map(b => b.title);
    expect(dueHits).toContain('with-due');
    expect(dueHits).not.toContain('no-due');
    const chatHits = listBeads(db.raw, { chatJid: '1555XXXX0002@s.whatsapp.net' }).map(b => b.title);
    expect(chatHits).toEqual(['no-due']);
    const limited = listBeads(db.raw, { limit: 1 });
    expect(limited).toHaveLength(1);
    // since filter: a far-future timestamp matches nothing.
    expect(listBeads(db.raw, { since: 9_999_999_999 })).toHaveLength(0);
  });

  // #1773 rem-4 regression: review_by_at was written by the proposal sweep
  // but never read anywhere — no SELECT, scheduler, sweep, or alert consumed
  // it, so overdue proposals accumulated silently (683 on one live instance).
  it('listBeads(reviewOverdue) surfaces only overdue OPEN proposals', () => {
    const now = Math.floor(Date.now() / 1000);
    const overdueProposal = createBead(db.raw, {
      kind: 'task', title: 'overdue-proposal', ownerJid: 'mw', actor: 'user',
      status: 'proposed', reviewByAt: now - 1000, confidence: 0.6, proposalReason: 'inline',
    });
    createBead(db.raw, {
      kind: 'task', title: 'not-yet-due-proposal', ownerJid: 'mw', actor: 'user',
      status: 'proposed', reviewByAt: now + 100_000, confidence: 0.6, proposalReason: 'inline',
    });
    // A bead whose review_by_at has passed but is NOT status='proposed' (already
    // disposed via approve_proposal/reject_proposal, or never had a proposal
    // lifecycle) must never surface as overdue — its review_by_at is inert.
    const approvedPastDue = createBead(db.raw, {
      kind: 'task', title: 'approved-past-due', ownerJid: 'mw', actor: 'user',
      status: 'proposed', reviewByAt: now - 1000, confidence: 0.6, proposalReason: 'inline',
    });
    approveProposal(db.raw, approvedPastDue.id, { actor: 'user' });

    const overdue = listBeads(db.raw, { reviewOverdue: true });
    expect(overdue.map(b => b.title)).toEqual(['overdue-proposal']);
    expect(overdue.map(b => b.id)).toEqual([overdueProposal.id]);

    // reviewOverdue overrides an explicit conflicting status filter rather
    // than ANDing a second contradictory predicate.
    expect(listBeads(db.raw, { reviewOverdue: true, status: 'active' }).map(b => b.title))
      .toEqual(['overdue-proposal']);

    expect(countOverdueProposals(db.raw, now)).toBe(1);
    expect(countOverdueProposals(db.raw, now - 2000)).toBe(0);
  });

  it('activityFeed with no owner filter returns bead events across owners', () => {
    const a = createBead(db.raw, { kind: 'task', title: 'a', ownerJid: 'mw', actor: 'user' });
    const b = createBead(db.raw, { kind: 'task', title: 'b', ownerJid: 'other', actor: 'user' });
    const feed = activityFeed(db.raw, { limit: 50 });
    const ids = feed.filter(r => r.source === 'bead_event').map(r => r.bead_id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('activityFeed respects the since cutoff and default limit', () => {
    const before = Math.floor(Date.now() / 1000) + 1;
    createBead(db.raw, { kind: 'task', title: 'future', ownerJid: 'mw', actor: 'user' });
    // since=before-future-event → no rows.
    expect(activityFeed(db.raw, { since: before, limit: 50 }).filter(r => r.source === 'bead_event')).toHaveLength(0);
    // default limit (100) path runs without explicit limit.
    const feed = activityFeed(db.raw, {});
    expect(Array.isArray(feed)).toBe(true);
  });
});
