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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    // That cold read started a walk. Let it finish here rather than letting it
    // run into the next beforeEach, which removes the fixture underneath it.
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    expect(manager.getHealthConnectionState().authBond?.treeProvenance?.source).toBe('cached');
  });

  it('keeps the delivery gate live even while the cached projection is unknown', () => {
    const manager = new ConnectionManager();

    // Same instant, same instance, two different questions.
    const health = manager.getHealthConnectionState();
    const live = manager.getConnectionState();

    expect(health.authBond?.status).toBe('unknown');
    expect(live.authBond?.status).toBe('present');
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
