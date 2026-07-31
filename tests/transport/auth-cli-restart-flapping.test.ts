import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ConnectionUpdateHandler = (update: {
  connection?: string;
  qr?: string;
  lastDisconnect?: { error?: unknown };
}) => unknown | Promise<unknown>;

const mocks = vi.hoisted(() => ({
  connectionHandlers: [] as ConnectionUpdateHandler[],
  sockets: [] as Array<{
    ev: { on: ReturnType<typeof vi.fn> };
    end: ReturnType<typeof vi.fn>;
    user?: { id?: string };
  }>,
  makeWASocket: vi.fn(),
  useMultiFileAuthState: vi.fn(),
  existsSync: vi.fn(),
  saveCreds: vi.fn(),
  qrcodeGenerate: vi.fn(),
  nextUserId: undefined as string | undefined,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: mocks.existsSync,
  };
});

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: mocks.makeWASocket,
  useMultiFileAuthState: mocks.useMultiFileAuthState,
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 2413, 1] }),
  makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
  DisconnectReason: {
    loggedOut: 401,
    restartRequired: 515,
    connectionClosed: 428,
    timedOut: 408,
    badSession: 500,
    unavailableService: 503,
    401: 'loggedOut',
    515: 'restartRequired',
    428: 'connectionClosed',
    408: 'timedOut',
    500: 'badSession',
    503: 'unavailableService',
  },
}));

vi.mock('qrcode-terminal', () => ({
  default: { generate: mocks.qrcodeGenerate },
}));

vi.mock('../../src/config.ts', () => ({
  config: {
    authDir: '/tmp/wa-test-auth',
    lockPath: '/tmp/wa-test-auth.lock',
  },
}));

vi.mock('../../src/transport/third-party-console-redaction.ts', () => ({
  installThirdPartyConsoleRedaction: vi.fn(),
}));

vi.mock('../../src/transport/atomic-auth-save.ts', () => ({
  createAtomicCredsSaver: vi.fn(() => mocks.saveCreds),
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
    mocks.nextUserId = undefined;
    mocks.existsSync.mockReset();
    mocks.existsSync.mockReturnValue(false);
    mocks.saveCreds.mockReset();
    mocks.saveCreds.mockResolvedValue(undefined);
    mocks.qrcodeGenerate.mockReset();
    mocks.useMultiFileAuthState.mockReset();
    mocks.useMultiFileAuthState.mockResolvedValue({
      state: { creds: {}, keys: {} },
      saveCreds: mocks.saveCreds,
    });
    mocks.makeWASocket.mockReset();
    mocks.makeWASocket.mockImplementation(() => {
      const sock = {
        ev: {
          on: vi.fn((event: string, handler: ConnectionUpdateHandler) => {
            if (event === 'connection.update') mocks.connectionHandlers.push(handler);
          }),
        },
        end: vi.fn(),
        user: mocks.nextUserId === undefined ? undefined : { id: mocks.nextUserId },
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

  it('refuses to start when the bot lock file exists', async () => {
    mocks.existsSync.mockReturnValueOnce(true);
    vi.mocked(process.exit).mockImplementationOnce(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(import('../../src/transport/auth.ts')).rejects.toThrow('exit:1');

    expect(console.error).toHaveBeenCalledWith(
      'Bot is currently running. Stop it first:\n' +
      '  Linux: systemctl --user stop whatsoup\n' +
      '  macOS: use the Fleet auth flow or see docs/runbooks/macos-launchd-deployment.md#restart-procedures\n' +
      '         (do not use legacy launchctl stop for a KeepAlive job)',
    );
    expect(mocks.makeWASocket).not.toHaveBeenCalled();
  });

  it('uses the default lock path when config provides no lockPath', async () => {
    vi.resetModules();
    vi.doMock('../../src/config.ts', () => ({
      config: { authDir: '/tmp/wa-test-auth' },
    }));
    const checkedPaths: unknown[] = [];
    mocks.existsSync.mockImplementation((lockPath: unknown) => {
      checkedPaths.push(lockPath);
      return true;
    });
    vi.mocked(process.exit).mockImplementationOnce(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      await expect(import('../../src/transport/auth.ts')).rejects.toThrow('exit:1');
      expect(checkedPaths).toContain(join(tmpdir(), 'whatsoup-auth.lock'));
      expect(mocks.makeWASocket).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../src/config.ts');
    }
  });

  it('emits QR events on stdout while rendering terminal QR on stderr', async () => {
    mocks.qrcodeGenerate.mockImplementation((_qr: string, _opts: unknown, render: (asciiArt: string) => void) => {
      render('ASCII-QR');
    });
    await import('../../src/transport/auth.ts');
    await flushPromises();

    const handler = mocks.connectionHandlers.at(-1);
    if (!handler) throw new Error('missing connection.update handler');
    await handler({ qr: 'qr-payload' });

    expect(process.stdout.write).toHaveBeenCalledWith(JSON.stringify({ event: 'qr', data: 'qr-payload' }) + '\n');
    expect(console.error).toHaveBeenCalledWith('\nScan the QR code below with WhatsApp > Linked Devices > Link a Device:\n');
    expect(mocks.qrcodeGenerate).toHaveBeenCalledWith('qr-payload', { small: true }, expect.any(Function));
    expect(process.stderr.write).toHaveBeenCalledWith('ASCII-QR\n');
  });

  it('passes a silent Baileys logger with no-op methods to avoid credential leakage', async () => {
    await import('../../src/transport/auth.ts');
    await flushPromises();

    const socketOptions = mocks.makeWASocket.mock.calls[0]?.[0] as {
      logger?: {
        level: string;
        trace: () => void;
        debug: () => void;
        info: () => void;
        warn: () => void;
        error: () => void;
        child: () => unknown;
      };
    };
    const logger = socketOptions.logger;
    if (!logger) throw new Error('missing Baileys logger');

    expect(logger.level).toBe('silent');
    expect(logger.trace()).toBeUndefined();
    expect(logger.debug()).toBeUndefined();
    expect(logger.info()).toBeUndefined();
    expect(logger.warn()).toBeUndefined();
    expect(logger.error()).toBeUndefined();
    expect(logger.child()).toBe(logger);
  });

  it('saves credentials, closes the socket, and exits cleanly after connection opens', async () => {
    mocks.nextUserId = '15551230004:1@s.whatsapp.net';
    await import('../../src/transport/auth.ts');
    await flushPromises();

    const handler = mocks.connectionHandlers.at(-1);
    if (!handler) throw new Error('missing connection.update handler');
    await handler({ connection: 'open' });

    expect(process.stdout.write).toHaveBeenCalledWith(JSON.stringify({ event: 'connected' }) + '\n');
    expect(console.error).toHaveBeenCalledWith('\nAuthenticated successfully as [REDACTED WHATSAPP JID]');
    expect(console.error).toHaveBeenCalledWith('Saving credentials...');
    expect(mocks.saveCreds).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(mocks.sockets[0]!.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.sockets[0]!.end).toHaveBeenCalledWith(undefined);
    expect(console.error).toHaveBeenCalledWith('Done. You can now start the bot.');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('uses unknown identity and still exits when best-effort socket close throws', async () => {
    await import('../../src/transport/auth.ts');
    await flushPromises();

    mocks.sockets[0]!.end.mockImplementationOnce(() => {
      throw new Error('socket already closed');
    });

    const handler = mocks.connectionHandlers.at(-1);
    if (!handler) throw new Error('missing connection.update handler');
    await handler({ connection: 'open' });

    expect(console.error).toHaveBeenCalledWith('\nAuthenticated successfully as unknown');
    expect(mocks.saveCreds).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.sockets[0]!.end).toHaveBeenCalledWith(undefined);
    expect(console.error).toHaveBeenCalledWith('Done. You can now start the bot.');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('reports authentication timeout when no connection opens', async () => {
    await import('../../src/transport/auth.ts');
    await flushPromises();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(console.error).toHaveBeenCalledWith('Timed out after 120 seconds — no successful authentication.');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exits without reconnecting when Baileys reports loggedOut', async () => {
    await import('../../src/transport/auth.ts');
    await flushPromises();

    const handler = mocks.connectionHandlers.at(-1);
    if (!handler) throw new Error('missing connection.update handler');
    await handler({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });

    expect(console.error).toHaveBeenCalledWith('Logged out — delete the auth directory and re-run this script.');
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);
  });

  it('logs a mapped close reason and reconnects for transient socket churn', async () => {
    await import('../../src/transport/auth.ts');
    await flushPromises();

    const handler = mocks.connectionHandlers.at(-1);
    if (!handler) throw new Error('missing connection.update handler');
    await handler({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });

    expect(console.error).toHaveBeenCalledWith('Connection closed during auth: connectionClosed — reconnecting...');
    expect(mocks.sockets[0]!.end).toHaveBeenCalledWith(undefined);
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(2);
  });

  it('logs numeric unknown close reasons and reconnects for unmapped status codes', async () => {
    await import('../../src/transport/auth.ts');
    await flushPromises();

    const handler = mocks.connectionHandlers.at(-1);
    if (!handler) throw new Error('missing connection.update handler');
    await handler({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 499 } } },
    });

    expect(console.error).toHaveBeenCalledWith('Connection closed during auth: unknown(499) — reconnecting...');
    expect(mocks.sockets[0]!.end).toHaveBeenCalledWith(undefined);
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(2);
  });

  it('logs unknown close reasons and reconnects when Baileys omits a status code', async () => {
    await import('../../src/transport/auth.ts');
    await flushPromises();

    const handler = mocks.connectionHandlers.at(-1);
    if (!handler) throw new Error('missing connection.update handler');
    await handler({ connection: 'close', lastDisconnect: { error: {} } });

    expect(console.error).toHaveBeenCalledWith('Connection closed during auth: unknown — reconnecting...');
    expect(mocks.sockets[0]!.end).toHaveBeenCalledWith(undefined);
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(2);
  });

  it('redacts Error startup failures before exiting', async () => {
    mocks.useMultiFileAuthState.mockRejectedValueOnce(new Error('token=super-secret path=/tmp/private-auth'));

    await import('../../src/transport/auth.ts');
    await flushPromises();

    expect(console.error).toHaveBeenCalledWith(
      'Auth failed:',
      'token=[REDACTED] path=/tmp/private-auth',
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('redacts non-Error startup failures before exiting', async () => {
    mocks.useMultiFileAuthState.mockRejectedValueOnce('Authorization: Bearer abc.def');

    await import('../../src/transport/auth.ts');
    await flushPromises();

    expect(console.error).toHaveBeenCalledWith(
      'Auth failed:',
      'Authorization: Bearer [REDACTED]',
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
