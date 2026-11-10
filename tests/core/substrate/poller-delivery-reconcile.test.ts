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
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../../src/core/database.ts';
import { createBead } from '../../../src/core/substrate/beads.ts';
import { createTrigger } from '../../../src/core/substrate/triggers.ts';
import { TriggerPoller } from '../../../src/core/substrate/poller.ts';
import { TRIGGER_BUDGETS } from '../../../src/core/substrate/trigger-budgets.ts';
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
    let signalDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      signalDispatchStarted = resolve;
    });
    const hungMessenger: Messenger = {
      sendMessage: () => {
        signalDispatchStarted();
        return new Promise<SubmissionReceipt>(() => {});
      },
      async sendMedia() { throw new Error('not used'); },
    };
    const crashed = new TriggerPoller(db.raw, hungMessenger, { now: () => 1_000_000_001 });
    void crashed.tickOnce(); // hangs post-commit in dispatch — do not await

    // Entering the messenger proves the finalize transaction committed; avoid
    // guessing how many event-loop turns the isolated SQLite worker needs.
    await dispatchStarted;
    const rows = runRows(db, t.id);
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

function makeExpiringTrigger(db: Database, onTerminal: 'notify' | 'silent' | 'reopen_bead' = 'notify') {
  const bead = createBead(db.raw, {
    kind: 'watch', title: 'expiry', ownerJid: 'mw', actor: 'u', status: 'completed',
  });
  return createTrigger(db.raw, {
    beadId: bead.id, kind: 'poll.email', spec: { source: 'gmail' },
    reportChatJid: 'admin@s.whatsapp.net', dedupeKey: `expiry-${bead.id}`,
    intervalSeconds: 60, nextFireAt: 1_000_000_000,
    requestedTerminalAt: 999_999_999, onTerminal, actor: 'u',
  });
}

describe('TriggerPoller — expiry delivery boundaries', () => {
  let path: string;
  let db: Database;
  beforeEach(() => { path = tmpFile(); db = new Database(path); db.open(); });
  afterEach(() => { db.close(); if (existsSync(path)) unlinkSync(path); });

  const invalidRoots = [
    { label: 'oversized target', column: 'report_chat_jid', value: '😀'.repeat(TRIGGER_BUDGETS.maxReportTargetBytes / 4 + 1) },
    { label: 'non-text target', column: 'report_chat_jid', value: Buffer.from('private-target') },
    { label: 'oversized dedupe key', column: 'dedupe_key', value: '😀'.repeat(TRIGGER_BUDGETS.maxDedupeKeyBytes / 4 + 1) },
    { label: 'non-text dedupe key', column: 'dedupe_key', value: Buffer.from('private-key') },
  ] as const;

  it.each(invalidRoots.flatMap((root) => (['notify', 'reopen_bead'] as const).map((onTerminal) => ({ ...root, onTerminal }))))(
    'retires an expired $label without its $onTerminal effect', async ({ column, value, onTerminal }) => {
      const t = makeExpiringTrigger(db, onTerminal);
      db.raw.prepare(`UPDATE bead_triggers SET ${column} = ? WHERE id = ?`).run(value, t.id);
      const calls: string[] = [];
      const messenger: Messenger = {
        async sendMessage(chatJid) { calls.push(chatJid); return { waMessageId: 'unexpected' }; },
        async sendMedia() { throw new Error('not used'); },
      };
      const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, batchSize: 0 });
      await poller.tickOnce();
      await poller.tickOnce();

      expect(calls).toEqual([]);
      expect(db.raw.prepare('SELECT status FROM beads WHERE id = ?').get(t.bead_id)).toEqual({ status: 'completed' });
      expect(db.raw.prepare('SELECT status, next_fire_at FROM bead_triggers WHERE id = ?').get(t.id))
        .toEqual({ status: 'expired', next_fire_at: null });
      expect(runRows(db, t.id)).toMatchObject([
        { status: 'failed', error_kind: 'resource_exhausted', notify_pending: null, delivered_wa_id: null },
      ]);
      const run = db.raw.prepare('SELECT output_json, error_message FROM trigger_runs WHERE trigger_id = ?').get(t.id);
      expect(run).toEqual({
        output_json: JSON.stringify({ reason: 'resource_exhausted' }),
        error_message: 'persisted trigger exceeded the current resource budget',
      });
    },
  );

  it.each([
    { label: 'receipt', receipt: { waMessageId: 'expiry-1' }, error: null, classification: null },
    { label: 'missing receipt', receipt: {}, error: null, classification: 'notify_outcome_unknown' },
    { label: 'transient rejection', receipt: {}, error: new Error('connection closed'), classification: 'notify_dispatch_failed' },
    { label: 'forbidden rejection', receipt: {}, error: new Error('forbidden (403)'), classification: 'notify_forbidden_target' },
  ])('records committed expiry intent and its $label disposition', async ({ receipt, error, classification }) => {
    const t = makeExpiringTrigger(db);
    const reader = new DatabaseSync(path, { readOnly: true });
    const observed: unknown[] = [];
    let sends = 0;
    const messenger: Messenger = {
      async sendMessage() {
        sends++;
        observed.push(reader.prepare(`SELECT status, json_extract(output_json, '$.notifyPending') AS pending
          FROM trigger_runs WHERE trigger_id = ?`).all(t.id));
        if (error) throw error;
        return receipt;
      },
      async sendMedia() { throw new Error('not used'); },
    };
    try {
      const poller = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001, batchSize: 0 });
      await poller.tickOnce();
      expect(observed).toEqual([[{ status: 'terminal_fired', pending: 1 }]]);
      poller.reconcileDeliveryIntents(1_000_000_500);
      await poller.tickOnce();
      expect(sends).toBe(1);
      expect(runRows(db, t.id)).toMatchObject([{
        status: 'terminal_fired', error_kind: classification,
        delivered_wa_id: receipt.waMessageId ?? null,
        notify_pending: classification === 'notify_outcome_unknown' ? 1 : null,
      }]);
      expect(db.raw.prepare('SELECT status FROM bead_triggers WHERE id = ?').get(t.id)).toEqual({ status: 'expired' });
    } finally {
      reader.close();
    }
  });

  it('reconciles an interrupted expiry send as unknown without replaying it', async () => {
    const t = makeExpiringTrigger(db);
    let started!: () => void;
    let finish!: (receipt: SubmissionReceipt) => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<SubmissionReceipt>((resolve) => { finish = resolve; });
    const messenger: Messenger = {
      sendMessage() { started(); return pending; },
      async sendMedia() { throw new Error('not used'); },
    };
    const interrupted = new TriggerPoller(db.raw, messenger, { now: () => 1_000_000_001 });
    const tick = interrupted.tickOnce();
    let replayed = 0;
    try {
      await entered;
      expect(runRows(db, t.id)).toMatchObject([{ notify_pending: 1, error_kind: null }]);
      const restarted = new TriggerPoller(db.raw, {
        async sendMessage() { replayed++; return { waMessageId: 'unexpected' }; },
        async sendMedia() { throw new Error('not used'); },
      }, { now: () => 1_000_000_500 });
      restarted.reconcileDeliveryIntents(1_000_000_500);
      await restarted.tickOnce();
      expect(runRows(db, t.id)).toMatchObject([{ error_kind: 'notify_outcome_unknown', delivered_wa_id: null }]);
      expect(replayed).toBe(0);
    } finally {
      finish({});
      await tick;
    }
  });

  it('does not send when the expiry transaction cannot record the run', async () => {
    const t = makeExpiringTrigger(db);
    db.raw.exec(`CREATE TRIGGER fail_expiry_run BEFORE INSERT ON trigger_runs
      WHEN NEW.status = 'terminal_fired' BEGIN SELECT RAISE(ABORT, 'blocked expiry run'); END;`);
    let sends = 0;
    const poller = new TriggerPoller(db.raw, {
      async sendMessage() { sends++; return { waMessageId: 'unexpected' }; },
      async sendMedia() { throw new Error('not used'); },
    }, { now: () => 1_000_000_001, batchSize: 0 });
    await poller.tickOnce();
    expect(sends).toBe(0);
    expect(runRows(db, t.id)).toEqual([]);
    expect(db.raw.prepare('SELECT status FROM bead_triggers WHERE id = ?').get(t.id)).toEqual({ status: 'active' });
  });

  it('does not repeat expiry from a stale batch after another poller retires the row', async () => {
    const first = makeExpiringTrigger(db);
    const second = makeExpiringTrigger(db);
    let started!: () => void;
    let finish!: (receipt: SubmissionReceipt) => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<SubmissionReceipt>((resolve) => { finish = resolve; });
    const sends: string[] = [];
    const messenger: Messenger = {
      sendMessage(_target, text) {
        sends.push(text);
        if (sends.length === 1) { started(); return pending; }
        return Promise.resolve({ waMessageId: 'expiry-other' });
      },
      async sendMedia() { throw new Error('not used'); },
    };
    const opts = { now: () => 1_000_000_001, batchSize: 0 };
    const tick = new TriggerPoller(db.raw, messenger, opts).tickOnce();
    try {
      await entered;
      await new TriggerPoller(db.raw, messenger, opts).tickOnce();
    } finally {
      finish({ waMessageId: 'expiry-first' });
      await tick;
    }
    expect(sends).toHaveLength(2);
    expect(runRows(db, first.id)).toHaveLength(1);
    expect(runRows(db, second.id)).toHaveLength(1);
  });
});
