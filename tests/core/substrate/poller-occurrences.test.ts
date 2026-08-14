// #2566 slice 1 — durable trigger-occurrence lifecycle.
// A committed occurrence row must exist BEFORE the executor runs, carry a
// fenced lease, survive as observable evidence through a hang or crash, and
// give every scheduled occurrence a stable identity that cannot run twice.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import { createTrigger } from '../../../src/core/substrate/triggers.ts';
import { TriggerPoller } from '../../../src/core/substrate/poller.ts';
import type { Messenger, SubmissionReceipt } from '../../../src/core/types.ts';

function tmpFile() { return join(tmpdir(), `occ-${randomBytes(8).toString('hex')}.db`); }

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

function makeWatchTrigger(db: Database, nextFireAt: number) {
  const bead = createBead(db.raw, { kind: 'watch', title: 'occ', ownerJid: 'mw', actor: 'u' });
  db.raw.exec(`CREATE TABLE IF NOT EXISTS probes (id INTEGER PRIMARY KEY)`);
  return createTrigger(db.raw, {
    beadId: bead.id, kind: 'poll.sqlite',
    spec: { sql: `SELECT id FROM probes`, fire_when: 'rows_returned' },
    reportChatJid: 'admin@s.whatsapp.net',
    intervalSeconds: 60, nextFireAt,
    actor: 'u',
  });
}

type OccurrenceRow = {
  state: string; lease_owner: string | null; lease_generation: number;
  lease_expires_at: number | null; claimed_at: number; started_at: number | null;
  finished_at: number | null; stale_cause: string | null; scheduled_for: number; attempt: number;
};

function occurrences(raw: DatabaseSync, triggerId: number): OccurrenceRow[] {
  return raw.prepare(
    `SELECT state, lease_owner, lease_generation, lease_expires_at, claimed_at,
            started_at, finished_at, stale_cause, scheduled_for, attempt
       FROM trigger_occurrences WHERE trigger_id = ? ORDER BY id`,
  ).all(triggerId) as unknown as OccurrenceRow[];
}

describe('TriggerPoller — durable occurrence lifecycle (#2566 slice 1)', () => {
  let path: string;
  let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('F1: a blocked executor has a committed running occurrence visible from a second connection', async () => {
    const { messenger } = makeMessenger();
    const t = makeWatchTrigger(db, 1_000_000_000);
    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });

    let release!: () => void;
    const held = new Promise<never>((_resolve, reject) => { release = () => reject(new Error('released')); });
    vi.spyOn(
      poller as unknown as { executeTrigger(trigger: unknown): Promise<unknown> },
      'executeTrigger',
    ).mockImplementationOnce(() => held);

    const tick = poller.tickOnce();
    await vi.waitFor(() => {
      const second = new DatabaseSync(path);
      try {
        const rows = second.prepare(
          `SELECT state, lease_owner, lease_expires_at FROM trigger_occurrences WHERE trigger_id = ?`,
        ).all(t.id) as Array<{ state: string; lease_owner: string | null; lease_expires_at: number | null }>;
        expect(rows).toHaveLength(1);
        expect(rows[0].state).toBe('running');
        expect(rows[0].lease_owner).toBeTruthy();
        expect(rows[0].lease_expires_at).toBeGreaterThan(1_000_000_001);
        const runs = second.prepare(`SELECT COUNT(*) AS n FROM trigger_runs WHERE trigger_id = ?`).get(t.id) as { n: number };
        expect(runs.n).toBe(0);
      } finally {
        second.close();
      }
    });

    release();
    await tick;
    const after = occurrences(db.raw, t.id);
    expect(after).toHaveLength(1);
    expect(after[0].state).toBe('failed');
  });

  it('F3: an expired lease is swept to stale on startup and is NOT replayed', async () => {
    const { messenger } = makeMessenger();
    const t = makeWatchTrigger(db, 2_000_000_000);
    db.raw.prepare(
      `INSERT INTO trigger_occurrences
         (trigger_id, bead_id, scheduled_for, attempt, state, lease_owner, lease_generation, lease_expires_at, claimed_at, started_at)
       VALUES (?, ?, 999, 1, 'running', 'pid:dead:aaaa', 1, 500, 400, 400)`,
    ).run(t.id, t.bead_id);

    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_000 });
    const spy = vi.spyOn(
      poller as unknown as { executeTrigger(trigger: unknown): Promise<unknown> },
      'executeTrigger',
    );
    poller.reconcileStaleOccurrences(1_000_000_000);
    await poller.tickOnce();

    const rows = occurrences(db.raw, t.id);
    const stale = rows.find(r => r.scheduled_for === 999);
    expect(stale?.state).toBe('stale');
    expect(stale?.stale_cause).toBe('lease_expired');
    expect(spy).not.toHaveBeenCalled();
  });

  it('F4: a terminal occurrence identity cannot be claimed again', async () => {
    const { messenger } = makeMessenger();
    const t = makeWatchTrigger(db, 1_000_000_000);
    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();
    const first = occurrences(db.raw, t.id);
    expect(first).toHaveLength(1);
    expect(['ok', 'noop']).toContain(first[0].state);

    // Rewind the trigger to the SAME scheduled_for and tick again: the UNIQUE
    // occurrence identity must refuse a second run of the same occurrence.
    db.raw.prepare(`UPDATE bead_triggers SET next_fire_at = ?, last_fire_at = NULL WHERE id = ?`).run(1_000_000_000, t.id);
    const spy = vi.spyOn(
      poller as unknown as { executeTrigger(trigger: unknown): Promise<unknown> },
      'executeTrigger',
    );
    await poller.tickOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(occurrences(db.raw, t.id)).toHaveLength(1);
  });

  it('F5: finalize is fenced — a different lease owner cannot commit a terminal state', async () => {
    const { messenger } = makeMessenger();
    const t = makeWatchTrigger(db, 1_000_000_000);
    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });

    vi.spyOn(
      poller as unknown as { executeTrigger(trigger: unknown): Promise<unknown> },
      'executeTrigger',
    ).mockImplementationOnce(async () => {
      // Simulate a competing owner stealing the lease mid-execution.
      db.raw.prepare(
        `UPDATE trigger_occurrences SET lease_owner = 'pid:thief:bbbb', lease_generation = lease_generation + 1 WHERE trigger_id = ?`,
      ).run(t.id);
      return { status: 'ok', fired: false, outputSummary: 'stolen', outputJson: {} };
    });

    await poller.tickOnce();
    const rows = occurrences(db.raw, t.id);
    expect(rows).toHaveLength(1);
    // The original owner's finalize must NOT have committed over the stolen lease.
    expect(rows[0].state).toBe('running');
    expect(rows[0].lease_owner).toBe('pid:thief:bbbb');
  });

  it('S3-F4: an agent-job dispatch carries the durable occurrence identity', async () => {
    const { messenger } = makeMessenger();
    const bead = createBead(db.raw, {
      kind: 'agent_job', title: 'sweep', ownerJid: 'mw', actor: 'u',
      body: 'Run the sweep.',
    });
    const t = createTrigger(db.raw, {
      beadId: bead.id, kind: 'schedule.cron',
      spec: { expr: '*/5 * * * *' },
      reportChatJid: 'admin@s.whatsapp.net',
      nextFireAt: 1_000_000_000, actor: 'u',
    });

    const dispatched: Array<{ occurrenceId: number; triggerId: number }> = [];
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => 1_000_000_001,
      agentJobDispatch: (ctx) => {
        dispatched.push({ occurrenceId: ctx.occurrenceId, triggerId: ctx.triggerId });
        return { dispatched: true, detail: 'enqueued' };
      },
    });
    await poller.tickOnce();

    expect(dispatched).toHaveLength(1);
    const occ = db.raw.prepare(
      `SELECT id FROM trigger_occurrences WHERE trigger_id = ?`,
    ).get(t.id) as { id: number };
    expect(dispatched[0].triggerId).toBe(t.id);
    expect(dispatched[0].occurrenceId).toBe(occ.id);
  });

  it('F7: happy path commits one ordered claimed→running→terminal occurrence', async () => {
    const { messenger } = makeMessenger();
    const t = makeWatchTrigger(db, 1_000_000_000);
    const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    const rows = occurrences(db.raw, t.id);
    expect(rows).toHaveLength(1);
    const occ = rows[0];
    expect(['ok', 'noop']).toContain(occ.state);
    expect(occ.scheduled_for).toBe(1_000_000_000);
    expect(occ.attempt).toBe(1);
    expect(occ.lease_owner).toBeTruthy();
    expect(occ.claimed_at).toBe(1_000_000_001);
    expect(occ.started_at).toBe(1_000_000_001);
    expect(occ.finished_at).toBe(1_000_000_001);
    expect(occ.lease_generation).toBe(1);
  });
});
