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
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// Scheduler-scoped logger capture: the marker branches are distinguished by
// whether they SAY anything, so "discarded loudly" and "dropped silently" need
// the log, not just the file. Other components fall through to a discarding
// mock (same shape as health-probe-storm.test.ts).
const schedulerLog = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);

vi.mock('../../src/logger.ts', async () => {
  const { componentLoggerMock, loggerMock } = await import('../helpers/logger-mock.ts');
  const { log, createChildLogger } = componentLoggerMock('scheduler', () => loggerMock().createChildLogger());
  Object.assign(schedulerLog, log);
  return { createChildLogger };
});

import { Database } from '../../src/core/database.ts';
import { MessageScheduler } from '../../src/core/scheduler.ts';
import { confineAlertContent } from '../../src/lib/alert-evidence.ts';
import { resetEmitAlertThrottle } from '../../src/lib/emit-alert.ts';
import { loadRecoveryMarkers, setRecoveryMarker } from '../../src/lib/recovery-authority-store.ts';
import type { RuntimeConnection } from '../../src/transport/runtime-connection.ts';
import { resetLoggerMock } from '../helpers/logger-mock.ts';

const INSTANCE = 'personal';
const MARKER_PREFIX = `scheduler_send_failed:${INSTANCE}:`;
const MARKER_DIR_NAME = 'recovery-authority.d';
const SCHEDULER_CONFIG = { intervalMs: 60_000, maxRetries: 3, instance: INSTANCE };

/** A body distinctive enough that its presence in a durable record is provable. */
const SECRET_BODY = 'sentinel-body-must-not-be-persisted';
const SECRET_JID = '15550100777@s.whatsapp.net';

/**
 * Payload bytes that DO reach the JSON.parse message, and therefore the row's
 * error column. V8 quotes only the first ten characters of an input that is not
 * JSON-shaped at all ("Unexpected token 'R', \"RACHEL-PAY\"... is not valid
 * JSON"), so a longer sentinel would be truncated away and the assertion that
 * the marker excludes it would pass for the wrong reason.
 */
const PAYLOAD_SENTINEL = 'RACHEL-PAY';

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
    resetLoggerMock(schedulerLog);
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

  function markerDirPath(): string {
    return join(markerDir, MARKER_DIR_NAME);
  }

  /** Resolve one key to its file through the store's own encoder, never a copy of it. */
  function markerPathOf(key: string): string {
    setRecoveryMarker(key);
    const name = readdirSync(markerDirPath()).find((f) => decodeURIComponent(f.slice(0, -'.json'.length)) === key);
    if (name === undefined) throw new Error(`no marker file materialised for ${key}`);
    return join(markerDirPath(), name);
  }

  /** Replace one marker's bytes with arbitrary content (corrupt-marker fixtures). */
  function writeRawMarker(key: string, bytes: string): void {
    writeFileSync(markerPathOf(key), bytes);
  }

  /** Remove one marker behind the scheduler's back, as another process would. */
  function removeRawMarker(key: string): void {
    unlinkSync(markerPathOf(key));
  }

  /** Scheduler warn-event names seen so far, for the loud-versus-silent branches. */
  function warnEvents(): string[] {
    return schedulerLog['warn']!.mock.calls.map((call) => {
      const first = call[0] as Record<string, unknown> | undefined;
      return typeof first?.['event'] === 'string' ? (first['event'] as string) : '';
    });
  }

  /**
   * Warn events with their `reason`. The two unusable-marker branches share an
   * event name and differ only here, so asserting the name alone cannot tell
   * "bytes I could not read" from "bytes I read and cannot use".
   */
  function warnReasons(event: string): string[] {
    return schedulerLog['warn']!.mock.calls
      .map((call) => call[0] as Record<string, unknown> | undefined)
      .filter((first) => first?.['event'] === event)
      .map((first) => String(first?.['reason'] ?? ''));
  }

  /**
   * The durable records themselves, read as files rather than via the producer.
   *
   * `body` is null for bytes that are not parseable JSON — a corrupt record is a
   * fixture here, so the reader must survive it and let the assertion speak.
   */
  function markerFiles(): Array<{ key: string; body: Record<string, unknown> | null; raw: string }> {
    const dir = markerDirPath();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const raw = readFileSync(join(dir, name), 'utf8');
        let body: Record<string, unknown> | null = null;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = null;
        }
        return { key: decodeURIComponent(name.slice(0, -'.json'.length)), raw, body };
      });
  }

  /** Marker keys as the producer's own restart scan sees them. */
  function retainedKeys(): string[] {
    return [...loadRecoveryMarkers()].filter((key) => key.startsWith(MARKER_PREFIX)).sort();
  }

  /** Only this leaf's records, with their bytes. */
  function terminalMarkers(): Array<{ key: string; body: Record<string, unknown> | null; raw: string }> {
    return markerFiles().filter((m) => m.key.startsWith(MARKER_PREFIX));
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

    // Captured before the drain clears it: the record is what the retried alert
    // must be built from, so the expectation comes from disk rather than from a
    // second copy of the producer's logic. The error it holds is redacted (B1);
    // everything else is the baseline text.
    const storedError = String(terminalMarkers()[0]!.body?.['error']);

    acceptEnqueue();
    await scheduler.tick();

    const alerts = alertsOf('scheduler_send_failed');
    expect(alerts.length).toBe(1);
    expectAlertText(alerts[0], baselineUndecodableAlert(id, storedError, false));
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
    expect(record.body?.['scheduledId']).toBe(id);

    // `source` and `setAt` are the marker store's own envelope fields; the rest
    // is exactly what re-rendering the alert needs.
    expect(Object.keys(record.body ?? {}).sort()).toEqual(
      ['attempts', 'error', 'errorClass', 'kind', 'scheduledId', 'setAt', 'source'].sort(),
    );

    // The destination and the message body never reach durable storage. (The
    // error string does, because the alert's own `error=` line needs it; the
    // evidence-redaction boundary is #2386's, deliberately not this leaf's.)
    const serialized = JSON.stringify(record.body);
    expect(serialized).not.toContain(SECRET_JID);
    expect(serialized).not.toContain(SECRET_BODY);
  });

  it('B1: an undecodable payload puts no payload bytes in the durable record or in the retried alert', async () => {
    const id = insertPending(db.raw, `${PAYLOAD_SENTINEL} roll advance 4200 lands Friday`);
    const { conn } = makeConn();
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await scheduler.tick();

    // Positive control. Without it the two negative assertions below would pass
    // on a fixture whose error simply never carried payload bytes — which is
    // exactly how the first clause-5 control (A8) missed this path.
    expect(rowOf(db, id).error ?? '').toContain(PAYLOAD_SENTINEL);

    const retained = terminalMarkers();
    expect(retained.length).toBe(1);
    expect(retained[0]!.raw).not.toContain(PAYLOAD_SENTINEL);
    const storedError = String(retained[0]!.body?.['error']);
    expect(storedError).toContain('<redacted>');

    // The retried alert is rendered from the record, so it inherits the
    // redaction. Built from the bytes on disk, not from a copy of the redactor.
    acceptEnqueue();
    await scheduler.tick();
    const alerts = alertsOf('scheduler_send_failed');
    expect(alerts.length).toBe(1);
    expectAlertText(alerts[0], baselineUndecodableAlert(id, storedError, false));
  });

  it('B2 (control): an accepted first-attempt alert still carries the raw error, unchanged from base', async () => {
    const id = insertPending(db.raw, `${PAYLOAD_SENTINEL} roll advance 4200 lands Friday`);
    const { conn } = makeConn();

    // Sink healthy: no record is written, so nothing is redacted and the
    // operator sees exactly what the baseline emitted.
    await new MessageScheduler(db, conn, SCHEDULER_CONFIG).tick();

    const alerts = alertsOf('scheduler_send_failed');
    expect(alerts.length).toBe(1);
    const rawError = rowOf(db, id).error ?? '';
    expect(rawError).toContain(PAYLOAD_SENTINEL);
    expectAlertText(alerts[0], baselineUndecodableAlert(id, rawError, false));
    expect(retainedKeys()).toEqual([]);
  });

  it('B1b: a payload that itself contains a double quote still reaches no durable byte', async () => {
    // V8 echoes such a payload WHOLE rather than as a ten-character prefix:
    // `{"x":}` renders as `Unexpected token '}', "{"x":}" is not valid JSON`.
    // Pair-matching the quotes there aligns them wrongly and leaves the payload
    // sitting between two redacted pairs, so the span must be greedy.
    const id = insertPending(db.raw, `{"${PAYLOAD_SENTINEL}":}`);
    const { conn } = makeConn();
    rejectEnqueue();
    await new MessageScheduler(db, conn, SCHEDULER_CONFIG).tick();

    expect(rowOf(db, id).error ?? '').toContain(PAYLOAD_SENTINEL);
    expect(terminalMarkers()[0]!.raw).not.toContain(PAYLOAD_SENTINEL);
  });

  it('B2b: redaction blanks quoted runs by shape, not by matching a V8 phrasing', async () => {
    // The positional message quotes grammar tokens rather than payload bytes.
    // Blanking those too is the price of not depending on V8 wording, which is
    // not a stable contract across Node versions — so pin the price.
    const id = insertUndecodable(db.raw);
    const { conn } = makeConn();
    rejectEnqueue();
    await new MessageScheduler(db, conn, SCHEDULER_CONFIG).tick();

    const rawError = rowOf(db, id).error ?? '';
    expect(rawError).toContain("'}'");
    const storedError = String(terminalMarkers()[0]!.body?.['error']);
    expect(storedError).not.toContain("'}'");
    expect(storedError).toContain("'<redacted>'");
    // The skeleton an operator acts on survives.
    expect(storedError).toContain('in JSON at position 1');
  });

  it('B2c (control): an unquoted transport error is stored byte-identical, so its retried alert is unchanged', async () => {
    const id = insertSendable(db.raw);
    const { conn } = makeConn(async () => {
      throw new Error('WhatsApp is not connected');
    });
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await exhaustRetries(scheduler);

    // Redaction is scoped to quoted content: the retry-exhaustion path carries no
    // payload bytes and must not pay for the undecodable path's problem.
    expect(String(terminalMarkers()[0]!.body?.['error'])).toBe('WhatsApp is not connected');

    acceptEnqueue();
    await scheduler.tick();
    const alerts = alertsOf('scheduler_send_failed');
    expect(alerts.length).toBe(1);
    expectAlertText(alerts[0], baselineExhaustionAlert(id, 'WhatsApp is not connected', 3));
  });

  it('B2d: a pathological error is bounded before it reaches the record', async () => {
    insertSendable(db.raw);
    const { conn } = makeConn(async () => {
      throw new Error(`overflow ${'X'.repeat(5000)}`);
    });
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await exhaustRetries(scheduler);

    const storedError = String(terminalMarkers()[0]!.body?.['error']);
    // The row keeps the whole thing; the durable record is a bounded field, not a log.
    expect((rowOf(db, 1).error ?? '').length).toBeGreaterThan(1000);
    expect(storedError.length).toBeLessThanOrEqual(201);
  });

  it('B3: a record whose bytes are unparseable is logged and discarded, not dropped silently', async () => {
    writeRawMarker(`${MARKER_PREFIX}77`, '{"kind":"retry_exhausted","scheduledId":77,');
    const { conn } = makeConn();
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    await scheduler.tick();

    expect(alertsOf('scheduler_send_failed').length).toBe(0);
    expect(terminalMarkers()).toEqual([]);
    // `invalid`, not `unparseable`: the bytes never became an object at all.
    expect(warnReasons('scheduler_terminal_alert_marker_unusable')).toEqual(['invalid']);
  });

  it('C1: an alert delivered but whose marker cannot be cleared pages once, not once per tick', async () => {
    const id = insertUndecodable(db.raw);
    const { conn } = makeConn();
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await scheduler.tick();
    expect(retainedKeys()).toEqual([`${MARKER_PREFIX}${id}`]);

    // 0500 leaves readdir and read working and makes unlink fail: the alert
    // lands, the marker survives, and the per-tick re-derivation keeps handing
    // the key back. Without a bound that is one page every tick, forever.
    acceptEnqueue();
    chmodSync(markerDirPath(), 0o500);
    try {
      await scheduler.tick();
      await scheduler.tick();
      await scheduler.tick();
    } finally {
      chmodSync(markerDirPath(), 0o700);
    }

    expect(alertsOf('scheduler_send_failed').length).toBe(1);
    expect(retainedKeys()).toEqual([`${MARKER_PREFIX}${id}`]);
    // Said once, on entry — a warn per tick is the same spam in another channel.
    expect(warnEvents().filter((e) => e === 'scheduler_terminal_alert_marker_unclearable')).toEqual([
      'scheduler_terminal_alert_marker_unclearable',
    ]);

    // The clear is still retried every tick, so a store that heals resolves it
    // with no further page.
    await scheduler.tick();
    expect(retainedKeys()).toEqual([]);
    expect(alertsOf('scheduler_send_failed').length).toBe(1);
  });

  it('E1: a NEW obligation at a suppressed key is emitted, not skipped unread and deleted', async () => {
    const id = insertUndecodable(db.raw);
    const { conn } = makeConn();
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await scheduler.tick();
    const firstMarker = terminalMarkers()[0]!.raw;

    // Deliver, fail the clear: the key is now suppressed against re-emission.
    acceptEnqueue();
    chmodSync(markerDirPath(), 0o500);
    try {
      await scheduler.tick();
    } finally {
      chmodSync(markerDirPath(), 0o700);
    }
    expect(alertsOf('scheduler_send_failed').length).toBe(1);

    // A DIFFERENT obligation lands at the same key while the suppression stands
    // — the operator-recreated marker of the design note. The key names a row,
    // not a delivery, so nothing about the old delivery speaks for this one.
    const path = markerPathOf(`${MARKER_PREFIX}${id}`);
    writeFileSync(
      path,
      JSON.stringify({
        kind: 'retry_exhausted',
        scheduledId: id,
        error: 'a second, different terminal failure',
        attempts: 3,
        source: `${MARKER_PREFIX}${id}`,
        setAt: '2099-01-01T00:00:00.000Z',
      }),
    );
    expect(readFileSync(path, 'utf8')).not.toBe(firstMarker);
    chmodSync(markerDirPath(), 0o500);
    try {
      await scheduler.tick();
    } finally {
      chmodSync(markerDirPath(), 0o700);
    }

    // Emitted, and the record still on disk because the clear is still failing.
    expect(alertsOf('scheduler_send_failed').length).toBe(2);
    expect(retainedKeys()).toEqual([`${MARKER_PREFIX}${id}`]);
    // And it is the NEW obligation that was paged, not a repeat of the first:
    // the confined summary is a digest of the text, so inequality here is
    // inequality of the alert itself.
    const paged = alertsOf('scheduler_send_failed');
    expect(paged[1]?.['summary']).not.toEqual(paged[0]?.['summary']);
    expect(paged[1]?.['summary']).toEqual(
      confineAlertContent('summary', baselineExhaustionAlert(id, 'a second, different terminal failure', 3).summary),
    );
  });

  it('E2 (control): once the clear lands, a later obligation at the same key emits normally', async () => {
    const id = insertUndecodable(db.raw);
    const { conn } = makeConn();
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await scheduler.tick();
    acceptEnqueue();
    chmodSync(markerDirPath(), 0o500);
    try {
      await scheduler.tick();
    } finally {
      chmodSync(markerDirPath(), 0o700);
    }
    expect(alertsOf('scheduler_send_failed').length).toBe(1);

    // Healed store: the clear lands and the suppression retires with it.
    await scheduler.tick();
    expect(retainedKeys()).toEqual([]);

    // The same row fails terminally again with the sink rejecting.
    db.raw
      .prepare("UPDATE scheduled_messages SET status = 'pending', retry_count = 0 WHERE id = ?")
      .run(id);
    rejectEnqueue();
    await scheduler.tick();
    expect(retainedKeys()).toEqual([`${MARKER_PREFIX}${id}`]);

    acceptEnqueue();
    await scheduler.tick();
    expect(alertsOf('scheduler_send_failed').length).toBe(2);
    expect(retainedKeys()).toEqual([]);
  });

  it('E3: an unquoted destination in a send error never reaches the durable record', async () => {
    const destination = '15551234567@s.whatsapp.net';
    insertSendable(db.raw);
    const { conn } = makeConn(async () => {
      throw new Error(`send to ${destination} rejected`);
    });
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await exhaustRetries(scheduler);

    // Positive control: quoting does not cover this shape, so the raw error
    // really does carry the destination and the assertions below are not vacuous.
    expect(rowOf(db, 1).error ?? '').toContain(destination);

    const record = terminalMarkers()[0]!;
    expect(record.raw).not.toContain(destination);
    expect(record.raw).not.toContain('15551234567');
    expect(record.raw).not.toContain('s.whatsapp.net');
    const storedError = String(record.body?.['error']);
    expect(storedError).toContain('rejected');

    // The retry-path alert carries the placeholder form, not the destination.
    acceptEnqueue();
    await scheduler.tick();
    const alerts = alertsOf('scheduler_send_failed');
    expect(alerts.length).toBe(1);
    expectAlertText(alerts[0], baselineExhaustionAlert(1, storedError, 3));
  });

  it('C2 (documented): a restart over a marker whose clear never landed re-emits exactly once', async () => {
    const id = insertUndecodable(db.raw);
    const { conn } = makeConn();
    const first = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await first.tick();
    acceptEnqueue();
    chmodSync(markerDirPath(), 0o500);
    try {
      await first.tick();
      await first.tick();
    } finally {
      chmodSync(markerDirPath(), 0o700);
    }
    expect(alertsOf('scheduler_send_failed').length).toBe(1);

    // The suppression is process-local ON PURPOSE. Disk still says the alert was
    // never cleared, and a new process has no standing to disbelieve it — one
    // duplicate page is the honest reading of a marker that is still there.
    chmodSync(markerDirPath(), 0o500);
    let restarted: MessageScheduler;
    try {
      restarted = new MessageScheduler(db, conn, SCHEDULER_CONFIG);
      await restarted.tick();
    } finally {
      chmodSync(markerDirPath(), 0o700);
    }
    expect(alertsOf('scheduler_send_failed').length).toBe(2);
    expect(retainedKeys()).toEqual([`${MARKER_PREFIX}${id}`]);
  });

  it('C3: a record whose bytes cannot be READ is kept, and says so with reason unreadable', async () => {
    const key = `${MARKER_PREFIX}55`;
    const path = markerPathOf(key);
    setRecoveryMarker(key, { kind: 'retry_exhausted', scheduledId: 55, error: 'boom', attempts: 3 });
    chmodSync(path, 0o000);

    const { conn } = makeConn();
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);
    try {
      await scheduler.tick();
      // Kept, not discarded: bytes nobody could interpret must not be deleted.
      expect(existsSync(path)).toBe(true);
      expect(alertsOf('scheduler_send_failed').length).toBe(0);
      expect(warnReasons('scheduler_terminal_alert_marker_unusable')).toEqual(['unreadable']);
    } finally {
      chmodSync(path, 0o600);
    }

    // And a later tick, once the file is readable, delivers the alert it held.
    resetLoggerMock(schedulerLog);
    await scheduler.tick();
    expect(alertsOf('scheduler_send_failed').length).toBe(1);
    expect(retainedKeys()).toEqual([]);
  });

  it('B4 (control): a record another process already discharged is dropped without a word', async () => {
    const id = insertUndecodable(db.raw);
    const { conn } = makeConn();
    const scheduler = new MessageScheduler(db, conn, SCHEDULER_CONFIG);

    rejectEnqueue();
    await scheduler.tick();
    expect(retainedKeys()).toEqual([`${MARKER_PREFIX}${id}`]);

    removeRawMarker(`${MARKER_PREFIX}${id}`);
    resetLoggerMock(schedulerLog);
    acceptEnqueue();
    await scheduler.tick();

    // Nothing to re-emit and nothing wrong: a missing record is the normal
    // shape of "someone else discharged it", not a fault to report.
    expect(alertsOf('scheduler_send_failed').length).toBe(0);
    expect(warnEvents()).not.toContain('scheduler_terminal_alert_marker_unusable');
  });

  it('B5: a retained record survives a failed startup scan and is emitted on a later tick exactly once', async () => {
    const id = insertUndecodable(db.raw);
    const { conn } = makeConn();

    rejectEnqueue();
    await new MessageScheduler(db, conn, SCHEDULER_CONFIG).tick();
    expect(retainedKeys()).toEqual([`${MARKER_PREFIX}${id}`]);

    // Restart while the marker directory is unreadable. readMarkerDirectory
    // returns an EMPTY set rather than throwing on a readdir failure, so a
    // constructor-only seed cannot tell this from "nothing is owed" — and the
    // rows are terminal, so no later event could ever re-seed it.
    chmodSync(markerDirPath(), 0o000);
    let restarted: MessageScheduler;
    try {
      restarted = new MessageScheduler(db, conn, SCHEDULER_CONFIG);
    } finally {
      chmodSync(markerDirPath(), 0o700);
    }

    acceptEnqueue();
    await restarted.tick();
    expect(alertsOf('scheduler_send_failed').length).toBe(1);
    expect(retainedKeys()).toEqual([]);

    await restarted.tick();
    expect(alertsOf('scheduler_send_failed').length).toBe(1);
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
    // `unparseable`, not `invalid`: the bytes parsed into an object that no
    // alert can be rendered from. Same event, opposite diagnosis.
    expect(warnReasons('scheduler_terminal_alert_marker_unusable')).toEqual(['unparseable']);
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

