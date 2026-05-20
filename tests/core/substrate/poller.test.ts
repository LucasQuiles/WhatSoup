import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import { createTrigger } from '../../../src/core/substrate/triggers.ts';
import { TriggerPoller } from '../../../src/core/substrate/poller.ts';
import type { Messenger, SubmissionReceipt } from '../../../src/core/types.ts';

function tmpFile() { return join(tmpdir(), `poller-${randomBytes(8).toString('hex')}.db`); }

function makeMessenger() {
  const calls: Array<{ chatJid: string; text: string }> = [];
  const messenger: Messenger = {
    async sendMessage(chatJid: string, text: string): Promise<SubmissionReceipt> {
      calls.push({ chatJid, text });
      return { waMessageId: `wa-${calls.length}` };
    },
    async sendMedia() { throw new Error('not used'); },
  };
  return { messenger, calls };
}

function makeFailingMessenger() {
  const calls: Array<{ chatJid: string; text: string }> = [];
  const messenger: Messenger = {
    async sendMessage(chatJid: string, text: string): Promise<SubmissionReceipt> {
      calls.push({ chatJid, text });
      throw new Error('transport down');
    },
    async sendMedia() { throw new Error('not used'); },
  };
  return { messenger, calls };
}

describe('TriggerPoller — poll.sqlite', () => {
  let path: string;
  let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('fire_when=rows_returned: fires when SQL returns rows, dispatches notification', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY, label TEXT)`);
    db.raw.prepare(`INSERT INTO probes (label) VALUES ('hit-1'), ('hit-2')`).run();
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT id, label FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    const processed = await poller.tickOnce();

    expect(processed).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].chatJid).toBe('admin@s.whatsapp.net');
    expect(calls[0].text).toContain('Watch fired');
    expect(calls[0].text).toContain('2 rows');

    const runs = db.raw.prepare(`SELECT status, output_summary, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_summary: string; output_json: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('ok');
    expect(runs[0].output_summary).toContain('2 rows');
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ rowCount: 2, deliveredWaMessageId: 'wa-1' });

    const refreshed = db.raw.prepare(`SELECT next_fire_at, last_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { next_fire_at: number; last_fire_at: number };
    expect(refreshed.next_fire_at).toBe(1_000_000_001 + 60);
    expect(refreshed.last_fire_at).toBe(1_000_000_001);
  });

  it('fire_when=rows_returned: does NOT fire on 0 rows', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT id FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status, output_summary FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_summary: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('noop');
    expect(runs[0].output_summary).toContain('0 rows');
  });

  it('fire_when=rowcount_changed: first run with 0 rows is noop, count increase fires, stable count noops', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT id FROM probes`, fire_when: 'rowcount_changed' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    // tick 1: 0 rows, no prior run -> noop
    let poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();
    expect(calls).toHaveLength(0);

    // tick 2: insert 2 rows, count: 0 -> 2 -> fires
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(1_000_000_100, t.id);
    poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_101 });
    await poller.tickOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('rowcount changed');

    // tick 3: same count, no change -> noop
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(1_000_000_200, t.id);
    poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_201 });
    await poller.tickOnce();
    expect(calls).toHaveLength(1);
  });

  it('SQL execution failure: records status=failed, schedules retry cooldown', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    // Use intervalSeconds != FAILED_RETRY_COOLDOWN_SEC so the assertion can
    // actually distinguish "applied cooldown" from "applied normal interval".
    // The 60s normal interval would alias to the cooldown and mask a bug
    // where the production code mistakenly used t.interval_seconds on failure.
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM table_that_does_not_exist`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 300, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status, error_kind, error_message FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string; error_message: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('sql_error');
    expect(runs[0].error_message).toMatch(/table_that_does_not_exist|no such table/i);

    const refreshed = db.raw.prepare(`SELECT next_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { next_fire_at: number };
    // FAILED_RETRY_COOLDOWN_SEC = 60. interval_seconds is 300. If the
    // production code regresses to using interval_seconds on failure,
    // next_fire_at would be 1_000_000_301 and this expect would fail.
    expect(refreshed.next_fire_at).toBe(1_000_000_001 + 60);
  });
});

describe('TriggerPoller — schedule kinds', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('schedule.at_time: fires once, then expires', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'agent_job', title: 'one-shot', ownerJid: 'mw', actor: 'u' });
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.at_time',
      spec: { fire_at: 1_000_000_000 },
      reportChatJid: 'admin@s.whatsapp.net',
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('Scheduled fire');
    const refreshed = db.raw.prepare(`SELECT status, next_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string; next_fire_at: number | null };
    expect(refreshed.next_fire_at).toBeNull();
    expect(refreshed.status).toBe('expired');

    // Strong behavioural assertion: a second tick must not re-fire the one-shot.
    await poller.tickOnce();
    expect(calls).toHaveLength(1);
  });

  it('schedule.cron: fires and advances next_fire_at via nextCronRun', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'agent_job', title: 'cron', ownerJid: 'mw', actor: 'u' });
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.cron',
      spec: { expr: '*/5 * * * *' },
      reportChatJid: 'admin@s.whatsapp.net',
      nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('Cron tick');
    const refreshed = db.raw.prepare(`SELECT status, next_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string; next_fire_at: number };
    expect(refreshed.status).toBe('active');
    // nextCronRun for */5 from 1_000_000_001 should be the next 5-minute mark, > now
    expect(refreshed.next_fire_at).toBeGreaterThan(1_000_000_001);
  });
});

describe('TriggerPoller — terminal_at expiry', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('trigger past terminal_at is expired without execution', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      requestedTerminalAt: 999_999_999,  // already in the past relative to tick's now
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    expect(calls).toHaveLength(1);  // expiry notification fires when on_terminal=notify (default)
    expect(calls[0].text).toContain('Watch expired');

    const runs = db.raw.prepare(`SELECT status, output_summary FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_summary: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('terminal_fired');
    expect(runs[0].output_summary).toContain('terminal_at_reached');

    const refreshed = db.raw.prepare(`SELECT status FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string };
    expect(refreshed.status).toBe('expired');

    const eventKinds = (db.raw.prepare(`SELECT event_type FROM bead_events WHERE bead_id = ?`).all(bead.id) as Array<{ event_type: string }>).map(e => e.event_type);
    expect(eventKinds).toContain('trigger_expired');
  });

  it('expired trigger does not appear in subsequent dueTriggers calls', async () => {
    const { messenger } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      requestedTerminalAt: 999_999_999,
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    // Second tick: poller should not pick up the now-expired trigger
    const processed2 = await poller.tickOnce();
    expect(processed2).toBe(0);
  });
});

describe('TriggerPoller — not-yet-implemented kinds', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('poll.shell records noop with not_implemented reason and bumps next_fire_at by 1h cooldown', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.shell',
      spec: { argv: ['/bin/true'], fire_when: 'exit_zero' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs[0].status).toBe('noop');
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ reason: 'not_implemented' });

    const refreshed = db.raw.prepare(`SELECT next_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { next_fire_at: number };
    expect(refreshed.next_fire_at).toBe(1_000_000_001 + 3_600);
  });
});

describe('TriggerPoller — messenger failure tolerance', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('dispatch failure does not throw out of processTrigger; run is still recorded', async () => {
    const { messenger, calls } = makeFailingMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await expect(poller.tickOnce()).resolves.toBe(1);
    expect(calls).toHaveLength(1);  // attempted

    const runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs[0].status).toBe('ok');  // SQL ran fine
    expect(JSON.parse(runs[0].output_json).deliveredWaMessageId).toBeUndefined();  // dispatch failed
  });
});

describe('TriggerPoller — start/stop lifecycle', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('start() schedules a tick; stop() cancels it; double-start logs warn but does not schedule twice', () => {
    const { messenger } = makeMessenger();
    const scheduledCalls: Array<{ ms: number }> = [];
    let lastTimer = 0;
    const fakeSetTimeout = ((_fn: () => void, ms: number) => {
      scheduledCalls.push({ ms });
      lastTimer += 1;
      return lastTimer as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    const cleared: number[] = [];
    const fakeClearTimeout = ((id: NodeJS.Timeout) => { cleared.push(id as unknown as number); }) as typeof clearTimeout;

    const poller = new TriggerPoller(db.raw, messenger, {
      intervalMs: 5_000,
      setTimeoutImpl: fakeSetTimeout,
      clearTimeoutImpl: fakeClearTimeout,
    });

    poller.start();
    expect(scheduledCalls).toHaveLength(1);
    expect(scheduledCalls[0].ms).toBe(5_000);

    poller.start();  // second start
    expect(scheduledCalls).toHaveLength(1);

    poller.stop();
    expect(cleared).toHaveLength(1);
  });
});

describe('TriggerPoller — circuit breaker', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('pauses a trigger after maxConsecutiveFailures consecutive SQL failures', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'flaky', ownerJid: 'mw', actor: 'u' });
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM table_that_does_not_exist`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 300, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    // Override max to 2 so the test runs in 2 ticks instead of 5.
    let now = 1_000_000_001;
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => now,
      maxConsecutiveFailures: 2,
    });

    // Failure 1 — trigger still active, next_fire_at bumped by FAILED_RETRY_COOLDOWN_SEC.
    await poller.tickOnce();
    const afterFirst = db.raw.prepare(`SELECT status FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string };
    expect(afterFirst.status).toBe('active');

    // Failure 2 — count reaches 2, trigger paused with notification.
    now = 1_000_000_100;
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(now - 1, t.id);
    await poller.tickOnce();

    const refreshed = db.raw.prepare(`SELECT status, next_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string; next_fire_at: number | null };
    expect(refreshed.status).toBe('paused');
    expect(refreshed.next_fire_at).toBeNull();

    const pauseEvents = db.raw.prepare(`SELECT event_type, payload_json FROM bead_events WHERE bead_id = ? AND event_type = 'trigger_paused'`).all(bead.id) as Array<{ event_type: string; payload_json: string }>;
    expect(pauseEvents).toHaveLength(1);
    expect(JSON.parse(pauseEvents[0].payload_json)).toMatchObject({ reason: 'consecutive_failures' });

    expect(calls.some(c => c.text.includes('paused') && c.text.includes('consecutive'))).toBe(true);

    // Third tick: paused trigger is not due, returns 0.
    now = 1_000_000_200;
    const processed = await poller.tickOnce();
    expect(processed).toBe(0);
  });

  it('does NOT pause when a success resets the consecutive-failure streak', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'recovering', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 300, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    // First failure: drop the probes table.
    db.raw.exec(`DROP TABLE probes`);
    let now = 1_000_000_001;
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => now,
      maxConsecutiveFailures: 2,
    });
    await poller.tickOnce();

    // Recreate the table with a row — next tick succeeds and fires.
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    now = 1_000_000_100;
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(now - 1, t.id);
    await poller.tickOnce();
    expect(calls.length).toBeGreaterThanOrEqual(1);  // fired

    // Drop the table again — failure 1, but streak was reset by the success.
    // Trigger must remain active.
    db.raw.exec(`DROP TABLE probes`);
    now = 1_000_000_200;
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(now - 1, t.id);
    await poller.tickOnce();

    const refreshed = db.raw.prepare(`SELECT status FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string };
    expect(refreshed.status).toBe('active');
  });
});

describe('TriggerPoller — read-only SQL guard', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('rejects DELETE statements in spec.sql — the canary row survives', async () => {
    const { messenger } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'malicious', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY, label TEXT)`);
    db.raw.prepare(`INSERT INTO probes (label) VALUES ('canary')`).run();

    // Operator-controlled spec SQL tries to mutate the live db.
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `DELETE FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 300, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    // Canary must still exist — the DELETE was blocked by PRAGMA query_only.
    const remaining = db.raw.prepare(`SELECT COUNT(*) AS n FROM probes`).get() as { n: number };
    expect(remaining.n).toBe(1);

    const runs = db.raw.prepare(`SELECT status, error_kind, error_message FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string; error_message: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('sql_error');
    expect(runs[0].error_message).toMatch(/readonly|read-only|write/i);
  });

  it('restores write access after the spec SQL — bead_triggers UPDATE and trigger_runs INSERT still succeed', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'normal', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();

    // Innocuous read-only spec — should succeed and fire.
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 300, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    expect(calls).toHaveLength(1);

    // If query_only=ON had leaked past the spec SQL, the poller's own
    // UPDATE bead_triggers and INSERT trigger_runs would have failed.
    // Confirm both wrote successfully:
    const refreshed = db.raw.prepare(`SELECT next_fire_at, last_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { next_fire_at: number; last_fire_at: number };
    expect(refreshed.next_fire_at).toBe(1_000_000_001 + 300);  // poller's UPDATE worked
    expect(refreshed.last_fire_at).toBe(1_000_000_001);

    const runs = db.raw.prepare(`SELECT status, output_summary FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_summary: string }>;
    expect(runs).toHaveLength(1);  // INSERT worked
    expect(runs[0].status).toBe('ok');
  });
});

