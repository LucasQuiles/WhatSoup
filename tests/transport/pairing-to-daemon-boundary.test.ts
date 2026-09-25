/**
 * S2/S3 acceptance — the pairing receipt must survive the process boundary.
 *
 * WHY THIS EXISTS. The first version of S2 recorded the pairing client into an
 * in-memory singleton inside `auth.ts`, which is a SHORT-LIVED CLI PROCESS that
 * calls `process.exit(0)` moments later. The only consumer is `connection.ts`, in a
 * separate daemon process started afterwards. No file, IPC, SSE payload, or database
 * row carried the receipt between them.
 *
 * So the receipt provably executed and provably never arrived. Deleting the call
 * site failed a test while the production outcome stayed absent — a test proving a
 * call happens inside one module graph is not a test that its value reaches a
 * consumer. That is the exact failure this file is written to prevent.
 *
 * WHAT THIS TEST COVERS, precisely: pairing writes a durable receipt to a real
 * filesystem, and a FRESH module graph — new singletons, as a new process would
 * have — reads it back and carries it onto a terminal bond event, together with the
 * runtime client receipt.
 *
 * WHAT IT DOES NOT COVER, stated so it is not mistaken for more: it does not fork a
 * real child process. `vi.resetModules()` gives the second stage new module
 * instances, which reproduces the part that broke (singletons do not survive), and
 * the carrier under test is a genuine file on disk. A true two-process test would
 * additionally cover argv/env/cwd differences, which this does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAIRING_STATE_ROOT = mkdtempSync(join(tmpdir(), 'wa-boundary-state-'));
const DAEMON_DATA_ROOT = mkdtempSync(join(tmpdir(), 'wa-boundary-data-'));

const mocks = vi.hoisted(() => ({
  makeWASocket: vi.fn(),
  useMultiFileAuthState: vi.fn(),
  existsSync: vi.fn(),
  saveCreds: vi.fn(),
  qrcodeGenerate: vi.fn(),
  connectionHandlers: [] as Array<(u?: unknown) => unknown>,
}));

const { mockConfig, logger } = vi.hoisted(() => {
  const log = { level: 'error', child: vi.fn(() => log) } as unknown as Record<
    string,
    ReturnType<typeof vi.fn>
  >;
  return {
    mockConfig: {
      adminPhones: new Set<string>(),
      authDir: '/tmp/wa-boundary-auth',
      stateRoot: '',
      dataRoot: '',
      lockPath: '/tmp/wa-boundary.lock',
      dbPath: ':memory:',
      mediaDir: '/tmp/wa-boundary-media',
      botName: 'WhatSoup',
      accessMode: 'allowlist',
      healthPort: 9090,
      autoTyping: 'off' as const,
      generateHighQualityLinkPreview: false,
      maxExhaustionCycles: 99,
      models: {
        conversation: 'claude-opus-4-5',
        extraction: 'claude-haiku-4-5',
        validation: 'claude-haiku-4-5',
        fallback: 'claude-sonnet-4-5',
      },
    },
    logger: log,
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: mocks.existsSync };
});

vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: mocks.makeWASocket,
  useMultiFileAuthState: mocks.useMultiFileAuthState,
  fetchLatestBaileysVersion: vi
    .fn()
    .mockResolvedValue({ version: [2, 3000, 1043857760], isLatest: true }),
  makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
  DisconnectReason: { loggedOut: 401, restartRequired: 515, 401: 'loggedOut', 515: 'restartRequired' },
  jidNormalizedUser: (j: string) => j,
  Browsers: { macOS: () => ['Mac OS', 'Chrome', '14.4.1'] },
}));

vi.mock('qrcode-terminal', () => ({ default: { generate: mocks.qrcodeGenerate } }));
vi.mock('../../src/config.ts', () => ({ config: mockConfig }));
vi.mock('../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../helpers/logger-mock.ts');
  Object.assign(logger, singletonLoggerMock(), { fatal: vi.fn() });
  return { createChildLogger: () => logger };
});
vi.mock('../../src/transport/third-party-console-redaction.ts', () => ({
  installThirdPartyConsoleRedaction: vi.fn(),
}));
vi.mock('../../src/transport/atomic-auth-save.ts', () => ({
  createAtomicCredsSaver: vi.fn(() => mocks.saveCreds),
}));
vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('S2/S3 — pairing receipt crosses the process boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    mockConfig.stateRoot = PAIRING_STATE_ROOT;
    mockConfig.dataRoot = DAEMON_DATA_ROOT;
    mocks.connectionHandlers.length = 0;
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
    mocks.makeWASocket.mockImplementation(() => ({
      ev: {
        on: vi.fn((event: string, handler: (u?: unknown) => unknown) => {
          if (event === 'connection.update') mocks.connectionHandlers.push(handler);
        }),
      },
      end: vi.fn(),
      user: { id: '15550000003@s.whatsapp.net' },
    }));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** STAGE 1 — the pairing process: pair, then let it "exit". */
  async function runPairing(): Promise<void> {
    await import('../../src/transport/auth.ts');
    await flush();
    const handler = mocks.connectionHandlers.at(-1);
    if (!handler) throw new Error('no connection.update handler registered by the pairing CLI');
    await handler({ connection: 'open' });
    await flush();
  }

  it('persists the generation and pairing client to disk, not just to memory', async () => {
    await runPairing();

    const receiptPath = join(PAIRING_STATE_ROOT, 'auth-generation.json');
    // NOT existsSync: this file mocks node:fs's existsSync for auth.ts, so calling it
    // here would read the mock's `false` and the assertion would lie about the
    // filesystem. readFileSync is the real implementation (the mock spreads actual),
    // so a genuinely missing file throws ENOENT and this reports it as such.
    let raw: string;
    try {
      raw = readFileSync(receiptPath, 'utf8');
    } catch (err) {
      throw new Error(
        `pairing must leave a durable receipt at ${receiptPath}, but reading it failed: ${String(err)}`,
      );
    }
    const persisted = JSON.parse(raw) as Record<string, unknown>;
    expect(persisted['bondCreatedAt']).toEqual(expect.any(String));
    const pairingClient = persisted['pairingClient'] as Record<string, unknown> | null;
    expect(pairingClient, 'the pairing client must be persisted, not left in memory').not.toBeNull();
    expect(pairingClient!['callSite']).toBe('pairing_cli');
    expect(pairingClient!['protocolVersion']).toBe('2.3000.1043857760');

    // Privacy: the durable carrier must not contain the raw account identity.
    expect(raw).not.toContain('15550000003');
  });

  it('a FRESH module graph carries both receipts onto a terminal bond event', async () => {
    await runPairing();

    // Simulate the daemon: brand-new module instances, so every in-memory singleton
    // the pairing process populated is gone — exactly what a new process gets.
    vi.resetModules();

    const { ConnectionManager } = await import('../../src/transport/connection.ts');
    const { effectiveClientRegistry } = await import(
      '../../src/transport/effective-client-receipt.ts'
    );

    // Non-vacuity: the runtime registry must genuinely be empty at this point, or
    // this test would be reading leftovers from stage 1 rather than the file.
    expect(
      effectiveClientRegistry.current(),
      'the daemon-side registry must start empty, else the boundary is not being tested',
    ).toBeNull();

    const manager = new ConnectionManager();
    (
      manager as unknown as {
        recordCredentialLifecycle: (event: string, detail?: unknown) => void;
      }
    ).recordCredentialLifecycle('device_bond_lost');

    const lines = readFileSync(join(DAEMON_DATA_ROOT, 'bond-events.ndjson'), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const event = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;

    // The generation, read back across the boundary from the file.
    const gen = event['authGeneration'] as Record<string, unknown>;
    expect(gen['status']).toBe('recorded');
    const receipt = gen['receipt'] as Record<string, unknown>;
    expect(receipt['bondCreatedAt']).toEqual(expect.any(String));
    expect(receipt['generationId']).toEqual(expect.any(String));

    // …carrying the client that ESTABLISHED the bond. This is the join that was
    // impossible before: pairing-time client vs. the client running at death.
    const pairingClient = receipt['pairingClient'] as Record<string, unknown> | null;
    expect(pairingClient, 'the terminal event must carry the pairing client').not.toBeNull();
    expect(pairingClient!['callSite']).toBe('pairing_cli');

    // The daemon never opened a socket here, so its own runtime client is honestly
    // unavailable rather than borrowed from the pairing receipt.
    expect(event['effectiveClient']).toEqual({
      status: 'unavailable',
      version: 1,
      reason: 'not_recorded',
    });
  });
});
