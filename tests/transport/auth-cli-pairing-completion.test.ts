/**
 * Pins the pairing CLI's exit to the pairing-completion gate.
 *
 * The CLI printed `{"event":"connected"}` and exited as soon as `saveCreds()`
 * resolved. Baileys still runs key-store writes after 'open' in a
 * `process.nextTick` block (socket.js CB:success, rc13 :764-785), so the exit
 * could kill them in flight. Fleet activation reads `connected` as "auth
 * material persisted", so these tests assert on that line and the exit code:
 *   - `connected` is printed only after a nextTick-scheduled key write landed;
 *   - a failed credential save, or a deadline with a write still in flight,
 *     exits 1 without `connected`;
 *   - a close during the wait does not start a second socket.
 *
 * The own-LID state check itself is pinned in pairing-completion.test.ts.
 * Whether WhatsApp accepts the first runtime reconnect is not covered by any
 * unit test; that needs a live-line qualification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../helpers/deferred.ts';

type Handler = (update?: unknown) => unknown | Promise<unknown>;
type KeyData = Record<string, Record<string, unknown>>;

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
  // Pass-through, so the store Baileys writes to is the one the CLI wrapped.
  makeCacheableSignalKeyStore: vi.fn((store: unknown) => store),
  DisconnectReason: { loggedOut: 401, restartRequired: 515, 401: 'loggedOut', 515: 'restartRequired' },
}));

vi.mock('qrcode-terminal', () => ({ default: { generate: mocks.qrcodeGenerate } }));

vi.mock('../../src/config.ts', () => ({
  config: {
    authDir: '/tmp/wa-test-auth-auth-cli-pairing-completion',
    lockPath: '/tmp/wa-test-auth-auth-cli-pairing-completion.lock',
  },
}));

vi.mock('../../src/transport/third-party-console-redaction.ts', () => ({
  installThirdPartyConsoleRedaction: vi.fn(),
}));

vi.mock('../../src/transport/atomic-auth-save.ts', () => ({
  createAtomicCredsSaver: vi.fn(() => mocks.saveCreds),
}));

const CONNECTED_LINE = JSON.stringify({ event: 'connected' }) + '\n';

const macrotask = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

async function settleTurns(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await macrotask();
}

/** Key store whose writes span real macrotask turns, like file I/O. */
function memoryKeys() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(type: string, ids: string[]): Promise<Record<string, unknown>> {
      await macrotask();
      const out: Record<string, unknown> = {};
      for (const id of ids) out[id] = data.get(`${type}/${id}`) ?? null;
      return out;
    },
    async set(update: KeyData): Promise<void> {
      await macrotask();
      await macrotask();
      for (const [type, entries] of Object.entries(update)) {
        for (const [id, value] of Object.entries(entries)) data.set(`${type}/${id}`, value);
      }
    },
  };
}

function errorLines(): string[] {
  return vi.mocked(process.stderr.write).mock.calls.map((call) => call.map(String).join(' '));
}

function connectedPrinted(): boolean {
  return vi.mocked(process.stdout.write).mock.calls.some(([chunk]) => chunk === CONNECTED_LINE);
}

describe('pairing CLI exit waits for the pairing-completion gate', () => {
  let keys: ReturnType<typeof memoryKeys>;
  let unhandled: unknown[];
  let onUnhandled: (reason: unknown) => void;

  beforeEach(() => {
    // setImmediate stays real: the gate needs real macrotask turns. Only the
    // deadline (setTimeout) is under test control.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.resetModules();
    mocks.connectionHandlers.length = 0;
    mocks.credsHandlers.length = 0;
    mocks.existsSync.mockReset();
    mocks.existsSync.mockReturnValue(false);
    mocks.saveCreds.mockReset();
    mocks.saveCreds.mockResolvedValue(undefined);
    mocks.qrcodeGenerate.mockReset();
    keys = memoryKeys();
    mocks.useMultiFileAuthState.mockReset();
    mocks.useMultiFileAuthState.mockResolvedValue({ state: { creds: {}, keys }, saveCreds: mocks.saveCreds });
    mocks.makeWASocket.mockReset();
    mocks.makeWASocket.mockImplementation(() => ({
      ev: {
        on: vi.fn((event: string, handler: Handler) => {
          if (event === 'connection.update') mocks.connectionHandlers.push(handler);
          if (event === 'creds.update') mocks.credsHandlers.push(handler);
        }),
      },
      end: vi.fn(),
      user: undefined,
    }));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    unhandled = [];
    onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function loadCli(): Promise<{ connection: Handler; creds: Handler }> {
    await import('../../src/transport/auth.ts');
    await settleTurns(2);
    const connection = mocks.connectionHandlers.at(-1);
    const creds = mocks.credsHandlers.at(-1);
    if (!connection || !creds) throw new Error('the pairing CLI registered no socket handlers');
    return { connection, creds };
  }

  it('prints connected only after a key write scheduled via process.nextTick after open has landed', async () => {
    const { connection } = await loadCli();
    let landed = false;
    let landedWhenConnected: boolean | undefined;
    vi.mocked(process.stdout.write).mockImplementation(((chunk: unknown) => {
      if (chunk === CONNECTED_LINE) landedWhenConnected = landed;
      return true;
    }) as typeof process.stdout.write);

    // socket.js CB:success order: emit 'open', then schedule the unawaited block.
    const opening = Promise.resolve(connection({ connection: 'open' }));
    process.nextTick(() => {
      void keys.set({ 'device-list': { '15550000003': ['7'] } }).then(() => { landed = true; });
    });
    await opening;

    expect(landedWhenConnected).toBe(true);
    expect(keys.data.get('device-list/15550000003')).toEqual(['7']);
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(errorLines()).toContainEqual(expect.stringContaining('Done. You can now start the bot.'));
  });

  it('exits 1 without connected when a pending credential save rejects', async () => {
    const { connection, creds } = await loadCli();
    const listenerSave = deferred<void>();
    // First call: the creds.update listener; later calls (the open branch) resolve.
    mocks.saveCreds.mockImplementationOnce(() => listenerSave.promise);
    await creds();

    const opening = Promise.resolve(connection({ connection: 'open' }));
    await settleTurns(3);
    expect(process.exit).not.toHaveBeenCalled();
    listenerSave.reject(new Error('ENOSPC: no space left on device'));
    await opening;

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(process.exit).not.toHaveBeenCalledWith(0);
    expect(connectedPrinted()).toBe(false);
    expect(errorLines()).toContainEqual(
      expect.stringContaining('pairing did not reach a durable state: creds-save-failed'),
    );
    expect(unhandled).toHaveLength(0);
  });

  it('exits 1 at the deadline, naming key-store quiescence, when a key write never resolves', async () => {
    keys.set = () => new Promise<void>(() => {});
    const { connection } = await loadCli();

    const opening = Promise.resolve(connection({ connection: 'open' }));
    process.nextTick(() => { void keys.set({ 'device-list': { '15550000003': ['7'] } }); });
    await settleTurns(5);
    expect(process.exit).not.toHaveBeenCalled();
    expect(connectedPrinted()).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    await opening;

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(connectedPrinted()).toBe(false);
    expect(errorLines()).toContainEqual(
      expect.stringContaining('pairing did not reach a durable state: key-store-quiescence'),
    );
    expect(errorLines().filter((l) => l.includes('Done. You can now start the bot.'))).toHaveLength(0);
  });

  it('does not open a second socket when the connection closes while the gate is waiting', async () => {
    keys.set = () => new Promise<void>(() => {});
    const { connection } = await loadCli();
    expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);

    const opening = Promise.resolve(connection({ connection: 'open' }));
    process.nextTick(() => { void keys.set({ 'device-list': { '15550000003': ['7'] } }); });
    await settleTurns(5);
    await connection({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    await settleTurns(3);

    expect(mocks.makeWASocket).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await opening;
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(connectedPrinted()).toBe(false);
  });
});
