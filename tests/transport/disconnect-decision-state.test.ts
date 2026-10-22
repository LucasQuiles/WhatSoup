/**
 * The transport carries its own disconnect decision into the connection
 * snapshot (and from there into authenticated /health and alert evidence).
 *
 * Contract under test (plan §7, req-health):
 *   - confirmed device_removed is terminal with no retry;
 *   - an inspected ambiguous 401 earns one bounded reconnect, a second parks;
 *   - an uninspected 401 is a separately labelled conservative exit;
 *   - a fresh successful open resets the decision to null;
 *   - a process restart (a new manager) starts with no decision and a fresh
 *     bounded retry — the decision is process-local by design;
 *   - the conflict parser handles nested nodes and hostile/malformed data.
 * All identifiers are fabricated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, rmSync } from 'node:fs';
import { usePerTestBotErrorsMarkerIsolation } from '../../tests/setup/bot-errors-vitest-isolation.ts';

const emitAlertMock = vi.hoisted(() => vi.fn((..._args: unknown[]) => true));
const { testAuthDir, testDataRoot, testRoot, testStateRoot } = vi.hoisted(() => {
  const testRoot = `/tmp/wa-test-disconnect-decision-${process.pid}`;
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
    mediaDir: '/tmp/whatsoup-test-media-disconnect-decision/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9090,
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
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';

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
    // Fabricated identity: 555-01xx fiction range and a zero-padded LID.
    user: { id: '15550100004:1@s.whatsapp.net', lid: '10000000000001:2@lid', name: 'WhatSoup' },
  };
  function emit(events: Record<string, unknown>) {
    if (!evProcessCallback) throw new Error('ev.process callback not yet registered');
    return (evProcessCallback as any)(events);
  }
  return { mockSock, emit };
}

function closeWith(error: unknown) {
  return { 'connection.update': { connection: 'close', lastDisconnect: { error } } };
}

function loggedOut(data: unknown) {
  return closeWith({ output: { statusCode: 401 }, data });
}

function streamError(content: unknown) {
  return { tag: 'stream:error', attrs: { code: '401' }, content };
}

function openEvent() {
  return { 'connection.update': { connection: 'open' } };
}

function trackSockets(): ReturnType<typeof makeMockSocket>[] {
  const sockets: ReturnType<typeof makeMockSocket>[] = [];
  vi.mocked(makeWASocket).mockImplementation(() => {
    const s = makeMockSocket();
    sockets.push(s);
    return s.mockSock as any;
  });
  return sockets;
}

function lastAlert(): { title: string; evidence: string; asset: any } {
  const call = emitAlertMock.mock.calls.at(-1) as unknown[] | undefined;
  if (!call) throw new Error('no alert emitted');
  return { title: String(call[2]), evidence: String(call[3]), asset: call[5] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});

afterEach(() => {
  vi.useRealTimers();
  try {
    chmodSync(testAuthDir, 0o700);
  } catch {
    // best-effort cleanup
  }
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});

usePerTestBotErrorsMarkerIsolation();

describe('ConnectionManager — disconnect decision carried into the snapshot', () => {
  it('a new process starts with no decision', async () => {
    trackSockets();
    const manager = new ConnectionManager();
    expect(manager.getConnectionState().disconnectDecision).toBeNull();
    await manager.connect();
    expect(manager.getHealthConnectionState().disconnectDecision).toBeNull();
    await manager.shutdown();
  });

  it('one ambiguous retry, then a second ambiguous 401 parks with an honest alert', async () => {
    vi.setSystemTime(new Date('2026-09-25T02:00:00.000Z'));
    const sockets = trackSockets();
    const manager = new ConnectionManager();
    await manager.connect();

    sockets[0]!.emit(loggedOut(streamError([{ tag: 'conflict', attrs: { type: 'replaced' } }])));
    expect(manager.getConnectionState().disconnectDecision).toEqual({
      version: 1,
      classification: 'ambiguous_401_reconnecting',
      decision: 'reconnect:auth-401-unclassified',
      action: 'reconnect',
      reason: 'auth-401-unclassified',
      basis: null,
      statusCode: 401,
      conflictInspected: true,
      conflictType: 'replaced',
      unclassified401RetrySpent: false,
      observedAt: '2026-09-25T02:00:00.000Z',
    });
    expect(emitAlertMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(2);

    sockets[1]!.emit(loggedOut(streamError([{ tag: 'conflict', attrs: { type: 'replaced' } }])));
    expect(manager.getConnectionState()).toMatchObject({
      state: 'disconnected',
      disconnectDecision: {
        classification: 'ambiguous_401_parked',
        decision: 'exit:logged-out:ambiguous_401_repeated',
        basis: 'ambiguous_401_repeated',
        unclassified401RetrySpent: true,
      },
    });

    const alert = lastAlert();
    expect(alert.title).toContain('unconfirmed WhatsApp 401 logout');
    expect(alert.title).not.toContain('lost WhatsApp linked-device bond');
    expect(alert.evidence).toContain('disconnect_classification: ambiguous_401_parked');
    expect(alert.evidence).toContain('device removal NOT confirmed');
    expect(alert.asset.failure.confidence).toBe('probable');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(2);
    await manager.shutdown();
  });

  it('confirmed device_removed exits on the first 401 with no retry and a confirmed alert', async () => {
    vi.setSystemTime(new Date('2026-09-25T02:10:00.000Z'));
    const sockets = trackSockets();
    const manager = new ConnectionManager();
    await manager.connect();

    sockets[0]!.emit(loggedOut(streamError([{ tag: 'conflict', attrs: { type: 'device_removed' } }])));
    expect(manager.getConnectionState().disconnectDecision).toMatchObject({
      classification: 'confirmed_device_removed',
      basis: 'device_removed',
      conflictInspected: true,
      conflictType: 'device_removed',
      unclassified401RetrySpent: false,
    });
    const alert = lastAlert();
    expect(alert.title).toContain('lost WhatsApp linked-device bond');
    expect(alert.evidence).toContain('disconnect_classification: confirmed_device_removed');
    expect(alert.asset.failure.confidence).toBe('confirmed');

    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);
    await manager.shutdown();
  });

  it('a 401 with no error data is an uninspected conservative exit, never labelled confirmed', async () => {
    const sockets = trackSockets();
    const manager = new ConnectionManager();
    await manager.connect();

    sockets[0]!.emit(closeWith({ output: { statusCode: 401 } }));
    expect(manager.getConnectionState().disconnectDecision).toMatchObject({
      classification: 'uninspected_401_conservative_exit',
      basis: 'uninspected',
      conflictInspected: false,
      conflictType: null,
    });
    const alert = lastAlert();
    expect(alert.evidence).toContain('conflict_inspected: false');
    expect(alert.asset.failure.confidence).toBe('probable');
    await manager.shutdown();
  });

  it('a fresh successful open resets the prior decision to null', async () => {
    const sockets = trackSockets();
    const manager = new ConnectionManager();
    await manager.connect();

    sockets[0]!.emit(loggedOut(streamError([])));
    expect(manager.getConnectionState().disconnectDecision?.classification).toBe('ambiguous_401_reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]!.emit(openEvent());

    expect(manager.getConnectionState()).toMatchObject({ connected: true, disconnectDecision: null });
    await manager.shutdown();
  });

  it('a non-401 close is classified other with its decision preserved', async () => {
    const sockets = trackSockets();
    const manager = new ConnectionManager();
    await manager.connect();

    sockets[0]!.emit(closeWith({ output: { statusCode: 440 } }));
    expect(manager.getConnectionState().disconnectDecision).toMatchObject({
      classification: 'other',
      decision: 'reconnect:connection-replaced',
      statusCode: 440,
      conflictInspected: false,
    });
    await manager.shutdown();
  });

  it('process restart: a new manager after a park has no decision and gets its own bounded retry', async () => {
    const first = trackSockets();
    const before = new ConnectionManager();
    await before.connect();
    first[0]!.emit(loggedOut(streamError([])));
    await vi.advanceTimersByTimeAsync(1_000);
    first[1]!.emit(loggedOut(streamError([])));
    expect(before.getConnectionState().disconnectDecision?.classification).toBe('ambiguous_401_parked');
    await before.shutdown();

    vi.mocked(makeWASocket).mockReset();
    const second = trackSockets();
    const after = new ConnectionManager();
    expect(after.getConnectionState().disconnectDecision).toBeNull();
    await after.connect();
    second[0]!.emit(loggedOut(streamError([])));
    expect(after.getConnectionState()).toMatchObject({
      state: 'reconnecting',
      disconnectDecision: { classification: 'ambiguous_401_reconnecting' },
    });
    await after.shutdown();
  });
});

describe('ConnectionManager — conflict node parsing feeds the decision', () => {
  async function decisionFor(error: unknown) {
    const sockets = trackSockets();
    const manager = new ConnectionManager();
    await manager.connect();
    sockets[0]!.emit(closeWith(error));
    const decision = manager.getConnectionState().disconnectDecision;
    await manager.shutdown();
    return decision;
  }

  it('finds a device_removed conflict nested below intermediate nodes', async () => {
    const nested = streamError([
      { tag: 'wrapper', attrs: {}, content: [{ tag: 'inner', attrs: {}, content: [
        { tag: 'conflict', attrs: { type: 'device_removed' } },
      ] }] },
    ]);
    expect(await decisionFor({ output: { statusCode: 401 }, data: nested })).toMatchObject({
      classification: 'confirmed_device_removed',
      conflictInspected: true,
    });
  });

  it('a conflict node with a non-string type is inspected and ambiguous, not confirmed', async () => {
    const data = streamError([{ tag: 'conflict', attrs: { type: 42 } }]);
    expect(await decisionFor({ output: { statusCode: 401 }, data })).toMatchObject({
      classification: 'ambiguous_401_reconnecting',
      conflictInspected: true,
      conflictType: null,
    });
  });

  it('data that is not a node tree (string, deep beyond the bound) is uninspected, not confirmed', async () => {
    expect(await decisionFor({ output: { statusCode: 401 }, data: 'garbage' })).toMatchObject({
      classification: 'uninspected_401_conservative_exit',
      conflictInspected: false,
    });

    let deep: Record<string, unknown> = { tag: 'conflict', attrs: { type: 'device_removed' } };
    for (let i = 0; i < 12; i++) deep = { tag: 'wrapper', attrs: {}, content: [deep] };
    expect(await decisionFor({ output: { statusCode: 401 }, data: deep })).toMatchObject({
      classification: 'uninspected_401_conservative_exit',
      conflictInspected: false,
    });
  });

  it('a device_removed string in a non-conflict position does not confirm removal', async () => {
    const data = streamError([{ tag: 'text', attrs: { type: 'device_removed' }, content: 'device_removed' }]);
    expect(await decisionFor({ output: { statusCode: 401 }, data })).toMatchObject({
      classification: 'ambiguous_401_reconnecting',
      conflictInspected: true,
      conflictType: null,
    });
  });
});
