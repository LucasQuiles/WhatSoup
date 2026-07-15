import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import { createTrigger } from '../../../src/core/substrate/triggers.ts';
import { TriggerPoller } from '../../../src/core/substrate/poller.ts';
import type { Messenger, SubmissionReceipt } from '../../../src/core/types.ts';

// #1745 — a scheduled bead trigger whose notification send is rejected with a
// PERMANENT per-target authz error (WhatsApp `forbidden`/403 — the bot was
// removed from the target group) must be RETIRED (paused, next_fire_at NULL)
// after a small bound and its producer signalled (bead_event +/- alert) — it
// must NOT loop for days re-firing into an undeliverable chat. Transient send
// failures (timeout, connection closed, session 401) must still retry.

function tmpFile() { return join(tmpdir(), `poller-forbidden-${randomBytes(8).toString('hex')}.db`); }

/** Messenger whose send always throws a given error — models a rejected send. */
function makeThrowingMessenger(makeError: () => unknown) {
  const calls: Array<{ chatJid: string; text: string }> = [];
  const messenger: Messenger = {
    async sendMessage(chatJid: string, text: string): Promise<SubmissionReceipt> {
      calls.push({ chatJid, text });
      throw makeError();
    },
    async sendMedia() { throw new Error('not used'); },
  };
  return { messenger, calls };
}

/** A schedule.cron trigger on a plain (non agent_job) bead — fires + notifies every tick. */
function armCronTrigger(db: Database, reportChatJid: string) {
  const bead = createBead(db.raw, { kind: 'watch', title: 'daily report', ownerJid: 'mw@s.whatsapp.net', actor: 'u' });
  const t = createTrigger(db.raw, {
    beadId: bead.id, kind: 'schedule.cron',
    spec: { expr: '* * * * *', tz: 'UTC' },
    reportChatJid, nextFireAt: 1_000_000_000, actor: 'u',
  });
  return { bead, t };
}

function pausedBeadEvents(db: Database, beadId: number) {
  return (db.raw.prepare(
    `SELECT event_type, payload_json FROM bead_events WHERE bead_id = ? AND event_type = 'trigger_paused'`,
  ).all(beadId) as Array<{ event_type: string; payload_json: string }>)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload_json) as Record<string, unknown> }));
}

describe('TriggerPoller — forbidden-target producer feedback (#1745)', () => {
  let path: string; let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('retires the trigger and signals the producer after N consecutive forbidden rejects, and stops looping', async () => {
    // WhatsApp rejects a send to a group the bot was removed from with err.message
    // === 'forbidden' (this is exactly the raw string stored verbatim in
    // outbound_ops.error in the incident — durability.ts markFailedPermanent = err.message).
    const { messenger, calls } = makeThrowingMessenger(() => new Error('forbidden'));
    const { bead, t } = armCronTrigger(db, 'removed-group@g.us');

    let clock = 1_000_000_001;
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => clock,
      instance: 'q',
      maxConsecutiveForbiddenRejects: 3,
    });
    // Fire well past the bound to prove it does NOT loop unbounded.
    for (let i = 0; i < 8; i++) { await poller.tickOnce(); clock += 120; }

    // BOUNDED: the send was attempted at most the threshold number of times, not 8.
    expect(calls.length).toBe(3);

    // RETIRED: trigger paused, next_fire_at cleared → dueTriggers can never select it again.
    const refreshed = db.raw.prepare(
      `SELECT status, next_fire_at FROM bead_triggers WHERE id = ?`,
    ).get(t.id) as { status: string; next_fire_at: number | null };
    expect(refreshed.status).toBe('paused');
    expect(refreshed.next_fire_at).toBeNull();

    // PRODUCER SIGNALLED: a trigger_paused bead_event with a forbidden_target reason.
    const events = pausedBeadEvents(db, bead.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload.reason).toBe('forbidden_target');
    expect(events[0].payload.trigger_id).toBe(t.id);
    expect(events[0].payload.report_chat_jid).toBe('removed-group@g.us');

    // The forbidden rejects are distinguishable in telemetry from a throttled/ok run.
    const runs = db.raw.prepare(
      `SELECT status, error_kind FROM trigger_runs WHERE trigger_id = ? ORDER BY id`,
    ).all(t.id) as Array<{ status: string; error_kind: string | null }>;
    expect(runs).toHaveLength(3);
    for (const r of runs) expect(r.error_kind).toBe('notify_forbidden_target');
  });

  it('classifies a Boom-shaped 403 (statusCode) even when the message text is opaque', async () => {
    // The Baileys reject can surface as a wrapped error whose message is generic
    // ("transaction failed, rolling back") but carries output.statusCode = 403.
    const { messenger, calls } = makeThrowingMessenger(() => {
      const err = new Error('transaction failed, rolling back') as Error & { output?: { statusCode?: number } };
      err.output = { statusCode: 403 };
      return err;
    });
    const { t } = armCronTrigger(db, 'removed-group@g.us');

    let clock = 1_000_000_001;
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => clock, instance: 'q', maxConsecutiveForbiddenRejects: 3,
    });
    for (let i = 0; i < 6; i++) { await poller.tickOnce(); clock += 120; }

    expect(calls.length).toBe(3);
    const refreshed = db.raw.prepare(`SELECT status FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string };
    expect(refreshed.status).toBe('paused');
  });

  it('keeps retrying a TRANSIENT send failure — a transport blip must not retire a daily job', async () => {
    const { messenger, calls } = makeThrowingMessenger(() => new Error('transport down'));
    const { bead, t } = armCronTrigger(db, 'active-group@g.us');

    let clock = 1_000_000_001;
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => clock, instance: 'q', maxConsecutiveForbiddenRejects: 3,
    });
    for (let i = 0; i < 6; i++) { await poller.tickOnce(); clock += 120; }

    // Every fire attempted, trigger stays active and keeps rescheduling (fail-loud, not retire).
    expect(calls.length).toBe(6);
    const refreshed = db.raw.prepare(
      `SELECT status, next_fire_at FROM bead_triggers WHERE id = ?`,
    ).get(t.id) as { status: string; next_fire_at: number | null };
    expect(refreshed.status).toBe('active');
    expect(refreshed.next_fire_at).not.toBeNull();
    // Transient failures keep the existing notify_dispatch_failed classification.
    const runs = db.raw.prepare(
      `SELECT error_kind FROM trigger_runs WHERE trigger_id = ?`,
    ).all(t.id) as Array<{ error_kind: string | null }>;
    for (const r of runs) expect(r.error_kind).toBe('notify_dispatch_failed');
    // And the producer is NOT falsely retired.
    expect(pausedBeadEvents(db, bead.id)).toHaveLength(0);
  });

  it('treats a session 401/unauthorized as transient (re-pair heals it), not a per-target retire', async () => {
    const { messenger, calls } = makeThrowingMessenger(() => new Error('Unauthorized (401)'));
    const { t } = armCronTrigger(db, 'active-group@g.us');

    let clock = 1_000_000_001;
    const poller = new TriggerPoller(db.raw, messenger, {
      now: () => clock, instance: 'q', maxConsecutiveForbiddenRejects: 3,
    });
    for (let i = 0; i < 5; i++) { await poller.tickOnce(); clock += 120; }

    expect(calls.length).toBe(5);
    const refreshed = db.raw.prepare(`SELECT status FROM bead_triggers WHERE id = ?`).get(t.id) as { status: string };
    expect(refreshed.status).toBe('active');
  });
});
