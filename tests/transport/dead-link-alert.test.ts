/**
 * Dead-link alert: a 401 loggedOut with no reconnect inside 10 minutes raises
 * exactly one BOT ERRORS card per outage (source `whatsapp_link_dead`).
 *
 * Production gap (2026-11-09): four bots stayed linkless for 8-18 days. Each
 * outage's immediate `whatsapp_device_bond_lost` alert was absorbed by a
 * months-old `awaiting_physical` incident for the same key, so no new card
 * reached anyone. This alert has its own incident, which the transport clears
 * when the link opens again, so the next outage gets a fresh card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { usePerTestBotErrorsMarkerIsolation } from '../../tests/setup/bot-errors-vitest-isolation.ts';

const emitAlertMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => true));
const clearAlertSourceMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => true));
const { testAuthDir, testDataRoot, testRoot, testStateRoot } = vi.hoisted(() => {
  const testRoot = `/tmp/wa-test-dead-link-${process.pid}`;
  return {
    testAuthDir: `${testRoot}/auth`,
    testDataRoot: `${testRoot}/data`,
    testRoot,
    testStateRoot: `${testRoot}/state`,
  };
});

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: vi.fn(),
  useMultiFileAuthState: vi.fn().mockResolvedValue({
    state: { creds: {}, keys: {} },
    saveCreds: vi.fn(),
  }),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 2413, 1] }),
  makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
  DisconnectReason: {
    loggedOut: 401,
    restartRequired: 515,
    connectionClosed: 428,
    connectionLost: 408,
    timedOut: 408,
    connectionReplaced: 440,
    multideviceMismatch: 411,
    badSession: 500,
    unavailableService: 503,
    401: 'loggedOut',
    408: 'timedOut',
    411: 'multideviceMismatch',
    428: 'connectionClosed',
    440: 'connectionReplaced',
    500: 'badSession',
    503: 'unavailableService',
    515: 'restartRequired',
  },
  isJidGroup: vi.fn((jid: string) => jid?.endsWith('@g.us')),
  jidNormalizedUser: vi.fn((jid: string) => jid?.replace(/:.*@/, '@')),
  BufferJSON: {
    replacer: (_key: string, value: unknown) => value,
    reviver: (_key: string, value: unknown) => value,
  },
}));

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    authDir: testAuthDir,
    stateRoot: testStateRoot,
    dataRoot: testDataRoot,
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-dead-link/tmp',
    botName: 'dead-link-bot',
    accessMode: 'allowlist',
    healthPort: 9090,
    transportAuthority: { enabled: false, accountId: 'synthetic-account' },
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('../../src/core/retry.ts', () => ({
  jitteredDelay: (baseMs: number, attempt: number, maxMs: number = 30_000) =>
    Math.min(baseMs * Math.pow(2, attempt), maxMs),
}));

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: emitAlertMock,
  emitAlertChecked: emitAlertMock,
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: clearAlertSourceMock,
  clearAlertSourceChecked: clearAlertSourceMock,
}));

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';
import {
  DEAD_LINK_ALERT_SOURCE,
  DEAD_LINK_CLEAR_RETRY_MS,
  DEAD_LINK_GRACE_MS,
  DeadLinkAlarm,
} from '../../src/transport/dead-link-alert.ts';

const TEN_MINUTES = 10 * 60_000;
const OUTAGE_START = '2026-11-09T05:00:00.000Z';
const MARKER = join(testDataRoot, 'dead-link-outage.json');
const LOGGED_OUT = { statusCode: 401, reason: 'loggedOut', classification: 'uninspected_401_conservative_exit' };

function readMarker(): Record<string, unknown> {
  return JSON.parse(readFileSync(MARKER, 'utf8')) as Record<string, unknown>;
}

function silentLog() {
  return { warn: vi.fn(), error: vi.fn() };
}

function makeMockSocket() {
  let evProcessCallback: ((events: Record<string, unknown>) => void) | undefined;
  const mockSock = {
    ev: {
      process: vi.fn((cb: (events: Record<string, unknown>) => void) => {
        evProcessCallback = cb;
      }),
    },
    sendMessage: vi.fn(),
    query: vi.fn().mockResolvedValue({}),
    end: vi.fn(),
    ws: { isOpen: true },
    user: { id: '15551230004:1@s.whatsapp.net', lid: '81536414179557:2@lid', name: 'dead-link-bot' },
  };
  function emit(events: Record<string, unknown>) {
    if (!evProcessCallback) throw new Error('ev.process callback not yet registered');
    return (evProcessCallback as (e: Record<string, unknown>) => unknown)(events);
  }
  return { mockSock, emit };
}

function closeEvent(statusCode: number) {
  return {
    'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode } } } },
  };
}

/** A 401 whose stream:error names a non-removal conflict: one bounded reconnect. */
function retryable401Event() {
  return {
    'connection.update': {
      connection: 'close',
      lastDisconnect: {
        error: {
          output: { statusCode: 401 },
          data: { tag: 'stream:error', attrs: { code: '401' }, content: [{ tag: 'conflict', attrs: { type: 'replaced' } }] },
        },
      },
    },
  };
}

function openEvent() {
  return { 'connection.update': { connection: 'open' } };
}

function deadLinkAlerts(): unknown[][] {
  return emitAlertMock.mock.calls.filter(call => call[1] === DEAD_LINK_ALERT_SOURCE);
}

function deadLinkClears(): unknown[][] {
  return clearAlertSourceMock.mock.calls.filter(call => call[1] === DEAD_LINK_ALERT_SOURCE);
}

/** Every socket the manager creates is recorded so a test can drive the latest. */
function trackSockets(): ReturnType<typeof makeMockSocket>[] {
  const sockets: ReturnType<typeof makeMockSocket>[] = [];
  vi.mocked(makeWASocket).mockImplementation(() => {
    const s = makeMockSocket();
    sockets.push(s);
    return s.mockSock as never;
  });
  return sockets;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(OUTAGE_START));
  vi.clearAllMocks();
  emitAlertMock.mockImplementation(() => true);
  clearAlertSourceMock.mockImplementation(() => true);
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});

usePerTestBotErrorsMarkerIsolation();

describe('dead-link alert', () => {
  it('waits 10 minutes', () => {
    expect(DEAD_LINK_GRACE_MS).toBe(TEN_MINUTES);
  });

  it('a 401 loggedOut with no open for 10 minutes raises exactly one card naming the bot and the time', async () => {
    const sockets = trackSockets();
    const manager = new ConnectionManager();
    await manager.connect();
    sockets[0]!.emit(openEvent());

    sockets[0]!.emit(closeEvent(401));

    await vi.advanceTimersByTimeAsync(TEN_MINUTES - 1);
    expect(deadLinkAlerts()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(deadLinkAlerts()).toHaveLength(1);
    const [instance, source, summary, evidence, severity] = deadLinkAlerts()[0]!;
    expect(instance).toBe('dead-link-bot');
    expect(source).toBe('whatsapp_link_dead');
    expect(severity).toBe('critical');
    expect(summary).toContain('dead-link-bot');
    expect(summary).toContain(OUTAGE_START);
    expect(evidence).toContain(`outage_started_at: ${OUTAGE_START}`);
    expect(evidence).toContain('status_code: 401');

    // More of the same outage never adds a second card.
    await vi.advanceTimersByTimeAsync(3 * TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(1);
    await manager.shutdown();
  });

  it('a restart inside the same outage keeps the original start and adds no second card', async () => {
    const sockets = trackSockets();
    const first = new ConnectionManager();
    await first.connect();
    sockets[0]!.emit(closeEvent(401));
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(1);
    await first.shutdown();

    // A watchdog restart: the new process is refused with 401 again.
    const second = new ConnectionManager();
    await second.connect();
    sockets.at(-1)!.emit(closeEvent(401));
    await vi.advanceTimersByTimeAsync(2 * TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(1);
    await second.shutdown();
  });

  it('a restart before the deadline alerts at the original deadline, not 10 minutes after the restart', async () => {
    const sockets = trackSockets();
    const first = new ConnectionManager();
    await first.connect();
    sockets[0]!.emit(closeEvent(401));
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await first.shutdown();

    const second = new ConnectionManager();
    await second.connect();
    sockets.at(-1)!.emit(closeEvent(401));
    await vi.advanceTimersByTimeAsync(6 * 60_000 - 1);
    expect(deadLinkAlerts()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(deadLinkAlerts()).toHaveLength(1);
    expect(deadLinkAlerts()[0]![2]).toContain(OUTAGE_START);
    await second.shutdown();
  });

  it('a restart that never reaches a 401 still alerts at the original deadline', async () => {
    const sockets = trackSockets();
    const first = new ConnectionManager();
    await first.connect();
    sockets[0]!.emit(closeEvent(401));
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await first.shutdown();

    // The next process starts connecting but its socket never answers.
    const second = new ConnectionManager();
    await second.connect();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(deadLinkAlerts()).toHaveLength(1);
    await second.shutdown();
  });

  it('a reconnect inside 10 minutes yields no card', async () => {
    const sockets = trackSockets();
    const manager = new ConnectionManager();
    await manager.connect();

    sockets[0]!.emit(retryable401Event());
    // The bounded reconnect fires after its backoff and the link opens.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets.length).toBeGreaterThan(1);
    sockets.at(-1)!.emit(openEvent());

    await vi.advanceTimersByTimeAsync(2 * TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(0);
    // Nothing was raised, so nothing is cleared.
    expect(deadLinkClears()).toHaveLength(0);
    expect(existsSync(join(testDataRoot, 'dead-link-outage.json'))).toBe(false);
    await manager.shutdown();
  });

  it('a reconnect after the card clears it, and the next outage raises a new card', async () => {
    const sockets = trackSockets();
    const first = new ConnectionManager();
    await first.connect();
    sockets[0]!.emit(closeEvent(401));
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(1);
    await first.shutdown();

    // Relinked: the next process opens.
    const second = new ConnectionManager();
    await second.connect();
    sockets.at(-1)!.emit(openEvent());
    expect(deadLinkClears()).toHaveLength(1);
    expect(deadLinkClears()[0]![0]).toBe('dead-link-bot');
    expect(existsSync(join(testDataRoot, 'dead-link-outage.json'))).toBe(false);

    // A second outage, 15 minutes after the relink, is its own card.
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    sockets.at(-1)!.emit(closeEvent(401));
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(2);
    await second.shutdown();
  });

  it('a clear that could not be queued is retried, and the next outage still raises its own card', async () => {
    const sockets = trackSockets();
    const manager = new ConnectionManager();
    await manager.connect();
    sockets[0]!.emit(closeEvent(401));
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(1);
    await manager.shutdown();

    const relinked = new ConnectionManager();
    await relinked.connect();
    clearAlertSourceMock.mockReturnValueOnce(false);
    sockets.at(-1)!.emit(openEvent());
    expect(deadLinkClears()).toHaveLength(1);
    expect(existsSync(join(testDataRoot, 'dead-link-outage.json'))).toBe(true);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    // The pending clear was retried while the link stayed open.
    expect(deadLinkClears()).toHaveLength(2);
    expect(existsSync(join(testDataRoot, 'dead-link-outage.json'))).toBe(false);
    sockets.at(-1)!.emit(closeEvent(401));
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(2);
    expect(deadLinkAlerts()[1]![2]).toContain('2026-11-09T05:25:');
    await relinked.shutdown();
  });

  it('asks for an outbox-backed clear, so a legacy helper that merely accepted it does not end the outage', async () => {
    // emit-alert's contract (tests/lib/emit-alert.test.ts): when the outbox
    // write fails, the default clear spawns the legacy helper and reports
    // success on its acceptance alone; requireDurableOutbox reports failure.
    clearAlertSourceMock.mockImplementation((...args: unknown[]) =>
      (args[4] as { requireDurableOutbox?: boolean } | undefined)?.requireDurableOutbox !== true);
    const alarm = new DeadLinkAlarm({ instance: 'dead-link-bot', dataRoot: testDataRoot, log: silentLog() as never });
    alarm.onLoggedOut(LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(1);

    alarm.onConnectionOpen();
    expect(deadLinkClears()).toHaveLength(1);
    expect(deadLinkClears()[0]![4]).toEqual({ requireDurableOutbox: true });
    // The dispatcher has not seen a clear: the recovered marker stays.
    expect(readMarker()).toMatchObject({ outageStartedAt: OUTAGE_START, linkOpenedAt: '2026-11-09T05:10:00.000Z' });

    // The next outage is held, not folded into the still-open incident.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    alarm.onLoggedOut(LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(1);
    expect(readMarker()).toMatchObject({ outageStartedAt: OUTAGE_START });

    // The outbox recovers: the clear is queued, then the held outage raises its card.
    clearAlertSourceMock.mockImplementation(() => true);
    // +1: the overdue card is a 0 ms timer armed inside the retry, which fake
    // timers run 1 ms later.
    await vi.advanceTimersByTimeAsync(DEAD_LINK_CLEAR_RETRY_MS + 1);
    expect(deadLinkAlerts()).toHaveLength(2);
    expect(deadLinkAlerts()[1]![2]).toContain('2026-11-09T05:15:00.000Z');
    alarm.dispose();
  });

  it('a repeated clear failure keeps the recovered marker and holds the next outage, across a restart', async () => {
    const first = new DeadLinkAlarm({ instance: 'dead-link-bot', dataRoot: testDataRoot, log: silentLog() as never });
    first.onLoggedOut(LOGGED_OUT);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(1);

    clearAlertSourceMock.mockImplementation(() => false);
    first.onConnectionOpen();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // A new 401 retries the clear; it fails again.
    first.onLoggedOut(LOGGED_OUT);
    const recovered = readMarker();
    expect(recovered).toMatchObject({
      outageStartedAt: OUTAGE_START,
      linkOpenedAt: '2026-11-09T05:10:00.000Z',
    });
    expect(recovered.alertedAt).not.toBeNull();

    await vi.advanceTimersByTimeAsync(3 * TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(1);
    expect(deadLinkClears().length).toBeGreaterThan(3);
    expect(readMarker()).toMatchObject({ outageStartedAt: OUTAGE_START });
    first.dispose();

    // A restart keeps holding; once the clear is queued the held outage alerts
    // at once (its deadline has passed) and names its own start.
    const second = new DeadLinkAlarm({ instance: 'dead-link-bot', dataRoot: testDataRoot, log: silentLog() as never });
    second.resume();
    await vi.advanceTimersByTimeAsync(DEAD_LINK_CLEAR_RETRY_MS);
    expect(deadLinkAlerts()).toHaveLength(1);
    clearAlertSourceMock.mockImplementation(() => true);
    await vi.advanceTimersByTimeAsync(DEAD_LINK_CLEAR_RETRY_MS + 1);
    expect(deadLinkAlerts()).toHaveLength(2);
    expect(deadLinkAlerts()[1]![2]).toContain('2026-11-09T05:15:00.000Z');
    expect(readMarker()).toMatchObject({ outageStartedAt: '2026-11-09T05:15:00.000Z', linkOpenedAt: null });
    second.dispose();
  });

  it('keeps one card per outage when the marker cannot be written', async () => {
    mkdirSync(testRoot, { recursive: true });
    const notADirectory = join(testRoot, 'not-a-directory');
    writeFileSync(notADirectory, '');
    const log = { warn: vi.fn(), error: vi.fn() };
    const alarm = new DeadLinkAlarm({ instance: 'dead-link-bot', dataRoot: notADirectory, log: log as never });
    const observation = { statusCode: 401, reason: 'loggedOut', classification: 'uninspected_401_conservative_exit' };

    alarm.onLoggedOut(observation);
    await vi.advanceTimersByTimeAsync(TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(1);
    expect(log.warn).toHaveBeenCalled();

    alarm.onLoggedOut(observation);
    await vi.advanceTimersByTimeAsync(2 * TEN_MINUTES);
    expect(deadLinkAlerts()).toHaveLength(1);
    alarm.dispose();
  });

  it.each([408, 428, 440])('close code %i never raises the dead-link card', async (statusCode) => {
    const sockets = trackSockets();
    const manager = new ConnectionManager();
    await manager.connect();
    sockets[0]!.emit(openEvent());

    sockets[0]!.emit(closeEvent(statusCode));
    // The link stays down well past the grace window without ever opening.
    await vi.advanceTimersByTimeAsync(TEN_MINUTES + 5 * 60_000);
    expect(deadLinkAlerts()).toHaveLength(0);
    expect(existsSync(join(testDataRoot, 'dead-link-outage.json'))).toBe(false);
    await manager.shutdown();
  });
});
