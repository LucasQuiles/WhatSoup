import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ConnectionUpdateHandler = (update: {
  connection?: string;
  lastDisconnect?: { error?: unknown };
}) => unknown | Promise<unknown>;

const mocks = vi.hoisted(() => ({
  connectionHandlers: [] as ConnectionUpdateHandler[],
  sockets: [] as Array<{ ev: { on: ReturnType<typeof vi.fn> }; end: ReturnType<typeof vi.fn> }>,
  makeWASocket: vi.fn(),
  saveCreds: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: mocks.makeWASocket,
  useMultiFileAuthState: vi.fn().mockResolvedValue({
    state: { creds: {}, keys: {} },
    saveCreds: mocks.saveCreds,
  }),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 2413, 1] }),
  makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
  DisconnectReason: {
    loggedOut: 401,
    restartRequired: 515,
    connectionClosed: 428,
    401: 'loggedOut',
    515: 'restartRequired',
    428: 'connectionClosed',
  },
}));

vi.mock('qrcode-terminal', () => ({
  default: { generate: vi.fn() },
}));

vi.mock('../../src/config.ts', () => ({
  config: {
    authDir: '/tmp/wa-test-auth',
    lockPath: '/tmp/wa-test-auth.lock',
  },
}));

function restartRequiredClose() {
  return {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 515 } } },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('auth CLI restartRequired handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    mocks.connectionHandlers.length = 0;
    mocks.sockets.length = 0;
    mocks.makeWASocket.mockImplementation(() => {
      const sock = {
        ev: {
          on: vi.fn((event: string, handler: ConnectionUpdateHandler) => {
            if (event === 'connection.update') mocks.connectionHandlers.push(handler);
          }),
        },
        end: vi.fn(),
      };
      mocks.sockets.push(sock);
      return sock;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('backs off instead of immediately reconnecting when restartRequired flaps', async () => {
    await import('../../src/transport/auth.ts');
    await flushPromises();

    expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 9; i += 1) {
      const handler = mocks.connectionHandlers.at(-1);
      if (!handler) throw new Error('missing connection.update handler');
      await handler(restartRequiredClose());
      expect(mocks.makeWASocket).toHaveBeenCalledTimes(i + 2);
    }

    const callsBeforeFlap = mocks.makeWASocket.mock.calls.length;
    const handler = mocks.connectionHandlers.at(-1);
    if (!handler) throw new Error('missing connection.update handler');
    await handler(restartRequiredClose());

    expect(mocks.makeWASocket).toHaveBeenCalledTimes(callsBeforeFlap);
    expect(console.error).toHaveBeenCalledWith(
      'restartRequired flapping detected (10 in <60s) — backing off before reconnecting...',
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(callsBeforeFlap);

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(callsBeforeFlap + 1);
  });
});
