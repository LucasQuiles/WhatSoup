import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import {
  createTrigger, listTriggers, pauseTrigger, extendTrigger,
  validateTriggerSpec, dueTriggers, isSafeSqliteSql,
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

  it('event.message persists with next_fire_at NULL (reserved scaffold, not polled)', () => {
    // event.message is a RESERVED SCAFFOLD: accepted + persisted but never
    // executed by the interval poller (pending a future ingest-path
    // integration). computeNextFireAt returns NULL so the row sits inert and
    // dueTriggers (which requires next_fire_at IS NOT NULL) never selects it.
    const bead = createBead(db.raw, { kind: 'watch', title: 'msg', ownerJid: 'mw', actor: 'user' });
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'event.message',
      spec: { match: 'sender_jid', value: '123@s.whatsapp.net' },
      reportChatJid: 'c', intervalSeconds: 60, actor: 'user',
    });
    // Persisted active, but inert: next_fire_at is NULL so the poller never
    // selects it. Assert the full shape so the row identity is pinned, not just
    // a bare null.
    expect(t).toMatchObject({ kind: 'event.message', status: 'active', next_fire_at: null });
  });

  it('dueTriggers does NOT return an event.message row even when past-due fields would otherwise match', () => {
    const bead = createBead(db.raw, { kind: 'watch', title: 'msg', ownerJid: 'mw', actor: 'user' });
    const now = Math.floor(Date.now() / 1000);
    createTrigger(db.raw, {
      beadId: bead.id, kind: 'event.message',
      spec: { match: 'regex', value: 'urgent' },
      reportChatJid: 'c', actor: 'user',
    });
    // Sanity: a normal past-due trigger on the same bead IS returned, so the
    // exclusion is specific to event.message's NULL next_fire_at.
    const sched = createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.at_time', spec: { fire_at: now - 5 },
      reportChatJid: 'c', actor: 'user',
    });
    const due = dueTriggers(db.raw, now, 10);
    const kinds = due.map(d => d.kind);
    expect(kinds).not.toContain('event.message');
    expect(due.map(d => d.id)).toContain(sched.id);
  });

  it('event.message still TTL-expires via the kind-agnostic terminal_at sweep', () => {
    // The persisted row carries a terminal_at (create_watch always sets one),
    // so the poller expiry sweep (status=active AND terminal_at <= now) still
    // reaps it even though it is never polled. Proven here at the data layer:
    // the row is selectable by the sweep predicate.
    const bead = createBead(db.raw, { kind: 'watch', title: 'msg', ownerJid: 'mw', actor: 'user' });
    const now = Math.floor(Date.now() / 1000);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'event.message',
      spec: { match: 'mention', value: '@me' },
      reportChatJid: 'c', requestedTerminalAt: now - 1, actor: 'user',
    });
    expect(t.terminal_at).not.toBeNull();
    const overdue = db.raw.prepare(
      `SELECT id FROM bead_triggers WHERE status='active' AND terminal_at IS NOT NULL AND terminal_at <= ?`,
    ).all(now) as Array<{ id: number }>;
    expect(overdue.map(r => r.id)).toContain(t.id);
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

describe('poll.sqlite SQL safety guard (#1096)', () => {
  it('isSafeSqliteSql accepts a single read query and rejects ATTACH/PRAGMA/multi-statement', () => {
    expect(isSafeSqliteSql('SELECT * FROM messages WHERE id > ?')).toBe(true);
    expect(isSafeSqliteSql('SELECT 1;')).toBe(true); // single trailing semicolon ok
    expect(isSafeSqliteSql("ATTACH DATABASE '/etc/passwd' AS x")).toBe(false);
    expect(isSafeSqliteSql('PRAGMA query_only = OFF')).toBe(false);
    expect(isSafeSqliteSql('SELECT 1; SELECT 2')).toBe(false); // multi-statement
  });

  it('QR-026: isSafeSqliteSql rejects recursive CTEs (unbounded-CPU vector under query_only)', () => {
    // A count/aggregate over a recursive CTE returns ONE row → the poller row-cap can't
    // bound it, and node:sqlite DatabaseSync has no statement-time interrupt → whole-process
    // freeze. Reject at validation so it never executes.
    expect(
      isSafeSqliteSql('WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM r WHERE x<1000000000) SELECT count(*) FROM r'),
    ).toBe(false);
    expect(isSafeSqliteSql('with recursive cnt(n) as (select 1 union all select n+1 from cnt) select n from cnt')).toBe(false);
    // A NON-recursive CTE remains allowed — only the recursive keyword is the CPU vector.
    expect(isSafeSqliteSql('WITH recent AS (SELECT id FROM messages LIMIT 10) SELECT * FROM recent')).toBe(true);
  });

  it('validateTriggerSpec rejects a poll.sqlite spec with ATTACH', () => {
    expect(() =>
      validateTriggerSpec('poll.sqlite', {
        sql: "ATTACH DATABASE '/tmp/x.db' AS y", fire_when: 'rows_returned',
      }),
    ).toThrow();
    expect(() =>
      validateTriggerSpec('poll.sqlite', {
        sql: 'SELECT count(*) FROM messages', fire_when: 'rows_returned',
      }),
    ).not.toThrow();
  });
});
