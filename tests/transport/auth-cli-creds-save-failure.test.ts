/**
 * Pins credential-save failure handling in the pairing CLI (#2165).
 *
 * `createAtomicCredsSaver` returns a promise that DOES carry the write
 * rejection — `tests/transport/atomic-auth-save.test.ts` already proves it
 * (`await expect(failedSave).rejects.toThrow(/BigInt/)`). The defect was on the
 * consuming side, in this CLI:
 *
 *   - `sock.ev.on('creds.update', saveCreds)` discarded the returned promise,
 *     so a write failure became an unhandled rejection. The `main().catch` at
 *     the bottom of auth.ts does not cover it: listener callbacks run outside
 *     main()'s promise chain.
 *   - the `connection === 'open'` branch awaited the save with no try/catch, so
 *     on failure the CLI skipped both its "Done" message and `process.exit(0)`
 *     — it had already printed "Authenticated successfully".
 *
 * Every assertion below is about what the operator observes on a FAILED save,
 * which is the state the pre-fix code could not report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (update?: unknown) => unknown | Promise<unknown>;

const mocks = vi.hoisted(() => ({
  connectionHandlers: [] as Handler[],
  credsHandlers: [] as Handler[],
  makeWASocket: vi.fn(),
  useMultiFileAuthState: vi.fn(),
  existsSync: vi.fn(),
  saveCreds: vi.fn(),
  qrcodeGenerate: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: mocks.existsSync };
});

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: mocks.makeWASocket,
  useMultiFileAuthState: mocks.useMultiFileAuthState,
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 2413, 1] }),
  makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
  DisconnectReason: { loggedOut: 401, restartRequired: 515, 401: 'loggedOut', 515: 'restartRequired' },
}));

vi.mock('qrcode-terminal', () => ({ default: { generate: mocks.qrcodeGenerate } }));

vi.mock('../../src/config.ts', () => ({
  config: { authDir: '/tmp/wa-test-auth', lockPath: '/tmp/wa-test-auth.lock' },
}));

vi.mock('../../src/transport/third-party-console-redaction.ts', () => ({
  installThirdPartyConsoleRedaction: vi.fn(),
}));

vi.mock('../../src/transport/atomic-auth-save.ts', () => ({
  createAtomicCredsSaver: vi.fn(() => mocks.saveCreds),
}));

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Every `console.error` argument list, flattened to one string per call. */
function errorLines(): string[] {
  return vi.mocked(console.error).mock.calls.map((call) => call.map(String).join(' '));
}

describe('#2165 auth CLI credential-save failure', () => {
  let unhandled: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    mocks.connectionHandlers.length = 0;
    mocks.credsHandlers.length = 0;
    mocks.existsSync.mockReset();
    mocks.existsSync.mockReturnValue(false);
    mocks.saveCreds.mockReset();
    mocks.saveCreds.mockResolvedValue(undefined);
    mocks.qrcodeGenerate.mockReset();
    mocks.useMultiFileAuthState.mockReset();
    mocks.useMultiFileAuthState.mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds: mocks.saveCreds });
    mocks.makeWASocket.mockReset();
    mocks.makeWASocket.mockImplementation(() => ({
      ev: {
        on: vi.fn((event: string, handler: Handler) => {
          if (event === 'connection.update') mocks.connectionHandlers.push(handler);
          if (event === 'creds.update') mocks.credsHandlers.push(handler);
        }),
      },
      end: vi.fn(),
      // No `user.id`: auth.ts falls back to 'unknown', and none of these tests
      // assert on the identity. A literal JID here would be a credential-shaped
      // fixture the repo's posture scanners cannot distinguish from a leak.
      user: undefined,
    }));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    unhandled = [];
    process.on('unhandledRejection', (reason) => { unhandled.push(reason); });
  });

  afterEach(() => {
    process.removeAllListeners('unhandledRejection');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("the 'creds.update' listener", () => {
    it('reports a failed save instead of leaving the rejection unhandled', async () => {
      await import('../../src/transport/auth.ts');
      await flushPromises();

      const handler = mocks.credsHandlers.at(-1);
      if (!handler) throw new Error('missing creds.update handler');

      mocks.saveCreds.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
      await handler();
      await flushPromises();

      expect(errorLines()).toContainEqual(
        expect.stringContaining('Credential save failed:'),
      );
      expect(errorLines().join('\n')).toContain('ENOSPC');
    });

    it('does not surface a rejection to the process when the save fails', async () => {
      await import('../../src/transport/auth.ts');
      await flushPromises();

      const handler = mocks.credsHandlers.at(-1);
      if (!handler) throw new Error('missing creds.update handler');

      mocks.saveCreds.mockRejectedValueOnce(new Error('EACCES: permission denied'));
      // Whatever the listener returns must not itself be a rejecting promise —
      // the pre-fix code handed `saveCreds` directly to `.on`, so the raw
      // rejection escaped with no handler.
      await expect(Promise.resolve(handler())).resolves.not.toThrow();
      await flushPromises();

      expect(unhandled).toHaveLength(0);
    });

    it('stays silent on a successful save', async () => {
      await import('../../src/transport/auth.ts');
      await flushPromises();

      const handler = mocks.credsHandlers.at(-1);
      if (!handler) throw new Error('missing creds.update handler');

      await handler();
      await flushPromises();

      expect(errorLines().filter((l) => l.includes('Credential save failed'))).toHaveLength(0);
    });
  });

  describe("the connection === 'open' branch", () => {
    async function openConnection(): Promise<void> {
      await import('../../src/transport/auth.ts');
      await flushPromises();
      const handler = mocks.connectionHandlers.at(-1);
      if (!handler) throw new Error('missing connection.update handler');
      await handler({ connection: 'open' });
      await flushPromises();
    }

    it('exits NON-ZERO when the final credential save fails', async () => {
      mocks.saveCreds.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
      await openConnection();

      expect(process.exit).toHaveBeenCalledWith(1);
      expect(errorLines()).toContainEqual(expect.stringContaining('FATAL: credential save failed:'));
    });

    it('tells the operator pairing did not complete', async () => {
      mocks.saveCreds.mockRejectedValueOnce(new Error('EACCES: permission denied'));
      await openConnection();

      // "Authenticated successfully" has already been printed at this point, so
      // without this line the run reads as a success.
      expect(errorLines()).toContainEqual(
        expect.stringContaining('the bot cannot start without saved credentials'),
      );
    });

    it('never prints the success message after a failed save', async () => {
      mocks.saveCreds.mockRejectedValueOnce(new Error('ENOSPC'));
      await openConnection();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(errorLines().filter((l) => l.includes('Done. You can now start the bot.'))).toHaveLength(0);
      expect(process.exit).not.toHaveBeenCalledWith(0);
    });

    it('still completes normally when the save succeeds', async () => {
      await openConnection();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(errorLines()).toContainEqual(expect.stringContaining('Done. You can now start the bot.'));
      expect(process.exit).toHaveBeenCalledWith(0);
      expect(errorLines().filter((l) => l.includes('FATAL'))).toHaveLength(0);
    });
  });
});
