import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const emitAlertMock = vi.hoisted(() => vi.fn((...args: unknown[]) => {
  void args;
  return true;
}));
const clearAlertSourceMock = vi.hoisted(() => vi.fn(() => true));
const { testAuthDir, testDataRoot, testRoot, testStateRoot } = vi.hoisted(() => {
  const testRoot = `/tmp/wa-test-latch-replay-${process.pid}`;
  return {
    testAuthDir: `${testRoot}/auth`,
    testDataRoot: `${testRoot}/data`,
    testRoot,
    testStateRoot: `${testRoot}/state`,
  };
});

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
    mediaDir: '/tmp/whatsoup-test-media-latch-replay/tmp',
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

vi.mock('../../src/core/retry.ts', () => ({
  jitteredDelay: (baseMs: number, attempt: number, maxMs: number = 30_000) => {
    const exp = baseMs * Math.pow(2, attempt);
    return Math.min(exp, maxMs);
  },
}));

vi.mock('../../src/logger.ts', async () => {
  const { loggerMock } = await import('../helpers/logger-mock.ts');
  return loggerMock();
});

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlert: emitAlertMock,
  emitAlertChecked: emitAlertMock,
  clearAlertSource: clearAlertSourceMock,
  clearAlertSourceChecked: clearAlertSourceMock,
}));

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';
import {
  appendLatchTransition,
  readTerminalLatchJournal,
  terminalLatchJournalPath,
  type LatchTransitionV1,
  type TerminalLatchV1,
} from '../../src/transport/terminal-latch.ts';
import {
  computeCredentialTreeDigest,
  persistAuthGenerationReceiptV2,
} from '../../src/transport/auth-generation-v2.ts';
import { parseAccountScopeId } from '../../src/transport/auth-custody-contracts.ts';

const SCOPE = parseAccountScopeId('scope:line-a-wa')!;
const EVIDENCE_DIGEST = 'f'.repeat(64);

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

function openEvent() {
  return { 'connection.update': { connection: 'open' } };
}

function deviceRemovedEvent() {
  return {
    'connection.update': {
      connection: 'close',
      lastDisconnect: {
        error: {
          output: { statusCode: 401 },
          data: {
            tag: 'stream:error',
            attrs: { code: '401' },
            content: [{ tag: 'conflict', attrs: { type: 'device_removed' } }],
          },
        },
      },
    },
  };
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

function latchFor(digest: string): TerminalLatchV1 {
  return {
    v: 1,
    scopeId: SCOPE,
    latchedGenerationId: null,
    latchedCredentialTreeDigest: digest,
    reason: 'serverside_logout_irreversible',
    evidenceDigest: EVIDENCE_DIGEST,
    latchedAt: '2026-08-18T12:00:00.000Z',
  };
}

function createdTransition(digest: string, revision = 1): LatchTransitionV1 {
  return {
    v: 1,
    scopeId: SCOPE,
    kind: 'latch_created',
    revision,
    expectedPriorRevision: revision - 1,
    at: '2026-08-18T12:00:00.000Z',
    operationId: `latch-op-${revision}`,
    ownerAuthorizationId: null,
    latch: latchFor(digest),
    supersededByGenerationId: null,
  };
}

/**
 * Establish the pre-incident world through the PRODUCTION constructor and
 * capture path: connect, open (auth-bond captures a backup of the tree),
 * terminal device_removed 401 (park). Returns the revoked tree's digest.
 */
async function establishRevokedGenerationWithBackup(): Promise<string> {
  writeValidTestAuth();
  const { mockSock, emit } = makeMockSocket();
  vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
  const manager = new ConnectionManager();
  await manager.connect();
  await emit(openEvent());
  const digest = computeCredentialTreeDigest(testAuthDir);
  if (!digest.ok) throw new Error('fixture digest unexpectedly failed');
  const latest = JSON.parse(
    readFileSync(join(testStateRoot, 'auth-bond-backups', 'WhatSoup', 'latest.json'), 'utf8'),
  );
  expect(typeof latest.backupPath).toBe('string');
  await emit(deviceRemovedEvent());
  vi.mocked(makeWASocket).mockClear();
  return digest.digest;
}

/** Operator quarantine: the revoked ACTIVE tree is renamed aside, read-only. */
function quarantineActiveTree(): string {
  const quarantinePath = `${testAuthDir}.revoked-test`;
  renameSync(testAuthDir, quarantinePath);
  chmodSync(quarantinePath, 0o500);
  return quarantinePath;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of [testAuthDir, `${testAuthDir}.revoked-test`]) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // fixture dir may not exist in this scenario
    }
  }
  rmSync(testRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
});

describe('terminal-latch enforcement at the restore seam (production constructor)', () => {
  it('with an ACTIVE latch, a quarantined tree and an unbound legacy backup are NOT restored and no socket is created', async () => {
    const revokedDigest = await establishRevokedGenerationWithBackup();
    quarantineActiveTree();

    const append = appendLatchTransition(testStateRoot, createdTransition(revokedDigest));
    expect(append.ok).toBe(true);

    const restarted = new ConnectionManager();
    await restarted.connect();

    // The replay this lane exists to prevent: the revoked snapshot must not be
    // copied back into the active auth directory...
    expect(existsSync(join(testAuthDir, 'creds.json'))).toBe(false);
    // ...and the runtime must not activate a socket on top of it.
    expect(vi.mocked(makeWASocket)).not.toHaveBeenCalled();
    // The hold is operator-visible, not silent.
    expect(
      emitAlertMock.mock.calls.some(call => call[1] === 'terminal_auth_latch_hold'),
    ).toBe(true);
  });

  it('with NO latch recorded, legacy restore behavior is preserved (compatibility pin)', async () => {
    await establishRevokedGenerationWithBackup();
    quarantineActiveTree();

    const restarted = new ConnectionManager();
    await restarted.connect();

    expect(existsSync(join(testAuthDir, 'creds.json'))).toBe(true);
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);
  });
});

describe('terminal-latch enforcement at the connect seam (production constructor)', () => {
  it('with an ACTIVE latch and the revoked tree still present, activation is refused', async () => {
    const revokedDigest = await establishRevokedGenerationWithBackup();

    const append = appendLatchTransition(testStateRoot, createdTransition(revokedDigest));
    expect(append.ok).toBe(true);

    const restarted = new ConnectionManager();
    await restarted.connect();

    expect(vi.mocked(makeWASocket)).not.toHaveBeenCalled();
    expect(
      emitAlertMock.mock.calls.some(call => call[1] === 'terminal_auth_latch_hold'),
    ).toBe(true);
  });

  it('with a CORRUPT latch journal, activation is refused (fail closed)', async () => {
    await establishRevokedGenerationWithBackup();
    writeFileSync(terminalLatchJournalPath(testStateRoot), 'garbage\n', { mode: 0o600 });

    const restarted = new ConnectionManager();
    await restarted.connect();

    expect(vi.mocked(makeWASocket)).not.toHaveBeenCalled();
  });

  it('an ACTIVE latch with a receipted newer tree still refuses until generation_superseded commits', async () => {
    const revokedDigest = await establishRevokedGenerationWithBackup();
    const append = appendLatchTransition(testStateRoot, createdTransition(revokedDigest));
    expect(append.ok).toBe(true);

    // A fresh generation was paired and receipted, but the supersession
    // transition has NOT been committed: activation must still refuse.
    rmSync(testAuthDir, { recursive: true, force: true });
    writeValidTestAuth('15551230005:1@s.whatsapp.net');
    const persisted = persistAuthGenerationReceiptV2({
      scopeId: SCOPE,
      operationId: 'op-fresh-generation',
      authDir: testAuthDir,
      stateRoot: testStateRoot,
      createdAtMs: Date.parse('2026-08-18T15:00:00.000Z'),
      persistedAtMs: Date.parse('2026-08-18T15:00:01.000Z'),
      effectiveClient: null,
      actorOperationId: null,
    });
    if (!persisted.ok) throw new Error(`fixture persist failed: ${persisted.failure}`);

    const restarted = new ConnectionManager();
    await restarted.connect();
    expect(vi.mocked(makeWASocket)).not.toHaveBeenCalled();
  });

  it('after generation_superseded commits for the bound receipt, activation proceeds', async () => {
    const revokedDigest = await establishRevokedGenerationWithBackup();
    const append = appendLatchTransition(testStateRoot, createdTransition(revokedDigest));
    expect(append.ok).toBe(true);

    rmSync(testAuthDir, { recursive: true, force: true });
    writeValidTestAuth('15551230005:1@s.whatsapp.net');
    const persisted = persistAuthGenerationReceiptV2({
      scopeId: SCOPE,
      operationId: 'op-fresh-generation',
      authDir: testAuthDir,
      stateRoot: testStateRoot,
      createdAtMs: Date.parse('2026-08-18T15:00:00.000Z'),
      persistedAtMs: Date.parse('2026-08-18T15:00:01.000Z'),
      effectiveClient: null,
      actorOperationId: null,
    });
    if (!persisted.ok) throw new Error(`fixture persist failed: ${persisted.failure}`);

    const superseded = appendLatchTransition(testStateRoot, {
      v: 1,
      scopeId: SCOPE,
      kind: 'generation_superseded',
      revision: 2,
      expectedPriorRevision: 1,
      at: '2026-08-18T15:00:02.000Z',
      operationId: 'op-supersede-1',
      ownerAuthorizationId: null,
      latch: null,
      supersededByGenerationId: persisted.receipt.generationId,
    });
    expect(superseded.ok).toBe(true);
    expect(readTerminalLatchJournal(testStateRoot).status).toBe('superseded');

    const { mockSock } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    const restarted = new ConnectionManager();
    await restarted.connect();
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);
  });

  it('a SUPERSEDED latch still activates after routine credential rotation of the fresh generation', async () => {
    const revokedDigest = await establishRevokedGenerationWithBackup();
    const append = appendLatchTransition(testStateRoot, createdTransition(revokedDigest));
    expect(append.ok).toBe(true);

    rmSync(testAuthDir, { recursive: true, force: true });
    writeValidTestAuth('15551230005:1@s.whatsapp.net');
    const persisted = persistAuthGenerationReceiptV2({
      scopeId: SCOPE,
      operationId: 'op-fresh-generation',
      authDir: testAuthDir,
      stateRoot: testStateRoot,
      createdAtMs: Date.parse('2026-08-18T15:00:00.000Z'),
      persistedAtMs: Date.parse('2026-08-18T15:00:01.000Z'),
      effectiveClient: null,
      actorOperationId: null,
    });
    if (!persisted.ok) throw new Error(`fixture persist failed: ${persisted.failure}`);
    const superseded = appendLatchTransition(testStateRoot, {
      v: 1,
      scopeId: SCOPE,
      kind: 'generation_superseded',
      revision: 2,
      expectedPriorRevision: 1,
      at: '2026-08-18T15:00:02.000Z',
      operationId: 'op-supersede-1',
      ownerAuthorizationId: null,
      latch: null,
      supersededByGenerationId: persisted.receipt.generationId,
    });
    expect(superseded.ok).toBe(true);

    // The session layer rewrites creds on every connection: the tree digest
    // drifts from the pairing-time receipt immediately. Rotation within the
    // superseding generation must NOT re-brick the line.
    writeFileSync(join(testAuthDir, 'creds.json'), JSON.stringify({ me: { id: '15551230005:2@s.whatsapp.net' } }));

    const { mockSock } = makeMockSocket();
    vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
    const restarted = new ConnectionManager();
    await restarted.connect();
    expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);
  });

  it('a SUPERSEDED latch refuses activation if the REVOKED tree reappears', async () => {
    const revokedDigest = await establishRevokedGenerationWithBackup();
    const savedRevokedTree = `${testAuthDir}.saved-revoked`;
    const append = appendLatchTransition(testStateRoot, createdTransition(revokedDigest));
    expect(append.ok).toBe(true);

    renameSync(testAuthDir, savedRevokedTree);
    writeValidTestAuth('15551230005:1@s.whatsapp.net');
    const persisted = persistAuthGenerationReceiptV2({
      scopeId: SCOPE,
      operationId: 'op-fresh-generation',
      authDir: testAuthDir,
      stateRoot: testStateRoot,
      createdAtMs: Date.parse('2026-08-18T15:00:00.000Z'),
      persistedAtMs: Date.parse('2026-08-18T15:00:01.000Z'),
      effectiveClient: null,
      actorOperationId: null,
    });
    if (!persisted.ok) throw new Error(`fixture persist failed: ${persisted.failure}`);
    const superseded = appendLatchTransition(testStateRoot, {
      v: 1,
      scopeId: SCOPE,
      kind: 'generation_superseded',
      revision: 2,
      expectedPriorRevision: 1,
      at: '2026-08-18T15:00:02.000Z',
      operationId: 'op-supersede-1',
      ownerAuthorizationId: null,
      latch: null,
      supersededByGenerationId: persisted.receipt.generationId,
    });
    expect(superseded.ok).toBe(true);

    // The exact revoked generation coming back (e.g. a copy-back mistake or
    // an out-of-band restore) is refused even though the latch is superseded.
    rmSync(testAuthDir, { recursive: true, force: true });
    renameSync(savedRevokedTree, testAuthDir);

    const restarted = new ConnectionManager();
    await restarted.connect();
    expect(vi.mocked(makeWASocket)).not.toHaveBeenCalled();
  });
});
