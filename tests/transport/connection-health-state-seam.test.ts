/**
 * P42 review r2 / HIGH-1 — the cached auth digest must not escape /health.
 *
 * getConnectionState() is a delivery-gate input: src/core/scheduler.ts uses it
 * to decide whether a disconnected instance is de-linked, and holds scheduled
 * rows when it is. An earlier revision of this branch switched that getter
 * wholesale to the cached projection, so a stale-clean digest could let a
 * de-linked instance burn its retry budget on rows the live check preserved.
 *
 * These tests pin the split at the production seam, not at the guard: they call
 * ConnectionManager's own methods, so reverting the one-line change in
 * connection.ts fails them.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureRoot = mkdtempSync(join(tmpdir(), 'whatsoup-p42-seam-'));
const fixtureAuthDir = join(fixtureRoot, 'auth');

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    adminPhones: new Set<string>(),
    authDir: '',
    stateRoot: '',
    dbPath: ':memory:',
    mediaDir: '/tmp/whatsoup-test-media-p42-seam/tmp',
    botName: 'p42-seam',
    accessMode: 'allowlist',
    healthPort: 9097,
    autoTyping: 'off' as const,
    generateHighQualityLinkPreview: false,
    maxExhaustionCycles: 99,
    authBondAutoRestore: false,
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}));

vi.mock('../../src/config.ts', () => ({ config: mockConfig }));
vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  // atomic-auth-save serialises creds through BufferJSON, which the shared
  // helper mock does not export. Identity replacer/reviver is enough here: the
  // fixtures carry no Buffers, and the assertion is about WHEN the commit hook
  // runs, not about Buffer encoding.
  return { ...baileysMock(), BufferJSON: { replacer: undefined, reviver: undefined } };
});
vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return { createChildLogger: () => loggerMock().createChildLogger() };
});
vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: vi.fn(() => true),
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
  clearAlertSource: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import { makeWASocket, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { createAtomicCredsSaver } from '../../src/transport/atomic-auth-save.ts';

function writeAuthFixture(): void {
  rmSync(fixtureAuthDir, { recursive: true, force: true });
  mkdirSync(fixtureAuthDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(fixtureAuthDir, 'creds.json'), JSON.stringify({
    me: { id: '15550100001:1@s.whatsapp.net', lid: '12345:1@lid' },
    registrationId: 1,
  }), { mode: 0o600 });
  for (let i = 0; i < 8; i += 1) {
    writeFileSync(join(fixtureAuthDir, `pre-key-${i}.json`), JSON.stringify({ keyId: i }), { mode: 0o600 });
  }
}

beforeEach(() => {
  mockConfig.authDir = fixtureAuthDir;
  mockConfig.stateRoot = join(fixtureRoot, 'state');
  writeAuthFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The fixture root was created with mkdtempSync and never removed.
afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/**
 * Drain a background walk by waiting for it to land, not by sleeping a guess.
 *
 * Bounded so a genuine failure to converge still fails the test rather than
 * hanging, but it returns the moment the digest is published — no fixed wall
 * time, which is what makes it safe on a loaded worker.
 */
async function settleDigest(read: () => string | undefined, boundMs = 5_000): Promise<string | undefined> {
  const deadline = Date.now() + boundMs;
  let seen = read();
  while (seen !== 'cached' && Date.now() < deadline) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    seen = read();
  }
  return seen;
}

/**
 * Drain a walk a test started, without waiting for it to PUBLISH.
 *
 * settleDigest is the right tool when the published digest IS the subject. It
 * is the wrong tool for teardown: after an invalidation inside the refresh
 * floor the next walk is a queued successor seconds away, so waiting for
 * `cached` would turn cleanup into a real sleep. This waits only for the thing
 * the fixture removal actually races — a walk still traversing the tree — and
 * returns it so a failure to drain fails the test instead of leaking into the
 * next one.
 */
async function settleWalkInFlight(
  read: () => boolean | undefined,
  boundMs = 5_000,
): Promise<boolean | undefined> {
  const deadline = Date.now() + boundMs;
  let inFlight = read();
  while (inFlight === true && Date.now() < deadline) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    inFlight = read();
  }
  return inFlight;
}

/**
 * Build a key store the wrapper can actually wrap; the shared helper returns {}.
 *
 * The original `set` is handed back separately because the wrapper replaces the
 * member IN PLACE, so after wiring `store.set` is the wrapper and no longer the
 * function installed here.
 */
function installKeyStore(): {
  store: Record<string, unknown>;
  originalSet: ReturnType<typeof vi.fn>;
} {
  const originalSet = vi.fn(async () => undefined);
  const store: Record<string, unknown> = {
    get: vi.fn(async () => ({})),
    set: originalSet,
    clear: vi.fn(async () => undefined),
  };
  vi.mocked(makeCacheableSignalKeyStore).mockReturnValue(store as never);
  return { store, originalSet };
}

function makeConnectableSocket() {
  let handler: ((events: Record<string, unknown>) => void) | undefined;
  const sock = {
    ev: { process: vi.fn((cb: (events: Record<string, unknown>) => void) => { handler = cb; }) },
    sendMessage: vi.fn(),
    sendPresenceUpdate: vi.fn(async () => undefined),
    query: vi.fn(async () => ({})),
    end: vi.fn(),
    ws: { isOpen: true },
    user: { id: '15551230004:1@s.whatsapp.net', lid: '111:1@lid', name: 'seam' },
  };
  vi.mocked(makeWASocket).mockReturnValue(sock as never);
  return { sock, emit: (events: Record<string, unknown>) => handler?.(events) };
}

describe('ConnectionManager — live gate vs cached health projection', () => {
  it('serves getConnectionState live, with no cache provenance, before any warm', () => {
    const manager = new ConnectionManager();

    const live = manager.getConnectionState();

    // A live inspection walks the tree on the spot: a digest exists even though
    // nothing warmed a cache, and there is no provenance because nothing was
    // served from one. Pointing this getter at the cache fails both.
    expect(live.authBond?.treeProvenance).toBeUndefined();
    expect(live.authBond?.treeHash).toHaveLength(64);
    expect(live.authBond?.status).toBe('present');
  });

  it('serves getHealthConnectionState from the cache, reporting provenance', async () => {
    const manager = new ConnectionManager();

    const health = manager.getHealthConnectionState();

    // Nothing has warmed the cache, so the observability projection must say so
    // rather than pay for a walk.
    expect(health.authBond?.treeProvenance).toBeDefined();
    expect(health.authBond?.treeProvenance?.source).toBe('absent');
    expect(health.authBond?.treeHash).toBeNull();
    // And it must not read as a clean tree.
    expect(health.authBond?.status).toBe('unknown');

    // That cold read started a walk. Drain it here rather than letting it run
    // into the next beforeEach, which removes the fixture underneath it.
    const settled = await settleDigest(
      () => manager.getHealthConnectionState().authBond?.treeProvenance?.source,
    );
    expect(settled).toBe('cached');
  });

  it('keeps the delivery gate live even while the cached projection is unknown', async () => {
    const manager = new ConnectionManager();

    // Same instant, same instance, two different questions.
    const health = manager.getHealthConnectionState();
    const live = manager.getConnectionState();

    expect(health.authBond?.status).toBe('unknown');
    expect(live.authBond?.status).toBe('present');

    // The cached read above found no observation and started a walk. afterAll
    // removes fixtureRoot, so drain it rather than leaving it traversing a
    // tree that is about to be deleted.
    expect(await settleWalkInFlight(
      () => manager.getHealthConnectionState().authBond?.treeProvenance?.refreshInFlight,
    )).toBe(false);
  });
});

describe('MED-4 — invalidation hangs off the write, not off an event name', () => {
  it('fires the credential commit hook at the rename, with the new bytes already visible', async () => {
    const dir = join(fixtureRoot, 'saver');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const credsPath = join(dir, 'creds.json');

    let creds = { me: { id: 'first:1@s.whatsapp.net' } };
    const seenAtCommit: string[] = [];
    const save = createAtomicCredsSaver(dir, () => creds, () => {
      // The hook's whole purpose is that the bytes are already committed when
      // it runs. Reading here is the assertion: firing after the promise
      // settled would also see them, but firing before the rename would not.
      seenAtCommit.push(readFileSync(credsPath, 'utf8'));
    });

    await save();
    expect(seenAtCommit).toHaveLength(1);
    expect(seenAtCommit[0]).toContain('first:1@s.whatsapp.net');

    creds = { me: { id: 'second:1@s.whatsapp.net' } };
    await save();
    expect(seenAtCommit).toHaveLength(2);
    expect(seenAtCommit[1]).toContain('second:1@s.whatsapp.net');

    rmSync(dir, { recursive: true, force: true });
  });

  it('does not let a hook failure break a credential save', async () => {
    const dir = join(fixtureRoot, 'saver-throws');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const save = createAtomicCredsSaver(
      dir,
      () => ({ me: { id: 'x:1@s.whatsapp.net' } }),
      () => { throw new Error('observer exploded'); },
    );

    // The write already succeeded by the time the hook runs; letting the hook
    // reject would turn a completed credential save into a reported failure.
    await expect(save()).resolves.toBeUndefined();
    expect(readFileSync(join(dir, 'creds.json'), 'utf8')).toContain('x:1@s.whatsapp.net');

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('r3 SHOULD-3 — the two production wiring lines are exercised', () => {
  it('invalidates the digest when Baileys writes through the configured key store', async () => {
    const { store, originalSet } = installKeyStore();
    makeConnectableSocket();
    const manager = new ConnectionManager();
    await manager.connect();

    // Read the store off the socket config the manager actually built. The
    // wrapper replaces `set` in place, so wrapping shows up as the member no
    // longer being the function we installed. Deleting the invalidatingKeyStore
    // call in connection.ts leaves it unwrapped and both assertions fail.
    const configured = vi.mocked(makeWASocket).mock.calls[0]![0] as {
      auth: { keys: { set: (data: unknown) => Promise<void> } };
    };
    expect(configured.auth.keys).toBe(store);
    expect(store['set']).not.toBe(originalSet);

    await configured.auth.keys.set({ 'pre-key': { 1: { public: 'x' } } });

    // The underlying write still happens; the wrapper only observes it.
    expect(originalSet).toHaveBeenCalledTimes(1);
    expect(
      manager.getHealthConnectionState().authBond?.treeProvenance?.lastInvalidationReason,
    ).toBe('key-store-set');

    // The invalidation reason is set synchronously, so the assertion above can
    // pass while the walk it triggered is still running. Drain it.
    expect(await settleWalkInFlight(
      () => manager.getHealthConnectionState().authBond?.treeProvenance?.refreshInFlight,
    )).toBe(false);
  });

  it('invalidates the digest when the credential saver commits', async () => {
    installKeyStore();
    const { emit } = makeConnectableSocket();
    const manager = new ConnectionManager();
    await manager.connect();

    // Drive the real creds.update path. The manager passes its own commit hook
    // as the saver's third argument; removing that argument leaves the reason
    // untouched and this fails.
    emit({ 'creds.update': [{}] });
    const deadline = Date.now() + 2_000;
    let reason = manager.getHealthConnectionState().authBond?.treeProvenance?.lastInvalidationReason;
    while (reason !== 'creds-file-committed' && Date.now() < deadline) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      reason = manager.getHealthConnectionState().authBond?.treeProvenance?.lastInvalidationReason;
    }

    expect(reason).toBe('creds-file-committed');

    // Same shape as above, plus the emit() handler's own promise, which this
    // test does not hold: the commit fires the invalidation, and the walk it
    // starts outlives the assertion unless it is drained here.
    expect(await settleWalkInFlight(
      () => manager.getHealthConnectionState().authBond?.treeProvenance?.refreshInFlight,
    )).toBe(false);
  });
});
