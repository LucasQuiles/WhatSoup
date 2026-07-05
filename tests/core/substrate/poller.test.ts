import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  unlinkSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  utimesSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { constants as sqliteConstants } from 'node:sqlite';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import { createTrigger } from '../../../src/core/substrate/triggers.ts';
import { TriggerPoller, toBindArgs } from '../../../src/core/substrate/poller.ts';
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

    const runs = db.raw.prepare(`SELECT status, error_kind, output_summary, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string | null; output_summary: string; output_json: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('ok');
    expect(runs[0].error_kind).toBeNull();  // successful dispatch is not a notify_dispatch_failed
    expect(runs[0].output_summary).toContain('2 rows');
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ rowCount: 2, deliveredWaMessageId: 'wa-1' });

    const refreshed = db.raw.prepare(`SELECT next_fire_at, last_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { next_fire_at: number; last_fire_at: number };
    expect(refreshed.next_fire_at).toBe(1_000_000_001 + 60);
    expect(refreshed.last_fire_at).toBe(1_000_000_001);
  });

  it('continues when recording a post-dispatch receipt fails', async () => {
    const calls: Array<{ chatJid: string; text: string }> = [];
    const messenger: Messenger = {
      async sendMessage(chatJid: string, text: string): Promise<SubmissionReceipt> {
        calls.push({ chatJid, text });
        db.raw.exec(`DROP TABLE trigger_runs`);
        return { waMessageId: 'wa-after-drop' };
      },
      async sendMedia() { throw new Error('not used'); },
    };
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY, label TEXT)`);
    db.raw.prepare(`INSERT INTO probes (label) VALUES ('hit')`).run();
    createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT id, label FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await expect(poller.tickOnce()).resolves.toBe(1);

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('Watch fired');
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

  it('disables a non-scheduled trigger with no interval after a successful run', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT id FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: null, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const refreshed = db.raw.prepare(`SELECT next_fire_at, last_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { next_fire_at: number | null; last_fire_at: number };
    expect(refreshed.next_fire_at).toBeNull();
    expect(refreshed.last_fire_at).toBe(1_000_000_001);
  });

  it('QR-026: a query exceeding the MAX_SQLITE_ROWS cap fails (bounds large-result DoS)', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    // 22 rows → a 3-way cartesian join yields 22^3 = 10648 > MAX_SQLITE_ROWS (10000),
    // tripping the iterate cap WITHOUT a recursive CTE (those are rejected at validation).
    const insert = db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`);
    for (let i = 0; i < 22; i++) insert.run();
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT 1 AS one FROM probes a, probes b, probes c`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000, actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    // Capped → failed outcome, no notification dispatched.
    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status, output_summary, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_summary: string; output_json: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].output_summary).toContain('10000-row cap');
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ rowCap: 10000 });
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

  it('invalid spec_json syntax records spec_parse before validation or execution', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'invalid json', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    const now = 1_000_000_000;
    const info = db.raw.prepare(
      `INSERT INTO bead_triggers (
         bead_id, kind, spec_json, spec_version, status, interval_seconds,
         next_fire_at, last_fire_at, terminal_at, on_terminal, report_chat_jid,
         dedupe_key, created_at, updated_at
       ) VALUES (?, 'poll.sqlite', ?, 1, 'active', 300, ?, NULL, NULL, 'notify', ?, NULL, ?, ?)`,
    ).run(
      bead.id,
      '{"sql":',
      now,
      'admin@s.whatsapp.net',
      now,
      now,
    );
    const triggerId = Number(info.lastInsertRowid);

    const poller = new TriggerPoller(db.raw, messenger, { now: () => now + 1 });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(
      `SELECT status, error_kind, output_summary, output_json
       FROM trigger_runs WHERE trigger_id = ?`,
    ).all(triggerId) as Array<{ status: string; error_kind: string; output_summary: string; output_json: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('spec_parse');
    expect(runs[0].output_summary).toMatch(/not valid JSON/i);
    expect(JSON.parse(runs[0].output_json)).toEqual({});
  });

  it('invalid spec_json shape fails SPEC_REGISTRY validation before execution', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'invalid spec', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    const now = 1_000_000_000;
    const info = db.raw.prepare(
      `INSERT INTO bead_triggers (
         bead_id, kind, spec_json, spec_version, status, interval_seconds,
         next_fire_at, last_fire_at, terminal_at, on_terminal, report_chat_jid,
         dedupe_key, created_at, updated_at
       ) VALUES (?, 'poll.sqlite', ?, 1, 'active', 300, ?, NULL, NULL, 'notify', ?, NULL, ?, ?)`,
    ).run(
      bead.id,
      JSON.stringify({ sql: `SELECT * FROM probes` }),
      now,
      'admin@s.whatsapp.net',
      now,
      now,
    );
    const triggerId = Number(info.lastInsertRowid);

    const poller = new TriggerPoller(db.raw, messenger, { now: () => now + 1 });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(
      `SELECT status, error_kind, output_summary, output_json
       FROM trigger_runs WHERE trigger_id = ?`,
    ).all(triggerId) as Array<{ status: string; error_kind: string; output_summary: string; output_json: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('spec_invalid');
    expect(runs[0].output_summary).toMatch(/spec_json/i);
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ kind: 'poll.sqlite' });
  });

  it('legacy unsafe SQL specs are rejected by the runtime guard before query_only runs', () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'unsafe sql', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT id FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 300, nextFireAt: 1_000_000_000,
      actor: 'u',
    });
    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    const outcome = (poller as unknown as {
      executeSqlite(trigger: typeof t, spec: { sql: string; fire_when: 'rows_returned' }): {
        status: string;
        fired: boolean;
        outputSummary: string;
        outputJson: Record<string, unknown>;
        errorKind?: string;
      };
    }).executeSqlite(t, { sql: 'PRAGMA user_version', fire_when: 'rows_returned' });

    expect(calls).toHaveLength(0);
    expect(outcome).toMatchObject({
      status: 'failed',
      fired: false,
      outputSummary: 'unsafe SQL rejected',
      outputJson: { reason: 'unsafe_sql' },
      errorKind: 'unsafe_sql',
    });
  });

  it('rowcount_changed treats malformed prior output_json as no prior rowcount', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'malformed rowcount', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT id FROM probes`, fire_when: 'rowcount_changed' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      actor: 'u',
    });
    db.raw.prepare(
      `INSERT INTO trigger_runs (
         trigger_id, bead_id, status, started_at, finished_at, duration_ms,
         output_summary, output_json, attempt, metadata_json
       ) VALUES (?, ?, 'ok', ?, ?, 0, 'legacy malformed', ?, 1, '{}')`,
    ).run(t.id, bead.id, 999_999_990, 999_999_991, '{not-json');

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    expect(calls).toHaveLength(1);
    const latest = db.raw.prepare(
      `SELECT status, output_summary, output_json FROM trigger_runs
       WHERE trigger_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(t.id) as { status: string; output_summary: string; output_json: string };
    expect(latest.status).toBe('ok');
    expect(latest.output_summary).toContain('first run -> 1');
    expect(JSON.parse(latest.output_json)).toMatchObject({ rowCount: 1, lastRowCount: null });
  });

  it('executor throws are converted into failed trigger runs and retry cooldowns', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'executor throw', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT id FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 300, nextFireAt: 1_000_000_000,
      actor: 'u',
    });
    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    vi.spyOn(
      poller as unknown as { executeTrigger(trigger: unknown): Promise<unknown> },
      'executeTrigger',
    ).mockRejectedValueOnce(new Error('executor crashed'));

    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const run = db.raw.prepare(
      `SELECT status, error_kind, error_message FROM trigger_runs WHERE trigger_id = ?`,
    ).get(t.id) as { status: string; error_kind: string; error_message: string };
    expect(run).toMatchObject({ status: 'failed', error_kind: 'execute_throw' });
    expect(run.error_message).toContain('executor crashed');
    const refreshed = db.raw.prepare(`SELECT next_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { next_fire_at: number };
    expect(refreshed.next_fire_at).toBe(1_000_000_001 + 60);
  });

  it("on_terminal='silent' still dispatches normal fire notifications", async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'silent terminal only', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      onTerminal: 'silent',
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('Watch fired');
    const runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs[0].status).toBe('ok');
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ deliveredWaMessageId: 'wa-1' });
  });

  it('records delivered receipt without a standalone trigger_runs SELECT', () => {
    const { messenger } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'atomic receipt', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    const trigger = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      actor: 'u',
    });
    const info = db.raw.prepare(
      `INSERT INTO trigger_runs (
         trigger_id, bead_id, status, started_at, finished_at, duration_ms,
         output_summary, output_json, attempt, metadata_json
       ) VALUES (?, ?, 'ok', ?, ?, 0, 'ok', ?, 1, '{}')`,
    ).run(trigger.id, bead.id, 1_000_000_000, 1_000_000_001, JSON.stringify({ rowCount: 2 }));
    const runId = Number(info.lastInsertRowid);
    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });

    db.raw.setAuthorizer((actionCode) => (
      actionCode === sqliteConstants.SQLITE_SELECT
        ? sqliteConstants.SQLITE_DENY
        : sqliteConstants.SQLITE_OK
    ));
    try {
      (poller as unknown as {
        recordDeliveredWaMessageId(runId: number, deliveredWaId: string): void;
      }).recordDeliveredWaMessageId(runId, 'wa-atomic');
    } finally {
      db.raw.setAuthorizer(null);
    }

    const row = db.raw.prepare(`SELECT output_json FROM trigger_runs WHERE id = ?`).get(runId) as { output_json: string };
    expect(JSON.parse(row.output_json)).toMatchObject({ rowCount: 2, deliveredWaMessageId: 'wa-atomic' });
  });

  it('rolls back run writes and does not notify when rescheduling fails', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'atomic', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      actor: 'u',
    });
    db.raw.exec(`
      CREATE TRIGGER fail_bead_trigger_update
      BEFORE UPDATE ON bead_triggers
      BEGIN
        SELECT RAISE(ABORT, 'blocked trigger update');
      END;
    `);

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    const runs = db.raw.prepare(`SELECT status FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string }>;
    expect(runs).toHaveLength(0);
    expect(calls).toHaveLength(0);
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

  it('legacy malformed cron spec records failure and uses retry cooldown for next_fire_at', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'agent_job', title: 'bad cron', ownerJid: 'mw', actor: 'u' });
    const now = 1_000_000_000;
    const info = db.raw.prepare(
      `INSERT INTO bead_triggers (
         bead_id, kind, spec_json, spec_version, status, interval_seconds,
         next_fire_at, last_fire_at, terminal_at, on_terminal, report_chat_jid,
         dedupe_key, created_at, updated_at
       ) VALUES (?, 'schedule.cron', ?, 1, 'active', NULL, ?, NULL, NULL, 'notify', ?, NULL, ?, ?)`,
    ).run(bead.id, '{"expr":', now, 'admin@s.whatsapp.net', now, now);
    const triggerId = Number(info.lastInsertRowid);

    const poller = new TriggerPoller(db.raw, messenger, { now: () => now + 1 });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const run = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).get(triggerId) as { status: string; error_kind: string };
    expect(run).toMatchObject({ status: 'failed', error_kind: 'spec_parse' });
    const refreshed = db.raw.prepare(`SELECT next_fire_at FROM bead_triggers WHERE id = ?`).get(triggerId) as { next_fire_at: number };
    expect(refreshed.next_fire_at).toBe(now + 1 + 60);
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

  it("on_terminal='reopen_bead' reactivates a terminal bead at expiry", async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, {
      kind: 'watch',
      title: 'reopen me',
      ownerJid: 'mw',
      status: 'completed',
      actor: 'u',
    });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      requestedTerminalAt: 999_999_999,
      onTerminal: 'reopen_bead',
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const refreshed = db.raw.prepare(`SELECT status, completed_at FROM beads WHERE id = ?`).get(bead.id) as { status: string; completed_at: number | null };
    expect(refreshed.status).toBe('active');
    expect(refreshed.completed_at).toBeNull();
    const events = db.raw.prepare(
      `SELECT event_type, payload_json, actor FROM bead_events
       WHERE bead_id = ? ORDER BY id ASC`,
    ).all(bead.id) as Array<{ event_type: string; payload_json: string; actor: string }>;
    expect(events.some((event) => event.event_type === 'trigger_expired')).toBe(true);
    expect(events.some((event) => {
      if (event.event_type !== 'status_change') return false;
      const payload = JSON.parse(event.payload_json);
      return payload.from === 'completed' && payload.to === 'active' && payload.reason === 'trigger_terminal_reopen';
    })).toBe(true);
    const runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('terminal_fired');
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ on_terminal: 'reopen_bead' });
  });

  it("rolls back the whole expiry when reopen_bead's status_change event fails", async () => {
    const { messenger } = makeMessenger();
    const bead = createBead(db.raw, {
      kind: 'watch',
      title: 'atomic reopen',
      ownerJid: 'mw',
      status: 'completed',
      actor: 'u',
    });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      requestedTerminalAt: 999_999_999,
      onTerminal: 'reopen_bead',
      actor: 'u',
    });
    db.raw.exec(`
      CREATE TRIGGER fail_reopen_status_change
      BEFORE INSERT ON bead_events
      WHEN NEW.event_type = 'status_change' AND NEW.actor = 'trigger-poller'
      BEGIN
        SELECT RAISE(ABORT, 'blocked reopen status_change');
      END;
    `);

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    const refreshedBead = db.raw.prepare(`SELECT status FROM beads WHERE id = ?`).get(bead.id) as { status: string };
    expect(refreshedBead.status).toBe('completed');
    const refreshedTrigger = db.raw.prepare(`SELECT status, next_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string; next_fire_at: number | null };
    expect(refreshedTrigger.status).toBe('active');
    expect(refreshedTrigger.next_fire_at).toBe(1_000_000_000);
    const runs = db.raw.prepare(`SELECT status FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string }>;
    expect(runs).toHaveLength(0);
    const triggerExpiredEvents = db.raw.prepare(
      `SELECT id FROM bead_events WHERE bead_id = ? AND event_type = 'trigger_expired'`,
    ).all(bead.id) as Array<{ id: number }>;
    expect(triggerExpiredEvents).toHaveLength(0);
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

  it('poll.email records noop with not_implemented reason and bumps next_fire_at by 1h cooldown', async () => {
    // poll.email remains deferred (no executor); it is the canonical
    // still-not-implemented kind now that poll.shell is removed and
    // poll.url/file/pinecone are wired.
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.email',
      spec: { source: 'gmail', sender: 'invoices-sender-invalid' },
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

  it('a LEGACY event.message row with a non-null next_fire_at fails closed and is NOT rescheduled on the 1h cooldown', async () => {
    // event.message is a reserved scaffold; fresh rows persist with
    // next_fire_at=NULL so the poller never sees them. This forces the legacy
    // shape (non-null next_fire_at) via a direct UPDATE and proves the
    // defensive exec-time branch: fail CLOSED + clear next_fire_at (stop
    // polling), NOT a silent 1h not_implemented reschedule.
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'msg', ownerJid: 'mw', actor: 'u' });
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'event.message',
      spec: { match: 'sender_jid', value: '123@s.whatsapp.net' },
      reportChatJid: 'admin@s.whatsapp.net', intervalSeconds: 60, actor: 'u',
    });
    // Created inert (NULL); simulate a legacy row by force-arming it.
    expect((db.raw.prepare(`SELECT next_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { next_fire_at: number | null }).next_fire_at).toBeNull();
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(1_000_000_000, t.id);

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs[0].status).toBe('failed');
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ reason: 'event_message_not_polled' });

    // Not rescheduled on ANY cooldown — next_fire_at cleared (stops polling)
    // and the row stays active (it TTL-expires via the sweep, not here).
    const refreshed = db.raw.prepare(`SELECT status, next_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string; next_fire_at: number | null };
    expect(refreshed).toMatchObject({ status: 'active', next_fire_at: null });
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

    const runs = db.raw.prepare(`SELECT status, error_kind, error_message, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string | null; error_message: string | null; output_json: string }>;
    // The trigger evaluation succeeded, so status stays 'ok' — a fired-but-
    // undelivered run must NOT be masqueraded as an execute failure.
    expect(runs[0].status).toBe('ok');  // SQL ran fine
    expect(JSON.parse(runs[0].output_json).deliveredWaMessageId).toBeUndefined();  // dispatch failed
    // ...but the delivery failure is now observable: error_kind marks it so it
    // is distinguishable in telemetry from a throttled (never-attempted) run.
    expect(runs[0].error_kind).toBe('notify_dispatch_failed');
    expect(runs[0].error_message).toBeNull();  // no free-text; kind carries the signal
  });

  it('recordNotifyDispatchFailed never clobbers an existing error_kind classification', () => {
    const { messenger } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT 1`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      actor: 'u',
    });
    const inserted = db.raw.prepare(
      `INSERT INTO trigger_runs (
         trigger_id, bead_id, status, started_at, finished_at, duration_ms,
         output_summary, output_json, attempt, metadata_json, error_kind
       ) VALUES (?, ?, 'failed', ?, ?, 0, 'execute failed', '{}', 1, '{}', 'timeout')`,
    ).run(t.id, bead.id, 999_999_990, 999_999_991);
    const runId = Number(inserted.lastInsertRowid);

    // Today every fired:true outcome writes error_kind=NULL in the same
    // transaction, so the public flow cannot reach this state — the WHERE
    // guard is defense-in-depth so a future outcome type that fires with a
    // pre-set error_kind cannot have its classification silently replaced.
    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    (poller as unknown as { recordNotifyDispatchFailed(runId: number): void })
      .recordNotifyDispatchFailed(runId);

    const row = db.raw.prepare(
      `SELECT error_kind FROM trigger_runs WHERE id = ?`,
    ).get(runId) as { error_kind: string | null };
    expect(row.error_kind).toBe('timeout');
  });
});

describe('TriggerPoller — poll.pinecone', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  function makePineconeTrigger(spec: Record<string, unknown>) {
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    return createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.pinecone',
      spec,
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      actor: 'u',
    });
  }

  it('fires ok when top match score >= threshold; outputJson is scalar matchCount/topScore (no record bodies)', async () => {
    const { messenger, calls } = makeMessenger();
    const search = vi.fn(
      async (_args: { index: string; namespace: string; query: string; topK: number }) => ({
        matches: [{ score: 0.92 }, { score: 0.41 }],
      }),
    );
    const t = makePineconeTrigger({ index: 'mw-mind', namespace: 'ns_facts', query: 'urgent invoice', threshold: 0.8 });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      pineconeAllowedIndexes: ['mw-mind'],
      pineconeSearch: search,
    });
    await poller.tickOnce();

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toMatchObject({ index: 'mw-mind', namespace: 'ns_facts', query: 'urgent invoice' });
    expect(calls).toHaveLength(1);
    const runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs[0].status).toBe('ok');
    const oj = JSON.parse(runs[0].output_json);
    expect(oj).toMatchObject({ matchCount: 2, topScore: 0.92 });
    // No record bodies / arrays leaked into output_json.
    expect(oj.matches).toBeUndefined();
    expect(typeof oj.topScore).toBe('number');
  });

  it('noop when top score is below threshold', async () => {
    const { messenger, calls } = makeMessenger();
    const search = vi.fn(async () => ({ matches: [{ score: 0.41 }] }));
    const t = makePineconeTrigger({ index: 'mw-mind', namespace: 'ns_facts', query: 'q', threshold: 0.8 });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      pineconeAllowedIndexes: ['mw-mind'],
      pineconeSearch: search,
    });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs[0].status).toBe('noop');
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ matchCount: 1, topScore: 0.41 });
  });

  it('uses a singular Pinecone summary for exactly one firing match', async () => {
    const { messenger, calls } = makeMessenger();
    const search = vi.fn(async () => ({ matches: [{ score: 0.91 }] }));
    const t = makePineconeTrigger({ index: 'mw-mind', namespace: 'ns_facts', query: 'q', threshold: 0.8 });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      pineconeAllowedIndexes: ['mw-mind'],
      pineconeSearch: search,
    });
    await poller.tickOnce();

    expect(calls).toHaveLength(1);
    const run = db.raw.prepare(`SELECT status, output_summary, output_json FROM trigger_runs WHERE trigger_id = ?`).get(t.id) as { status: string; output_summary: string; output_json: string };
    expect(run.status).toBe('ok');
    expect(run.output_summary).toContain('pinecone matched 1 result');
    expect(run.output_summary).not.toContain('1 results');
    expect(JSON.parse(run.output_json)).toMatchObject({ matchCount: 1, topScore: 0.91 });
  });

  it('with no threshold, fires when results.length > 0 and noops on zero results', async () => {
    const { messenger } = makeMessenger();
    const search = vi.fn(async () => ({ matches: [{ score: 0.1 }] }));
    const t1 = makePineconeTrigger({ index: 'mw-mind', namespace: 'ns_facts', query: 'q1' });
    const poller1 = new TriggerPoller(db.raw, makeMessenger().messenger, {
      now: () => 1_000_000_001, pineconeAllowedIndexes: ['mw-mind'], pineconeSearch: search,
    });
    void poller1;
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001, pineconeAllowedIndexes: ['mw-mind'], pineconeSearch: search,
    });
    await poller.tickOnce();
    let runs = db.raw.prepare(`SELECT status FROM trigger_runs WHERE trigger_id = ?`).all(t1.id) as Array<{ status: string }>;
    expect(runs[0].status).toBe('ok');

    const emptySearch = vi.fn(async () => ({ matches: [] as Array<{ score: number }> }));
    const t2 = makePineconeTrigger({ index: 'mw-mind', namespace: 'ns_facts', query: 'q2' });
    const poller2 = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_002, pineconeAllowedIndexes: ['mw-mind'], pineconeSearch: emptySearch,
    });
    await poller2.tickOnce();
    runs = db.raw.prepare(`SELECT status FROM trigger_runs WHERE trigger_id = ?`).all(t2.id) as Array<{ status: string }>;
    expect(runs[0].status).toBe('noop');
  });

  it('rejects a disallowed index fail-closed with errorKind index_not_allowed (search never called)', async () => {
    const { messenger, calls } = makeMessenger();
    const search = vi.fn(async () => ({ matches: [{ score: 1 }] }));
    const t = makePineconeTrigger({ index: 'secret-index', namespace: 'ns', query: 'q' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      pineconeAllowedIndexes: ['mw-mind'],
      pineconeSearch: search,
    });
    await poller.tickOnce();

    expect(search).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('index_not_allowed');
  });

  it('empty allowed-index list denies all (fail-closed)', async () => {
    const { messenger } = makeMessenger();
    const search = vi.fn(async () => ({ matches: [{ score: 1 }] }));
    const t = makePineconeTrigger({ index: 'mw-mind', namespace: 'ns', query: 'q' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      pineconeAllowedIndexes: [],
      pineconeSearch: search,
    });
    await poller.tickOnce();

    expect(search).not.toHaveBeenCalled();
    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('index_not_allowed');
  });

  it('fails with pinecone_unavailable when no search client is configured', async () => {
    const { messenger } = makeMessenger();
    const t = makePineconeTrigger({ index: 'mw-mind', namespace: 'ns', query: 'q' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      pineconeAllowedIndexes: ['mw-mind'],
      // no pineconeSearch
    });
    await poller.tickOnce();

    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('pinecone_unavailable');
  });

  it('fails with pinecone_error when the search client throws', async () => {
    const { messenger, calls } = makeMessenger();
    const search = vi.fn(async () => {
      throw new Error('pinecone offline');
    });
    const t = makePineconeTrigger({ index: 'mw-mind', namespace: 'ns', query: 'q' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      pineconeAllowedIndexes: ['mw-mind'],
      pineconeSearch: search,
    });
    await poller.tickOnce();

    expect(search).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(
      `SELECT status, error_kind, error_message, output_json FROM trigger_runs WHERE trigger_id = ?`,
    ).all(t.id) as Array<{ status: string; error_kind: string; error_message: string; output_json: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('pinecone_error');
    expect(runs[0].error_message).toContain('pinecone offline');
    expect(JSON.parse(runs[0].output_json)).toEqual({ index: 'mw-mind' });
  });

  it('treats sparse Pinecone responses with non-array matches as an empty noop', async () => {
    const { messenger, calls } = makeMessenger();
    const search = vi.fn(async () => ({ matches: null as unknown as Array<{ score: number }> }));
    const t = makePineconeTrigger({ index: 'mw-mind', namespace: 'ns', query: 'q' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      pineconeAllowedIndexes: ['mw-mind'],
      pineconeSearch: search,
    });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs[0].status).toBe('noop');
    expect(JSON.parse(runs[0].output_json)).toEqual({ matchCount: 0, topScore: null });
  });
});

describe('TriggerPoller — poll.file', () => {
  let path: string; let db: Database;
  let root: string;
  beforeEach(() => {
    path = tmpFile(); db = new Database(path); db.open();
    root = mkdtempSync(join(tmpdir(), 'pollfile-root-'));
  });
  afterEach(() => {
    db.close(); if (existsSync(path)) unlinkSync(path);
    rmSync(root, { recursive: true, force: true });
  });

  function makeFileTrigger(spec: Record<string, unknown>, nextFireAt = 1_000_000_000) {
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    return createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.file',
      spec,
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt,
      actor: 'u',
    });
  }

  it('watch=exists: fires when the file is present (stateless)', async () => {
    const { messenger, calls } = makeMessenger();
    const filePath = join(root, 'present.txt');
    writeFileSync(filePath, 'hi');
    const t = makeFileTrigger({ path: filePath, watch: 'exists' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      fileWatchAllowedRoots: [root],
    });
    await poller.tickOnce();

    expect(calls).toHaveLength(1);
    const runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs[0].status).toBe('ok');
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ exists: true });
  });

  it('watch=exists: noop when the file is absent', async () => {
    const { messenger, calls } = makeMessenger();
    const filePath = join(root, 'absent.txt');
    const t = makeFileTrigger({ path: filePath, watch: 'exists' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      fileWatchAllowedRoots: [root],
    });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string }>;
    expect(runs[0].status).toBe('noop');
  });

  it('allows a root that is created after the poller is constructed', async () => {
    const { messenger, calls } = makeMessenger();
    const futureRoot = join(root, 'future-root');
    const filePath = join(futureRoot, 'created-later.txt');
    const t = makeFileTrigger({ path: filePath, watch: 'exists' });
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      fileWatchAllowedRoots: [futureRoot],
    });

    mkdirSync(futureRoot);
    writeFileSync(filePath, 'created after constructor');
    await poller.tickOnce();

    expect(calls).toHaveLength(1);
    const run = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).get(t.id) as { status: string; output_json: string };
    expect(run.status).toBe('ok');
    expect(JSON.parse(run.output_json)).toMatchObject({ exists: true });
  });

  it('watch=mtime: fires when mtime changes, noop when unchanged', async () => {
    const { messenger } = makeMessenger();
    const filePath = join(root, 'm.txt');
    writeFileSync(filePath, 'a');
    utimesSync(filePath, new Date(1000), new Date(1000));
    const t = makeFileTrigger({ path: filePath, watch: 'mtime' });

    // run 1: first observation -> fires (no prior state)
    let poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, fileWatchAllowedRoots: [root] });
    await poller.tickOnce();
    let runs = db.raw.prepare(`SELECT status FROM trigger_runs WHERE trigger_id = ? ORDER BY id`).all(t.id) as Array<{ status: string }>;
    expect(runs[runs.length - 1].status).toBe('ok');

    // run 2: same mtime -> noop
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(1_000_000_100, t.id);
    poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_101, fileWatchAllowedRoots: [root] });
    await poller.tickOnce();
    runs = db.raw.prepare(`SELECT status FROM trigger_runs WHERE trigger_id = ? ORDER BY id`).all(t.id) as Array<{ status: string }>;
    expect(runs[runs.length - 1].status).toBe('noop');

    // run 3: bump mtime -> fires
    utimesSync(filePath, new Date(5000), new Date(5000));
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(1_000_000_200, t.id);
    poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_201, fileWatchAllowedRoots: [root] });
    await poller.tickOnce();
    runs = db.raw.prepare(`SELECT status FROM trigger_runs WHERE trigger_id = ? ORDER BY id`).all(t.id) as Array<{ status: string }>;
    expect(runs[runs.length - 1].status).toBe('ok');
  });

  it('watch=content_hash: fires on content change, noop when content unchanged', async () => {
    const { messenger } = makeMessenger();
    const filePath = join(root, 'c.txt');
    writeFileSync(filePath, 'original');
    const t = makeFileTrigger({ path: filePath, watch: 'content_hash' });

    // run 1: first observation -> fires
    let poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, fileWatchAllowedRoots: [root] });
    await poller.tickOnce();
    let runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ? ORDER BY id`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs[runs.length - 1].status).toBe('ok');
    // hash must not be leaked as file content; only scalar markers allowed
    const oj = JSON.parse(runs[runs.length - 1].output_json);
    expect(oj).toMatchObject({ exists: true });
    expect(typeof oj.hashChanged).toBe('boolean');

    // run 2: same content (but bump mtime to prove it is content-keyed, not mtime) -> noop
    utimesSync(filePath, new Date(9000), new Date(9000));
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(1_000_000_100, t.id);
    poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_101, fileWatchAllowedRoots: [root] });
    await poller.tickOnce();
    runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ? ORDER BY id`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs[runs.length - 1].status).toBe('noop');

    // run 3: change content -> fires
    writeFileSync(filePath, 'changed');
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(1_000_000_200, t.id);
    poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_201, fileWatchAllowedRoots: [root] });
    await poller.tickOnce();
    runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ? ORDER BY id`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs[runs.length - 1].status).toBe('ok');
  });

  it('SECURITY: a path outside every allowed root is rejected fail-closed (path_not_allowed)', async () => {
    const { messenger, calls } = makeMessenger();
    const outside = mkdtempSync(join(tmpdir(), 'pollfile-outside-'));
    const filePath = join(outside, 'secret.txt');
    writeFileSync(filePath, 'x');
    const t = makeFileTrigger({ path: filePath, watch: 'exists' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      fileWatchAllowedRoots: [root],
    });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('path_not_allowed');
    rmSync(outside, { recursive: true, force: true });
  });

  it('SECURITY: a symlink whose target escapes the allowed root is rejected (path_not_allowed)', async () => {
    const { messenger } = makeMessenger();
    const outside = mkdtempSync(join(tmpdir(), 'pollfile-symtarget-'));
    const realTarget = join(outside, 'real.txt');
    writeFileSync(realTarget, 'secret');
    const linkPath = join(root, 'link.txt'); // resides under root, but points outside
    symlinkSync(realTarget, linkPath);
    const t = makeFileTrigger({ path: linkPath, watch: 'exists' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      fileWatchAllowedRoots: [root],
    });
    await poller.tickOnce();

    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('path_not_allowed');
    rmSync(outside, { recursive: true, force: true });
  });

  it('SECURITY: empty allowed-root set denies all (deny-all default, inverted from the hook fail-open)', async () => {
    const { messenger } = makeMessenger();
    const filePath = join(root, 'present.txt');
    writeFileSync(filePath, 'hi');
    const t = makeFileTrigger({ path: filePath, watch: 'exists' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      fileWatchAllowedRoots: [],
    });
    await poller.tickOnce();

    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('path_not_allowed');
  });

  it('SECURITY: /proc/... is rejected even if an allowed root is /', async () => {
    const { messenger } = makeMessenger();
    const t = makeFileTrigger({ path: '/proc/self/stat', watch: 'exists' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      fileWatchAllowedRoots: ['/'],
    });
    await poller.tickOnce();

    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('path_not_allowed');
  });

  it('SECURITY: an absent /dev target is rejected before it can act as an existence oracle', async () => {
    const { messenger, calls } = makeMessenger();
    const missingDevicePath = `/dev/whatsoup-missing-${randomBytes(8).toString('hex')}`;
    const t = makeFileTrigger({ path: missingDevicePath, watch: 'exists' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      fileWatchAllowedRoots: ['/'],
    });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const run = db.raw.prepare(`SELECT status, error_kind, output_json FROM trigger_runs WHERE trigger_id = ?`).get(t.id) as { status: string; error_kind: string; output_json: string };
    expect(run.status).toBe('failed');
    expect(run.error_kind).toBe('path_not_allowed');
    expect(JSON.parse(run.output_json)).toMatchObject({ reason: 'path_not_allowed' });
  });

  it('SECURITY: an absent path under a symlinked denied ancestor is rejected', async () => {
    const { messenger, calls } = makeMessenger();
    const deviceLink = join(root, 'device-link');
    symlinkSync('/dev', deviceLink);
    const t = makeFileTrigger({ path: join(deviceLink, `missing-${randomBytes(8).toString('hex')}`), watch: 'exists' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      fileWatchAllowedRoots: ['/'],
    });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const run = db.raw.prepare(`SELECT status, error_kind, output_json FROM trigger_runs WHERE trigger_id = ?`).get(t.id) as { status: string; error_kind: string; output_json: string };
    expect(run.status).toBe('failed');
    expect(run.error_kind).toBe('path_not_allowed');
    expect(JSON.parse(run.output_json)).toMatchObject({ reason: 'path_not_allowed' });
  });

  it('SECURITY: a non-regular file (directory) is rejected', async () => {
    const { messenger } = makeMessenger();
    const dirPath = join(root, 'subdir');
    mkdirSync(dirPath);
    const t = makeFileTrigger({ path: dirPath, watch: 'exists' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      fileWatchAllowedRoots: [root],
    });
    await poller.tickOnce();

    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('path_not_allowed');
  });

  it('SECURITY: an absent path outside allowed roots is rejected instead of becoming an existence oracle', async () => {
    const { messenger, calls } = makeMessenger();
    const outside = mkdtempSync(join(tmpdir(), 'pollfile-absent-outside-'));
    const filePath = join(outside, 'missing.txt');
    const t = makeFileTrigger({ path: filePath, watch: 'exists' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      fileWatchAllowedRoots: [root],
    });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status, error_kind, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string; output_json: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('path_not_allowed');
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ reason: 'path_not_allowed' });
    rmSync(outside, { recursive: true, force: true });
  });

  it('SECURITY: an absent path is denied when the file-watch allowlist is empty', async () => {
    const { messenger } = makeMessenger();
    const filePath = join(root, 'missing-empty-allowlist.txt');
    const t = makeFileTrigger({ path: filePath, watch: 'exists' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      fileWatchAllowedRoots: [],
    });
    await poller.tickOnce();

    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('path_not_allowed');
  });

  it('watch=mtime ignores malformed prior output_json and records the current mtime as first run', async () => {
    const { messenger } = makeMessenger();
    const filePath = join(root, 'mtime-malformed.txt');
    writeFileSync(filePath, 'a');
    utimesSync(filePath, new Date(7000), new Date(7000));
    const t = makeFileTrigger({ path: filePath, watch: 'mtime' });
    db.raw.prepare(
      `INSERT INTO trigger_runs (
         trigger_id, bead_id, status, started_at, finished_at, duration_ms,
         output_summary, output_json, attempt, metadata_json
       ) VALUES (?, ?, 'ok', ?, ?, 0, 'legacy malformed', ?, 1, '{}')`,
    ).run(t.id, t.bead_id, 999_999_990, 999_999_991, '{not-json');

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, fileWatchAllowedRoots: [root] });
    await poller.tickOnce();

    const latest = db.raw.prepare(
      `SELECT status, output_summary, output_json FROM trigger_runs
       WHERE trigger_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(t.id) as { status: string; output_summary: string; output_json: string };
    expect(latest.status).toBe('ok');
    expect(latest.output_summary).toContain('first run');
    expect(JSON.parse(latest.output_json)).toMatchObject({ exists: true, mtime: 7_000 });
  });

  it('watch=content_hash ignores malformed prior output_json and records a first-run hash', async () => {
    const { messenger } = makeMessenger();
    const filePath = join(root, 'hash-malformed.txt');
    writeFileSync(filePath, 'hash me');
    const t = makeFileTrigger({ path: filePath, watch: 'content_hash' });
    db.raw.prepare(
      `INSERT INTO trigger_runs (
         trigger_id, bead_id, status, started_at, finished_at, duration_ms,
         output_summary, output_json, attempt, metadata_json
       ) VALUES (?, ?, 'ok', ?, ?, 0, 'legacy malformed', ?, 1, '{}')`,
    ).run(t.id, t.bead_id, 999_999_990, 999_999_991, '{not-json');

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, fileWatchAllowedRoots: [root] });
    await poller.tickOnce();

    const latest = db.raw.prepare(
      `SELECT status, output_summary, output_json FROM trigger_runs
       WHERE trigger_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(t.id) as { status: string; output_summary: string; output_json: string };
    expect(latest.status).toBe('ok');
    expect(latest.output_summary).toBe('content hash recorded (first run)');
    const parsed = JSON.parse(latest.output_json);
    expect(parsed.hashChanged).toBe(true);
    expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('watch=content_hash caps large file reads while still producing a stable digest marker', async () => {
    const { messenger } = makeMessenger();
    const filePath = join(root, 'large.txt');
    writeFileSync(filePath, Buffer.alloc(16 * 1024 * 1024 + 1024, 0x61));
    const t = makeFileTrigger({ path: filePath, watch: 'content_hash' });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, fileWatchAllowedRoots: [root] });
    await poller.tickOnce();

    const run = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).get(t.id) as { status: string; output_json: string };
    expect(run.status).toBe('ok');
    const parsed = JSON.parse(run.output_json);
    expect(parsed).toMatchObject({ exists: true, hashChanged: true });
    expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('watch=content_hash records hash_error when a readable stat becomes an unreadable stream', async () => {
    const { messenger, calls } = makeMessenger();
    const filePath = join(root, 'unreadable.txt');
    writeFileSync(filePath, 'secret');
    chmodSync(filePath, 0);
    const t = makeFileTrigger({ path: filePath, watch: 'content_hash' });

    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      fileWatchAllowedRoots: [root],
    });
    try {
      await poller.tickOnce();
    } finally {
      chmodSync(filePath, 0o600);
    }

    expect(calls).toHaveLength(0);
    const run = db.raw.prepare(`SELECT status, error_kind, output_json FROM trigger_runs WHERE trigger_id = ?`).get(t.id) as { status: string; error_kind: string; output_json: string };
    expect(run.status).toBe('failed');
    expect(run.error_kind).toBe('hash_error');
    expect(JSON.parse(run.output_json)).toMatchObject({ exists: true });
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

  it('tick() catches unexpected tickOnce failures and reschedules while running', async () => {
    const { messenger } = makeMessenger();
    const scheduled: Array<{ ms: number; fn: () => void }> = [];
    const fakeSetTimeout = ((fn: () => void, ms: number) => {
      scheduled.push({ ms, fn });
      return scheduled.length as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    const poller = new TriggerPoller(db.raw, messenger, {
      intervalMs: 5_000,
      setTimeoutImpl: fakeSetTimeout,
    });
    vi.spyOn(poller, 'tickOnce').mockRejectedValueOnce(new Error('tick failed unexpectedly'));

    await (poller as unknown as { tick(): Promise<void> }).tick();

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(5_000);
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

  it('awaits pause notification only after pause writes commit', async () => {
    const calls: Array<{ transactionWasOpen: boolean }> = [];
    let releaseSend: () => void = () => {};
    const sendCanResolve = new Promise<void>((resolve) => { releaseSend = resolve; });
    const messenger: Messenger = {
      async sendMessage(): Promise<SubmissionReceipt> {
        let transactionWasOpen = false;
        try {
          db.raw.exec('BEGIN');
          db.raw.exec('ROLLBACK');
        } catch {
          transactionWasOpen = true;
        }
        calls.push({ transactionWasOpen });
        await sendCanResolve;
        return { waMessageId: 'wa-pause' };
      },
      async sendMedia() { throw new Error('not used'); },
    };
    const bead = createBead(db.raw, { kind: 'watch', title: 'pause atomicity', ownerJid: 'mw', actor: 'u' });
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM table_that_does_not_exist`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 300, nextFireAt: 1_000_000_000,
      actor: 'u',
    });
    let now = 1_000_000_001;
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => now,
      maxConsecutiveFailures: 2,
    });

    await poller.tickOnce();
    now = 1_000_000_100;
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(now - 1, t.id);
    let tickResolved = false;
    const tick = poller.tickOnce().then(() => { tickResolved = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(calls).toEqual([{ transactionWasOpen: false }]);
    expect(tickResolved).toBe(false);
    releaseSend();
    await tick;
    expect(tickResolved).toBe(true);
    const refreshed = db.raw.prepare(`SELECT status FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string };
    expect(refreshed.status).toBe('paused');
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

describe('TriggerPoller — notification throttle', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('suppresses dispatch when the previous notification was within the throttle window', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'spammy', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 30, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    // Override throttle to 100s so the test runs quickly.
    let now = 1_000_000_001;
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => now,
      notificationThrottleMinIntervalSec: 100,
    });

    // First tick: dispatches normally.
    await poller.tickOnce();
    expect(calls).toHaveLength(1);

    // Second tick 30s later: SQL still matches, but throttle blocks the dispatch.
    now = 1_000_000_031;
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(now - 1, t.id);
    await poller.tickOnce();
    expect(calls).toHaveLength(1);  // dispatch suppressed

    // The trigger_run still records ok+fired, but with the throttled marker.
    const runs = db.raw.prepare(`SELECT status, error_kind, output_json FROM trigger_runs WHERE trigger_id = ? ORDER BY id DESC LIMIT 1`).all(t.id) as Array<{ status: string; error_kind: string | null; output_json: string }>;
    expect(runs[0].status).toBe('ok');
    // A throttled run was never dispatched, so it must NOT be marked
    // notify_dispatch_failed — that kind is reserved for attempted-and-failed
    // deliveries. This is the fired-undelivered vs throttled distinction.
    expect(runs[0].error_kind).toBeNull();
    const parsed = JSON.parse(runs[0].output_json);
    expect(parsed.throttled).toBe(true);
    expect(parsed.throttleRemainingSec).toBeGreaterThan(0);
  });

  it('dispatches normally after the throttle window expires', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'spammy', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 30, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    let now = 1_000_000_001;
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => now,
      notificationThrottleMinIntervalSec: 100,
    });

    // First tick: dispatches.
    await poller.tickOnce();
    expect(calls).toHaveLength(1);

    // Second tick past the window: dispatches again.
    now = 1_000_000_200;  // 199s after first dispatch — past 100s window
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(now - 1, t.id);
    await poller.tickOnce();
    expect(calls).toHaveLength(2);
  });

  it('does NOT throttle when the substring deliveredWaMessageId appears only in row data, not as a delivered receipt', async () => {
    // Regression for the brittle `output_json LIKE '%deliveredWaMessageId%'`
    // throttle: a watch whose query result serialises the text
    // "deliveredWaMessageId" under $.sampleRow must NOT be mistaken for a run
    // that actually delivered a WhatsApp notification. With the old LIKE scan
    // the first (never-delivered) run false-matched and suppressed dispatch;
    // json_extract($.deliveredWaMessageId) IS NOT NULL keys on the real value.
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'self-watch', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)`);
    // Row body literally contains the receipt key name — a realistic case for a
    // watch over a table that stores JSON / log text.
    db.raw.prepare(`INSERT INTO notes (body) VALUES (?)`).run('audit: deliveredWaMessageId was set elsewhere');
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM notes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 30, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    let now = 1_000_000_001;
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => now,
      notificationThrottleMinIntervalSec: 100,
    });

    // First tick: the only run so far has output_json containing the substring
    // (via sampleRow) but it is the run that is dispatching NOW — it must still
    // dispatch (the throttle looks at PRIOR delivered runs, of which there are none).
    await poller.tickOnce();
    expect(calls).toHaveLength(1);
    // Sanity: that run's output_json does carry the colliding substring.
    const firstRun = db.raw.prepare(`SELECT output_json FROM trigger_runs WHERE trigger_id = ? ORDER BY id ASC LIMIT 1`).get(t.id) as { output_json: string };
    expect(firstRun.output_json).toContain('deliveredWaMessageId');

    // Now strip the real delivered receipt from that first run, leaving ONLY the
    // colliding substring in sampleRow. Under the old LIKE scan this run would be
    // treated as "delivered" and throttle the next tick. It must not.
    db.raw.prepare(
      `UPDATE trigger_runs SET output_json = json_remove(output_json, '$.deliveredWaMessageId') WHERE trigger_id = ?`,
    ).run(t.id);
    const stripped = db.raw.prepare(`SELECT output_json FROM trigger_runs WHERE trigger_id = ? ORDER BY id ASC LIMIT 1`).get(t.id) as { output_json: string };
    expect(JSON.parse(stripped.output_json).deliveredWaMessageId).toBeUndefined();
    expect(stripped.output_json).toContain('deliveredWaMessageId');  // still present in sampleRow

    // Second tick 30s later (well within the 100s window). No PRIOR run actually
    // delivered, so dispatch must proceed — the substring collision must not throttle.
    now = 1_000_000_031;
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(now - 1, t.id);
    await poller.tickOnce();
    expect(calls).toHaveLength(2);  // dispatched again, NOT throttled
  });

  it('does NOT treat a literal-null deliveredWaMessageId as a delivered receipt', async () => {
    // A run whose output_json has $.deliveredWaMessageId === null is NOT a
    // delivered run. The old LIKE scan matched the key name regardless of value;
    // json_extract(...) IS NOT NULL correctly excludes the null value.
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'nullrcpt', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 30, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    let now = 1_000_000_001;
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => now,
      notificationThrottleMinIntervalSec: 100,
    });

    await poller.tickOnce();
    expect(calls).toHaveLength(1);

    // Force the first run's receipt to a literal JSON null (never a real delivery).
    db.raw.prepare(
      `UPDATE trigger_runs SET output_json = json_set(output_json, '$.deliveredWaMessageId', json('null')) WHERE trigger_id = ?`,
    ).run(t.id);
    const nulled = db.raw.prepare(`SELECT output_json FROM trigger_runs WHERE trigger_id = ? ORDER BY id ASC LIMIT 1`).get(t.id) as { output_json: string };
    expect(nulled.output_json).toContain('deliveredWaMessageId');
    expect(JSON.parse(nulled.output_json).deliveredWaMessageId).toBeNull();

    // Second tick within the window: the prior run's null receipt is not a real
    // delivery, so dispatch proceeds.
    now = 1_000_000_031;
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(now - 1, t.id);
    await poller.tickOnce();
    expect(calls).toHaveLength(2);
  });
});

describe('poller.ts uncovered-branch coverage', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('poll.sqlite spec.binds forwards positional args to the SQL query (toBindArgs path)', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'binds', ownerJid: 'mw', actor: 'u' });
    // probes with a label column so a WHERE label = ? bind can select a row.
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY, label TEXT)`);
    db.raw.prepare(`INSERT INTO probes (label) VALUES ('match')`).run();
    db.raw.prepare(`INSERT INTO probes (label) VALUES ('nope')`).run();
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      // binds object whose enumeration order matches the single ? placeholder.
      spec: { sql: `SELECT id, label FROM probes WHERE label = ?`, binds: { label: 'match' }, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    const processed = await poller.tickOnce();

    expect(processed).toBe(1);
    expect(calls).toHaveLength(1);
    // The bind selected exactly the 'match' row, proving binds reached the SQL.
    const runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs[0].status).toBe('ok');
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ rowCount: 1, sampleRow: { label: 'match' } });
  });

  it('dispatchPauseNotification swallows a messenger failure and still records the pause', async () => {
    const { messenger, calls } = makeFailingMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'pause-fail', ownerJid: 'mw', actor: 'u' });
    // on_terminal='notify' (default) so dispatchPauseNotification is invoked;
    // the failing messenger exercises the catch block at line 529.
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM table_that_does_not_exist`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 300, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    let now = 1_000_000_001;
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => now,
      maxConsecutiveFailures: 2,
    });

    // First failure: status=failed, retry cooldown — NO dispatch (failed outcomes don't notify).
    await poller.tickOnce();
    expect(calls).toHaveLength(0);

    // Second failure trips the circuit breaker; pause is committed and the
    // pause notification is dispatched via dispatchPauseNotification, whose
    // catch block (line 529) must absorb the messenger rejection.
    now = 1_000_000_100;
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ? WHERE id = ?`).run(now - 1, t.id);
    await expect(poller.tickOnce()).resolves.toBe(1); // does not throw despite pause-dispatch failure

    const refreshed = db.raw.prepare(`SELECT status, next_fire_at FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string; next_fire_at: number | null };
    expect(refreshed.status).toBe('paused');
    expect(refreshed.next_fire_at).toBeNull();
    // Pause dispatch was attempted (and swallowed) by the failing messenger.
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('consecutive failures');
  });

  it('expireTrigger swallows an expiry-notification dispatch rejection via .catch (line 548)', async () => {
    const { messenger, calls } = makeFailingMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'expiry-fail', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    // on_terminal defaults to 'notify', so expiry dispatch is attempted and rejects;
    // the void ... .catch(...) must absorb it so tickOnce resolves cleanly.
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      requestedTerminalAt: 999_999_999, // past relative to tick's now -> expiry sweep runs
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    // Drain microtasks so the void'd .catch promise settles before the test ends.
    const processed = await poller.tickOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(processed).toBe(1);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // Expiry was committed despite the dispatch failure.
    const refreshed = db.raw.prepare(`SELECT status FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string };
    expect(refreshed.status).toBe('expired');
    const runs = db.raw.prepare(`SELECT status, output_summary FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_summary: string }>;
    expect(runs[0].status).toBe('terminal_fired');
    expect(runs[0].output_summary).toContain('terminal_at_reached');
  });

  it('reopenTerminalBead is a no-op when the bead is NOT in a terminal status (line 593 early return)', async () => {
    const { messenger } = makeMessenger();
    // Bead stays 'active' (not terminal), so reopen_bead should short-circuit.
    const bead = createBead(db.raw, { kind: 'watch', title: 'still active', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      requestedTerminalAt: 999_999_999,
      onTerminal: 'reopen_bead',
      actor: 'u',
    });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    // Bead was never terminal — status unchanged. The only status_change events
    // present are from createBead itself; the trigger-poller must not have
    // written any reopen status_change (line 593 early return).
    const refreshedBead = db.raw.prepare(`SELECT status FROM beads WHERE id = ?`).get(bead.id) as { status: string };
    expect(refreshedBead.status).toBe('active');
    const pollerStatusChanges = db.raw.prepare(
      `SELECT event_type FROM bead_events WHERE bead_id = ? AND event_type = 'status_change' AND actor = 'trigger-poller'`,
    ).all(bead.id) as Array<{ event_type: string }>;
    expect(pollerStatusChanges).toEqual([]);
    // Trigger still expired.
    const refreshed = db.raw.prepare(`SELECT status FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string };
    expect(refreshed.status).toBe('expired');
  });

  it('tick() runs one cycle and reschedules itself when not stopped (lines 169-176)', async () => {
    const { messenger } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'tick-reschedule', ownerJid: 'mw', actor: 'u' });
    db.raw.exec(`CREATE TABLE probes (id INTEGER PRIMARY KEY)`);
    db.raw.prepare(`INSERT INTO probes DEFAULT VALUES`).run();
    createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.sqlite',
      spec: { sql: `SELECT * FROM probes`, fire_when: 'rows_returned' },
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt: 1_000_000_000,
      actor: 'u',
    });

    const scheduled: Array<{ ms: number }> = [];
    // Capture the timer callback AND any promise it returns so we can await it.
    const pending: Array<() => (void | Promise<void>)> = [];
    const fakeSetTimeout = ((fn: () => (void | Promise<void>), ms: number) => {
      scheduled.push({ ms });
      pending.push(fn);
      return pending.length as unknown as NodeJS.Timeout;
    }) as typeof setTimeout;
    const fakeClearTimeout = ((_id: NodeJS.Timeout) => { /* noop */ }) as typeof clearTimeout;

    const poller = new TriggerPoller(db.raw, messenger, {
      intervalMs: 7_000,
      setTimeoutImpl: fakeSetTimeout,
      clearTimeoutImpl: fakeClearTimeout,
      now: () => 1_000_000_001,
    });

    poller.start();
    expect(scheduled).toEqual([{ ms: 7_000 }]);

    // Fire the scheduled timer. tick() is wrapped in `void` inside scheduleNext,
    // but our fake captures the original closure reference, which we invoke and
    // then drain the microtask queue so tickOnce + scheduleNext both complete.
    const fire = pending.shift()!;
    fire();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(scheduled).toEqual([{ ms: 7_000 }, { ms: 7_000 }]);

    // lastRunAt proves tickOnce actually executed inside tick().
    expect(poller.lastRunAt).toBe(new Date(1_000_000_001 * 1000).toISOString());

    // After stop(), the poller's reschedule gate (!this.stopped) suppresses a new schedule.
    poller.stop();
    scheduled.length = 0;
    // Manually run any pending tick closure; the stopped flag must prevent rescheduling.
    if (pending.length > 0) {
      const fire2 = pending.shift()!;
      fire2();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(scheduled).toEqual([]);
  });
});

describe('TriggerPoller — poll.url (gated, default-OFF)', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  function makeUrlTrigger(spec: Record<string, unknown>, nextFireAt = 1_000_000_000) {
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    return createTrigger(db.raw, {
      beadId: bead.id, kind: 'poll.url',
      spec,
      reportChatJid: 'admin@s.whatsapp.net',
      intervalSeconds: 60, nextFireAt,
      actor: 'u',
    });
  }

  it('fails closed with url_watch_disabled when the flag is OFF, even for a valid spec', async () => {
    const { messenger, calls } = makeMessenger();
    const urlFetch = vi.fn(async () => ({ status: 200, headers: {}, body: 'hello' }));
    const t = makeUrlTrigger({ url: 'https://example.com/feed', hash_mode: 'text' });

    // enableUrlWatch defaults OFF — no flag passed.
    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, urlFetch });
    await poller.tickOnce();

    expect(urlFetch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string | null }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('url_watch_disabled');
  });

  it('fires on first run (hash recorded) and stores no body in output_json', async () => {
    const { messenger, calls } = makeMessenger();
    const urlFetch = vi.fn(async () => ({ status: 200, headers: { etag: 'abc' }, body: '<html>secret-body</html>' }));
    const t = makeUrlTrigger({ url: 'https://example.com/feed', hash_mode: 'text' });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();

    expect(urlFetch).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    const runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs[0].status).toBe('ok');
    const oj = JSON.parse(runs[0].output_json);
    // The fetched body must never appear in output_json — only scalars.
    expect(oj.body).toBeUndefined();
    expect(JSON.stringify(oj)).not.toContain('secret-body');
    // output_json carries exactly the scalar change-detection fields: a boolean
    // hashChanged, an opaque 64-char sha256 digest, and the hash mode.
    expect(oj).toMatchObject({ hashChanged: true, hashMode: 'text' });
    expect(oj.urlHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hash-change detection: fires when body changes, noops when unchanged', async () => {
    const { messenger } = makeMessenger();
    let bodyText = 'v1';
    const urlFetch = vi.fn(async () => ({ status: 200, headers: {}, body: bodyText }));
    const t = makeUrlTrigger({ url: 'https://example.com/feed', hash_mode: 'text' });

    // Run 1: first run fires.
    let poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();
    // Run 2: same body → noop.
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ?, status='active' WHERE id = ?`).run(1_000_000_100, t.id);
    poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_101, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();
    // Run 3: body changes → fires.
    bodyText = 'v2-changed';
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ?, status='active' WHERE id = ?`).run(1_000_000_200, t.id);
    poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_201, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();

    const runs = db.raw.prepare(`SELECT status FROM trigger_runs WHERE trigger_id = ? ORDER BY id ASC`).all(t.id) as Array<{ status: string }>;
    expect(runs.map((r) => r.status)).toEqual(['ok', 'noop', 'ok']);
  });

  it('selector hash_mode hashes only the selected subtree', async () => {
    const { messenger } = makeMessenger();
    let body = '<html><div id="price">10</div><div id="other">A</div></html>';
    const urlFetch = vi.fn(async () => ({ status: 200, headers: {}, body }));
    const t = makeUrlTrigger({ url: 'https://example.com/p', hash_mode: 'selector', selector: '#price' });

    let poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();
    // Change only the non-selected subtree → selector hash unchanged → noop.
    body = '<html><div id="price">10</div><div id="other">B-changed</div></html>';
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ?, status='active' WHERE id = ?`).run(1_000_000_100, t.id);
    poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_101, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();

    const runs = db.raw.prepare(`SELECT status FROM trigger_runs WHERE trigger_id = ? ORDER BY id ASC`).all(t.id) as Array<{ status: string }>;
    expect(runs.map((r) => r.status)).toEqual(['ok', 'noop']);
  });

  it('rejects a non-https url with ssrf_blocked at exec time', async () => {
    const { messenger } = makeMessenger();
    const urlFetch = vi.fn(async () => ({ status: 200, headers: {}, body: 'x' }));
    // Persist a non-https spec directly (bypass create_watch zod) to exercise the exec-time re-guard.
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    const t = db.raw.prepare(
      `INSERT INTO bead_triggers (bead_id, kind, spec_json, spec_version, status, interval_seconds, next_fire_at, terminal_at, on_terminal, report_chat_jid, created_at, updated_at)
       VALUES (?, 'poll.url', ?, 1, 'active', 60, 1000000000, NULL, 'notify', 'admin@s.whatsapp.net', 1, 1)`,
    ).run(bead.id, JSON.stringify({ url: 'http://example.com/x', hash_mode: 'text' }));
    const triggerId = Number(t.lastInsertRowid);

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();

    expect(urlFetch).not.toHaveBeenCalled();
    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(triggerId) as Array<{ status: string; error_kind: string | null }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('ssrf_blocked');
  });

  it('rejects a non-default port with ssrf_blocked', async () => {
    const { messenger } = makeMessenger();
    const urlFetch = vi.fn(async () => ({ status: 200, headers: {}, body: 'x' }));
    const t = makeUrlTrigger({ url: 'https://example.com:8443/x', hash_mode: 'text' });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();

    expect(urlFetch).not.toHaveBeenCalled();
    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string | null }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('ssrf_blocked');
  });

  it('maps a SsrfBlockedError from the fetcher (private/metadata host) to ssrf_blocked, fail-closed', async () => {
    const { messenger } = makeMessenger();
    const urlFetch = vi.fn(async () => {
      const { SsrfBlockedError } = await import('../../../src/runtimes/chat/media/links.ts');
      throw new SsrfBlockedError('private_ip', 'host resolves to 169.254.169.254');
    });
    const t = makeUrlTrigger({ url: 'https://metadata.example/latest', hash_mode: 'text' });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();

    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string | null }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('ssrf_blocked');
  });

  it('runtime URL guard rejects an unparsable legacy spec with ssrf_blocked before fetching', async () => {
    const { messenger } = makeMessenger();
    const urlFetch = vi.fn(async () => ({ status: 200, headers: {}, body: 'x' }));
    const t = makeUrlTrigger({ url: 'https://example.com/good', hash_mode: 'text' });
    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, enableUrlWatch: true, urlFetch });
    const outcome = await (poller as unknown as {
      executeUrl(trigger: typeof t, spec: { url: string; hash_mode: 'text' }): Promise<{
        status: string;
        fired: boolean;
        outputJson: Record<string, unknown>;
        errorKind?: string;
        errorMessage?: string;
      }>;
    }).executeUrl(t, { url: 'not a url', hash_mode: 'text' });

    expect(urlFetch).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: 'failed',
      fired: false,
      outputJson: { reason: 'ssrf_blocked' },
      errorKind: 'ssrf_blocked',
    });
    expect(outcome.errorMessage).toContain('url is not parseable');
  });

  it('maps generic fetch failures to fetch_error without dispatching', async () => {
    const { messenger, calls } = makeMessenger();
    const urlFetch = vi.fn(async () => {
      throw new Error('origin offline');
    });
    const t = makeUrlTrigger({ url: 'https://example.com/feed', hash_mode: 'text' });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status, error_kind, error_message, output_json FROM trigger_runs WHERE trigger_id = ?`).all(t.id) as Array<{ status: string; error_kind: string; error_message: string; output_json: string }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('fetch_error');
    expect(runs[0].error_message).toContain('origin offline');
    expect(JSON.parse(runs[0].output_json)).toEqual({ reason: 'fetch_error' });
  });

  it('headers hash_mode ignores body changes and fires only when tracked headers change', async () => {
    const { messenger } = makeMessenger();
    let body = 'body-v1';
    let etag = 'etag-v1';
    const urlFetch = vi.fn(async () => ({
      status: 200,
      headers: { etag, 'content-type': 'text/plain', 'x-ignored': 'ignored' },
      body,
    }));
    const t = makeUrlTrigger({ url: 'https://example.com/headers', hash_mode: 'headers' });

    let poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();

    body = 'body-v2';
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ?, status='active' WHERE id = ?`).run(1_000_000_100, t.id);
    poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_101, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();

    etag = 'etag-v2';
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ?, status='active' WHERE id = ?`).run(1_000_000_200, t.id);
    poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_201, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();

    const runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ? ORDER BY id ASC`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs.map((r) => r.status)).toEqual(['ok', 'noop', 'ok']);
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ hashMode: 'headers' });
  });

  it('selector hash_mode with an omitted selector hashes a stable empty selection', async () => {
    const { messenger } = makeMessenger();
    let body = '<html><div id="price">10</div></html>';
    const urlFetch = vi.fn(async () => ({ status: 200, headers: {}, body }));
    const t = makeUrlTrigger({ url: 'https://example.com/empty-selector', hash_mode: 'selector' });

    let poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();
    body = '<html><div id="price">20</div></html>';
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ?, status='active' WHERE id = ?`).run(1_000_000_100, t.id);
    poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_101, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();

    const runs = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ? ORDER BY id ASC`).all(t.id) as Array<{ status: string; output_json: string }>;
    expect(runs.map((r) => r.status)).toEqual(['ok', 'noop']);
    expect(JSON.parse(runs[0].output_json)).toMatchObject({ hashMode: 'selector' });
  });

  it('selector hash_mode falls back to a stable empty marker when selector parsing fails', async () => {
    const { messenger } = makeMessenger();
    const urlFetch = vi.fn(async () => ({ status: 200, headers: {}, body: '<html><div>A</div></html>' }));
    const t = makeUrlTrigger({ url: 'https://example.com/bad-selector', hash_mode: 'selector', selector: ':not(' });

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();

    const run = db.raw.prepare(`SELECT status, output_json FROM trigger_runs WHERE trigger_id = ?`).get(t.id) as { status: string; output_json: string };
    expect(run.status).toBe('ok');
    expect(JSON.parse(run.output_json)).toMatchObject({ hashChanged: true, hashMode: 'selector' });
  });

  it('malformed prior urlHash JSON is ignored and current URL hash is treated as first run', async () => {
    const { messenger } = makeMessenger();
    const urlFetch = vi.fn(async () => ({ status: 200, headers: {}, body: 'current' }));
    const t = makeUrlTrigger({ url: 'https://example.com/malformed-prior', hash_mode: 'text' });
    db.raw.prepare(
      `INSERT INTO trigger_runs (
         trigger_id, bead_id, status, started_at, finished_at, duration_ms,
         output_summary, output_json, attempt, metadata_json
       ) VALUES (?, ?, 'ok', ?, ?, 0, 'legacy malformed', ?, 1, '{}')`,
    ).run(t.id, t.bead_id, 999_999_990, 999_999_991, '{not-json');

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, enableUrlWatch: true, urlFetch });
    await poller.tickOnce();

    const latest = db.raw.prepare(
      `SELECT status, output_summary, output_json FROM trigger_runs
       WHERE trigger_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(t.id) as { status: string; output_summary: string; output_json: string };
    expect(latest.status).toBe('ok');
    expect(latest.output_summary).toBe('url hash recorded (first run)');
    expect(JSON.parse(latest.output_json)).toMatchObject({ hashChanged: true, hashMode: 'text' });
  });
});

describe('TriggerPoller — poll.shell removed (fail closed)', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('a legacy persisted poll.shell row fails closed with shell_watch_removed (no crash, no noop hot-loop)', async () => {
    const { messenger, calls } = makeMessenger();
    const bead = createBead(db.raw, { kind: 'watch', title: 'w', ownerJid: 'mw', actor: 'u' });
    // A row that could only have been persisted before removal. Insert directly,
    // since create_watch no longer accepts poll.shell.
    const info = db.raw.prepare(
      `INSERT INTO bead_triggers (bead_id, kind, spec_json, spec_version, status, interval_seconds, next_fire_at, terminal_at, on_terminal, report_chat_jid, created_at, updated_at)
       VALUES (?, 'poll.shell', ?, 1, 'active', 60, 1000000000, NULL, 'notify', 'admin@s.whatsapp.net', 1, 1)`,
    ).run(bead.id, JSON.stringify({ argv: ['/bin/true'], fire_when: 'exit_zero' }));
    const triggerId = Number(info.lastInsertRowid);

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    expect(calls).toHaveLength(0);
    const runs = db.raw.prepare(`SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ?`).all(triggerId) as Array<{ status: string; error_kind: string | null }>;
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error_kind).toBe('shell_watch_removed');
  });
});

describe('toBindArgs — positional bind ordering (#1090)', () => {
  it('preserves array element order for positional ? placeholders', () => {
    expect(toBindArgs(['b', 'a'])).toEqual(['b', 'a']);
    expect(toBindArgs(['x', 'y', 'z'])).toEqual(['x', 'y', 'z']);
  });

  it('returns an empty list for empty binds', () => {
    expect(toBindArgs([])).toEqual([]);
    expect(toBindArgs({})).toEqual([]);
  });

  it('still accepts a legacy single-value object', () => {
    expect(toBindArgs({ a: 'only' })).toEqual(['only']);
  });

  it('array form avoids the integer-key reordering hazard of object binds', () => {
    // A legacy object with integer-like keys is reordered numerically by Object.values,
    // regardless of source order — the array form is order-stable and must be used instead.
    expect(toBindArgs({ '2': 'b', '1': 'a' })).toEqual(['a', 'b']); // documents the legacy hazard
    expect(toBindArgs(['b', 'a'])).toEqual(['b', 'a']); // array preserves intended order
  });
});
