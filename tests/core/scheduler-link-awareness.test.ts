/**
 * #1779 — Scheduler link-awareness.
 *
 * A scheduled send fired against an instance whose WhatsApp link is DE-LINKED
 * (logged out / device-bond lost) must NOT be silently burned: the scheduler
 * defers (holds pending until re-link) and raises a loud owner alert, instead
 * of retrying 3× and marking the row `failed` with nobody told. A TRANSIENT
 * reconnect blip is distinguished and still "kept trying" (existing retry path).
 *
 * Companion to #1745 (forbidden-target producer-feedback retire in poller.ts):
 * same structural gap (a producer whose target is persistently unreachable
 * keeps producing with no feedback edge), here the unreachable "target" is the
 * instance's own WhatsApp link.
 *
 * Timer-hang guard: this suite NEVER calls scheduler.start() (which installs a
 * real setInterval). It drives scheduler.tick() directly — the proven-safe
 * pattern in scheduler.test.ts — and additionally fakes ONLY the timer
 * functions (not Date), so a stray interval can never wedge the run while
 * Date.now()-based candidate selection stays real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Database } from '../../src/core/database.ts';
import { MessageScheduler } from '../../src/core/scheduler.ts';
import { resetEmitAlertThrottle } from '../../src/lib/emit-alert.ts';
import type { RuntimeConnection } from '../../src/transport/runtime-connection.ts';
import type { ConnectionStateSnapshot } from '../../src/transport/connection.ts';

// ─── Snapshot / connection helpers ───────────────────────────────────────────

const BASE_SNAPSHOT: ConnectionStateSnapshot = {
  state: 'connected',
  connected: true,
  reconnectAttempts: 0,
  reconnectPhase: null,
  stateChangedAt: new Date().toISOString(),
  firstFailureAt: null,
  lastPingAt: null,
  lastPongAt: null,
  lastDisconnectReason: null,
  lastStatusCode: null,
  recentDisconnects: { windowMs: 0, count: 0, lastAt: null, lastReason: null, lastStatusCode: null, byReason: {} },
  credentialLifecycle: {} as ConnectionStateSnapshot['credentialLifecycle'],
};

function snapshot(overrides: Partial<ConnectionStateSnapshot>): ConnectionStateSnapshot {
  return { ...BASE_SNAPSHOT, ...overrides };
}

/** De-linked = logged out / device-bond lost (terminal, human re-pair required). */
const DELINKED = snapshot({
  state: 'disconnected',
  connected: false,
  reconnectPhase: null,
  lastDisconnectReason: 'loggedOut',
  lastStatusCode: 401,
  authBond: { status: 'invalid' } as ConnectionStateSnapshot['authBond'],
});

/** Transient blip = socket dropped but actively reconnecting (self-heals). */
const TRANSIENT = snapshot({
  state: 'reconnecting',
  connected: false,
  reconnectPhase: 'backoff',
  lastDisconnectReason: 'connectionClosed',
  lastStatusCode: 428,
});

interface MockConn {
  conn: RuntimeConnection;
  sendRawCalls: Array<[string, Record<string, unknown>]>;
}

function makeConn(opts: {
  getState?: () => ConnectionStateSnapshot;
  sendRawImpl?: () => Promise<{ waMessageId: string }>;
}): MockConn {
  const sendRawCalls: Array<[string, Record<string, unknown>]> = [];
  const base = {
    sendRaw: vi.fn(async (jid: string, content: Record<string, unknown>) => {
      sendRawCalls.push([jid, content]);
      if (opts.sendRawImpl) return opts.sendRawImpl();
      return { waMessageId: 'mock-msg-id' };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: 'mock-media-id' })),
  } as Record<string, unknown>;
  if (opts.getState) base['getConnectionState'] = opts.getState;
  return { conn: base as unknown as RuntimeConnection, sendRawCalls };
}

function insertPendingText(raw: DatabaseSync, chatJid = '15550100001@s.whatsapp.net'): number {
  const scheduledAt = Math.floor(Date.now() / 1000) - 10;
  return Number(
    raw
      .prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status, retry_count)
         VALUES (?, 'text', ?, ?, 'pending', 0)`,
      )
      .run(chatJid, JSON.stringify({ text: 'scheduled hello' }), scheduledAt).lastInsertRowid,
  );
}

function readAlerts(sink: string, source: string): Array<Record<string, unknown>> {
  if (!existsSync(sink)) return [];
  return readFileSync(sink, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e['source'] === source);
}

function rowOf(db: Database, id: number): { status: string; retry_count: number; error: string | null } {
  return db.raw
    .prepare('SELECT status, retry_count, error FROM scheduled_messages WHERE id = ?')
    .get(id) as { status: string; retry_count: number; error: string | null };
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('MessageScheduler — link-awareness (#1779)', () => {
  let db: Database;
  let sinkDir: string;
  let sink: string;

  beforeEach(() => {
    // Fake ONLY timer functions (never Date): a stray interval cannot wedge the
    // run, yet Date.now()-based candidate selection stays real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    db = new Database(':memory:');
    db.open();
    sinkDir = mkdtempSync(join(tmpdir(), 'sched-link-sink-'));
    sink = join(sinkDir, 'alerts.jsonl');
    process.env['WHATSOUP_ALERT_SINK'] = sink; // capture alerts instead of paging an operator
    process.env['EMIT_ALERT_THROTTLE_MS'] = '0';
    resetEmitAlertThrottle();
  });

  afterEach(() => {
    delete process.env['WHATSOUP_ALERT_SINK'];
    delete process.env['EMIT_ALERT_THROTTLE_MS'];
    rmSync(sinkDir, { recursive: true, force: true });
    db.close();
    vi.useRealTimers();
  });

  it('holds a due one-shot on a de-linked instance instead of silently dropping it, alerting once', async () => {
    const id = insertPendingText(db.raw);
    const { conn, sendRawCalls } = makeConn({ getState: () => DELINKED });
    const scheduler = new MessageScheduler(db, conn, { intervalMs: 60_000, maxRetries: 3, instance: 'personal' });

    // Tick more times than maxRetries — a de-linked instance must NEVER reach
    // 'failed' by burning retries.
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();

    // 1. Never attempted the doomed send (link-state gate short-circuits).
    expect(sendRawCalls.length).toBe(0);

    // 2. Message retained, not dropped: still pending, zero retries burned, and
    //    annotated with a clear de-link reason.
    const row = rowOf(db, id);
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(0);
    expect(row.error).toMatch(/de-link|logged out|held until re-link/i);

    // 3. Loud owner feedback — emitted exactly once despite four ticks (latched).
    const alerts = readAlerts(sink, 'scheduler_delinked_send_held');
    expect(alerts.length).toBe(1);
  });

  it('keeps trying (does not defer) on a transient reconnect blip', async () => {
    const id = insertPendingText(db.raw);
    const { conn, sendRawCalls } = makeConn({
      getState: () => TRANSIENT,
      sendRawImpl: async () => {
        throw new Error('WhatsApp is not connected');
      },
    });
    const scheduler = new MessageScheduler(db, conn, { intervalMs: 60_000, maxRetries: 3, instance: 'personal' });

    await scheduler.tick();

    // Transient → the send WAS attempted (kept trying) and one retry burned;
    // NOT deferred, and no de-link alert.
    expect(sendRawCalls.length).toBe(1);
    const row = rowOf(db, id);
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(1);
    expect(readAlerts(sink, 'scheduler_delinked_send_held').length).toBe(0);
  });

  it('resumes and sends the held message once the instance is re-linked', async () => {
    const id = insertPendingText(db.raw);
    let linked = false;
    const { conn, sendRawCalls } = makeConn({
      getState: () => (linked ? BASE_SNAPSHOT : DELINKED),
    });
    const scheduler = new MessageScheduler(db, conn, { intervalMs: 60_000, maxRetries: 3, instance: 'personal' });

    await scheduler.tick(); // de-linked → held
    expect(sendRawCalls.length).toBe(0);
    expect(rowOf(db, id).status).toBe('pending');

    linked = true;
    await scheduler.tick(); // re-linked → sends
    expect(sendRawCalls.length).toBe(1);
    expect(rowOf(db, id).status).toBe('sent');
  });

  it('re-arms the de-link alert across a message-free re-linked window (second episode alerts again)', async () => {
    let linked = false;
    const { conn, sendRawCalls } = makeConn({
      getState: () => (linked ? BASE_SNAPSHOT : DELINKED),
    });
    const scheduler = new MessageScheduler(db, conn, { intervalMs: 60_000, maxRetries: 3, instance: 'personal' });

    // Episode 1 — de-linked with a due message → held + alert #1.
    const id1 = insertPendingText(db.raw);
    await scheduler.tick();
    expect(readAlerts(sink, 'scheduler_delinked_send_held').length).toBe(1);
    // Retire the held row so the re-linked window below has NOTHING due.
    db.raw.prepare("UPDATE scheduled_messages SET status = 'sent' WHERE id = ?").run(id1);

    // Re-link during a window with no due message. The latch must re-arm even
    // though there is nothing to send (matches loggedOutAlertEmitted, which
    // clears on 'open' unconditionally — not gated on scheduler activity).
    linked = true;
    await scheduler.tick();
    expect(sendRawCalls.length).toBe(0);

    // Episode 2 — de-link again with a fresh due message → alert #2 must fire.
    linked = false;
    insertPendingText(db.raw);
    await scheduler.tick();
    expect(readAlerts(sink, 'scheduler_delinked_send_held').length).toBe(2);
  });

  it('raises a loud alert when a one-shot scheduled send permanently fails (backstop, remediation #3)', async () => {
    const id = insertPendingText(db.raw);
    // No getConnectionState (e.g. an SMS transport, or a link state the gate
    // cannot classify): the send is attempted, fails, exhausts retries. The
    // permanent drop must be LOUD, not merely a log line.
    const { conn } = makeConn({
      sendRawImpl: async () => {
        throw new Error('WhatsApp is not connected');
      },
    });
    const scheduler = new MessageScheduler(db, conn, { intervalMs: 60_000, maxRetries: 3, instance: 'personal' });

    await scheduler.tick(); // retry 1
    await scheduler.tick(); // retry 2
    await scheduler.tick(); // retry 3 → permanently failed

    const row = rowOf(db, id);
    expect(row.status).toBe('failed');
    expect(row.retry_count).toBe(3);
    expect(readAlerts(sink, 'scheduler_send_failed').length).toBe(1);
  });
});
