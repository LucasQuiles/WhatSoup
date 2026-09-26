import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import {
  createTrigger, listTriggers, pauseTrigger, extendTrigger, resumeTrigger,
  validateTriggerSpec, dueTriggers, isSafeSqliteSql, prepareTrigger,
  normalizeFireAtSeconds, MAX_REASONABLE_FIRE_AT_SEC,
  countPastDueTriggers, DEFAULT_TRIGGER_PAST_DUE_GRACE_SEC,
} from '../../../src/core/substrate/triggers.ts';
import { nextCronRun } from '../../../src/core/cron.ts';
import { fakeClock } from '../../../src/lib/clock.ts';

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

  it('createTrigger persists created_at from the injected clock, not the wall clock (fails if reverted to free nowUnixSec)', () => {
    const bead = createBead(db.raw, { kind: 'watch', title: 'clocked', ownerJid: 'mw', actor: 'user' });
    const t0ms = 2_000_000_000_000; // distinctive future epoch (2033-05-18)
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.email', spec: { source: 'gmail' },
      reportChatJid: 'c', actor: 'user',
    }, fakeClock(t0ms));
    const row = db.raw.prepare('SELECT created_at FROM bead_triggers WHERE id = ?').get(t.id) as { created_at: number };
    // Persisted created_at must derive from fakeClock's epoch. Reverted code
    // reads the real 2026 wall clock and stores ~1.7e9, not floor(t0ms/1000).
    expect(row.created_at).toBe(Math.floor(t0ms / 1000));
  });

  it('QR-046: dedupe_key makes createTrigger idempotent for a LIVE (kind, dedupe_key)', () => {
    const bead = createBead(db.raw, { kind: 'watch', title: 'dedupe', ownerJid: 'mw', actor: 'user' });
    const base = {
      beadId: bead.id, kind: 'poll.email' as const, spec: { source: 'gmail' as const, sender: 'x@y' },
      reportChatJid: 'c', dedupeKey: 'daily-x', actor: 'user',
    };
    const first = createTrigger(db.raw, base);
    const second = createTrigger(db.raw, base);
    // Re-creating with the same (kind, dedupe_key) returns the SAME trigger, not a duplicate.
    expect(second.id).toBe(first.id);
    expect(listTriggers(db.raw, { kind: 'poll.email' })).toHaveLength(1);

    // Precision: a DIFFERENT dedupe_key creates a new trigger.
    const other = createTrigger(db.raw, { ...base, dedupeKey: 'daily-y' });
    expect(other.id).not.toBe(first.id);
    expect(listTriggers(db.raw, { kind: 'poll.email' })).toHaveLength(2);

    // Precision: a DIFFERENT kind with the SAME dedupe_key creates a new trigger (index is (kind, dedupe_key)).
    createTrigger(db.raw, { ...base, kind: 'poll.url', spec: { url: 'https://x.example.com', hash_mode: 'text' } });
    expect(listTriggers(db.raw, { kind: 'poll.url' })).toHaveLength(1);

    // Precision: NO dedupe_key never dedupes.
    createTrigger(db.raw, { ...base, dedupeKey: undefined });
    createTrigger(db.raw, { ...base, dedupeKey: undefined });
    expect(listTriggers(db.raw, { kind: 'poll.email' })).toHaveLength(4);
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

  it('listTriggers supports unfiltered and status-only reads', () => {
    const bead = createBead(db.raw, { kind: 'watch', title: 'status-list', ownerJid: 'mw', actor: 'u' });
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.email', spec: { source: 'gmail' },
      reportChatJid: 'c', actor: 'u',
    });
    pauseTrigger(db.raw, t.id, { actor: 'u' });

    expect(listTriggers(db.raw).map(row => row.id)).toContain(t.id);
    expect(listTriggers(db.raw, { status: 'paused' }).map(row => row.id)).toEqual([t.id]);
    expect(listTriggers(db.raw, { status: 'active' })).toEqual([]);
  });

  it('poll intervals schedule next_fire_at relative to creation time', () => {
    const bead = createBead(db.raw, { kind: 'watch', title: 'interval', ownerJid: 'mw', actor: 'u' });
    const before = Math.floor(Date.now() / 1000);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.file',
      spec: { path: '/tmp/interval-watch', watch: 'exists' },
      reportChatJid: 'c', intervalSeconds: 90, actor: 'u',
    });
    const after = Math.floor(Date.now() / 1000);

    expect(t.next_fire_at).toBeGreaterThanOrEqual(before + 90);
    expect(t.next_fire_at).toBeLessThanOrEqual(after + 90);
  });

  it('createTrigger rolls back when event persistence fails after insert', () => {
    const bead = createBead(db.raw, { kind: 'watch', title: 'rollback-create', ownerJid: 'mw', actor: 'u' });
    db.raw.exec('DROP TABLE bead_events');

    expect(() => createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.email', spec: { source: 'gmail' },
      reportChatJid: 'c', actor: 'u',
    })).toThrow(/bead_events/i);

    const count = db.raw.prepare('SELECT COUNT(*) AS c FROM bead_triggers WHERE bead_id = ?').get(bead.id) as { c: number };
    expect(count.c).toBe(0);
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

  it('pauseTrigger rejects missing ids before opening a transaction', () => {
    expect(() => pauseTrigger(db.raw, 999_999, { actor: 'u' })).toThrow(/trigger 999999 not found/);
  });

  it('pauseTrigger rolls back status changes when event persistence fails', () => {
    const bead = createBead(db.raw, { kind: 'agent_job', title: 'pause-rollback', ownerJid: 'mw', actor: 'u' });
    const t = createTrigger(db.raw, { beadId: bead.id, kind: 'schedule.cron', spec: { expr: '* * * * *' }, reportChatJid: 'c', actor: 'u' });
    const before = listTriggers(db.raw, { beadId: bead.id })[0];
    db.raw.exec('DROP TABLE bead_events');

    expect(() => pauseTrigger(db.raw, t.id, { actor: 'u' })).toThrow(/bead_events/i);

    const after = listTriggers(db.raw, { beadId: bead.id })[0];
    expect(after).toMatchObject({ status: before.status, next_fire_at: before.next_fire_at });
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

  it('extendTrigger rejects missing ids after validating a future until value', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(() => extendTrigger(db.raw, 999_999, { until: future, maxTtlHours: 72, actor: 'u' }))
      .toThrow(/trigger 999999 not found/);
  });

  it('extendTrigger rolls back terminal_at changes when event persistence fails', () => {
    const bead = createBead(db.raw, { kind: 'watch', title: 'extend-rollback', ownerJid: 'mw', actor: 'u' });
    const now = Math.floor(Date.now() / 1000);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.email', spec: { source: 'gmail' },
      reportChatJid: 'c', requestedTerminalAt: now + 3600, maxTtlHours: 72, actor: 'u',
    });
    const before = listTriggers(db.raw, { beadId: bead.id })[0];
    db.raw.exec('DROP TABLE bead_events');

    expect(() => extendTrigger(db.raw, t.id, { until: now + 7200, maxTtlHours: 72, actor: 'u' }))
      .toThrow(/bead_events/i);

    expect(listTriggers(db.raw, { beadId: bead.id })[0].terminal_at).toBe(before.terminal_at);
  });

  it('extendTrigger on a paused trigger changes only the deadline: it stays paused and is never due (#3608, #2417)', () => {
    const bead = createBead(db.raw, { kind: 'agent_job', title: 'extend-paused', ownerJid: 'mw', actor: 'u' });
    const t0ms = 2_000_000_000_000;
    const clock = fakeClock(t0ms);
    const now = Math.floor(t0ms / 1000);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.cron', spec: { expr: '30 8 * * *' },
      reportChatJid: 'report-example-invalid@s.whatsapp.net', requestedTerminalAt: now + 3600, actor: 'u',
    }, clock);
    pauseTrigger(db.raw, t.id, { actor: 'u' }, clock);
    expect(listTriggers(db.raw, { beadId: bead.id })[0]).toMatchObject({ status: 'paused', next_fire_at: null });

    extendTrigger(db.raw, t.id, { until: now + 10 * 86400, maxTtlHours: 72, actor: 'u' }, clock);

    expect(listTriggers(db.raw, { beadId: bead.id })[0]).toMatchObject({
      status: 'paused', next_fire_at: null, terminal_at: now + 72 * 3600,
    });
    expect(dueTriggers(db.raw, now + 86400, 10)).toEqual([]);
    const ev = db.raw.prepare(
      `SELECT payload_json FROM bead_events WHERE bead_id = ? AND event_type = 'trigger_extended' ORDER BY id DESC LIMIT 1`,
    ).get(bead.id) as { payload_json: string };
    expect(JSON.parse(ev.payload_json)).toMatchObject({ trigger_id: t.id, was_paused: true, terminal_at: now + 72 * 3600 });
  });

  it('extendTrigger on a paused open-ended trigger gives it the requested deadline and leaves it paused (#3608)', () => {
    const bead = createBead(db.raw, { kind: 'agent_job', title: 'extend-open', ownerJid: 'mw', actor: 'u' });
    const t0ms = 2_000_000_000_000;
    const clock = fakeClock(t0ms);
    const now = Math.floor(t0ms / 1000);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.cron', spec: { expr: '30 8 * * *' },
      reportChatJid: 'report-example-invalid@s.whatsapp.net', requestedTerminalAt: null, actor: 'u',
    }, clock);
    pauseTrigger(db.raw, t.id, { actor: 'u' }, clock);

    extendTrigger(db.raw, t.id, { until: now + 7200, maxTtlHours: 72, actor: 'u' }, clock);

    expect(listTriggers(db.raw, { beadId: bead.id })[0]).toMatchObject({
      status: 'paused', next_fire_at: null, terminal_at: now + 7200,
    });
  });

  describe('resumeTrigger (#3608)', () => {
    const t0ms = 2_000_000_000_000;
    const now = Math.floor(t0ms / 1000);
    const clock = fakeClock(t0ms);

    function pausedCron(opts: { terminalAt?: number | null; expr?: string } = {}) {
      const bead = createBead(db.raw, { kind: 'agent_job', title: 'resume', ownerJid: 'mw', actor: 'u' });
      const t = createTrigger(db.raw, {
        beadId: bead.id, kind: 'schedule.cron', spec: { expr: opts.expr ?? '30 8 * * *' },
        reportChatJid: 'report-example-invalid@s.whatsapp.net',
        requestedTerminalAt: opts.terminalAt === undefined ? null : opts.terminalAt, actor: 'u',
      }, clock);
      pauseTrigger(db.raw, t.id, { actor: 'u' }, clock);
      return { bead, t };
    }

    function lastEvent(beadId: number, type: string): Record<string, unknown> | undefined {
      const ev = db.raw.prepare(
        `SELECT payload_json FROM bead_events WHERE bead_id = ? AND event_type = ? ORDER BY id DESC LIMIT 1`,
      ).get(beadId, type) as { payload_json: string } | undefined;
      return ev ? JSON.parse(ev.payload_json) : undefined;
    }

    it('schedules a paused daily cron trigger at its next regular occurrence, keeps its deadline, and records trigger_resumed', () => {
      const { bead, t } = pausedCron({ terminalAt: now + 3600 * 48 });
      const expectedNext = nextCronRun('30 8 * * *', now, 'UTC');
      expect(expectedNext).toBeGreaterThan(now);

      const res = resumeTrigger(db.raw, t.id, { actor: 'u', maxTtlHours: 72 }, clock);

      expect(res).toEqual({ resumed: true, status: 'active', next_fire_at: expectedNext, terminal_at: now + 3600 * 48, paused_reason: null });
      expect(listTriggers(db.raw, { beadId: bead.id })[0]).toMatchObject({
        status: 'active', next_fire_at: expectedNext, terminal_at: now + 3600 * 48,
      });
      // Not due at the moment of resume: the daily job keeps its slot.
      expect(dueTriggers(db.raw, now, 10)).toEqual([]);
      expect(lastEvent(bead.id, 'trigger_resumed')).toEqual({
        trigger_id: t.id, next_fire_at: expectedNext, terminal_at: now + 3600 * 48, fire_now: false, paused_reason: null,
      });
    });

    it('fire_now makes an open-ended trigger due immediately and keeps it open-ended (#3609 case)', () => {
      const { bead, t } = pausedCron({ terminalAt: null });

      const res = resumeTrigger(db.raw, t.id, { actor: 'u', fireNow: true, maxTtlHours: 72 }, clock);

      expect(res).toMatchObject({ resumed: true, next_fire_at: now, terminal_at: null });
      expect(listTriggers(db.raw, { beadId: bead.id })[0]).toMatchObject({ status: 'active', next_fire_at: now, terminal_at: null });
      expect(dueTriggers(db.raw, now, 10).map((row) => row.id)).toEqual([t.id]);
    });

    it('is idempotent on an active trigger: no write, no event, resumed=false', () => {
      const bead = createBead(db.raw, { kind: 'agent_job', title: 'active', ownerJid: 'mw', actor: 'u' });
      const t = createTrigger(db.raw, {
        beadId: bead.id, kind: 'schedule.cron', spec: { expr: '30 8 * * *' },
        reportChatJid: 'report-example-invalid@s.whatsapp.net', actor: 'u',
      }, clock);
      const before = listTriggers(db.raw, { beadId: bead.id })[0];

      const res = resumeTrigger(db.raw, t.id, { actor: 'u', fireNow: true, maxTtlHours: 72 }, fakeClock(t0ms + 60_000));

      expect(res).toEqual({ resumed: false, status: 'active', next_fire_at: before.next_fire_at, terminal_at: before.terminal_at, paused_reason: null });
      expect(listTriggers(db.raw, { beadId: bead.id })[0]).toEqual(before);
      expect(lastEvent(bead.id, 'trigger_resumed')).toBeUndefined();
    });

    it('refuses expired and cancelled triggers and unknown ids', () => {
      const { t } = pausedCron();
      db.raw.prepare(`UPDATE bead_triggers SET status = 'expired' WHERE id = ?`).run(t.id);
      expect(() => resumeTrigger(db.raw, t.id, { actor: 'u', maxTtlHours: 72 }, clock)).toThrow(/is expired; only a paused trigger/);
      db.raw.prepare(`UPDATE bead_triggers SET status = 'cancelled' WHERE id = ?`).run(t.id);
      expect(() => resumeTrigger(db.raw, t.id, { actor: 'u', maxTtlHours: 72 }, clock)).toThrow(/is cancelled; only a paused trigger/);
      expect(() => resumeTrigger(db.raw, 999_999, { actor: 'u', maxTtlHours: 72 }, clock)).toThrow(/trigger 999999 not found/);
    });

    it('refuses a passed deadline unless until is given, and clamps until to the policy max', () => {
      const { bead, t } = pausedCron({ terminalAt: now - 60 });
      expect(() => resumeTrigger(db.raw, t.id, { actor: 'u', maxTtlHours: 72 }, clock)).toThrow(/deadline has passed/);
      expect(listTriggers(db.raw, { beadId: bead.id })[0].status).toBe('paused');
      expect(() => resumeTrigger(db.raw, t.id, { actor: 'u', until: now - 1, maxTtlHours: 72 }, clock)).toThrow(/until must be in the future/);

      const res = resumeTrigger(db.raw, t.id, { actor: 'u', until: now + 10 * 86400, maxTtlHours: 72 }, clock);

      expect(res).toMatchObject({ resumed: true, terminal_at: now + 72 * 3600 });
      expect(listTriggers(db.raw, { beadId: bead.id })[0]).toMatchObject({ status: 'active', terminal_at: now + 72 * 3600 });
    });

    it('reports the forbidden_target pause reason from the latest trigger_paused event', () => {
      const { bead, t } = pausedCron();
      db.raw.prepare(
        `INSERT INTO bead_events (bead_id, event_type, payload_json, actor, created_at) VALUES (?, 'trigger_paused', ?, 'trigger-poller', ?)`,
      ).run(bead.id, JSON.stringify({ trigger_id: t.id, reason: 'forbidden_target', reject_count: 3 }), now);

      const res = resumeTrigger(db.raw, t.id, { actor: 'u', maxTtlHours: 72 }, clock);

      expect(res.paused_reason).toBe('forbidden_target');
      expect(lastEvent(bead.id, 'trigger_resumed')).toMatchObject({ paused_reason: 'forbidden_target' });
    });

    it('applies the creation target rules: poll.url needs enableUrlWatch, poll.shell is refused, a corrupt spec is refused', () => {
      const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
      const url = createTrigger(db.raw, {
        beadId: bead.id, kind: 'poll.url', spec: { url: 'https://example.com/feed', hash_mode: 'text' },
        reportChatJid: 'c', requestedTerminalAt: now + 3600, maxTtlHours: 72, actor: 'u',
      }, clock);
      pauseTrigger(db.raw, url.id, { actor: 'u' }, clock);
      expect(() => resumeTrigger(db.raw, url.id, { actor: 'u', maxTtlHours: 72 }, clock)).toThrow(/url watch is disabled/);
      expect(resumeTrigger(db.raw, url.id, { actor: 'u', maxTtlHours: 72, enableUrlWatch: true }, clock)).toMatchObject({ resumed: true });

      const shell = createTrigger(db.raw, {
        beadId: bead.id, kind: 'poll.shell', spec: { argv: ['true'], fire_when: 'exit_zero' },
        reportChatJid: 'c', requestedTerminalAt: now + 3600, maxTtlHours: 72, actor: 'u',
      }, clock);
      pauseTrigger(db.raw, shell.id, { actor: 'u' }, clock);
      expect(() => resumeTrigger(db.raw, shell.id, { actor: 'u', maxTtlHours: 72 }, clock)).toThrow(/poll\.shell/);

      const { t } = pausedCron();
      db.raw.prepare(`UPDATE bead_triggers SET spec_json = '{}' WHERE id = ?`).run(t.id);
      expect(() => resumeTrigger(db.raw, t.id, { actor: 'u', maxTtlHours: 72 }, clock)).toThrow();
      expect(listTriggers(db.raw, {}).find((row) => row.id === t.id)?.status).toBe('paused');
    });

    it('rolls back the reactivation when event persistence fails', () => {
      const { bead, t } = pausedCron();
      db.raw.exec(`CREATE TRIGGER deny_resumed BEFORE INSERT ON bead_events WHEN NEW.event_type = 'trigger_resumed' BEGIN SELECT RAISE(ABORT, 'bead_events write denied'); END`);

      expect(() => resumeTrigger(db.raw, t.id, { actor: 'u', maxTtlHours: 72 }, clock)).toThrow(/bead_events write denied/);

      expect(listTriggers(db.raw, { beadId: bead.id })[0]).toMatchObject({ status: 'paused', next_fire_at: null });
    });
  });

  it('extendTrigger on an active trigger leaves status and next_fire_at untouched (was_paused=false)', () => {
    const bead = createBead(db.raw, { kind: 'agent_job', title: 'active', ownerJid: 'mw', actor: 'u' });
    const t0ms = 2_000_000_000_000;
    const clock = fakeClock(t0ms);
    const now = Math.floor(t0ms / 1000);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.cron', spec: { expr: '30 8 * * *' },
      reportChatJid: 'report-example-invalid@s.whatsapp.net', actor: 'u',
    }, clock);
    const before = listTriggers(db.raw, { beadId: bead.id })[0];

    extendTrigger(db.raw, t.id, { until: now + 3600, maxTtlHours: 72, actor: 'u' }, clock);

    expect(listTriggers(db.raw, { beadId: bead.id })[0]).toMatchObject({
      status: 'active', next_fire_at: before.next_fire_at, terminal_at: now + 3600,
    });
    const ev = db.raw.prepare(
      `SELECT payload_json FROM bead_events WHERE bead_id = ? AND event_type = 'trigger_extended' ORDER BY id DESC LIMIT 1`,
    ).get(bead.id) as { payload_json: string };
    expect(JSON.parse(ev.payload_json)).toMatchObject({ was_paused: false });
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

describe('QR-092: substrate schedule.cron honors the tz field', () => {
  const baseArgs = {
    beadId: 1, reportChatJid: '15550100001@s.whatsapp.net', actor: 'test',
  };

  it('threads spec.tz into next_fire_at (not evaluated in UTC)', () => {
    const { now, nextFireAt } = prepareTrigger({
      ...baseArgs,
      kind: 'schedule.cron',
      spec: { expr: '0 12 * * *', tz: 'America/New_York' },
    });
    // The computed next fire must honor the tz — equal to the tz-aware cron
    // computation, and DIFFERENT from the UTC one (noon-NY != noon-UTC).
    expect(nextFireAt).toBe(nextCronRun('0 12 * * *', now, 'America/New_York'));
    expect(nextFireAt).not.toBe(nextCronRun('0 12 * * *', now, 'UTC'));
  });

  it('defaults to UTC when no tz is provided', () => {
    const { now, nextFireAt } = prepareTrigger({
      ...baseArgs,
      kind: 'schedule.cron',
      spec: { expr: '0 12 * * *' },
    });
    expect(nextFireAt).toBe(nextCronRun('0 12 * * *', now, 'UTC'));
  });
});

describe('#1757: fire_at ms/sec normalization', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('normalizeFireAtSeconds passes a legit epoch-seconds value through unchanged', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    expect(normalizeFireAtSeconds(nowSec + 3600)).toBe(nowSec + 3600);
  });

  it('normalizeFireAtSeconds passes the exact ceiling through unchanged (boundary)', () => {
    expect(normalizeFireAtSeconds(MAX_REASONABLE_FIRE_AT_SEC)).toBe(MAX_REASONABLE_FIRE_AT_SEC);
  });

  it('normalizeFireAtSeconds treats one-past-ceiling as milliseconds and divides down (boundary)', () => {
    const onePastCeiling = MAX_REASONABLE_FIRE_AT_SEC + 1;
    expect(normalizeFireAtSeconds(onePastCeiling)).toBe(Math.round(onePastCeiling / 1000));
  });

  it('normalizeFireAtSeconds normalizes a realistic epoch-ms fire_at to the matching epoch-seconds value', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const oneHourFromNowMs = (nowSec + 3600) * 1000;
    expect(normalizeFireAtSeconds(oneHourFromNowMs)).toBe(nowSec + 3600);
  });

  it('normalizeFireAtSeconds rejects a value implausible in EITHER unit', () => {
    // Even divided by 1000 this still clears the epoch-seconds ceiling by 2
    // orders of magnitude — not a plausible timestamp in either unit.
    expect(() => normalizeFireAtSeconds(999_999_999_999_999)).toThrow(/not a plausible/i);
  });

  it('computeNextFireAt (via prepareTrigger) normalizes an epoch-ms fire_at for schedule.at_time', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const fireAtMs = (nowSec + 7200) * 1000;
    const { nextFireAt } = prepareTrigger({
      beadId: 1, kind: 'schedule.at_time', spec: { fire_at: fireAtMs },
      reportChatJid: 'c', actor: 'u',
    });
    expect(nextFireAt).toBe(nowSec + 7200);
  });

  it('prepareTrigger rejects a schedule.at_time fire_at implausible in either unit', () => {
    expect(() => prepareTrigger({
      beadId: 1, kind: 'schedule.at_time', spec: { fire_at: 999_999_999_999_999 },
      reportChatJid: 'c', actor: 'u',
    })).toThrow(/not a plausible/i);
  });

  it('createTrigger persists the NORMALIZED seconds value, not the raw ms input, for schedule.at_time', () => {
    const bead = createBead(db.raw, { kind: 'agent_job', title: 'ms-input', ownerJid: 'mw', actor: 'user' });
    const nowSec = Math.floor(Date.now() / 1000);
    const fireAtMs = (nowSec + 1800) * 1000;
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.at_time', spec: { fire_at: fireAtMs },
      reportChatJid: 'c', actor: 'user',
    });
    expect(t.next_fire_at).toBe(nowSec + 1800);
  });

  it('createTrigger leaves a legit epoch-seconds schedule.at_time fire_at untouched', () => {
    const bead = createBead(db.raw, { kind: 'agent_job', title: 'sec-input', ownerJid: 'mw', actor: 'user' });
    const fireAtSec = Math.floor(Date.now() / 1000) + 900;
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.at_time', spec: { fire_at: fireAtSec },
      reportChatJid: 'c', actor: 'user',
    });
    expect(t.next_fire_at).toBe(fireAtSec);
  });
});

// #1765 — countPastDueTriggers: liveness gauge for active triggers whose
// next_fire_at is >grace in the past AND that have never fired (last_fire_at IS
// NULL). Each boundary test isolates ONE clause of the predicate so a green
// result cannot be earned by the wrong column.
describe('countPastDueTriggers (#1765)', () => {
  let path: string; let db: Database;
  const NOW = 1_000_000_000;
  const GRACE = DEFAULT_TRIGGER_PAST_DUE_GRACE_SEC;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  // Active trigger with a caller-controlled next_fire_at; last_fire_at starts NULL.
  function activeTrigger(nextFireAt: number) {
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    return createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.cron', spec: { expr: '0 8 * * *' },
      reportChatJid: 'c', nextFireAt, actor: 'u',
    });
  }

  it('defaults grace to 24h (86400s) when omitted', () => {
    expect(GRACE).toBe(86_400);
    activeTrigger(NOW - GRACE - 1);
    // now defaulted to real clock would not see this row; pass now explicitly,
    // grace omitted so the DEFAULT is exercised.
    expect(countPastDueTriggers(db.raw, NOW)).toBe(1);
  });

  it('counts an active trigger past due beyond the grace window with zero runs', () => {
    activeTrigger(NOW - GRACE - 1);
    expect(countPastDueTriggers(db.raw, NOW, GRACE)).toBe(1);
  });

  it('excludes a trigger sitting exactly at the grace boundary (strict <)', () => {
    // next_fire_at === now - grace is NOT counted; one second older IS.
    const t = activeTrigger(NOW - GRACE);
    expect(countPastDueTriggers(db.raw, NOW, GRACE)).toBe(0);
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(NOW - GRACE - 1, t.id);
    expect(countPastDueTriggers(db.raw, NOW, GRACE)).toBe(1);
  });

  it('excludes a trigger that has already fired (last_fire_at IS NOT NULL) — isolates the last_fire_at clause', () => {
    const t = activeTrigger(NOW - GRACE - 1000);
    // Same status + ancient next_fire_at as a counted row; only last_fire_at differs.
    db.raw.prepare(`UPDATE bead_triggers SET last_fire_at = ? WHERE id = ?`).run(NOW - 500, t.id);
    expect(countPastDueTriggers(db.raw, NOW, GRACE)).toBe(0);
  });

  it('excludes a paused trigger — isolates the status clause', () => {
    const t = activeTrigger(NOW - GRACE - 1000);
    // Flip ONLY status; keep next_fire_at ancient and last_fire_at NULL so the
    // exclusion can only come from status != 'active' (not from pauseTrigger's
    // side effect of nulling next_fire_at).
    db.raw.prepare(`UPDATE bead_triggers SET status = 'paused' WHERE id = ?`).run(t.id);
    expect(countPastDueTriggers(db.raw, NOW, GRACE)).toBe(0);
  });

  it('excludes an active trigger with next_fire_at IS NULL', () => {
    const t = activeTrigger(NOW - GRACE - 1000);
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = NULL WHERE id = ?`).run(t.id);
    expect(countPastDueTriggers(db.raw, NOW, GRACE)).toBe(0);
  });

  it('preserves an explicit null `now` (default-parameter, not coalesce)', () => {
    activeTrigger(NOW - GRACE - 1000);
    const t0ms = 2_000_000_000_000; // distinctive future epoch (2033-05-18)
    // main's `now: number = nowUnixSec()` preserves an explicit null: the cutoff
    // becomes null - grace (null coerces to 0) = -86400, which matches no
    // positive next_fire_at (count 0). A `??` coalesce would substitute the
    // clock (well after the stale next_fire_at) and count the trigger.
    expect(countPastDueTriggers(db.raw, null as unknown as number, GRACE, fakeClock(t0ms))).toBe(0);
    // Sanity: the same stale trigger IS past-due against a real cutoff.
    expect(countPastDueTriggers(db.raw, Math.floor(t0ms / 1000), GRACE)).toBe(1);
  });
});
