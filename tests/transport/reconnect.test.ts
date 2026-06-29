import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const emitAlertMock = vi.hoisted(() => vi.fn(() => true));
const clearAlertSourceMock = vi.hoisted(() => vi.fn(() => true));
const { testAuthDir, testDataRoot, testRoot, testStateRoot } = vi.hoisted(() => {
  const testRoot = `/tmp/wa-test-reconnect-${process.pid}`;
  return {
    testAuthDir: `${testRoot}/auth`,
    testDataRoot: `${testRoot}/data`,
    testRoot,
    testStateRoot: `${testRoot}/state`,
  };
});

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before imports
// ---------------------------------------------------------------------------

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
    mediaDir: '/tmp',
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

// Mock jitteredDelay to remove randomness — return deterministic exponential backoff
vi.mock('../../src/core/retry.ts', () => ({
  jitteredDelay: (baseMs: number, attempt: number, maxMs: number = 30_000) => {
    const exp = baseMs * Math.pow(2, attempt);
    return Math.min(exp, maxMs);
  },
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      level: 'error',
    }),
  }),
}));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: emitAlertMock,
  emitAlertChecked: emitAlertMock,
  clearAlertSource: clearAlertSourceMock,
  clearAlertSourceChecked: clearAlertSourceMock,
}));

import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock socket and capture the ev.process callback. */
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
    user: {
      id: '15551230004:1@s.whatsapp.net',
      lid: '81536414179557:2@lid',
      name: 'WhatSoup',
    },
  };

  function emit(events: Record<string, unknown>) {
    if (!evProcessCallback) throw new Error('ev.process callback not yet registered');
    return (evProcessCallback as any)(events);
  }

  return { mockSock, emit };
}

/** Fire a connection.update close event with the given status code. */
function closeEvent(statusCode: number | undefined) {
  const error = statusCode !== undefined
    ? { output: { statusCode } }
    : undefined;
  return {
    'connection.update': {
      connection: 'close',
      lastDisconnect: error ? { error } : undefined,
    },
  };
}

function loggedOutStreamErrorEvent(conflictType: string | null, extra: Record<string, unknown> = {}) {
  const conflictNode = conflictType === null
    ? []
    : [{ tag: 'conflict', attrs: { type: conflictType } }];
  return {
    'connection.update': {
      connection: 'close',
      lastDisconnect: {
        error: {
          output: { statusCode: 401 },
          data: {
            tag: 'stream:error',
            attrs: { code: '401' },
            content: conflictNode,
          },
          ...extra,
        },
      },
    },
  };
}

function readBondEvents(): Array<Record<string, any>> {
  const eventPath = join(testDataRoot, 'bond-events.ndjson');
  return readFileSync(eventPath, 'utf-8')
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

/** Fire a connection.update open event. */
function openEvent() {
  return { 'connection.update': { connection: 'open' } };
}

async function flushAsyncReconnect(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

function writeValidTestAuth(id = '15551230004:1@s.whatsapp.net'): void {
  mkdirSync(testAuthDir, { recursive: true, mode: 0o700 });
  chmodSync(testAuthDir, 0o700);
  writeFileSync(join(testAuthDir, 'creds.json'), JSON.stringify({
    me: { id, lid: '81536414179557:2@lid' },
    registrationId: 1,
  }));
  writeFileSync(join(testAuthDir, 'app-state-sync-key-test.json'), JSON.stringify({ keyData: 'secret' }));
}

function readTestCreds(): any {
  return JSON.parse(readFileSync(join(testAuthDir, 'creds.json'), 'utf8'));
}

function readLatestAuthBond(): any {
  return JSON.parse(readFileSync(join(testStateRoot, 'auth-bond-backups', 'WhatSoup', 'latest.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});

afterEach(async () => {
  vi.useRealTimers();
  try {
    chmodSync(testAuthDir, 0o700);
  } catch {
    // best-effort cleanup
  }
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});

// ---------------------------------------------------------------------------
// T26d — Reconnect Resilience Tests
// ---------------------------------------------------------------------------

describe('ConnectionManager — backoff sequence', () => {
  it('first disconnect schedules reconnect with 1s backoff', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();

    // Simulate first close (connectionClosed = 428)
    emit(closeEvent(428));

    // makeWASocket called once at connect(); reconnect shouldn't fire yet
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);

    // Advance 999ms — still waiting
    await vi.advanceTimersByTimeAsync(999);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);

    // Advance 1ms more — fires at exactly 1000ms
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(2);

    await manager.shutdown();
  });

  it('successive failures double the backoff: 1s, 2s, 4s', async () => {
    const sockets: ReturnType<typeof makeMockSocket>[] = [];

    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });

    const manager = new ConnectionManager();
    await manager.connect(); // attempt 1

    // Fail attempt 1 → schedules reconnect in 1s (attempt index 1)
    sockets[0]!.emit(closeEvent(428));
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(2);

    // Fail attempt 2 → schedules reconnect in 2s
    sockets[1]!.emit(closeEvent(428));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(3);

    // Fail attempt 3 → schedules reconnect in 4s
    sockets[2]!.emit(closeEvent(428));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(4);

    await manager.shutdown();
  });

  it('backoff caps at 60s regardless of attempt count', async () => {
    const sockets: ReturnType<typeof makeMockSocket>[] = [];

    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });

    const manager = new ConnectionManager();
    await manager.connect();

    // Drive through 7 failures (1s, 2s, 4s, 8s, 16s, 32s, 64s→capped at 60s)
    const expectedBackoffs = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

    for (let i = 0; i < expectedBackoffs.length; i++) {
      sockets[i]!.emit(closeEvent(428));
      await vi.advanceTimersByTimeAsync(expectedBackoffs[i]! - 1);
      // Not yet reconnected
      expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(i + 2);
    }

    await manager.shutdown();
  });
});

// ---------------------------------------------------------------------------

describe('ConnectionManager — phase transitions', () => {
  it('after 10 backoff failures enters cooldown phase — no immediate reconnect', async () => {
    const sockets: ReturnType<typeof makeMockSocket>[] = [];

    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });

    const manager = new ConnectionManager();
    await manager.connect(); // attempt 1

    // Burn through 10 attempts.
    // Backoffs: 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, 60s, 60s = 303s total
    const backoffs = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000];
    for (let i = 0; i < 10; i++) {
      sockets[i]!.emit(closeEvent(428));
      await vi.advanceTimersByTimeAsync(backoffs[i]!);
    }

    // After 10 successful reconnects, there are now 11 sockets (1 initial + 10 retries)
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(11);

    // The 11th socket fails → should enter cooldown (no reconnect for 5 minutes)
    sockets[10]!.emit(closeEvent(428));

    // Advance 4m 59s — no new connect()
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 59_000);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(11);

    await manager.shutdown();
  });

  it('after cooldown expires — retries with fresh reconnect attempt', async () => {
    const sockets: ReturnType<typeof makeMockSocket>[] = [];

    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });

    const manager = new ConnectionManager();
    await manager.connect();

    // Burn through 10 backoff phases to trigger cooldown
    const backoffs = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000];
    for (let i = 0; i < 10; i++) {
      sockets[i]!.emit(closeEvent(428));
      await vi.advanceTimersByTimeAsync(backoffs[i]!);
    }
    // 11 sockets created; 11th's failure triggers cooldown
    sockets[10]!.emit(closeEvent(428));

    const countAfterCooldownEntry = vi.mocked(makeWASocket).mock.calls.length;

    // Advance through the full 5-minute cooldown
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    // A new connect() should have been fired
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(countAfterCooldownEntry + 1);

    await manager.shutdown();
  });

  it('successful connection resets all counters (reconnectAttempts=0, phase=backoff, firstFailureAt=null)', async () => {
    const sockets: ReturnType<typeof makeMockSocket>[] = [];

    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });

    const manager = new ConnectionManager();
    await manager.connect();

    // Cause 3 failures to increment the counter
    const threeBackoffs = [1_000, 2_000, 4_000];
    for (let i = 0; i < 3; i++) {
      sockets[i]!.emit(closeEvent(428));
      await vi.advanceTimersByTimeAsync(threeBackoffs[i]!);
    }

    // 4th socket connects successfully — resets state
    sockets[3]!.emit(openEvent());

    // Now fail once more — backoff should restart from 1s (not continue from 8s)
    sockets[3]!.emit(closeEvent(428));

    await vi.advanceTimersByTimeAsync(999);
    // Should not have reconnected yet
    const countBefore = vi.mocked(makeWASocket).mock.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    // Should reconnect at 1s (reset), not at 8s
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(countBefore + 1);

    await manager.shutdown();
  });

  it('successful reconnect clears stale disconnect metadata from the current health snapshot', async () => {
    const sockets: ReturnType<typeof makeMockSocket>[] = [];

    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });

    const manager = new ConnectionManager();
    await manager.connect();
    sockets[0]!.emit(openEvent());

    sockets[0]!.emit(closeEvent(428));
    expect(manager.getConnectionState()).toMatchObject({
      state: 'reconnecting',
      connected: false,
      lastDisconnectReason: 'connectionClosed',
      lastStatusCode: 428,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]!.emit(openEvent());

    expect(manager.getConnectionState()).toMatchObject({
      state: 'connected',
      connected: true,
      reconnectAttempts: 0,
      reconnectPhase: null,
      lastDisconnectReason: null,
      lastStatusCode: null,
      recentDisconnects: {
        windowMs: 10 * 60 * 1000,
        count: 1,
        lastReason: 'connectionClosed',
        lastStatusCode: 428,
        byReason: { connectionClosed: 1 },
      },
    });

    await manager.shutdown();
  });

  it('restartRequired disconnect below the flap threshold enters backoff', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);

    // Emit restartRequired (515)
    emit(closeEvent(515));

    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);
    expect(manager.getConnectionState()).toMatchObject({
      state: 'reconnecting',
      connected: false,
      reconnectAttempts: 1,
      reconnectPhase: 'backoff',
    });
    expect(manager.getConnectionState().firstFailureAt).not.toBeNull();

    await vi.advanceTimersByTimeAsync(999);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(2);

    await manager.shutdown();
  });

  it('restartRequired flapping uses backoff instead of immediate reconnect', async () => {
    const sockets: ReturnType<typeof makeMockSocket>[] = [];

    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });

    const manager = new ConnectionManager();
    await manager.connect();

    const backoffs = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000];
    for (let i = 0; i < 9; i++) {
      sockets[i]!.emit(closeEvent(515));
      expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(backoffs[i]!);
      expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(i + 2);
    }

    sockets[9]!.emit(closeEvent(515));
    await flushAsyncReconnect();

    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(10);
    expect(manager.getConnectionState()).toMatchObject({
      state: 'reconnecting',
      connected: false,
      reconnectAttempts: 10,
      reconnectPhase: 'backoff',
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(10);

    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(11);

    await manager.shutdown();
  });
});

// ---------------------------------------------------------------------------

describe('ConnectionManager — terminal conditions', () => {
  it('loggedOut disconnect does not schedule any reconnect', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);

    emit(closeEvent(401)); // loggedOut

    expect(emitAlertMock).toHaveBeenCalledOnce();
    expect(emitAlertMock).toHaveBeenCalledWith(
      'WhatSoup',
      'whatsapp_device_bond_lost',
      expect.stringContaining('PHYSICAL INTERVENTION REQUIRED'),
      expect.stringContaining('classification: physical_intervention_required'),
      'critical',
      expect.objectContaining({
        asset: expect.objectContaining({ kind: 'whatsapp_linked_device' }),
        failure: expect.objectContaining({ code: 'WA_AUTH_BOND_SERVER_REVOKED' }),
      }),
    );

    // Advance well past any backoff
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);

    await manager.shutdown();
  });

  it('an inspected non-device_removed 401 gets one bounded reconnect and durable conflict evidence', async () => {
    vi.setSystemTime(new Date('2026-05-10T09:00:00.000Z'));
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();

    emit(loggedOutStreamErrorEvent('replaced'));

    expect(emitAlertMock).not.toHaveBeenCalled();
    expect(manager.getConnectionState()).toMatchObject({
      state: 'reconnecting',
      connected: false,
      reconnectAttempts: 1,
      reconnectPhase: 'backoff',
      lastStatusCode: 401,
      lastDisconnectReason: 'loggedOut',
    });

    const eventPath = join(testDataRoot, 'bond-events.ndjson');
    expect(statSync(eventPath).mode & 0o777).toBe(0o600);
    const closeEvent = readBondEvents().find(event => event.event === 'connection_close' && event.statusCode === 401);
    expect(closeEvent).toMatchObject({
      event: 'connection_close',
      reason: 'loggedOut',
      conflictType: 'replaced',
      reconnectDecision: 'reconnect:auth-401-unclassified',
    });

    await manager.shutdown();
  });

  it('a device_removed 401 writes a redacted terminal bond event before parking', async () => {
    vi.setSystemTime(new Date('2026-05-10T09:05:00.000Z'));
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();

    emit(loggedOutStreamErrorEvent('device_removed', {
      message: 'removed 15555550123@s.whatsapp.net after phone 14155551234 with token do-not-print',
      creds: { advSecretKey: 'do-not-print', registrationId: 1234 },
      nested: {
        remoteJid: '15555550123@s.whatsapp.net',
        linkedPhone: '14155551234',
      },
    }));

    expect(emitAlertMock).toHaveBeenCalledOnce();
    expect(manager.getConnectionState()).toMatchObject({
      state: 'disconnected',
      connected: false,
      lastStatusCode: 401,
      lastDisconnectReason: 'loggedOut',
    });

    const eventPath = join(testDataRoot, 'bond-events.ndjson');
    expect(statSync(eventPath).mode & 0o777).toBe(0o600);
    const eventText = readFileSync(eventPath, 'utf-8');
    const events = readBondEvents();
    const closeEvent = events.find(event => event.event === 'connection_close' && event.statusCode === 401);
    const bondLostEvent = events.find(event => event.event === 'device_bond_lost' && event.statusCode === 401);

    expect(closeEvent).toMatchObject({
      event: 'connection_close',
      reason: 'loggedOut',
      conflictType: 'device_removed',
      reconnectDecision: 'exit:logged-out',
    });
    expect(bondLostEvent).toMatchObject({
      event: 'device_bond_lost',
      reason: 'loggedOut',
      conflictType: 'device_removed',
    });
    expect(eventText).toContain('<jid:');
    expect(eventText).toContain('<number:');
    expect(eventText).not.toContain('15555550123@s.whatsapp.net');
    expect(eventText).not.toContain('14155551234');
    expect(eventText).not.toContain('do-not-print');
    expect(eventText).not.toContain(testAuthDir);
    expect(eventText).not.toContain(testStateRoot);
    expect(eventText).not.toContain(testDataRoot);

    await manager.shutdown();
  });

  it('retries a logged-out alert when the first enqueue attempt throws', async () => {
    const sockets: ReturnType<typeof makeMockSocket>[] = [];
    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });
    emitAlertMock.mockImplementationOnce(() => { throw new Error('outbox unavailable'); });

    const manager = new ConnectionManager();
    await manager.connect();

    sockets[0]!.emit(closeEvent(401));
    expect(emitAlertMock).toHaveBeenCalledTimes(1);

    await manager.connect();
    sockets[1]!.emit(closeEvent(401));
    expect(emitAlertMock).toHaveBeenCalledTimes(2);

    await manager.connect();
    sockets[2]!.emit(closeEvent(401));
    expect(emitAlertMock).toHaveBeenCalledTimes(2);

    await manager.shutdown();
  });

  it('reconnects without physical-intervention alert when the connection is replaced by another session', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();

    emit(closeEvent(440));

    expect(emitAlertMock).not.toHaveBeenCalled();
    expect(manager.getConnectionState()).toMatchObject({
      state: 'reconnecting',
      connected: false,
      lastStatusCode: 440,
      lastDisconnectReason: 'connectionReplaced',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(2);

    await manager.shutdown();
  });

  it('reconnects without physical-intervention alert for multidevice mismatch', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();

    emit(closeEvent(411));

    expect(emitAlertMock).not.toHaveBeenCalled();
    expect(manager.getConnectionState()).toMatchObject({
      state: 'reconnecting',
      connected: false,
      lastStatusCode: 411,
      lastDisconnectReason: 'multideviceMismatch',
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(2);

    await manager.shutdown();
  });

  it('retries a local auth-bond alert when the first enqueue attempt throws', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    emitAlertMock.mockImplementationOnce(() => { throw new Error('outbox unavailable'); });

    const manager = new ConnectionManager();
    await manager.connect();

    emit({ 'connection.update': { qr: 'pair-me' } });
    expect(emitAlertMock).toHaveBeenCalledTimes(1);

    emit({ 'connection.update': { qr: 'pair-me-again' } });
    expect(emitAlertMock).toHaveBeenCalledTimes(2);

    emit({ 'connection.update': { qr: 'pair-me-third' } });
    expect(emitAlertMock).toHaveBeenCalledTimes(2);

    await manager.shutdown();
  });

  it('30-minute total failure window emits exhausted event (no process.exit)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const exhaustedSpy = vi.fn();

    const sockets: ReturnType<typeof makeMockSocket>[] = [];
    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });

    const manager = new ConnectionManager();
    manager.on('exhausted', exhaustedSpy);
    await manager.connect();

    // First failure sets firstFailureAt
    sockets[0]!.emit(closeEvent(428));

    // Advance 30 minutes + 1ms so that the elapsed check triggers on the next scheduleReconnect call
    await vi.advanceTimersByTimeAsync(1_000); // fires reconnect attempt 1 (1s backoff)
    sockets[1]!.emit(closeEvent(428));
    await vi.advanceTimersByTimeAsync(2_000); // fires reconnect attempt 2 (2s backoff)
    sockets[2]!.emit(closeEvent(428));

    // Now warp time past 30 minutes total
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
    // The next failure triggers scheduleReconnect which should see elapsed > 30min
    sockets[3]?.emit(closeEvent(428));

    // process.exit must NOT be called
    expect(exitSpy).not.toHaveBeenCalled();
    // 'exhausted' event must be emitted
    expect(exhaustedSpy).toHaveBeenCalled();

    exitSpy.mockRestore();
    await manager.shutdown();
  });

  it('sub-threshold restartRequired failures count toward the exhaustion window', async () => {
    const exhaustedSpy = vi.fn();

    const sockets: ReturnType<typeof makeMockSocket>[] = [];
    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });

    const manager = new ConnectionManager();
    manager.on('exhausted', exhaustedSpy);
    await manager.connect();

    sockets[0]!.emit(closeEvent(515));
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]!.emit(closeEvent(515));
    await vi.advanceTimersByTimeAsync(2_000);
    sockets[2]!.emit(closeEvent(515));

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
    sockets[3]?.emit(closeEvent(515));

    expect(exhaustedSpy).toHaveBeenCalledTimes(1);

    await manager.shutdown();
  });

  it('successful connection mid-cooldown cancels the cooldown and resets everything', async () => {
    const sockets: ReturnType<typeof makeMockSocket>[] = [];

    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });

    const manager = new ConnectionManager();
    await manager.connect();

    // Burn through all 10 backoff attempts to enter cooldown
    const backoffs = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000];
    for (let i = 0; i < 10; i++) {
      sockets[i]!.emit(closeEvent(428));
      await vi.advanceTimersByTimeAsync(backoffs[i]!);
    }
    sockets[10]!.emit(closeEvent(428)); // triggers cooldown

    const countBeforeSuccess = vi.mocked(makeWASocket).mock.calls.length;

    // Advance past cooldown
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // cooldown expires → new connect()

    // That new socket (index 11) sends open → resets all state
    sockets[11]!.emit(openEvent());

    // Verify reset: next failure should back off from 1s (not continue the retry phase)
    sockets[11]!.emit(closeEvent(428));

    await vi.advanceTimersByTimeAsync(999);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(countBeforeSuccess + 1); // still waiting

    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(countBeforeSuccess + 2); // reconnected at 1s

    await manager.shutdown();
  });

  it('exhausted failure window triggers a graceful reconnect attempt', async () => {
    const sockets: ReturnType<typeof makeMockSocket>[] = [];
    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });

    const manager = new ConnectionManager();
    await manager.connect();

    sockets[0]!.emit(closeEvent(428));
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]!.emit(closeEvent(428));
    await vi.advanceTimersByTimeAsync(2_000);
    sockets[2]!.emit(closeEvent(428));

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
    const countBeforeExhausted = vi.mocked(makeWASocket).mock.calls.length;
    sockets[3]?.emit(closeEvent(428));
    await flushAsyncReconnect();

    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(countBeforeExhausted + 1);

    await manager.shutdown();
  });
});

// ---------------------------------------------------------------------------
// T26d — New: botLid cleared on disconnect
// ---------------------------------------------------------------------------

describe('ConnectionManager — botLid cleared on disconnect', () => {
  it('botJid and botLid are both cleared when connection closes', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();

    // Simulate connection open to set botJid and botLid
    emit(openEvent());
    expect(manager.botJid).not.toBeNull();
    expect(manager.botLid).not.toBeNull();

    // Now close
    emit(closeEvent(428));
    expect(manager.botJid).toBeNull();
    expect(manager.botLid).toBeNull();

    await manager.shutdown();
  });
});

// ---------------------------------------------------------------------------
// T26d — New: new event handlers are registered
// ---------------------------------------------------------------------------

describe('ConnectionManager — new event handlers', () => {
  it('contacts.upsert emits contactsUpsert event', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const contactsUpsertSpy = vi.fn();
    manager.on('contactsUpsert', contactsUpsertSpy);
    await manager.connect();

    const contacts = [{ id: '15551234567@s.whatsapp.net', name: 'Alice', notify: 'Alice' }];
    emit({ 'contacts.upsert': contacts });

    expect(contactsUpsertSpy).toHaveBeenCalledWith(contacts);

    await manager.shutdown();
  });

  it('contacts.update emits contactsUpdate event', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const contactsUpdateSpy = vi.fn();
    manager.on('contactsUpdate', contactsUpdateSpy);
    await manager.connect();

    const updates = [{ id: '15551234567@s.whatsapp.net', notify: 'Alice Updated' }];
    emit({ 'contacts.update': updates });

    expect(contactsUpdateSpy).toHaveBeenCalledWith(updates);

    await manager.shutdown();
  });

  it('messages.update with editedMessage emits messageEdited event', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const messageEditedSpy = vi.fn();
    manager.on('messageEdited', messageEditedSpy);
    await manager.connect();

    const updates = [
      {
        key: { id: 'msg-001', remoteJid: '15551234567@s.whatsapp.net' },
        update: {
          message: {
            editedMessage: {
              message: { conversation: 'updated text' },
            },
          },
        },
      },
    ];
    emit({ 'messages.update': updates });

    expect(messageEditedSpy).toHaveBeenCalledWith('msg-001', 'updated text');

    await manager.shutdown();
  });

  it('messages.delete emits messageDeleted event', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const messageDeletedSpy = vi.fn();
    manager.on('messageDeleted', messageDeletedSpy);
    await manager.connect();

    const deleteData = {
      keys: [
        { id: 'msg-001', remoteJid: '15551234567@s.whatsapp.net' },
        { id: 'msg-002', remoteJid: '15551234567@s.whatsapp.net' },
      ],
    };
    emit({ 'messages.delete': deleteData });

    expect(messageDeletedSpy).toHaveBeenCalledWith(['msg-001', 'msg-002']);

    await manager.shutdown();
  });

  it('presence.update emits presenceUpdate event and updates presenceCache', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    const presenceUpdateSpy = vi.fn();
    manager.on('presenceUpdate', presenceUpdateSpy);
    await manager.connect();

    const presenceData = {
      id: '120363000000@g.us',
      presences: {
        '15551234567@s.whatsapp.net': {
          lastKnownPresence: 'available',
          lastSeen: 1700000000,
        },
      },
    };
    emit({ 'presence.update': presenceData });

    expect(presenceUpdateSpy).toHaveBeenCalledWith(
      '15551234567@s.whatsapp.net',
      'available',
      1700000000,
    );

    // Verify presenceCache was updated
    const cached = manager.presenceCache.get('15551234567@s.whatsapp.net');
    expect(cached).not.toBeUndefined();
    expect(cached!.status).toBe('available');
    expect(cached!.stale).toBe(false);

    await manager.shutdown();
  });

  it('call event emits callReceived and auto-rejects when autoRejectCalls=true', async () => {
    const { mockSock, emit } = makeMockSocket();
    const rejectCallSpy = vi.fn().mockResolvedValue(undefined);
    (mockSock as any).rejectCall = rejectCallSpy;
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    manager.autoRejectCalls = true;
    const callReceivedSpy = vi.fn();
    manager.on('callReceived', callReceivedSpy);
    await manager.connect();

    const calls = [{ id: 'call-001', from: '15551234567@s.whatsapp.net' }];
    emit({ 'call': calls });

    expect(callReceivedSpy).toHaveBeenCalledWith('call-001', '15551234567@s.whatsapp.net');
    // Allow microtasks to flush for the async rejectCall
    await Promise.resolve();
    expect(rejectCallSpy).toHaveBeenCalledWith('call-001', '15551234567@s.whatsapp.net');

    await manager.shutdown();
  });

  it('call event does NOT auto-reject when autoRejectCalls=false', async () => {
    const { mockSock, emit } = makeMockSocket();
    const rejectCallSpy = vi.fn().mockResolvedValue(undefined);
    (mockSock as any).rejectCall = rejectCallSpy;
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    manager.autoRejectCalls = false;
    await manager.connect();

    emit({ 'call': [{ id: 'call-002', from: '15551234567@s.whatsapp.net' }] });

    await Promise.resolve();
    expect(rejectCallSpy).not.toHaveBeenCalled();

    await manager.shutdown();
  });
});

describe('ConnectionManager — keepalive', () => {
  it('sends periodic ping queries and records a pong timestamp after connection opens', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());

    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockSock.query).toHaveBeenCalledWith({
      tag: 'iq',
      attrs: {
        to: 's.whatsapp.net',
        type: 'get',
        xmlns: 'w:p',
      },
      content: [{ tag: 'ping', attrs: {} }],
    }, 10_000);

    const state = (manager as any).getConnectionState?.();
    expect(state?.lastPongAt ?? null).not.toBeNull();

    await manager.shutdown();
  });

  it('failed keepalive triggers a fresh reconnect', async () => {
    const sockets: ReturnType<typeof makeMockSocket>[] = [];
    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });

    const manager = new ConnectionManager();
    await manager.connect();
    sockets[0]!.mockSock.query.mockRejectedValueOnce(new Error('ping timeout'));
    sockets[0]!.emit(openEvent());

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(2);

    await manager.shutdown();
  });
});

describe('ConnectionManager — lifecycle edge coverage', () => {
  it('captures a settled auth-bond snapshot after key-material churn without creds.update', async () => {
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'));
    writeValidTestAuth();
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());
    const initialLatest = readLatestAuthBond();

    writeFileSync(join(testAuthDir, 'sender-key-test.json'), JSON.stringify({ keyData: 'rotated' }));
    await emit({ 'messages.upsert': { type: 'notify', messages: [] } });

    let lifecycle = manager.getConnectionState().credentialLifecycle;
    expect(lifecycle.recentEvents.map(event => event.event)).toContain('auth_snapshot_scheduled');

    await vi.advanceTimersByTimeAsync(59_999);
    expect(readLatestAuthBond()).toEqual(initialLatest);

    await vi.advanceTimersByTimeAsync(1);
    const refreshedLatest = readLatestAuthBond();
    expect(refreshedLatest.backupPath).not.toBe(initialLatest.backupPath);
    expect(refreshedLatest.reason).toBe('baileys-key-material-settled');
    expect(refreshedLatest.treeHash).not.toBe(initialLatest.treeHash);

    lifecycle = manager.getConnectionState().credentialLifecycle;
    expect(lifecycle.recentEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'auth_snapshot_captured',
        note: expect.stringContaining(join(testStateRoot, 'auth-bond-backups', 'WhatSoup', 'history')),
      }),
    ]));

    await manager.shutdown();
  });

  it('bounds repeated settled auth-bond snapshots while traffic continues', async () => {
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'));
    writeValidTestAuth();
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());

    writeFileSync(join(testAuthDir, 'sender-key-a.json'), JSON.stringify({ keyData: 'a' }));
    await emit({ 'messages.upsert': { type: 'notify', messages: [] } });
    writeFileSync(join(testAuthDir, 'sender-key-b.json'), JSON.stringify({ keyData: 'b' }));
    await emit({ 'messages.update': [] });

    let scheduled = manager.getConnectionState().credentialLifecycle.recentEvents
      .filter(event => event.event === 'auth_snapshot_scheduled');
    expect(scheduled).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    const firstSettled = readLatestAuthBond();
    expect(firstSettled.reason).toBe('baileys-key-material-settled');

    writeFileSync(join(testAuthDir, 'sender-key-c.json'), JSON.stringify({ keyData: 'c' }));
    await emit({ 'messages.upsert': { type: 'notify', messages: [] } });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(readLatestAuthBond()).toEqual(firstSettled);
    expect(manager.getConnectionState().credentialLifecycle.recentEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'auth_snapshot_skipped',
        note: 'settled-snapshot-min-interval',
      }),
    ]));

    scheduled = manager.getConnectionState().credentialLifecycle.recentEvents
      .filter(event => event.event === 'auth_snapshot_scheduled');
    expect(scheduled).toHaveLength(2);

    await manager.shutdown();
  });

  it('cancels pending settled auth-bond snapshots when the device bond is lost', async () => {
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'));
    writeValidTestAuth();
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());
    const initialLatest = readLatestAuthBond();

    writeFileSync(join(testAuthDir, 'sender-key-after-logout.json'), JSON.stringify({ keyData: 'do-not-capture' }));
    await emit({ 'messages.upsert': { type: 'notify', messages: [] } });
    emit(closeEvent(401));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(readLatestAuthBond()).toEqual(initialLatest);
    expect(manager.getConnectionState().credentialLifecycle.recentEvents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'auth_snapshot_captured',
        note: expect.stringContaining('baileys-key-material-settled'),
      }),
    ]));

    await manager.shutdown();
  });

  it('getConnectionState returns connection, keepalive, and reconnect metadata', async () => {
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'));
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    expect(manager.getConnectionState()).toMatchObject({
      state: 'disconnected',
      connected: false,
      reconnectAttempts: 0,
      reconnectPhase: 'backoff',
      firstFailureAt: null,
      lastPingAt: null,
      lastPongAt: null,
    });
    expect(manager.getConnectionState().credentialLifecycle).toMatchObject({
      version: 1,
      redaction: { version: 1 },
      environment: {
        instance: 'WhatSoup',
        pid: process.pid,
        nodeVersion: process.version,
      },
      latestBaileysVersion: null,
      recentEvents: [],
    });

    await manager.connect();
    await vi.advanceTimersByTimeAsync(100);
    emit(openEvent());

    expect(manager.getConnectionState()).toMatchObject({
      state: 'connected',
      connected: true,
      reconnectAttempts: 0,
      reconnectPhase: null,
      stateChangedAt: '2026-05-10T12:00:00.100Z',
      firstFailureAt: null,
    });
    let lifecycle = manager.getConnectionState().credentialLifecycle;
    expect(lifecycle.latestBaileysVersion).toBe('2.2413.1');
    expect(lifecycle.lastOpenAt).toBe('2026-05-10T12:00:00.100Z');
    expect(lifecycle.recentEvents.map(event => event.event)).toEqual(expect.arrayContaining([
      'connect_start',
      'auth_preflight_invalid',
      'baileys_version',
      'socket_created',
      'auth_snapshot_failed',
      'connection_open',
    ]));
    expect(lifecycle.currentAuthBond).toMatchObject({
      status: 'missing',
      creds: {
        path: join(testAuthDir, 'creds.json'),
        hash: null,
        identityHash: null,
      },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(manager.getConnectionState()).toMatchObject({
      lastPingAt: '2026-05-10T12:00:30.100Z',
      lastPongAt: '2026-05-10T12:00:30.100Z',
    });

    await vi.advanceTimersByTimeAsync(50);
    emit(closeEvent(428));

    expect(manager.getConnectionState()).toMatchObject({
      state: 'reconnecting',
      connected: false,
      reconnectAttempts: 1,
      reconnectPhase: 'backoff',
      stateChangedAt: '2026-05-10T12:00:30.150Z',
      firstFailureAt: '2026-05-10T12:00:30.150Z',
    });
    lifecycle = manager.getConnectionState().credentialLifecycle;
    expect(lifecycle.lastCloseAt).toBe('2026-05-10T12:00:30.150Z');
    expect(lifecycle.lastDisconnectDiagnostic).toMatchObject({
      error: { output: { statusCode: 428 } },
    });
    expect(lifecycle.recentEvents.map(event => event.event)).toContain('connection_close');

    await manager.shutdown();
  });

  it('persists protected reconnect runtime state with planned retry evidence', async () => {
    vi.setSystemTime(new Date('2026-05-10T13:00:00.000Z'));
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());

    emit(closeEvent(428));

    const statePath = join(testDataRoot, 'connection-state.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, any>;
    const persistedText = JSON.stringify(persisted);

    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(persisted).toMatchObject({
      version: 1,
      event: 'reconnect_scheduled',
      environment: {
        instance: 'WhatSoup',
        healthPort: 9090,
      },
      connection: {
        state: 'reconnecting',
        connected: false,
        reconnectAttempts: 1,
        reconnectPhase: 'backoff',
        firstFailureAt: '2026-05-10T13:00:00.000Z',
        lastDisconnectReason: 'connectionClosed',
        lastStatusCode: 428,
        backoffMs: 1000,
        nextReconnectAt: '2026-05-10T13:00:01.000Z',
      },
      diagnostics: {
        stateFile: 'connection-state.json',
      },
    });
    expect(persisted.diagnostics.stateFileFingerprint).toMatch(/^[0-9a-f]{20}$/);
    expect(persistedText).not.toContain('15551230004');
    expect(persistedText).not.toContain(testAuthDir);
    expect(persistedText).not.toContain(testStateRoot);
    expect(persistedText).not.toContain(testDataRoot);

    await manager.shutdown();
  });

  it('does not write connection runtime state through a symlinked sidecar target', async () => {
    vi.setSystemTime(new Date('2026-05-10T13:10:00.000Z'));
    mkdirSync(testDataRoot, { recursive: true, mode: 0o700 });
    const statePath = join(testDataRoot, 'connection-state.json');
    const outside = join(testDataRoot, 'outside-connection-state.json');
    writeFileSync(outside, 'unchanged\n', { mode: 0o600 });
    symlinkSync(outside, statePath);

    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(closeEvent(428));

    expect(lstatSync(statePath).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, 'utf-8')).toBe('unchanged\n');

    await manager.shutdown();
  });

  it('redacts identifiers and credential-like fields from disconnect diagnostics and BOT ERRORS evidence', async () => {
    vi.setSystemTime(new Date('2026-05-10T12:30:00.000Z'));
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();

    emit({
      'connection.update': {
        connection: 'close',
        lastDisconnect: {
          error: {
            message: 'removed 15555550123@s.whatsapp.net after phone 14155551234',
            output: { statusCode: 401, payload: { reason: 'device_removed' } },
            creds: { advSecretKey: 'do-not-print', registrationId: 1234 },
            nested: {
              remoteJid: '15555550123@s.whatsapp.net',
              linkedPhone: '14155551234',
            },
          },
        },
      },
    });

    const lifecycleText = JSON.stringify(manager.getConnectionState().credentialLifecycle);
    expect(lifecycleText).toContain('<jid:');
    expect(lifecycleText).toContain('<number:');
    expect(lifecycleText).toContain('"creds":"<redacted>"');
    expect(lifecycleText).not.toContain('15555550123@s.whatsapp.net');
    expect(lifecycleText).not.toContain('14155551234');
    expect(lifecycleText).not.toContain('do-not-print');

    const alertCalls = emitAlertMock.mock.calls as unknown as Array<[string, string, string, string, ...unknown[]]>;
    const evidence = alertCalls[0]![3];
    expect(evidence).toContain('lastDisconnectSanitized');
    expect(evidence).toContain('recentCredentialLifecycle');
    expect(evidence).not.toContain('15555550123@s.whatsapp.net');
    expect(evidence).not.toContain('14155551234');
    expect(evidence).not.toContain('do-not-print');

    await manager.shutdown();
  });

  it('shutdown transitions to shutting_down and closes the current socket', async () => {
    vi.setSystemTime(new Date('2026-05-10T12:10:00.000Z'));
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());

    await manager.shutdown();

    expect(mockSock.end).toHaveBeenCalledWith(undefined);
    expect(manager.getSocket()).toBeNull();
    expect(manager.getConnectionState()).toMatchObject({
      state: 'shutting_down',
      connected: false,
      reconnectPhase: 'backoff',
      stateChangedAt: '2026-05-10T12:10:00.000Z',
    });
  });

  it('QR updates do not replace the active connection or schedule reconnect', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();

    emit({ 'connection.update': { qr: 'pair-me' } });
    await Promise.resolve();

    expect(manager.getSocket()).toBe(mockSock);
    expect(mockSock.end).not.toHaveBeenCalled();
    expect(manager.getConnectionState()).toMatchObject({
      state: 'connecting',
      connected: false,
      reconnectAttempts: 0,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);

    await manager.shutdown();
  });

  it('clears local auth-bond failure after protected auth and a later successful send', async () => {
    writeValidTestAuth();
    const { mockSock, emit } = makeMockSocket();
    mockSock.sendMessage.mockResolvedValue({ key: { id: 'auth-clear-proof' } });
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());
    clearAlertSourceMock.mockClear();

    (manager as any).localAuthAlertEmitted = true;

    (manager as any).captureAuthBondSnapshot('connection-open');
    expect(clearAlertSourceMock).not.toHaveBeenCalled();

    await manager.sendMessage('15550100001@s.whatsapp.net', 'proof send');
    expect(clearAlertSourceMock).not.toHaveBeenCalled();

    emit({
      'message-receipt.update': [
        {
          key: { id: 'auth-clear-proof' },
          receipt: { userJid: '15550100001@s.whatsapp.net', receiptTimestamp: 1780000000 },
        },
      ],
    });

    expect(clearAlertSourceMock).toHaveBeenCalledWith(
      'WhatSoup',
      'whatsapp_auth_bond_local_failure',
      expect.stringContaining('repair_lane:WhatSoup'),
      expect.any(Object),
    );
    expect(clearAlertSourceMock).toHaveBeenCalledWith(
      'WhatSoup',
      'whatsapp_auth_bond_local_failure',
      expect.stringContaining('status=present'),
      expect.any(Object),
    );
    expect(clearAlertSourceMock).toHaveBeenCalledWith(
      'WhatSoup',
      'whatsapp_auth_bond_local_failure',
      expect.stringContaining('confirmed_send_message_id=auth-clear-proof'),
      expect.any(Object),
    );
    expect(clearAlertSourceMock).toHaveBeenCalledWith(
      'WhatSoup',
      'whatsapp_auth_bond_local_failure',
      expect.stringContaining('confirmed_send_proof=receipt_update'),
      expect.any(Object),
    );
    expect(clearAlertSourceMock).toHaveBeenCalledWith(
      'WhatSoup',
      'whatsapp_auth_bond_local_failure',
      expect.stringContaining('creds_size='),
      expect.any(Object),
    );
    expect((manager as any).localAuthAlertEmitted).toBe(false);

    await manager.shutdown();
  });

  it('does not clear local auth-bond failure for a bogus send id without receipt or echo proof', async () => {
    writeValidTestAuth();
    const { mockSock, emit } = makeMockSocket();
    mockSock.sendMessage.mockResolvedValue({ key: { id: 'wa-123' } });
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());
    clearAlertSourceMock.mockClear();

    (manager as any).localAuthAlertEmitted = true;

    await expect(manager.sendMessage('15550100001@s.whatsapp.net', 'proof send'))
      .resolves.toEqual({ waMessageId: 'wa-123' });

    expect(clearAlertSourceMock).not.toHaveBeenCalledWith(
      'WhatSoup',
      'whatsapp_auth_bond_local_failure',
      expect.any(String),
    );
    expect((manager as any).localAuthAlertEmitted).toBe(true);

    await manager.shutdown();
  });

  it('does not clear local auth-bond failure for a local-only optimistic id without receipt or echo proof', async () => {
    writeValidTestAuth();
    const optimisticId = String(-1_700_000_000_000);
    const { mockSock, emit } = makeMockSocket();
    mockSock.sendMessage.mockResolvedValue({ key: { id: optimisticId } });
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());
    clearAlertSourceMock.mockClear();

    (manager as any).localAuthAlertEmitted = true;

    await expect(manager.sendMessage('15550100001@s.whatsapp.net', 'proof send'))
      .resolves.toEqual({ waMessageId: optimisticId });

    expect(clearAlertSourceMock).not.toHaveBeenCalledWith(
      'WhatSoup',
      'whatsapp_auth_bond_local_failure',
      expect.any(String),
    );
    expect((manager as any).localAuthAlertEmitted).toBe(true);

    await manager.shutdown();
  });

  it('creds.update writes creds.json atomically before auth-bond capture', async () => {
    writeValidTestAuth('18455940000:1@s.whatsapp.net');
    const truncatingSaveCreds = vi.fn(async () => {
      writeFileSync(join(testAuthDir, 'creds.json'), '');
    });
    const nextCreds = {
      me: { id: '15551230004:1@s.whatsapp.net', lid: '81536414179557:2@lid' },
      registrationId: 42,
    };
    vi.mocked(useMultiFileAuthState).mockResolvedValueOnce({
      state: { creds: nextCreds, keys: {} },
      saveCreds: truncatingSaveCreds,
    } as any);
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    await emit({ 'creds.update': {} });

    expect(truncatingSaveCreds).not.toHaveBeenCalled();
    expect(statSync(join(testAuthDir, 'creds.json')).size).toBeGreaterThan(0);
    expect(readTestCreds()).toMatchObject({
      me: { id: '15551230004:1@s.whatsapp.net' },
      registrationId: 42,
    });
    expect(emitAlertMock).not.toHaveBeenCalledWith(
      'WhatSoup',
      'whatsapp_auth_bond_local_failure',
      expect.any(String),
      expect.any(String),
      'critical',
    );

    await manager.shutdown();
  });

  it('does not emit a local auth-bond alert for a fresh credential write window', async () => {
    writeValidTestAuth();
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    emit(openEvent());
    emitAlertMock.mockClear();

    writeFileSync(join(testAuthDir, 'creds.json'), '');
    (manager as any).captureAuthBondSnapshot('creds-update');

    expect(emitAlertMock).not.toHaveBeenCalledWith(
      'WhatSoup',
      'whatsapp_auth_bond_local_failure',
      expect.any(String),
      expect.any(String),
      'critical',
      expect.any(Object),
    );
    expect((manager as any).authSnapshotFailureCount).toBe(0);
    expect(manager.getConnectionState().credentialLifecycle.recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'auth_snapshot_skipped',
          note: expect.stringContaining('credential write still in flight'),
        }),
      ]),
    );

    await manager.shutdown();
  });

  it('creds.update preserves previous creds when the protected writer refuses an unsafe target', async () => {
    writeValidTestAuth('15551230009:1@s.whatsapp.net');
    const credsPath = join(testAuthDir, 'creds.json');
    const outside = join(testAuthDir, 'outside-creds.json');
    const previousCreds = readFileSync(credsPath, 'utf-8');
    writeFileSync(outside, previousCreds, { mode: 0o600 });
    rmSync(credsPath, { force: true });
    symlinkSync(outside, credsPath);
    const truncatingSaveCreds = vi.fn(async () => {
      writeFileSync(credsPath, '');
    });
    vi.mocked(useMultiFileAuthState).mockResolvedValueOnce({
      state: {
        creds: {
          me: { id: '15551230004:1@s.whatsapp.net', lid: '81536414179557:2@lid' },
          registrationId: 99,
        },
        keys: {},
      },
      saveCreds: truncatingSaveCreds,
    } as any);
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    await emit({ 'creds.update': {} });

    expect(truncatingSaveCreds).not.toHaveBeenCalled();
    expect(lstatSync(credsPath).isSymbolicLink()).toBe(true);
    expect(statSync(outside).size).toBeGreaterThan(0);
    expect(readTestCreds()).toMatchObject({
      me: { id: '15551230009:1@s.whatsapp.net' },
      registrationId: 1,
    });

    await manager.shutdown();
  });

  it('send paths reject clearly when no socket is connected', async () => {
    const manager = new ConnectionManager();

    await expect(manager.sendMessage('111@s.whatsapp.net', 'hello')).rejects.toMatchObject({
      name: 'WhatSoupError',
      code: 'CONNECTION_UNAVAILABLE',
      message: 'WhatsApp is not connected',
    });
    await expect(manager.sendRaw('111@s.whatsapp.net', { text: 'hello' })).rejects.toMatchObject({
      name: 'WhatSoupError',
      code: 'CONNECTION_UNAVAILABLE',
      message: 'WhatsApp is not connected',
    });
    await expect(
      manager.sendMedia('111@s.whatsapp.net', {
        type: 'image',
        buffer: Buffer.from('image'),
        mimetype: 'image/png',
      }),
    ).rejects.toMatchObject({
      name: 'WhatSoupError',
      code: 'CONNECTION_UNAVAILABLE',
      message: 'WhatsApp is not connected',
    });
  });

  it('sendMedia passes stream sources through to Baileys media upload payloads', async () => {
    const { mockSock } = makeMockSocket();
    mockSock.sendMessage.mockResolvedValue({ key: { id: 'media-1' } });
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    const stream = Readable.from(['image']);

    await expect(
      manager.sendMedia('111@s.whatsapp.net', {
        type: 'image',
        stream,
        mimetype: 'image/png',
      }),
    ).resolves.toEqual({ waMessageId: 'media-1' });

    expect(mockSock.sendMessage).toHaveBeenCalledWith(
      '111@s.whatsapp.net',
      expect.objectContaining({
        image: { stream },
        mimetype: 'image/png',
      }),
    );

    await manager.shutdown();
  });

  it('sendMedia retries once when a buffer-backed Baileys encrypted tmp file vanishes', async () => {
    const { mockSock } = makeMockSocket();
    const tmpErr = Object.assign(
      new Error('ENOENT: no such file or directory, open /tmp/document123-enc'),
      { code: 'ENOENT', path: '/tmp/document123-enc' },
    );
    mockSock.sendMessage
      .mockRejectedValueOnce(tmpErr)
      .mockResolvedValueOnce({ key: { id: 'media-retry' } });
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();

    await expect(
      manager.sendMedia('111@s.whatsapp.net', {
        type: 'document',
        buffer: Buffer.from('doc'),
        filename: 'doc.txt',
        mimetype: 'text/plain',
      }),
    ).resolves.toEqual({ waMessageId: 'media-retry' });

    expect(mockSock.sendMessage).toHaveBeenCalledTimes(2);

    await manager.shutdown();
  });

  it('sendMedia does not retry Baileys tmp ENOENT more than once', async () => {
    const { mockSock } = makeMockSocket();
    const firstErr = Object.assign(
      new Error('ENOENT: no such file or directory, open /tmp/video123-enc'),
      { code: 'ENOENT', path: '/tmp/video123-enc' },
    );
    const secondErr = Object.assign(
      new Error('ENOENT: no such file or directory, open /tmp/video456-enc'),
      { code: 'ENOENT', path: '/tmp/video456-enc' },
    );
    mockSock.sendMessage
      .mockRejectedValueOnce(firstErr)
      .mockRejectedValueOnce(secondErr);
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();

    await expect(
      manager.sendMedia('111@s.whatsapp.net', {
        type: 'video',
        buffer: Buffer.from('video'),
        mimetype: 'video/mp4',
      }),
    ).rejects.toBe(secondErr);

    expect(mockSock.sendMessage).toHaveBeenCalledTimes(2);

    await manager.shutdown();
  });

  it('sendMedia does not retry non-Baileys tmp errors', async () => {
    const { mockSock } = makeMockSocket();
    const err = Object.assign(new Error('network down'), { code: 'ETIMEDOUT' });
    mockSock.sendMessage.mockRejectedValueOnce(err);
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();

    await expect(
      manager.sendMedia('111@s.whatsapp.net', {
        type: 'image',
        buffer: Buffer.from('image'),
        mimetype: 'image/png',
      }),
    ).rejects.toBe(err);

    expect(mockSock.sendMessage).toHaveBeenCalledTimes(1);

    await manager.shutdown();
  });

  it('sendMedia does not retry generic ENOENT outside the Baileys encrypted tmp path', async () => {
    const { mockSock } = makeMockSocket();
    const err = Object.assign(
      new Error('ENOENT: no such file or directory, open /tmp/source.pdf'),
      { code: 'ENOENT', path: '/tmp/source.pdf' },
    );
    mockSock.sendMessage.mockRejectedValueOnce(err);
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();

    await expect(
      manager.sendMedia('111@s.whatsapp.net', {
        type: 'document',
        buffer: Buffer.from('doc'),
        filename: 'source.pdf',
        mimetype: 'application/pdf',
      }),
    ).rejects.toBe(err);

    expect(mockSock.sendMessage).toHaveBeenCalledTimes(1);

    await manager.shutdown();
  });

  it('sendMedia does not retry stream-backed media because the stream may be consumed', async () => {
    const { mockSock } = makeMockSocket();
    const tmpErr = Object.assign(
      new Error('ENOENT: no such file or directory, open /tmp/image123-enc'),
      { code: 'ENOENT', path: '/tmp/image123-enc' },
    );
    mockSock.sendMessage.mockRejectedValueOnce(tmpErr);
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();

    await expect(
      manager.sendMedia('111@s.whatsapp.net', {
        type: 'image',
        stream: Readable.from(['image']),
        mimetype: 'image/png',
      }),
    ).rejects.toBe(tmpErr);

    expect(mockSock.sendMessage).toHaveBeenCalledTimes(1);

    await manager.shutdown();
  });

  it('ignores events emitted by stale sockets after reconnect', async () => {
    const sockets: ReturnType<typeof makeMockSocket>[] = [];
    vi.mocked(makeWASocket).mockImplementation(() => {
      const s = makeMockSocket();
      sockets.push(s);
      return s.mockSock as any;
    });

    const manager = new ConnectionManager();
    const contactsUpsertSpy = vi.fn();
    manager.on('contactsUpsert', contactsUpsertSpy);

    await manager.connect();
    sockets[0]!.emit(closeEvent(515));
    await flushAsyncReconnect();

    sockets[0]!.emit({
      'connection.update': { connection: 'open' },
      'contacts.upsert': [{ id: 'stale@s.whatsapp.net', name: 'Stale' }],
    });

    expect(contactsUpsertSpy).not.toHaveBeenCalled();
    expect(manager.getConnectionState()).toMatchObject({
      state: 'reconnecting',
      connected: false,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    sockets[1]!.emit({
      'connection.update': { connection: 'open' },
      'contacts.upsert': [{ id: 'fresh@s.whatsapp.net', name: 'Fresh' }],
    });

    expect(contactsUpsertSpy).toHaveBeenCalledWith([
      { id: 'fresh@s.whatsapp.net', name: 'Fresh' },
    ]);
    expect(manager.getConnectionState()).toMatchObject({
      state: 'connected',
      connected: true,
    });

    await manager.shutdown();
  });
});
