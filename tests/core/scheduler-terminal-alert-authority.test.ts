/**
 * #2387 (scheduled-send addendum) — a TERMINAL scheduled-send failure must keep
 * durable notification authority when the checked alert enqueue is REJECTED.
 *
 * Both terminal dispositions in `handleSendFailure` write `status = 'failed'`
 * and then call `emitAlertChecked`. A `failed` row has left the due query, so
 * once the boolean is discarded a rejected enqueue has NO retry owner: the
 * operator alert for a permanently dropped scheduled message is lost for good,
 * silently. The same file already binds that boolean for the de-link hold
 * (#2415), where an accepted emission arms a latch and a durable marker.
 *
 * The criterion, verbatim: "Retain durable notification authority when the
 * checked alert enqueue fails; do not replay the scheduled send merely to
 * recreate an alert." The second clause is why every test here also pins the
 * row: re-sending a dropped message to regenerate its notification would be a
 * far worse cure than the disease.
 *
 * Enqueue rejection is produced the way the #2415 suite produces it — pointing
 * WHATSOUP_ALERT_SINK at a nonexistent directory, so `captureToAlertSink`
 * fails and `emitAlertChecked` returns false through the real emission path.
 * Nothing in `src/lib/emit-alert.ts` is mocked.
 *
 * The durable record is read as FILES under the marker directory rather than
 * through a scheduler accessor, so these tests cannot be satisfied by an
 * in-memory latch that a restart would lose.
 *
 * Timer-hang guard: this suite never calls scheduler.start(); it drives tick()
 * directly and fakes ONLY the timer functions (not Date), so a stray interval
 * cannot wedge the run while Date.now()-based candidate selection stays real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Database } from '../../src/core/database.ts';
import { MessageScheduler } from '../../src/core/scheduler.ts';
import { confineAlertContent } from '../../src/lib/alert-evidence.ts';
import { resetEmitAlertThrottle } from '../../src/lib/emit-alert.ts';
import { loadRecoveryMarkers, setRecoveryMarker } from '../../src/lib/recovery-authority-store.ts';
import type { RuntimeConnection } from '../../src/transport/runtime-connection.ts';

const INSTANCE = 'personal';
const MARKER_PREFIX = `scheduler_send_failed:${INSTANCE}:`;
const MARKER_DIR_NAME = 'recovery-authority.d';
const SCHEDULER_CONFIG = { intervalMs: 60_000, maxRetries: 3, instance: INSTANCE };

/** A body distinctive enough that its presence in a durable record is provable. */
const SECRET_BODY = 'sentinel-body-must-not-be-persisted';
const SECRET_JID = '15550100777@s.whatsapp.net';

interface MockConn {
  conn: RuntimeConnection;
  sendRawCalls: Array<[string, Record<string, unknown>]>;
}

function makeConn(sendRawImpl?: () => Promise<{ waMessageId: string }>): MockConn {
  const sendRawCalls: Array<[string, Record<string, unknown>]> = [];
  const conn = {
    sendRaw: vi.fn(async (jid: string, content: Record<string, unknown>) => {
      sendRawCalls.push([jid, content]);
      if (sendRawImpl) return sendRawImpl();
      return { waMessageId: 'mock-msg-id' };
    }),
    sendMedia: vi.fn(async () => ({ waMessageId: 'mock-media-id' })),
    // No getConnectionState: an unclassifiable transport is never link-gated,
    // so the #1779 de-link path can never absorb these rows.
  } as unknown as RuntimeConnection;
  return { conn, sendRawCalls };
}

function insertPending(raw: DatabaseSync, payload: string, chatJid = SECRET_JID): number {
  const scheduledAt = Math.floor(Date.now() / 1000) - 10;
  return Number(
    raw
      .prepare(
        `INSERT INTO scheduled_messages (chat_jid, content_type, payload, scheduled_at, status, retry_count)
         VALUES (?, 'text', ?, ?, 'pending', 0)`,
      )
      .run(chatJid, payload, scheduledAt).lastInsertRowid,
  );
}

/** A row whose stored payload can never decode — the first terminal path. */
function insertUndecodable(raw: DatabaseSync): number {
  return insertPending(raw, '{not valid json');
}

/** A row that decodes and sends, so the transport can exhaust its retries. */
function insertSendable(raw: DatabaseSync): number {
  return insertPending(raw, JSON.stringify({ text: SECRET_BODY }));
}

type RowState = {
  status: string;
  retry_count: number;
  error: string | null;
  send_started_at: number | null;
};

/**
 * The alert text as it stands at the baseline, transcribed from the two inline
 * emissions in `handleSendFailure`.
 *
 * Deliberately an INDEPENDENT copy rather than a call into the producer: the
 * criterion requires a re-emitted alert to be the same alert, and comparing the
 * producer against itself would prove only that it is self-consistent. #2386
 * confines this prose to `{failureClass, length, correlationDigest}` before it
 * reaches any transport, and that digest is a pure PBKDF2 of the raw string, so
 * asserting the confined form is a byte-exact assertion on the text.
 */
function baselineUndecodableAlert(id: number, error: string, recurring: boolean): {
  summary: string;
  evidence: string;
} {
  return {
    summary: `whatsoup@${INSTANCE} dead-lettered scheduled send (id ${id}) — stored payload is undecodable, message DROPPED: ${error}`,
    evidence: [
      `scheduledId=${id}`,
      `recurring=${recurring}`,
      `error=${error}`,
      'ref: #2359 — an undecodable payload is permanent, so it is dead-lettered on the first occurrence rather than consuming the retry budget. Inspect the scheduled_messages row; the payload column is not valid JSON.',
    ].join('\n'),
  };
}

function baselineExhaustionAlert(id: number, error: string, attempts: number): {
  summary: string;
  evidence: string;
} {
  return {
    summary: `whatsoup@${INSTANCE} permanently failed a scheduled send (id ${id}) after ${attempts} attempts — message DROPPED: ${error}`,
    evidence: [
      `scheduledId=${id}`,
      `attempts=${attempts}`,
      `error=${error}`,
      'ref: #1779 remediation #3 — a permanent scheduled-send drop is now surfaced as an alert. If the transport is de-linked, re-pair the WhatsApp link; otherwise inspect the send error.',
    ].join('\n'),
  };
}

/** Assert a captured alert carries exactly the given text, through #2386's confinement. */
function expectAlertText(
  alert: Record<string, unknown> | undefined,
  expected: { summary: string; evidence: string },
): void {
  expect(alert?.['summary']).toEqual(confineAlertContent('summary', expected.summary));
  expect(alert?.['evidence']).toEqual(confineAlertContent('evidence', expected.evidence));
}

function rowOf(db: Database, id: number): RowState {
  return db.raw
    .prepare('SELECT status, retry_count, error, send_started_at FROM scheduled_messages WHERE id = ?')
    .get(id) as RowState;
}

/**
 * Rows the next tick would select. Asserted to be zero before every draining
 * tick: if the alert only re-fires while something is still due, the retained
 * authority is riding on the row loop and the terminal case it exists for —
 * where the row is `failed` and gone — is untested.
 */
function dueRowCount(db: Database): number {
  const now = Math.floor(Date.now() / 1000);
  const { n } = db.raw
    .prepare(
      `SELECT COUNT(*) AS n FROM scheduled_messages
       WHERE status = 'pending'
         AND ((recurrence IS NULL AND scheduled_at <= ?)
              OR (recurrence IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ?))`,
    )
    .get(now, now) as { n: number };
  return n;
}

describe('MessageScheduler — terminal send alert authority (#2387)', () => {
  let db: Database;
  let sinkDir: string;
  let sink: string;
  let brokenSink: string;
  let markerDir: string;
  let savedStateDir: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    db = new Database(':memory:');
    db.open();
    sinkDir = mkdtempSync(join(tmpdir(), 'sched-terminal-sink-'));
    sink = join(sinkDir, 'alerts.jsonl');
    brokenSink = join(sinkDir, 'missing-dir', 'alerts.jsonl');
    // Per-test marker root: a marker left by one test would otherwise satisfy
    // (or suppress) the next one, making these assertions order-dependent.
    markerDir = mkdtempSync(join(tmpdir(), 'sched-terminal-markers-'));
    savedStateDir = process.env['BOT_ERRORS_STATE_DIR'];
    process.env['BOT_ERRORS_STATE_DIR'] = markerDir;
    process.env['WHATSOUP_ALERT_SINK'] = sink;
    process.env['EMIT_ALERT_THROTTLE_MS'] = '0';
    resetEmitAlertThrottle();
  });

  afterEach(() => {
    if (savedStateDir === undefined) delete process.env['BOT_ERRORS_STATE_DIR'];
    else process.env['BOT_ERRORS_STATE_DIR'] = savedStateDir;
    delete process.env['WHATSOUP_ALERT_SINK'];
    delete process.env['EMIT_ALERT_THROTTLE_MS'];
    rmSync(sinkDir, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
    db.close();
    vi.useRealTimers();
  });

  /** Reject every alert enqueue: the sink's parent directory does not exist. */
  function rejectEnqueue(): void {
    process.env['WHATSOUP_ALERT_SINK'] = brokenSink;
  }

  function acceptEnqueue(): void {
    process.env['WHATSOUP_ALERT_SINK'] = sink;
  }

  function alertsOf(source: string, eventType = 'alert'): Array<Record<string, unknown>> {
    if (!existsSync(sink)) return [];
    return readFileSync(sink, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((e) => e['source'] === source && e['eventType'] === eventType);
  }

  /** The durable records themselves, read as files rather than via the producer. */
  function markerFiles(): Array<{ key: string; body: Record<string, unknown> }> {
    const dir = join(markerDir, MARKER_DIR_NAME);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({
        key: decodeURIComponent(name.slice(0, -'.json'.length)),
        body: JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>,
      }));
  }

  /** Marker keys as the producer's own restart scan sees them. */
  function retainedKeys(): string[] {
    return [...loadRecoveryMarkers()].filter((key) => key.startsWith(MARKER_PREFIX)).sort();
  }

  /** Drive a decodable row to retry exhaustion (maxRetries = 3). */
  async function exhaustRetries(scheduler: MessageScheduler): Promise<void> {
    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
  }

  it('A1: an undecodable payload whose alert enqueue is rejected retains durable authority, and the row is still dead-lettered', async () => {
    const id = insertUndecodable(db.raw);
    const { conn, sendRawCalls } = makeConn();
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await scheduler.tick();

    // Row disposition is EXACTLY today's: dead-lettered on the first occurrence,
    // retry budget untouched, transport never reached.
    const row = rowOf(db, id);
    expect(row.status).toBe('failed');
    expect(row.retry_count).toBe(0);
    expect(sendRawCalls.length).toBe(0);

    // The enqueue really was rejected — nothing reached the operator.
    expect(alertsOf('scheduler_send_failed').length).toBe(0);

    // ...and the notification is still owed, durably, keyed to this row.
    expect(retainedKeys()).toEqual([`${MARKER_PREFIX}${id}`]);
  });

  it('A2: retry exhaustion whose alert enqueue is rejected retains durable authority, and the row is still permanently failed', async () => {
    const id = insertSendable(db.raw);
    const { conn, sendRawCalls } = makeConn(async () => {
      throw new Error('WhatsApp is not connected');
    });
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await exhaustRetries(scheduler);

    const row = rowOf(db, id);
    expect(row.status).toBe('failed');
    expect(row.retry_count).toBe(3);
    expect(sendRawCalls.length).toBe(3);
    expect(alertsOf('scheduler_send_failed').length).toBe(0);
    expect(retainedKeys()).toEqual([`${MARKER_PREFIX}${id}`]);
  });

  it('A3: a later tick with the sink accepting emits the retained alert exactly once and clears the record', async () => {
    const id = insertUndecodable(db.raw);
    const { conn } = makeConn();
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await scheduler.tick();
    expect(retainedKeys().length).toBe(1);

    // The row is gone from the due set, so the drain cannot ride on the row loop.
    expect(dueRowCount(db)).toBe(0);

    acceptEnqueue();
    await scheduler.tick();

    const alerts = alertsOf('scheduler_send_failed');
    expect(alerts.length).toBe(1);
    // The retained alert is the SAME alert, not a reconstruction that resembles it.
    expectAlertText(alerts[0], baselineUndecodableAlert(id, rowOf(db, id).error ?? '', false));
    expect(retainedKeys()).toEqual([]);

    // Discharged, not merely delayed: further ticks add nothing.
    await scheduler.tick();
    await scheduler.tick();
    expect(alertsOf('scheduler_send_failed').length).toBe(1);
  });

  it('A4: the retained alert for retry exhaustion drains identically, carrying the same attempt count as a first-attempt alert', async () => {
    const id = insertSendable(db.raw);
    const { conn } = makeConn(async () => {
      throw new Error('WhatsApp is not connected');
    });
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await exhaustRetries(scheduler);
    expect(dueRowCount(db)).toBe(0);

    acceptEnqueue();
    await scheduler.tick();

    const alerts = alertsOf('scheduler_send_failed');
    expect(alerts.length).toBe(1);
    // Byte-exact against the baseline text, attempt count included: a retained
    // alert that lost `attempts=3` would still page, but would page a lie.
    expectAlertText(alerts[0], baselineExhaustionAlert(id, 'WhatsApp is not connected', 3));
    expect(retainedKeys()).toEqual([]);
  });

  it('A5: the retained record survives a restart and is drained exactly once by a new scheduler over the same store', async () => {
    const id = insertUndecodable(db.raw);
    const { conn } = makeConn();

    rejectEnqueue();
    await new MessageScheduler(db, conn, SCHEDULER_CONFIG).tick();
    expect(retainedKeys()).toEqual([`${MARKER_PREFIX}${id}`]);

    // "Restart": a brand-new scheduler over the same database and marker store.
    // The obligation must come back from disk, not from the dead process.
    acceptEnqueue();
    const afterRestart = new MessageScheduler(db, conn, SCHEDULER_CONFIG);
    expect(dueRowCount(db)).toBe(0);
    await afterRestart.tick();

    expect(alertsOf('scheduler_send_failed').length).toBe(1);
    expect(retainedKeys()).toEqual([]);

    // A second restart after the accepted emission must page nobody again.
    await new MessageScheduler(db, conn, SCHEDULER_CONFIG).tick();
    expect(alertsOf('scheduler_send_failed').length).toBe(1);
  });

  it('A6 (control): an accepted first-attempt enqueue leaves NO record behind and still emits exactly one alert', async () => {
    const id = insertUndecodable(db.raw);
    const { conn } = makeConn();
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    // Sink healthy throughout — today's behaviour, which must be preserved.
    await scheduler.tick();

    expect(rowOf(db, id).status).toBe('failed');
    const alerts = alertsOf('scheduler_send_failed');
    expect(alerts.length).toBe(1);
    // Anchors the baseline templates the retained-alert tests compare against:
    // this case passes on the UNCHANGED scheduler, so a wrong template would
    // fail here first rather than silently weakening those assertions.
    expectAlertText(alerts[0], baselineUndecodableAlert(id, rowOf(db, id).error ?? '', false));
    expect(retainedKeys()).toEqual([]);

    await scheduler.tick();
    expect(alertsOf('scheduler_send_failed').length).toBe(1);
    expect(retainedKeys()).toEqual([]);
  });

  it('A7 (control): draining the retained alert never re-attempts the send and never touches the row', async () => {
    const id = insertSendable(db.raw);
    const { conn, sendRawCalls } = makeConn(async () => {
      throw new Error('WhatsApp is not connected');
    });
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await exhaustRetries(scheduler);
    const sendsBefore = sendRawCalls.length;
    const rowBefore = rowOf(db, id);

    acceptEnqueue();
    await scheduler.tick();
    await scheduler.tick();

    // The alert was recreated; the message was not.
    expect(alertsOf('scheduler_send_failed').length).toBe(1);
    expect(sendRawCalls.length).toBe(sendsBefore);
    expect(rowOf(db, id)).toEqual(rowBefore);
  });

  it('A8 (control): the durable record carries only the fields needed to re-emit — no destination, no message body', async () => {
    const id = insertSendable(db.raw);
    const { conn } = makeConn(async () => {
      throw new Error('WhatsApp is not connected');
    });
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await exhaustRetries(scheduler);

    const retained = markerFiles().filter((m) => m.key.startsWith(MARKER_PREFIX));
    expect(retained.length).toBe(1);
    const record = retained[0]!;
    expect(record.body['scheduledId']).toBe(id);

    // `source` and `setAt` are the marker store's own envelope fields; the rest
    // is exactly what re-rendering the alert needs.
    expect(Object.keys(record.body).sort()).toEqual(
      ['attempts', 'error', 'kind', 'scheduledId', 'setAt', 'source'].sort(),
    );

    // The destination and the message body never reach durable storage. (The
    // error string does, because the alert's own `error=` line needs it; the
    // evidence-redaction boundary is #2386's, deliberately not this leaf's.)
    const serialized = JSON.stringify(record.body);
    expect(serialized).not.toContain(SECRET_JID);
    expect(serialized).not.toContain(SECRET_BODY);
  });

  it('A10 (control): a retained record that cannot be re-rendered is discarded once, not retried forever', async () => {
    // A marker written by a future or older shape. The drain must neither page
    // with a half-built alert nor loop on it every tick for the life of the
    // process. Written through the store so the real key encoding is exercised.
    const poisonKey = `${MARKER_PREFIX}99`;
    setRecoveryMarker(poisonKey, { kind: 'bogus-shape-from-another-version' });
    expect(retainedKeys()).toEqual([poisonKey]);

    const { conn } = makeConn();
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);
    await scheduler.tick();
    await scheduler.tick();

    expect(alertsOf('scheduler_send_failed').length).toBe(0);
    expect(retainedKeys()).toEqual([]);
  });

  it('A9 (control): a de-linked instance still holds its rows and alerts on its own source, untouched by this path', async () => {
    // The de-link hold (#1779/#2415) is a different terminal-free path: rows
    // stay pending and no scheduler_send_failed authority is ever retained.
    const id = insertSendable(db.raw);
    const conn = {
      sendRaw: vi.fn(async () => ({ waMessageId: 'unused' })),
      sendMedia: vi.fn(async () => ({ waMessageId: 'unused' })),
      getConnectionState: () => ({
        connected: false,
        lastDisconnectReason: 'loggedOut',
        authBond: { status: 'invalid' },
      }),
    } as unknown as RuntimeConnection;
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    await scheduler.tick();

    expect(rowOf(db, id).status).toBe('pending');
    expect(conn.sendRaw).not.toHaveBeenCalled();
    expect(alertsOf('scheduler_delinked_send_held').length).toBe(1);
    expect(alertsOf('scheduler_send_failed').length).toBe(0);
    expect(retainedKeys()).toEqual([]);
  });
});
