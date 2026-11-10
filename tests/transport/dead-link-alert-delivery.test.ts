/**
 * Dead-link alarm against the real emit-alert and outbox.
 *
 * The delivery rule: a card or a clear counts as done only when it is in the
 * durable outbox. A legacy helper that accepted it, or a failed write, leaves
 * the marker unreported and the alarm retries on its own bounded timer: a
 * logged-out bot is parked, so no later close or restart is coming to retry it.
 *
 * Only the legacy helper's process spawn and its script-presence check are
 * stubbed; the outbox write, the emit-alert ladder and the marker are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })));
const helperPresent = vi.hoisted(() => ({ value: true }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      String(path).endsWith('whatsapp-alert.sh') ? helperPresent.value : actual.existsSync(path),
  };
});

// The real private-fs, except that a test can make marker writes fail.
const markerWrites = vi.hoisted(() => ({ fail: false }));
vi.mock('../../src/lib/private-fs.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/private-fs.ts')>();
  return {
    ...actual,
    writePrivateJsonMarkerSync: (...args: Parameters<typeof actual.writePrivateJsonMarkerSync>) => {
      if (markerWrites.fail) throw new Error('EACCES: marker write refused');
      return actual.writePrivateJsonMarkerSync(...args);
    },
  };
});

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

import { resetEmitAlertThrottle } from '../../src/lib/emit-alert.ts';
import {
  DEAD_LINK_ALERT_SOURCE,
  DEAD_LINK_GRACE_MS,
  DEAD_LINK_RETRY_MS,
  DeadLinkAlarm,
} from '../../src/transport/dead-link-alert.ts';

const OUTAGE_START = '2026-11-09T05:00:00.000Z';
const UNWRITABLE_OUTBOX = '/dev/null/outbox';
const BOT_ERRORS_JID = '111111100000001@g.us';
const LOGGED_OUT = { statusCode: 401, reason: 'loggedOut', classification: 'uninspected_401_conservative_exit' };

let root = '';
let outboxDir = '';
let dataRoot = '';

function marker(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dataRoot, 'dead-link-outage.json'), 'utf8')) as Record<string, unknown>;
}

function queued(eventType: 'alert' | 'clear'): Record<string, any>[] {
  if (!existsSync(outboxDir)) return [];
  return readdirSync(outboxDir)
    .filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(readFileSync(join(outboxDir, file), 'utf8')) as Record<string, any>)
    .filter(event => event.source === DEAD_LINK_ALERT_SOURCE && event.eventType === eventType);
}

function newAlarm(): DeadLinkAlarm {
  return new DeadLinkAlarm({ instance: 'dead-link-bot', dataRoot, log: { warn: vi.fn(), error: vi.fn() } as never });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(OUTAGE_START));
  spawnMock.mockClear();
  helperPresent.value = true;
  markerWrites.fail = false;
  resetEmitAlertThrottle();
  root = mkdtempSync(join(tmpdir(), 'dead-link-delivery-'));
  outboxDir = join(root, 'outbox');
  dataRoot = join(root, 'data');
  process.env['BOT_ERRORS_OUTBOX_DIR'] = outboxDir;
  process.env['BOT_ERRORS_WRITEFAIL_DIR'] = join(root, 'writefail');
  process.env['BOT_ERRORS_JID'] = BOT_ERRORS_JID;
  process.env['BOT_ERRORS_EXPECTED_JID'] = BOT_ERRORS_JID;
  delete process.env['WHATSOUP_ALERT_SINK'];
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  for (const key of ['BOT_ERRORS_OUTBOX_DIR', 'BOT_ERRORS_WRITEFAIL_DIR', 'BOT_ERRORS_JID', 'BOT_ERRORS_EXPECTED_JID']) {
    delete process.env[key];
  }
});

describe('dead-link alarm delivery', () => {
  it('a card the legacy helper would accept is not recorded as raised, and is never handed to it', async () => {
    process.env['BOT_ERRORS_OUTBOX_DIR'] = UNWRITABLE_OUTBOX;
    const alarm = newAlarm();
    alarm.onLoggedOut(LOGGED_OUT);

    await vi.advanceTimersByTimeAsync(DEAD_LINK_GRACE_MS);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(marker()).toMatchObject({ outageStartedAt: OUTAGE_START, alertedAt: null });
    alarm.dispose();
  });

  it('a card no channel took is retried on a bounded timer with no further close or restart', async () => {
    helperPresent.value = false;
    process.env['BOT_ERRORS_OUTBOX_DIR'] = UNWRITABLE_OUTBOX;
    const alarm = newAlarm();
    alarm.onLoggedOut(LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(DEAD_LINK_GRACE_MS);
    expect(marker()).toMatchObject({ alertedAt: null });

    // The outbox recovers while the bot stays parked: nothing else happens.
    process.env['BOT_ERRORS_OUTBOX_DIR'] = outboxDir;
    await vi.advanceTimersByTimeAsync(DEAD_LINK_RETRY_MS);

    expect(queued('alert')).toHaveLength(1);
    expect(marker()).toMatchObject({ outageStartedAt: OUTAGE_START, alertedAt: '2026-11-09T05:11:00.000Z' });

    // Once queued, the card is never raised again for this outage.
    await vi.advanceTimersByTimeAsync(10 * DEAD_LINK_RETRY_MS);
    expect(queued('alert')).toHaveLength(1);
    alarm.dispose();
  });

  it('the queued card carries the outage start as a structured field', async () => {
    const alarm = newAlarm();
    alarm.onLoggedOut(LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(DEAD_LINK_GRACE_MS);

    const [card] = queued('alert');
    expect(card?.diagnostics?.outageStartedAt).toBe(OUTAGE_START);
    expect(card?.instance).toBe('dead-link-bot');
    alarm.dispose();
  });

  it('a clear the legacy helper would accept leaves the outage open, and is never handed to it', async () => {
    const alarm = newAlarm();
    alarm.onLoggedOut(LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(DEAD_LINK_GRACE_MS);
    expect(queued('alert')).toHaveLength(1);

    process.env['BOT_ERRORS_OUTBOX_DIR'] = UNWRITABLE_OUTBOX;
    alarm.onConnectionOpen();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(marker()).toMatchObject({ state: 'clearing' });

    process.env['BOT_ERRORS_OUTBOX_DIR'] = outboxDir;
    await vi.advanceTimersByTimeAsync(DEAD_LINK_RETRY_MS);
    expect(queued('clear')).toHaveLength(1);
    expect(marker()).toMatchObject({ state: 'cleared' });
    alarm.dispose();
  });
});

describe('dead-link alarm: at least once per outage, with an outage ID', () => {
  const MARKER_FILE = () => join(dataRoot, 'dead-link-outage.json');
  const lockDataRoot = () => { markerWrites.fail = true; };
  const unlockDataRoot = () => { markerWrites.fail = false; };

  it('keeps the marker after a clear, recorded as cleared, and never deletes it', async () => {
    const alarm = newAlarm();
    alarm.onLoggedOut(LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(DEAD_LINK_GRACE_MS);
    const id = queued('alert')[0]!.diagnostics.outageId as string;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    alarm.onConnectionOpen();
    expect(marker()).toMatchObject({ outageId: id, state: 'cleared', clearQueuedAt: expect.any(String) });
    expect(queued('clear')[0]!.diagnostics.outageId).toBe(id);
    alarm.dispose();
  });

  it('a marker that cannot be updated at the link open never suppresses the next outage', async () => {
    const alarm = newAlarm();
    alarm.onLoggedOut(LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(DEAD_LINK_GRACE_MS);
    expect(queued('alert')).toHaveLength(1);
    const first = marker();
    expect(first.state).toBe('alerted');

    lockDataRoot();
    alarm.onConnectionOpen();
    // The file still says "alerted" for the outage that has ended.
    expect(marker()).toMatchObject({ outageId: first.outageId, state: 'alerted' });

    alarm.onLoggedOut(LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(DEAD_LINK_GRACE_MS);
    const cards = queued('alert');
    expect(cards).toHaveLength(2);
    expect(cards[1]!.diagnostics.outageId).not.toBe(cards[0]!.diagnostics.outageId);
    alarm.dispose();
  });

  it('a failed marker write is retried on the retry timer and lands once the directory is writable', async () => {
    mkdirSync(dataRoot, { recursive: true });
    lockDataRoot();
    const alarm = newAlarm();
    alarm.onLoggedOut(LOGGED_OUT);
    expect(existsSync(MARKER_FILE())).toBe(false);

    await vi.advanceTimersByTimeAsync(DEAD_LINK_GRACE_MS);
    // Memory was authoritative: the card went out although nothing was persisted.
    expect(queued('alert')).toHaveLength(1);

    unlockDataRoot();
    await vi.advanceTimersByTimeAsync(DEAD_LINK_RETRY_MS);
    expect(marker()).toMatchObject({ state: 'alerted', outageId: queued('alert')[0]!.diagnostics.outageId });
    alarm.dispose();
  });

  it('a restart after a failed persist raises the card when the marker is missing', async () => {
    mkdirSync(dataRoot, { recursive: true });
    lockDataRoot();
    const before = newAlarm();
    before.onLoggedOut(LOGGED_OUT);
    before.dispose();
    expect(existsSync(MARKER_FILE())).toBe(false);
    unlockDataRoot();

    const after = newAlarm();
    after.resume();
    after.onLoggedOut(LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(DEAD_LINK_GRACE_MS);
    expect(queued('alert')).toHaveLength(1);
    after.dispose();
  });

  it.each([
    ['unparsable text', '{not json'],
    ['an unknown state', JSON.stringify({ version: 2, outageId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), outageStartedAt: OUTAGE_START, deadline: OUTAGE_START, state: 'weird', alertedAt: null, clearQueuedAt: null, statusCode: 401 })],
    ['a marker from the earlier format', JSON.stringify({ version: 1, outageStartedAt: OUTAGE_START, statusCode: 401, alertedAt: null, linkOpenedAt: null, heldOutage: null })],
  ])('a restart over %s treats the card as unconfirmed and raises it', async (_label, text) => {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(MARKER_FILE(), text);

    const alarm = newAlarm();
    alarm.resume();
    await vi.advanceTimersByTimeAsync(DEAD_LINK_GRACE_MS);
    expect(queued('alert')).toHaveLength(1);
    expect(marker()).toMatchObject({ state: 'alerted' });
    alarm.dispose();
  });

  it('a marker that vanishes mid-outage sends the card again with the same outage ID', async () => {
    const alarm = newAlarm();
    alarm.onLoggedOut(LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(DEAD_LINK_GRACE_MS);
    expect(queued('alert')).toHaveLength(1);

    rmSync(MARKER_FILE());
    alarm.onLoggedOut(LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(1);
    const cards = queued('alert');
    expect(cards).toHaveLength(2);
    expect(cards[1]!.diagnostics.outageId).toBe(cards[0]!.diagnostics.outageId);
    alarm.dispose();
  });
});
