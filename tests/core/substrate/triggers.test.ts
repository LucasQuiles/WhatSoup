import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import {
  createTrigger, listTriggers, pauseTrigger, extendTrigger,
  validateTriggerSpec, dueTriggers,
} from '../../../src/core/substrate/triggers.ts';

function tmpFile() { return join(tmpdir(), `sub-${randomBytes(8).toString('hex')}.db`); }

describe('triggers core', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('validateTriggerSpec: cron valid; unknown kind rejected; missing fields rejected', () => {
    expect(() => validateTriggerSpec('schedule.cron', { expr: '0 8 * * *' })).not.toThrow();
    expect(() => validateTriggerSpec('bogus.kind' as any, {})).toThrow(/unknown trigger kind/i);
    expect(() => validateTriggerSpec('schedule.cron', {})).toThrow();
    expect(() => validateTriggerSpec('poll.email', { source: 'gmail' })).not.toThrow();
    expect(() => validateTriggerSpec('poll.email', {})).toThrow();
  });

  it('createTrigger writes row + trigger_created event', () => {
    const bead = createBead(db.raw, { kind: 'agent_job', title: 'daily', ownerJid: 'mw', actor: 'user' });
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.cron', spec: { expr: '0 8 * * *' },
      reportChatJid: 'user-1@s.whatsapp.net', actor: 'user',
    });
    expect(t.id).toBeGreaterThan(0); expect(t.status).toBe('active');
    expect(t.next_fire_at).not.toBeNull();
    const kinds = (db.raw.prepare('SELECT event_type FROM bead_events WHERE bead_id = ?').all(bead.id) as Array<{ event_type: string }>).map(e => e.event_type);
    expect(kinds).toContain('trigger_created');
  });

  it('watch TTL clamps to maxHours', () => {
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'user' });
    const now = Math.floor(Date.now() / 1000);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.email', spec: { source: 'gmail', sender: 'x@y' },
      reportChatJid: 'c', requestedTerminalAt: now + 10 * 86400, maxTtlHours: 72, actor: 'user',
    });
    expect(t.terminal_at).toBeLessThanOrEqual(now + 72 * 3600 + 5);
  });

  it('listTriggers filters by bead + kind', () => {
    const a = createBead(db.raw, { kind: 'watch', title: 'a', ownerJid: 'mw', actor: 'user' });
    const b = createBead(db.raw, { kind: 'watch', title: 'b', ownerJid: 'mw', actor: 'user' });
    createTrigger(db.raw, { beadId: a.id, kind: 'poll.email', spec: { source: 'gmail' }, reportChatJid: 'c', actor: 'u' });
    createTrigger(db.raw, { beadId: b.id, kind: 'poll.url', spec: { url: 'https://x.example.com', hash_mode: 'text' }, reportChatJid: 'c', actor: 'u' });
    expect(listTriggers(db.raw, { beadId: a.id })).toHaveLength(1);
    expect(listTriggers(db.raw, { kind: 'poll.url' })).toHaveLength(1);
  });

  it('pauseTrigger sets status=paused, clears next_fire_at', () => {
    const bead = createBead(db.raw, { kind: 'agent_job', title: 'x', ownerJid: 'mw', actor: 'u' });
    const t = createTrigger(db.raw, { beadId: bead.id, kind: 'schedule.cron', spec: { expr: '* * * * *' }, reportChatJid: 'c', actor: 'u' });
    pauseTrigger(db.raw, t.id, { actor: 'u' });
    const fresh = listTriggers(db.raw, { beadId: bead.id })[0];
    expect(fresh).toMatchObject({
      status: 'paused',
      next_fire_at: null,
    });
  });

  it('extendTrigger clamps; rejects past time', () => {
    const bead = createBead(db.raw, { kind: 'watch', title: 'x', ownerJid: 'mw', actor: 'u' });
    const now = Math.floor(Date.now() / 1000);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.email', spec: { source: 'gmail' },
      reportChatJid: 'c', requestedTerminalAt: now + 3600, maxTtlHours: 72, actor: 'u',
    });
    extendTrigger(db.raw, t.id, { until: now + 10 * 86400, maxTtlHours: 72, actor: 'u' });
    expect(listTriggers(db.raw, { beadId: bead.id })[0].terminal_at).toBeLessThanOrEqual(now + 72 * 3600 + 5);
    expect(() => extendTrigger(db.raw, t.id, { until: now - 10, maxTtlHours: 72, actor: 'u' })).toThrow(/future/i);
  });

  it('dueTriggers returns active past-due rows, excludes far-future', () => {
    const bead = createBead(db.raw, { kind: 'agent_job', title: 'x', ownerJid: 'mw', actor: 'u' });
    const now = Math.floor(Date.now() / 1000);
    const t1 = createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.at_time', spec: { fire_at: now - 10 },
      reportChatJid: 'c', actor: 'u',
    });
    createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.at_time', spec: { fire_at: now + 86400 },
      reportChatJid: 'c', actor: 'u',
    });
    const due = dueTriggers(db.raw, now, 10);
    expect(due.map(d => d.id)).toContain(t1.id);
    expect(due).toHaveLength(1);
  });
});
