import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  DisconnectReason: { loggedOut: 401, restartRequired: 515, connectionClosed: 428 },
  isJidGroup: vi.fn((jid: string) => jid?.endsWith('@g.us')),
  jidNormalizedUser: vi.fn((jid: string) => jid?.replace(/:.*@/, '@')),
}));

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set(['15550100001']),
    authDir: '/tmp/wa-test-auth',
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

import { makeWASocket } from '@whiskeysockets/baileys';
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
    end: vi.fn(),
    user: {
      id: '18455943112:1@s.whatsapp.net',
      lid: '81536414179557:2@lid',
      name: 'WhatSoup',
    },
  };

  function emit(events: Record<string, unknown>) {
    if (!evProcessCallback) throw new Error('ev.process callback not yet registered');
    evProcessCallback(events);
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

/** Fire a connection.update open event. */
function openEvent() {
  return { 'connection.update': { connection: 'open' } };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(async () => {
  vi.useRealTimers();
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

  it('restartRequired disconnect triggers immediate reconnect without backoff', async () => {
    const { mockSock, emit } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);

    const manager = new ConnectionManager();
    await manager.connect();
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);

    // Emit restartRequired (515)
    emit(closeEvent(515));

    // Should reconnect synchronously (no setTimeout), so no timer advance needed
    // The reconnect call is async (void this.connect()), so let microtasks flush
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(2);

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

    // Advance well past any backoff
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);

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
