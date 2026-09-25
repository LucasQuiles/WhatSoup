/**
 * S2 — the pairing CLI must emit its own effective-client receipt.
 *
 * This test exists because the first version of the S2 suite did NOT prove it.
 * Deleting the `effectiveClientRegistry.record(...)` call from
 * `src/transport/auth.ts` left that suite fully green (13/13), because it only
 * exercised `buildEffectiveClientReceipt(..., 'pairing_cli')` directly — a
 * hand-written stand-in, not the production wiring. That is the same semantic
 * coverage gap that let a health-poller emitter deletion pass 28/28 earlier in this
 * programme, and the plan's own verifier names the falsifier explicitly: "Both
 * socket paths emit it — remove either call site."
 *
 * `auth.ts` has no exports; it runs on import. So this drives it the way the
 * existing auth-cli tests do, and then asserts the registry was populated by the
 * real code path.
 *
 * It also pins the FORM of divergence that motivates S2: the pairing CLI hard-codes
 * `generateHighQualityLinkPreview: false` while `connection.ts` passes the configured
 * value. The two are independently maintained and can drift on any field with nothing
 * detecting it — though for `q` the observed values agree, since the runtime config
 * defaults that field to false too. The gap being closed is the missing record, not a
 * demonstrated difference.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (update?: unknown) => unknown | Promise<unknown>;

const mocks = vi.hoisted(() => ({
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
  // isLatest: false — the fallback shape. It must reach the receipt as
  // `bundled_fallback`, never as a success.
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({
    version: [2, 3000, 1015901307],
    isLatest: false,
    error: new TypeError('fetch failed'),
  }),
  makeCacheableSignalKeyStore: vi.fn().mockReturnValue({}),
  DisconnectReason: {
    loggedOut: 401,
    restartRequired: 515,
    401: 'loggedOut',
    515: 'restartRequired',
  },
}));

vi.mock('qrcode-terminal', () => ({ default: { generate: mocks.qrcodeGenerate } }));

vi.mock('../../src/config.ts', () => ({
  config: {
    authDir: '/tmp/wa-test-auth-effective-client-pairing',
    lockPath: '/tmp/wa-test-auth-effective-client-pairing.lock',
  },
}));

vi.mock('../../src/transport/third-party-console-redaction.ts', () => ({
  installThirdPartyConsoleRedaction: vi.fn(),
}));

vi.mock('../../src/transport/atomic-auth-save.ts', () => ({
  createAtomicCredsSaver: vi.fn(() => mocks.saveCreds),
}));

import type { EffectiveClientReceipt } from '../../src/transport/effective-client-receipt.ts';

/**
 * Import the pairing CLI, then read the registry FROM THE SAME MODULE GRAPH.
 *
 * `vi.resetModules()` gives `auth.ts` a fresh instance of every module it imports,
 * including `effective-client-receipt.ts`. A statically imported registry is a
 * DIFFERENT singleton, so it stays empty no matter how correct the production
 * wiring is — the first version of this test failed for exactly that reason, not
 * because the code was wrong. Resolving it dynamically after the import lands on
 * the instance `auth.ts` actually wrote to.
 */
async function runPairingCliAndReadReceipt(): Promise<EffectiveClientReceipt | null> {
  await import('../../src/transport/auth.ts');
  await flushPromises();
  const mod = await import('../../src/transport/effective-client-receipt.ts');
  return mod.effectiveClientRegistry.current();
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('S2 — pairing CLI effective-client receipt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
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
      ev: { on: vi.fn() },
      end: vi.fn(),
      user: undefined,
    }));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('records a pairing_cli receipt from the real call site', async () => {
    const receipt = await runPairingCliAndReadReceipt();

    // Non-vacuity: the CLI must actually have built a socket, else this asserts
    // nothing about a receipt.
    expect(mocks.makeWASocket, 'the pairing CLI must have built a socket').toHaveBeenCalledTimes(
      1,
    );

    expect(receipt, 'the pairing CLI must have recorded a receipt').not.toBeNull();
    expect(receipt!.callSite).toBe('pairing_cli');
  });

  it('describes the socket the CLI actually built, including its divergence', async () => {
    const receipt = await runPairingCliAndReadReceipt();
    const passed = mocks.makeWASocket.mock.calls[0]![0] as Record<string, unknown>;
    expect(receipt).not.toBeNull();

    // The receipt must agree with what was really handed to makeWASocket — this is
    // the property that makes deriving-from-config worth doing.
    expect(receipt!.protocolVersionTuple).toEqual(passed['version']);
    expect(receipt!.protocolVersion).toBe('2.3000.1015901307');

    // The documented divergence from connection.ts: hard-coded false, explicitly.
    expect(receipt!.generateHighQualityLinkPreview).toEqual({
      value: false,
      provenance: 'explicit',
    });

    // Silently inherited library defaults, visible as such.
    expect(receipt!.syncFullHistory).toEqual({ value: true, provenance: 'library_default' });
    expect(receipt!.markOnlineOnConnect).toEqual({ value: true, provenance: 'library_default' });
  });

  it('records NOTHING when socket construction fails', async () => {
    // The ordering falsifier. Recording before makeWASocket() returns would log an
    // ATTEMPTED configuration as an effective client, so a later bond event would
    // name a client that never existed. Both orderings agree on the happy path —
    // only a throwing constructor separates them.
    mocks.makeWASocket.mockImplementation(() => {
      throw new Error('socket construction failed');
    });
    const receipt = await runPairingCliAndReadReceipt();
    expect({
      constructionAttempts: mocks.makeWASocket.mock.calls.length,
      recordedReceipt: receipt,
    }).toEqual({
      constructionAttempts: 1,
      recordedReceipt: null,
    });
  });

  it('carries honest provenance — a failed fetch is not reported as latest', async () => {
    const receipt = await runPairingCliAndReadReceipt();
    expect(receipt).not.toBeNull();
    expect(receipt!.protocolVersionSource).toBe('bundled_fallback');
    expect(receipt!.protocolVersionIsLatest).toBe(false);
    expect(receipt!.protocolVersionFetchErrorClass).toBe('TypeError');
    expect(JSON.stringify(receipt)).not.toContain('fetch failed');
  });
});
