import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import {
  createBead, getBead, listBeads, updateBead,
  completeBead, cancelBead, approveProposal, rejectProposal,
  activityFeed, countOverdueProposals, assertMutableBeadFields,
} from '../../../src/core/substrate/beads.ts';
import { upsertEntity, captureObservation, forgetObservation } from '../../../src/core/substrate/entities.ts';

function tmpFile() { return join(tmpdir(), `sub-${randomBytes(8).toString('hex')}.db`); }

describe('beads branch coverage — uncovered arms', () => {
  let path: string;
  let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  // ─────────────────────────────────────────────────────────────────────────
  // getBead null/notfound paths
  // ─────────────────────────────────────────────────────────────────────────

  it('getBead with bead found returns bead and ordered events', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    updateBead(db.raw, bead.id, { fields: { title: 'updated' }, actor: 'u' });
    const result = getBead(db.raw, bead.id);
    expect(result).not.toBeNull();
    expect(result!.bead.id).toBe(bead.id);
    expect(result!.events).toHaveLength(2);
    expect(result!.events[0].event_type).toBe('status_change');
    expect(result!.events[1].event_type).toBe('field_update');
    expect(result!.events[0].id).toBeLessThan(result!.events[1].id);
  });

  it('getBead null-coalesces bead lookup (path 90-91)', () => {
    const notFound = getBead(db.raw, 99999);
    expect(notFound).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // listBeads: filter arms (chatJid, dueBefore, since, reviewOverdue)
  // ─────────────────────────────────────────────────────────────────────────

  it('listBeads chatJid filter arm (path 133)', () => {
    createBead(db.raw, { kind: 'task', title: 't1', ownerJid: 'o', chatJid: '12036355555555NNNNA001@g.us', actor: 'u' });
    createBead(db.raw, { kind: 'task', title: 't2', ownerJid: 'o', chatJid: '12036355555555NNNNA002@g.us', actor: 'u' });
    createBead(db.raw, { kind: 'task', title: 't3', ownerJid: 'o', actor: 'u' });
    const hits = listBeads(db.raw, { chatJid: '12036355555555NNNNA001@g.us' });
    expect(hits.map(b => b.title)).toEqual(['t1']);
  });

  it('listBeads dueBefore null-check branch (path 134)', () => {
    const now = Math.floor(Date.now() / 1000);
    createBead(db.raw, { kind: 'task', title: 'due-soon', ownerJid: 'o', dueAt: now + 100, actor: 'u' });
    createBead(db.raw, { kind: 'task', title: 'overdue', ownerJid: 'o', dueAt: now - 1000, actor: 'u' });
    createBead(db.raw, { kind: 'task', title: 'no-due', ownerJid: 'o', actor: 'u' });
    const before = listBeads(db.raw, { dueBefore: now });
    expect(before.map(b => b.title)).toContain('overdue');
    expect(before.map(b => b.title)).not.toContain('due-soon');
    expect(before.map(b => b.title)).not.toContain('no-due');
  });

  it('listBeads since null-check branch (path 135)', () => {
    const now = Math.floor(Date.now() / 1000);
    const b1 = createBead(db.raw, { kind: 'task', title: 'old', ownerJid: 'o', actor: 'u' });
    db.raw.prepare('UPDATE beads SET updated_at = ? WHERE id = ?').run(now - 10000, b1.id);
    const b2 = createBead(db.raw, { kind: 'task', title: 'new', ownerJid: 'o', actor: 'u' });
    const recent = listBeads(db.raw, { since: now - 5000 });
    expect(recent.map(b => b.title)).toContain('new');
    expect(recent.map(b => b.title)).not.toContain('old');
  });

  it('listBeads reviewOverdue true path (128-129): surfaces overdue proposed', () => {
    const now = Math.floor(Date.now() / 1000);
    createBead(db.raw, {
      kind: 'task', title: 'overdueProposal', ownerJid: 'o', status: 'proposed',
      reviewByAt: now - 1000, confidence: 0.5, proposalReason: 'test', actor: 'u',
    });
    createBead(db.raw, {
      kind: 'task', title: 'notYetDue', ownerJid: 'o', status: 'proposed',
      reviewByAt: now + 100000, confidence: 0.5, proposalReason: 'test', actor: 'u',
    });
    createBead(db.raw, { kind: 'task', title: 'active', ownerJid: 'o', status: 'active', actor: 'u' });
    const overdue = listBeads(db.raw, { reviewOverdue: true });
    expect(overdue.map(b => b.title)).toEqual(['overdueProposal']);
  });

  it('listBeads reviewOverdue overrides status filter (130-131: else branch)', () => {
    const now = Math.floor(Date.now() / 1000);
    const overdue = createBead(db.raw, {
      kind: 'task', title: 'p', ownerJid: 'o', status: 'proposed',
      reviewByAt: now - 100, confidence: 0.5, proposalReason: 'test', actor: 'u',
    });
    const result = listBeads(db.raw, { reviewOverdue: true, status: 'active' });
    expect(result.map(b => b.id)).toContain(overdue.id);
  });

  it('listBeads ownerJid filter arm (path 126)', () => {
    createBead(db.raw, { kind: 'task', title: 'mw', ownerJid: 'mw', actor: 'u' });
    createBead(db.raw, { kind: 'task', title: 'other', ownerJid: 'other', actor: 'u' });
    const mwOnly = listBeads(db.raw, { ownerJid: 'mw' });
    expect(mwOnly.map(b => b.title)).toEqual(['mw']);
  });

  it('listBeads kind filter arm (path 127)', () => {
    createBead(db.raw, { kind: 'task', title: 'task1', ownerJid: 'o', actor: 'u' });
    createBead(db.raw, { kind: 'project', title: 'proj1', ownerJid: 'o', actor: 'u' });
    const tasks = listBeads(db.raw, { kind: 'task' });
    expect(tasks.map(b => b.title)).toEqual(['task1']);
  });

  it('listBeads status filter arm (path 130-131: else branch, no reviewOverdue)', () => {
    createBead(db.raw, { kind: 'task', title: 'active-t', ownerJid: 'o', status: 'active', actor: 'u' });
    createBead(db.raw, { kind: 'task', title: 'proposed-t', ownerJid: 'o', status: 'proposed', confidence: 0.5, proposalReason: 'test', actor: 'u' });
    const active = listBeads(db.raw, { status: 'active' });
    expect(active.map(b => b.title)).toEqual(['active-t']);
  });

  it('listBeads builds correct SQL with multiple filters', () => {
    const now = Math.floor(Date.now() / 1000);
    const b1 = createBead(db.raw, {
      kind: 'task', title: 't1', ownerJid: 'o', chatJid: '12036355555555NNNNA001@g.us',
      dueAt: now - 500, status: 'active', actor: 'u',
    });
    createBead(db.raw, {
      kind: 'task', title: 't2', ownerJid: 'o', chatJid: '12036355555555NNNNA001@g.us',
      dueAt: now + 1000, status: 'active', actor: 'u',
    });
    createBead(db.raw, {
      kind: 'project', title: 't3', ownerJid: 'o', chatJid: '12036355555555NNNNA001@g.us',
      dueAt: now - 500, status: 'active', actor: 'u',
    });
    const result = listBeads(db.raw, {
      ownerJid: 'o', kind: 'task', status: 'active',
      chatJid: '12036355555555NNNNA001@g.us', dueBefore: now,
    });
    expect(result.map(b => b.id)).toEqual([b1.id]);
  });

  it('listBeads respects default limit when not specified (path 138)', () => {
    for (let i = 0; i < 210; i++) {
      createBead(db.raw, { kind: 'task', title: `t${i}`, ownerJid: 'o', actor: 'u' });
    }
    const result = listBeads(db.raw, {});
    expect(result).toHaveLength(200);
  });

  it('listBeads respects custom limit (path 138)', () => {
    for (let i = 0; i < 50; i++) {
      createBead(db.raw, { kind: 'task', title: `t${i}`, ownerJid: 'o', actor: 'u' });
    }
    const result = listBeads(db.raw, { limit: 10 });
    expect(result).toHaveLength(10);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // updateBead: missing/body-clamp/transition arms
  // ─────────────────────────────────────────────────────────────────────────

  it('updateBead missing bead throws (path 166)', () => {
    expect(() => updateBead(db.raw, 99999, { fields: { title: 'x' }, actor: 'u' })).toThrow(/not found/);
  });

  it('updateBead body clamping arm (path 176)', () => {
    const huge = 'x'.repeat(100 * 1024);
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    updateBead(db.raw, bead.id, { fields: { body: huge }, actor: 'u' });
    const row = db.raw.prepare('SELECT body FROM beads WHERE id = ?').get(bead.id) as { body: string };
    expect(Buffer.byteLength(row.body, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(row.body).toMatch(/\.\.\.\[truncated\]$/);
  });

  it('updateBead field change detection (178: next !== prev)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 'x', ownerJid: 'o', priority: 0, actor: 'u' });
    updateBead(db.raw, bead.id, { fields: { title: 'y', priority: 1 }, actor: 'u' });
    const r = getBead(db.raw, bead.id)!;
    const fu = r.events.find(e => e.event_type === 'field_update')!;
    const changed = JSON.parse(fu.payload_json).changed;
    expect(changed.title).toEqual({ from: 'x', to: 'y' });
    expect(changed.priority).toEqual({ from: 0, to: 1 });
  });

  it('updateBead no-op same field values short-circuits (path 201)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 'same', ownerJid: 'o', priority: 2, body: 'content', actor: 'u' });
    const eventsBefore = (db.raw.prepare('SELECT COUNT(*) AS c FROM bead_events WHERE bead_id = ?').get(bead.id) as { c: number }).c;
    updateBead(db.raw, bead.id, { fields: { title: 'same', priority: 2, body: 'content' }, actor: 'u' });
    const eventsAfter = (db.raw.prepare('SELECT COUNT(*) AS c FROM bead_events WHERE bead_id = ?').get(bead.id) as { c: number }).c;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it('updateBead metadata merge shallow (194-199)', () => {
    const bead = createBead(db.raw, {
      kind: 'task', title: 't', ownerJid: 'o', actor: 'u',
      metadata: { a: { x: 1, y: 2 }, b: 'keep' },
    });
    updateBead(db.raw, bead.id, { fields: { metadata: { a: { x: 3 } } }, actor: 'u' });
    const row = db.raw.prepare('SELECT metadata_json FROM beads WHERE id = ?').get(bead.id) as { metadata_json: string };
    const merged = JSON.parse(row.metadata_json);
    expect(merged).toEqual({ a: { x: 3 }, b: 'keep' });
  });

  it('updateBead metadata no-op (196: next === current.metadata_json)', () => {
    const bead = createBead(db.raw, {
      kind: 'task', title: 't', ownerJid: 'o', actor: 'u',
      metadata: { a: 1 },
    });
    const eventsBefore = (db.raw.prepare('SELECT COUNT(*) AS c FROM bead_events WHERE bead_id = ?').get(bead.id) as { c: number }).c;
    updateBead(db.raw, bead.id, { fields: { metadata: { a: 1 } }, actor: 'u' });
    const eventsAfter = (db.raw.prepare('SELECT COUNT(*) AS c FROM bead_events WHERE bead_id = ?').get(bead.id) as { c: number }).c;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it('updateBead metadata change triggers event (197-199)', () => {
    const bead = createBead(db.raw, {
      kind: 'task', title: 't', ownerJid: 'o', actor: 'u',
      metadata: { a: 1 },
    });
    updateBead(db.raw, bead.id, { fields: { metadata: { a: 2 } }, actor: 'u' });
    const r = getBead(db.raw, bead.id)!;
    const fu = r.events.find(e => e.event_type === 'field_update')!;
    const changed = JSON.parse(fu.payload_json).changed;
    expect(changed.metadata).toEqual({ from: { a: 1 }, to: { a: 2 } });
  });

  it('updateBead transaction rollback on write failure (207)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 'orig', ownerJid: 'o', actor: 'u' });
    db.raw.exec('DROP TABLE bead_events');
    expect(() => updateBead(db.raw, bead.id, { fields: { title: 'new' }, actor: 'u' })).toThrow();
    const row = db.raw.prepare('SELECT title FROM beads WHERE id = ?').get(bead.id) as { title: string };
    expect(row.title).toBe('orig');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // transition / completeBead / cancelBead: guard arms
  // ─────────────────────────────────────────────────────────────────────────

  it('transition missing bead throws (218: !current)', () => {
    expect(() => completeBead(db.raw, 99999, { actor: 'u' })).toThrow(/not found/);
  });

  it('transition terminal check rejects (path 219-220)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    completeBead(db.raw, bead.id, { actor: 'u' });
    expect(() => completeBead(db.raw, bead.id, { actor: 'u' })).toThrow(/terminal/);
    expect(() => cancelBead(db.raw, bead.id, { actor: 'u' })).toThrow(/terminal/);
  });

  it('transition completed sets completed_at (228)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    const now = Math.floor(Date.now() / 1000);
    completeBead(db.raw, bead.id, { actor: 'u', at: now });
    const r = getBead(db.raw, bead.id)!;
    expect(r.bead.completed_at).toBe(now);
  });

  it('transition cancelled sets cancelled_at (229)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    const now = Math.floor(Date.now() / 1000);
    cancelBead(db.raw, bead.id, { actor: 'u', at: now });
    const r = getBead(db.raw, bead.id)!;
    expect(r.bead.cancelled_at).toBe(now);
  });

  it('transition uses provided at time, falls back to nowUnixSec (225)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    const specificTime = Math.floor(Date.now() / 1000) - 10000;
    completeBead(db.raw, bead.id, { actor: 'u', at: specificTime });
    const r = getBead(db.raw, bead.id)!;
    expect(r.bead.completed_at).toBe(specificTime);
  });

  it('transition note conditionally included in payload (238)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    completeBead(db.raw, bead.id, { actor: 'u', note: 'done!' });
    const r = getBead(db.raw, bead.id)!;
    const sc = r.events.filter(e => e.event_type === 'status_change').pop()!;
    expect(JSON.parse(sc.payload_json)).toHaveProperty('note', 'done!');
  });

  it('transition reason conditionally included in payload (239)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    cancelBead(db.raw, bead.id, { actor: 'u', reason: 'not needed' });
    const r = getBead(db.raw, bead.id)!;
    const sc = r.events.filter(e => e.event_type === 'status_change').pop()!;
    const payload = JSON.parse(sc.payload_json);
    expect(payload).toHaveProperty('reason', 'not needed');
  });

  it('transition rollback on event write failure (244)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    db.raw.exec('DROP TABLE bead_events');
    expect(() => completeBead(db.raw, bead.id, { actor: 'u' })).toThrow();
    const row = db.raw.prepare('SELECT status, completed_at FROM beads WHERE id = ?').get(bead.id) as { status: string; completed_at: number | null };
    expect(row.status).toBe('active');
    expect(row.completed_at).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // proposal guards: approveProposal / rejectProposal
  // ─────────────────────────────────────────────────────────────────────────

  it('approveProposal not-found check (255)', () => {
    expect(() => approveProposal(db.raw, 99999, { actor: 'u' })).toThrow(/not found/);
  });

  it('approveProposal status check rejects non-proposed (256)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u', status: 'active' });
    expect(() => approveProposal(db.raw, bead.id, { actor: 'u' })).toThrow(/not proposed/);
  });

  it('approveProposal allowedFrom=["proposed"] guard (257)', () => {
    const bead = createBead(db.raw, {
      kind: 'task', title: 't', ownerJid: 'o', actor: 'u',
      status: 'proposed', confidence: 0.5, proposalReason: 'test',
    });
    approveProposal(db.raw, bead.id, { actor: 'u' });
    const r = getBead(db.raw, bead.id)!;
    expect(r.bead.status).toBe('active');
  });

  it('rejectProposal not-found check (260)', () => {
    expect(() => rejectProposal(db.raw, 99999, { actor: 'u' })).toThrow(/not found/);
  });

  it('rejectProposal status check rejects non-proposed (262)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u', status: 'active' });
    expect(() => rejectProposal(db.raw, bead.id, { actor: 'u' })).toThrow(/not proposed/);
  });

  it('rejectProposal with reason includes rejection_reason (263)', () => {
    const bead = createBead(db.raw, {
      kind: 'task', title: 't', ownerJid: 'o', actor: 'u',
      status: 'proposed', confidence: 0.5, proposalReason: 'test',
    });
    rejectProposal(db.raw, bead.id, { actor: 'u', reason: 'not relevant' });
    const r = getBead(db.raw, bead.id)!;
    const sc = r.events.filter(e => e.event_type === 'status_change').pop()!;
    expect(JSON.parse(sc.payload_json)).toHaveProperty('rejection_reason', 'not relevant');
  });

  it('rejectProposal without reason omits rejection_reason (263: else)', () => {
    const bead = createBead(db.raw, {
      kind: 'task', title: 't', ownerJid: 'o', actor: 'u',
      status: 'proposed', confidence: 0.5, proposalReason: 'test',
    });
    rejectProposal(db.raw, bead.id, { actor: 'u' });
    const r = getBead(db.raw, bead.id)!;
    const sc = r.events.filter(e => e.event_type === 'status_change').pop()!;
    expect(JSON.parse(sc.payload_json)).not.toHaveProperty('rejection_reason');
  });

  it('rejectProposal allowedFrom=["proposed"] guard (263)', () => {
    const bead = createBead(db.raw, {
      kind: 'task', title: 't', ownerJid: 'o', actor: 'u',
      status: 'proposed', confidence: 0.5, proposalReason: 'test',
    });
    rejectProposal(db.raw, bead.id, { actor: 'u' });
    const r = getBead(db.raw, bead.id)!;
    expect(r.bead.status).toBe('cancelled');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // assertMutableBeadFields: guard for protected fields
  // ─────────────────────────────────────────────────────────────────────────

  it('assertMutableBeadFields rejects id (32-34)', () => {
    expect(() => assertMutableBeadFields({ id: 99 })).toThrow(/id/);
  });

  it('assertMutableBeadFields rejects kind (32-34)', () => {
    expect(() => assertMutableBeadFields({ kind: 'project' })).toThrow(/kind/);
  });

  it('assertMutableBeadFields rejects owner_jid (32-34)', () => {
    expect(() => assertMutableBeadFields({ owner_jid: 'other' })).toThrow(/owner_jid/);
  });

  it('assertMutableBeadFields rejects status (32-34)', () => {
    expect(() => assertMutableBeadFields({ status: 'completed' })).toThrow(/status/);
  });

  it('assertMutableBeadFields rejects created_at (32-34)', () => {
    expect(() => assertMutableBeadFields({ created_at: 0 })).toThrow(/created_at/);
  });

  it('assertMutableBeadFields allows mutable fields', () => {
    expect(() => assertMutableBeadFields({ title: 'x', body: 'y', due_at: 123, priority: 1 })).not.toThrow();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // countOverdueProposals: uses OVERDUE_PROPOSAL_WHERE predicate
  // ─────────────────────────────────────────────────────────────────────────

  it('countOverdueProposals counts only overdue proposed (149-153)', () => {
    const now = Math.floor(Date.now() / 1000);
    createBead(db.raw, {
      kind: 'task', title: 'overdue1', ownerJid: 'o', status: 'proposed',
      reviewByAt: now - 1000, confidence: 0.5, proposalReason: 'test', actor: 'u',
    });
    createBead(db.raw, {
      kind: 'task', title: 'overdue2', ownerJid: 'o', status: 'proposed',
      reviewByAt: now - 500, confidence: 0.5, proposalReason: 'test', actor: 'u',
    });
    createBead(db.raw, {
      kind: 'task', title: 'not-overdue', ownerJid: 'o', status: 'proposed',
      reviewByAt: now + 10000, confidence: 0.5, proposalReason: 'test', actor: 'u',
    });
    createBead(db.raw, {
      kind: 'task', title: 'active', ownerJid: 'o', status: 'active', actor: 'u',
    });
    expect(countOverdueProposals(db.raw, now)).toBe(2);
  });

  it('countOverdueProposals with custom now parameter', () => {
    const t1 = Math.floor(Date.now() / 1000);
    const t2 = t1 + 100;
    createBead(db.raw, {
      kind: 'task', title: 'p', ownerJid: 'o', status: 'proposed',
      reviewByAt: t1, confidence: 0.5, proposalReason: 'test', actor: 'u',
    });
    expect(countOverdueProposals(db.raw, t1)).toBe(0);
    expect(countOverdueProposals(db.raw, t2)).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // activityFeed: owner scoping and filtering
  // ─────────────────────────────────────────────────────────────────────────

  it('activityFeed beadEvents empty string owner filter (280)', () => {
    const mw = createBead(db.raw, { kind: 'task', title: 'mw', ownerJid: 'mw', actor: 'u' });
    const other = createBead(db.raw, { kind: 'task', title: 'other', ownerJid: 'other', actor: 'u' });
    const feed = activityFeed(db.raw, { limit: 50 });
    const ids = feed.filter(r => r.source === 'bead_event').map(r => r.bead_id);
    expect(ids).toContain(mw.id);
    expect(ids).toContain(other.id);
  });

  it('activityFeed beadEvents with owner filter scopes correctly (276, 280)', () => {
    const mw = createBead(db.raw, { kind: 'task', title: 'mw', ownerJid: 'mw', actor: 'u' });
    const other = createBead(db.raw, { kind: 'task', title: 'other', ownerJid: 'other', actor: 'u' });
    const mwFeed = activityFeed(db.raw, { ownerJid: 'mw', limit: 50 });
    const ids = mwFeed.filter(r => r.source === 'bead_event').map(r => r.bead_id);
    expect(ids).toContain(mw.id);
    expect(ids).not.toContain(other.id);
  });

  it('activityFeed respects since cutoff for bead_events (277)', () => {
    const before = Math.floor(Date.now() / 1000);
    createBead(db.raw, { kind: 'task', title: 'future', ownerJid: 'o', actor: 'u' });
    const feed = activityFeed(db.raw, { since: before + 1000, limit: 50 });
    expect(feed.filter(r => r.source === 'bead_event')).toHaveLength(0);
  });

  it('activityFeed default owner/since filtering (269-270)', () => {
    const b = createBead(db.raw, { kind: 'task', title: 'b', ownerJid: 'o', actor: 'u' });
    const feed = activityFeed(db.raw, {});
    const ids = feed.filter(r => r.source === 'bead_event').map(r => r.bead_id);
    expect(ids).toContain(b.id);
  });

  it('activityFeed observations excluded if superseded (294-299)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    const ent = upsertEntity(db.raw, { kind: 'person', canonicalName: 'L' });
    db.raw.prepare(
      'INSERT INTO bead_entity_refs (bead_id, entity_id, role, created_at) VALUES (?, ?, \'subject\', ?)'
    ).run(bead.id, ent.id, Math.floor(Date.now() / 1000));
    const o1 = captureObservation(db.raw, { entityRef: { entityId: ent.id }, kind: 'fact', text: 'stale', confidence: 0.9, sourceKind: 'manual' });
    const o2 = captureObservation(db.raw, { entityRef: { entityId: ent.id }, kind: 'fact', text: 'live', confidence: 0.95, sourceKind: 'manual', supersedesObservationId: o1.id });
    const feed = activityFeed(db.raw, { ownerJid: 'o', limit: 50 });
    const obsTexts = feed.filter(r => r.source === 'entity_observation').map(r => r.text);
    expect(obsTexts).toContain('live');
    expect(obsTexts).not.toContain('stale');
    void o2;
  });

  it('activityFeed observations excluded if forgotten (293)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    const ent = upsertEntity(db.raw, { kind: 'person', canonicalName: 'L' });
    db.raw.prepare(
      'INSERT INTO bead_entity_refs (bead_id, entity_id, role, created_at) VALUES (?, ?, \'subject\', ?)'
    ).run(bead.id, ent.id, Math.floor(Date.now() / 1000));
    const obs = captureObservation(db.raw, { entityRef: { entityId: ent.id }, kind: 'fact', text: 'forgotten', confidence: 0.8, sourceKind: 'manual' });
    forgetObservation(db.raw, obs.id, 'test');
    const feed = activityFeed(db.raw, { ownerJid: 'o', limit: 50 });
    const obsTexts = feed.filter(r => r.source === 'entity_observation').map(r => r.text);
    expect(obsTexts).not.toContain('forgotten');
  });

  it('activityFeed observations sorts and slices (325-326)', () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
      const b = createBead(db.raw, { kind: 'task', title: `t${i}`, ownerJid: 'o', actor: 'u' });
      db.raw.prepare('UPDATE beads SET created_at = ? WHERE id = ?').run(now - 1000 + i * 100, b.id);
    }
    const feed = activityFeed(db.raw, { limit: 2 });
    expect(feed).toHaveLength(2);
    expect(feed[0].created_at).toBeGreaterThanOrEqual(feed[1].created_at);
  });

  it('activityFeed observations respects since cutoff (301)', () => {
    const now = Math.floor(Date.now() / 1000);
    const ent = upsertEntity(db.raw, { kind: 'person', canonicalName: 'L' });
    const obs = captureObservation(db.raw, { entityRef: { entityId: ent.id }, kind: 'fact', text: 'old', confidence: 0.9, sourceKind: 'manual' });
    db.raw.prepare('UPDATE entity_observations SET created_at = ? WHERE id = ?').run(now - 10000, obs.id);
    const feed = activityFeed(db.raw, { since: now - 5000, limit: 50 });
    const obsTexts = feed.filter(r => r.source === 'entity_observation').map(r => r.text);
    expect(obsTexts).not.toContain('old');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // createBead: body clamping and defaults
  // ─────────────────────────────────────────────────────────────────────────

  it('createBead clampBody null returns null (37-38)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', body: null, actor: 'u' });
    expect(bead.body).toBeNull();
  });

  it('createBead clampBody undefined returns null (37-38)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    expect(bead.body).toBeNull();
  });

  it('createBead clampBody within cap (39)', () => {
    const body = 'x'.repeat(100);
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', body, actor: 'u' });
    expect(bead.body).toBe(body);
  });

  it('createBead clampBody over cap (43-50)', () => {
    const huge = 'y'.repeat(100 * 1024);
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', body: huge, actor: 'u' });
    expect(Buffer.byteLength(bead.body!, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(bead.body).toMatch(/\.\.\.\[truncated\]$/);
  });

  it('createBead iterative slice loop terminates (45-48)', () => {
    const emoji = '😀'.repeat(40 * 1024);
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', body: emoji, actor: 'u' });
    expect(Buffer.byteLength(bead.body!, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(bead.body).toMatch(/\.\.\.\[truncated\]$/);
  });

  it('createBead defaults status to active (55)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    expect(bead.status).toBe('active');
  });

  it('createBead respects explicit status (55, 65)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', status: 'proposed', confidence: 0.5, proposalReason: 'test', actor: 'u' });
    expect(bead.status).toBe('proposed');
  });

  it('createBead defaults priority to 0 (67)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    expect(bead.priority).toBe(0);
  });

  it('createBead respects explicit priority (67)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', priority: 2, actor: 'u' });
    expect(bead.priority).toBe(2);
  });

  it('createBead chatJid and sourceMessagePk default to null (66)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    expect(bead.chat_jid).toBeNull();
    expect(bead.source_message_pk).toBeNull();
  });

  it('createBead metadata defaults to {} (70)', () => {
    const bead = createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' });
    expect(JSON.parse(bead.metadata_json)).toEqual({});
  });

  it('createBead rollback on event write failure (81-84)', () => {
    db.raw.exec('DROP TABLE bead_events');
    expect(() => createBead(db.raw, { kind: 'task', title: 't', ownerJid: 'o', actor: 'u' })).toThrow();
    const count = (db.raw.prepare('SELECT COUNT(*) AS c FROM beads').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
