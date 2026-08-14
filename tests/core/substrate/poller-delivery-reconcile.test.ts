// #2566 slice 3 — durable notification-delivery handoff.
// A fired run records its dispatch INTENT inside the finalize transaction, so
// a crash between COMMIT and sendMessage leaves durable evidence. Startup
// reconcile marks such rows with the bounded class notify_outcome_unknown
// (F1), never re-sends (F2), and delivery evidence stays independently
// queryable in both directions (F3).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import { createTrigger } from '../../../src/core/substrate/triggers.ts';
import { TriggerPoller } from '../../../src/core/substrate/poller.ts';
import type { Messenger, SubmissionReceipt } from '../../../src/core/types.ts';

function tmpFile() { return join(tmpdir(), `delivery-${randomBytes(8).toString('hex')}.db`); }

type RunRow = {
  id: number; status: string; error_kind: string | null;
  notify_pending: number | null; delivered_wa_id: string | null;
};

function runRows(db: Database, triggerId: number): RunRow[] {
  return db.raw.prepare(
    `SELECT id, status, error_kind,
            json_extract(output_json, '$.notifyPending') AS notify_pending,
            json_extract(output_json, '$.deliveredWaMessageId') AS delivered_wa_id
       FROM trigger_runs WHERE trigger_id = ? ORDER BY id`,
  ).all(triggerId) as unknown as RunRow[];
}

// A firing sqlite watch: probes table has a row, fire_when rows_returned.
function makeFiringTrigger(db: Database, nextFireAt: number) {
  const bead = createBead(db.raw, { kind: 'watch', title: 'fire', ownerJid: 'mw', actor: 'u' });
  db.raw.exec(`CREATE TABLE IF NOT EXISTS probes (id INTEGER PRIMARY KEY); INSERT INTO probes (id) VALUES (1);`);
  return createTrigger(db.raw, {
    beadId: bead.id, kind: 'poll.sqlite',
    spec: { sql: `SELECT id FROM probes`, fire_when: 'rows_returned' },
    reportChatJid: 'admin@s.whatsapp.net',
    intervalSeconds: 60, nextFireAt,
    actor: 'u',
  });
}

describe('TriggerPoller — durable delivery handoff (#2566 slice 3)', () => {
  let path: string;
  let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  it('F1: a crash between finalize and dispatch leaves durable intent that reconcile marks notify_outcome_unknown', async () => {
    const t = makeFiringTrigger(db, 1_000_000_000);
    // Messenger whose send NEVER settles — the run commits with dispatch
    // intent, then the "process" dies mid-dispatch (we simply abandon it).
    const hungMessenger: Messenger = {
      sendMessage: () => new Promise<SubmissionReceipt>(() => {}),
      async sendMedia() { throw new Error('not used'); },
    };
    const crashed = new TriggerPoller(db.raw, hungMessenger, { now: () => 1_000_000_001 });
    void crashed.tickOnce(); // hangs post-commit in dispatch — do not await

    // The finalize transaction must have committed durable dispatch intent.
    let rows: RunRow[] = [];
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    rows = runRows(db, t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].notify_pending).toBe(1);
    expect(rows[0].delivered_wa_id).toBeNull();
    expect(rows[0].error_kind).toBeNull();

    // "Restart": a fresh poller on the same DB reconciles delivery intents.
    const calls: string[] = [];
    const quietMessenger: Messenger = {
      async sendMessage(chatJid: string): Promise<SubmissionReceipt> {
        calls.push(chatJid);
        return { waMessageId: 'wa-should-not-happen' };
      },
      async sendMedia() { throw new Error('not used'); },
    };
    const restarted = new TriggerPoller(db.raw, quietMessenger, { now: () => 1_000_000_500 });
    restarted.reconcileDeliveryIntents(1_000_000_500);

    const after = runRows(db, t.id);
    expect(after[0].error_kind).toBe('notify_outcome_unknown');
    // F2: reconcile NEVER re-sends.
    expect(calls).toHaveLength(0);
  });

  it('F3: delivery evidence is coherent in both directions — success clears intent, unknown stays queryable', async () => {
    const t = makeFiringTrigger(db, 1_000_000_000);
    const good: Messenger = {
      async sendMessage(): Promise<SubmissionReceipt> { return { waMessageId: 'wa-1' }; },
      async sendMedia() { throw new Error('not used'); },
    };
    const poller = new TriggerPoller(db.raw, good, { now: () => 1_000_000_001 });
    await poller.tickOnce();

    const rows = runRows(db, t.id);
    expect(rows).toHaveLength(1);
    // Successful dispatch: waId recorded AND pending intent cleared — a
    // delivered run must never match the unknown-outcome query.
    expect(rows[0].delivered_wa_id).toBe('wa-1');
    expect(rows[0].notify_pending).toBeNull();
    expect(rows[0].error_kind).toBeNull();

    // Reconcile on a healthy history is a no-op.
    poller.reconcileDeliveryIntents(1_000_000_600);
    expect(runRows(db, t.id)[0].error_kind).toBeNull();
  });
});
