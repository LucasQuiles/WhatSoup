import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthBondCaptureResult, AuthBondRestoreResult, AuthBondSnapshot } from '../../src/transport/auth-bond.ts';

type AuthBondSnapshotOverrides = Partial<Omit<AuthBondSnapshot, 'authDir' | 'creds' | 'backup'>> & {
  authDir?: Partial<AuthBondSnapshot['authDir']>;
  creds?: Partial<AuthBondSnapshot['creds']>;
  backup?: Partial<AuthBondSnapshot['backup']>;
};

const { mockConfig, mockAuth, alertCalls, clearCalls, logger } = vi.hoisted(() => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    level: 'error',
    child: vi.fn(() => log),
  };
  return {
    mockConfig: {
      adminPhones: new Set<string>(),
      authDir: '/tmp/wa-test-auth-bond-edge',
      stateRoot: '/tmp/wa-test-auth-bond-edge-state',
      dataRoot: '/tmp/wa-test-auth-bond-edge-data',
      lockPath: '/tmp/wa-test-auth-bond-edge.lock',
      dbPath: ':memory:',
      mediaDir: '/tmp',
      botName: 'WhatSoup',
      accessMode: 'allowlist',
      healthPort: 9090,
      autoTyping: 'off' as 'off' | 'composing' | 'recording',
      generateHighQualityLinkPreview: false,
      maxExhaustionCycles: 99,
      models: {
        conversation: 'claude-opus-4-5',
        extraction: 'claude-haiku-4-5',
        validation: 'claude-haiku-4-5',
        fallback: 'claude-sonnet-4-5',
      },
    },
    mockAuth: {
      snapshot: null as AuthBondSnapshot | null,
      restore: null as AuthBondRestoreResult | null,
      capture: null as AuthBondCaptureResult | null,
    },
    alertCalls: [] as unknown[][],
    clearCalls: [] as unknown[][],
    logger: log,
  };
});

vi.mock('@whiskeysockets/baileys', async () => {
  const { baileysMock } = await import('../helpers/baileys-mock.ts');
  return baileysMock();
});

vi.mock('../../src/config.ts', () => ({ config: mockConfig }));

vi.mock('../../src/logger.ts', () => ({ createChildLogger: () => logger }));

vi.mock('../../src/core/retry.ts', () => ({
  jitteredDelay: (baseMs: number, attempt: number, maxMs = 30_000) => {
    const exp = baseMs * Math.pow(2, attempt);
    return Math.min(exp, maxMs);
  },
}));

vi.mock('../../src/transport/auth-bond.ts', () => ({
  AuthBondGuard: vi.fn(function () {
    return {
      inspect: vi.fn(() => mockAuth.snapshot),
      restoreLatestIfNeeded: vi.fn(() => mockAuth.restore ?? {
        attempted: false,
        restored: false,
        source: null,
        snapshot: mockAuth.snapshot,
        error: null,
      }),
      capture: vi.fn(() => mockAuth.capture ?? {
        ok: true,
        snapshot: mockAuth.snapshot,
        captured: false,
        deferred: false,
        path: null,
        error: null,
      }),
    };
  }),
}));

vi.mock('../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn((...args: unknown[]) => {
    alertCalls.push(args);
    return true;
  }),
  clearAlertSourceChecked: vi.fn((...args: unknown[]) => {
    clearCalls.push(args);
    return true;
  }),
}));

import { makeWASocket } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';

function makeSnapshot(overrides: AuthBondSnapshotOverrides = {}): AuthBondSnapshot {
  const snapshot: AuthBondSnapshot = {
    status: 'present',
    authDir: {
      path: mockConfig.authDir,
      exists: true,
      mode: '700',
      size: 128,
      mtime: '2026-07-01T00:00:00.000Z',
      sha256: 'auth-dir-hash',
    },
    creds: {
      path: `${mockConfig.authDir}/creds.json`,
      exists: true,
      mode: '600',
      size: 2048,
      mtime: '2026-07-01T00:00:00.000Z',
      sha256: 'a'.repeat(64),
    },
    meHash: 'me-hash',
    treeHash: 'tree-hash',
    backup: {
      root: `${mockConfig.stateRoot}/auth-backups`,
      latest: '/tmp/auth-backup/latest',
      latestAt: '2026-07-01T00:00:00.000Z',
      latestReason: 'test',
      latestTreeHash: 'backup-tree-hash',
      lastCaptureAt: null,
      lastCaptureReason: null,
      lastCaptureError: null,
      lastCaptureDeferredAt: null,
      lastCaptureDeferredReason: null,
      lastCaptureDeferredAgeMs: null,
      lastRestoreAt: null,
      lastRestoreSource: null,
      lastRestoreError: null,
    },
    issues: [],
  };
  return {
    ...snapshot,
    ...overrides,
    authDir: { ...snapshot.authDir, ...overrides.authDir },
    creds: { ...snapshot.creds, ...overrides.creds },
    backup: { ...snapshot.backup, ...overrides.backup },
    issues: overrides.issues ?? snapshot.issues,
  };
}

function makeMockSocket() {
  let evProcessCallback: ((events: Record<string, unknown>) => void) | undefined;
  const mockSock = {
    ev: {
      process: vi.fn((cb: (events: Record<string, unknown>) => void) => {
        evProcessCallback = cb;
      }),
    },
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wamid.0001' } }),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    rejectCall: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({}),
    end: vi.fn(),
    ws: { isOpen: true },
    user: {
      id: '15551230004:1@s.whatsapp.net',
      lid: '81536414179557:2@lid',
      name: 'WhatSoup',
    },
  };
  return {
    mockSock,
    emit(events: Record<string, unknown>) {
      if (!evProcessCallback) throw new Error('ev.process callback not registered');
      evProcessCallback(events);
    },
  };
}

async function connectRegistered() {
  const { mockSock, emit } = makeMockSocket();
  vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
  const manager = new ConnectionManager();
  await manager.connect();
  return { manager, mockSock, emit };
}

function latestCriticalAsset() {
  const call = alertCalls.at(-1);
  if (!call) throw new Error('no alert emitted');
  return call[5] as { failure: { code: string; recoverability: string; confidence: string } };
}

function openEvent() {
  return { 'connection.update': { connection: 'open' } };
}

function closeEvent(statusCode: number) {
  return { 'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode } } } } };
}

function clearCandidate(messageId = 'wamid.clear') {
  return {
    operation: 'sendMessage',
    messageId,
    submittedAt: Date.now(),
  };
}

function clearProof(messageId = 'wamid.clear') {
  return {
    source: 'receipt_update',
    messageId,
    recipientJid: '15550100001@s.whatsapp.net',
    confirmedAt: Date.now(),
  };
}

function lifecycleEventCount(manager: ConnectionManager, event: string): number {
  return manager.getConnectionState().credentialLifecycle.recentEvents
    .filter(entry => entry.event === event)
    .length;
}

beforeEach(() => {
  vi.clearAllMocks();
  alertCalls.length = 0;
  clearCalls.length = 0;
  mockAuth.snapshot = makeSnapshot();
  mockAuth.restore = null;
  mockAuth.capture = null;
});

describe('ConnectionManager auth-bond edge coverage', () => {
  it('records a successful auth-bond restore before creating the socket', async () => {
    const snapshot = makeSnapshot();
    mockAuth.snapshot = snapshot;
    mockAuth.restore = {
      attempted: true,
      restored: true,
      source: '/tmp/auth-backup/latest',
      snapshot,
      error: null,
    };

    const { manager } = await connectRegistered();
    const events = manager.getConnectionState().credentialLifecycle.recentEvents;

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'auth_restore_succeeded',
        note: '/tmp/auth-backup/latest',
      }),
    ]));
    expect(logger.warn).toHaveBeenCalledWith(
      { source: '/tmp/auth-backup/latest' },
      'auth bond restored from protected local snapshot',
    );
  });

  it('classifies a missing local auth bond with a backup as restorable', async () => {
    mockAuth.snapshot = makeSnapshot({
      status: 'missing',
      authDir: { exists: false, mode: null, size: null, mtime: null, sha256: null },
      creds: { exists: false, mode: null, size: null, mtime: null, sha256: null },
      issues: ['missing auth directory'],
    });
    const { emit } = await connectRegistered();

    emit({ 'connection.update': { qr: 'pairing-required' } });

    expect(latestCriticalAsset().failure.code).toBe('WA_AUTH_BOND_LOCAL_MISSING_RESTORABLE');
    expect(latestCriticalAsset().failure.recoverability).toBe('auto_recoverable');
  });

  it('classifies capture failures as manual repair even when a backup exists', async () => {
    const snapshot = makeSnapshot({
      status: 'invalid',
      backup: { lastCaptureError: 'capture failed' },
      issues: ['capture failed'],
    });
    mockAuth.snapshot = snapshot;
    mockAuth.capture = {
      ok: false,
      snapshot,
      captured: false,
      deferred: false,
      path: null,
      error: 'capture failed',
    };
    const { emit } = await connectRegistered();

    emit({ 'connection.update': { connection: 'open' } });

    expect(latestCriticalAsset().failure.code).toBe('WA_AUTH_BOND_SNAPSHOT_CAPTURE_FAILED');
    expect(latestCriticalAsset().failure.recoverability).toBe('manual_repair_required');
  });

  it('classifies local auth permission drift separately from generic corruption', async () => {
    mockAuth.snapshot = makeSnapshot({
      status: 'invalid',
      backup: { latest: null, latestAt: null },
      issues: ['permission mode drift'],
    });
    const { emit } = await connectRegistered();

    emit({ 'connection.update': { qr: 'pairing-required' } });

    expect(latestCriticalAsset().failure.code).toBe('WA_AUTH_BOND_PERMISSION_DRIFT');
    expect(latestCriticalAsset().failure.confidence).toBe('confirmed');
  });

  it('classifies local auth corruption with a backup as restorable', async () => {
    mockAuth.snapshot = makeSnapshot({
      status: 'invalid',
      issues: ['creds json corrupt'],
    });
    const { emit } = await connectRegistered();

    emit({ 'connection.update': { qr: 'pairing-required' } });

    expect(latestCriticalAsset().failure.code).toBe('WA_AUTH_BOND_LOCAL_CORRUPT_RESTORABLE');
    expect(latestCriticalAsset().failure.recoverability).toBe('auto_recoverable');
  });

  it('swallows listener errors inside each Baileys event block', async () => {
    const cases: Array<{
      eventName: string;
      listenerName: string;
      payload: Record<string, unknown>;
    }> = [
      {
        eventName: 'message-receipt.update',
        listenerName: 'receiptUpdate',
        payload: {
          'message-receipt.update': [{
            key: { id: 'wamid.receipt' },
            receipt: { userJid: '15550100001@s.whatsapp.net', receiptTimestamp: 1_780_000_000 },
          }],
        },
      },
      {
        eventName: 'messages.media-update',
        listenerName: 'mediaUpdate',
        payload: { 'messages.media-update': [{ key: { id: 'wamid.media' }, update: { status: 'uploaded' } }] },
      },
      {
        eventName: 'chats.upsert',
        listenerName: 'chatsUpsert',
        payload: { 'chats.upsert': [{ id: '15550100001@s.whatsapp.net' }] },
      },
      {
        eventName: 'chats.update',
        listenerName: 'chatsUpdate',
        payload: { 'chats.update': [{ id: '15550100001@s.whatsapp.net', unreadCount: 1 }] },
      },
      {
        eventName: 'chats.delete',
        listenerName: 'chatsDelete',
        payload: { 'chats.delete': ['15550100001@s.whatsapp.net'] },
      },
      {
        eventName: 'messaging-history.set',
        listenerName: 'historyMessages',
        payload: { 'messaging-history.set': { messages: [{ key: { id: 'history-1' } }], isLatest: true } },
      },
      {
        eventName: 'groups.upsert',
        listenerName: 'groupsUpsert',
        payload: { 'groups.upsert': [{ id: 'group-edge@g.us', subject: 'Group' }] },
      },
      {
        eventName: 'groups.update',
        listenerName: 'groupsUpdate',
        payload: { 'groups.update': [{ id: 'group-edge@g.us' }] },
      },
      {
        eventName: 'group.join-request',
        listenerName: 'groupJoinRequest',
        payload: { 'group.join-request': { id: 'group-edge@g.us', participant: '15550100001@s.whatsapp.net' } },
      },
      {
        eventName: 'blocklist.set',
        listenerName: 'blocklistSet',
        payload: { 'blocklist.set': { blocklist: ['15550100001@s.whatsapp.net'] } },
      },
      {
        eventName: 'blocklist.update',
        listenerName: 'blocklistUpdate',
        payload: { 'blocklist.update': { blocklist: ['15550100001@s.whatsapp.net'], type: 'remove' } },
      },
      {
        eventName: 'newsletter.reaction',
        listenerName: 'newsletterReaction',
        payload: { 'newsletter.reaction': { newsletterJid: 'newsletter@newsletter', emoji: '+' } },
      },
      {
        eventName: 'newsletter.view',
        listenerName: 'newsletterView',
        payload: { 'newsletter.view': { newsletterJid: 'newsletter@newsletter' } },
      },
      {
        eventName: 'newsletter-participants.update',
        listenerName: 'newsletterParticipantsUpdate',
        payload: { 'newsletter-participants.update': { participants: ['15550100001@s.whatsapp.net'] } },
      },
      {
        eventName: 'newsletter-settings.update',
        listenerName: 'newsletterSettingsUpdate',
        payload: { 'newsletter-settings.update': { muted: true } },
      },
      {
        eventName: 'labels.edit',
        listenerName: 'labelsEdit',
        payload: { 'labels.edit': [{ id: 'label-1', name: 'Follow up' }] },
      },
      {
        eventName: 'labels.association',
        listenerName: 'labelsAssociation',
        payload: {
          'labels.association': {
            association: { labelId: 'label-1', type: 'chat', chatId: '15550100001@s.whatsapp.net' },
            type: 'add',
          },
        },
      },
    ];

    for (const { eventName, listenerName, payload } of cases) {
      logger.error.mockClear();
      const listener = vi.fn(() => { throw new Error(`${listenerName} failed`); });
      const { manager: scopedManager, emit: scopedEmit } = await connectRegistered();
      scopedManager.once(listenerName as never, listener as never);

      expect(() => scopedEmit(payload)).not.toThrow();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: eventName, err: expect.any(Error) }),
        'event handler failed',
      );
    }
  });

  it('clears a pending reconnect cooldown when a later open event arrives', async () => {
    const { manager, emit } = await connectRegistered();
    (manager as any).cooldownTimer = 1 as unknown as ReturnType<typeof setTimeout>;

    emit(openEvent());

    expect((manager as any).cooldownTimer).toBeNull();
  });

  it('uses backoff reconnect when restart-required closes are flapping', async () => {
    vi.useFakeTimers();
    try {
      const { manager, emit } = await connectRegistered();
      (manager as any).restartRequiredTimestamps = Array.from({ length: 9 }, () => Date.now());

      emit(closeEvent(515));

      expect(logger.warn).toHaveBeenCalledWith(
        { count: 10 },
        expect.stringContaining('restartRequired flapping detected'),
        10,
      );
      expect((manager as any).restartRequiredTimestamps).toEqual([]);
      expect(manager.getConnectionState()).toMatchObject({
        state: 'reconnecting',
        reconnectAttempts: 1,
      });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not schedule restart-required flapping reconnects during shutdown', async () => {
    vi.useFakeTimers();
    try {
      const { manager, emit } = await connectRegistered();
      (manager as any).restartRequiredTimestamps = Array.from({ length: 9 }, () => Date.now());
      (manager as any).shuttingDown = true;

      emit(closeEvent(515));

      expect((manager as any).restartRequiredTimestamps).toEqual([]);
      expect(manager.getConnectionState().reconnectAttempts).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('skips settled auth snapshots immediately after a terminal auth alert', async () => {
    vi.useFakeTimers();
    try {
      const { manager, emit } = await connectRegistered();
      emit(openEvent());
      const scheduledBefore = lifecycleEventCount(manager, 'auth_snapshot_scheduled');
      const capturedBefore = lifecycleEventCount(manager, 'auth_snapshot_captured');
      (manager as any).loggedOutAlertEmitted = true;

      (manager as any).scheduleSettledAuthBondSnapshot('terminal-auth-alert');

      expect(lifecycleEventCount(manager, 'auth_snapshot_scheduled')).toBe(scheduledBefore);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lifecycleEventCount(manager, 'auth_snapshot_captured')).toBe(capturedBefore);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('drops a settled auth snapshot when terminal auth appears before the timer fires', async () => {
    vi.useFakeTimers();
    try {
      const { manager, emit } = await connectRegistered();
      emit(openEvent());
      const capturedBefore = lifecycleEventCount(manager, 'auth_snapshot_captured');

      (manager as any).scheduleSettledAuthBondSnapshot('key-material-settled');
      (manager as any).loggedOutAlertEmitted = true;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(manager.getConnectionState().credentialLifecycle.recentEvents).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: 'auth_snapshot_scheduled' })]),
      );
      expect(lifecycleEventCount(manager, 'auth_snapshot_captured')).toBe(capturedBefore);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('drops a settled auth snapshot when the socket disappears before the timer fires', async () => {
    vi.useFakeTimers();
    try {
      const { manager, emit } = await connectRegistered();
      emit(openEvent());
      const capturedBefore = lifecycleEventCount(manager, 'auth_snapshot_captured');

      (manager as any).scheduleSettledAuthBondSnapshot('key-material-settled');
      (manager as any).sock = null;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(lifecycleEventCount(manager, 'auth_snapshot_captured')).toBe(capturedBefore);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not clear local auth alerts until the repaired snapshot is fully verified', async () => {
    const { manager, emit } = await connectRegistered();
    emit(openEvent());
    const cases: AuthBondSnapshotOverrides[] = [
      { status: 'invalid' },
      { creds: { exists: false } },
      { creds: { size: 0 } },
      { creds: { sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' } },
      { treeHash: null },
      { backup: { latest: null } },
    ];

    for (const overrides of cases) {
      clearCalls.length = 0;
      (manager as any).localAuthAlertEmitted = true;
      mockAuth.snapshot = makeSnapshot(overrides);

      (manager as any).clearLocalAuthBondFailureAfterVerifiedSend(clearCandidate(), clearProof());

      expect(clearCalls).toHaveLength(0);
      expect((manager as any).localAuthAlertEmitted).toBe(true);
    }
  });

  it('keeps local auth alerts open when no alert is active or the socket is not verified connected', async () => {
    const { manager } = await connectRegistered();

    (manager as any).localAuthAlertEmitted = false;
    (manager as any).clearLocalAuthBondFailureAfterVerifiedSend(clearCandidate(), clearProof());
    expect(clearCalls).toHaveLength(0);

    (manager as any).localAuthAlertEmitted = true;
    (manager as any).clearLocalAuthBondFailureAfterVerifiedSend(clearCandidate(), clearProof());
    expect(clearCalls).toHaveLength(0);
  });

  it('clears local auth alerts after a verified repaired snapshot and send proof', async () => {
    const { manager, emit } = await connectRegistered();
    emit(openEvent());
    (manager as any).localAuthAlertEmitted = true;
    mockAuth.snapshot = makeSnapshot();

    (manager as any).clearLocalAuthBondFailureAfterVerifiedSend(clearCandidate(), clearProof());

    expect(clearCalls).toHaveLength(1);
    expect(clearCalls[0]?.[0]).toBe('WhatSoup');
    expect(clearCalls[0]?.[1]).toBe('whatsapp_auth_bond_local_failure');
    expect(clearCalls[0]?.[2]).toEqual(expect.stringContaining('status=present'));
    expect(clearCalls[0]?.[3]).toMatchObject({
      failure: { code: 'WA_AUTH_BOND_LOCAL_REPAIR_VERIFIED' },
    });
    expect((manager as any).localAuthAlertEmitted).toBe(false);
  });

  it('records unserializable disconnect diagnostics as alert evidence', () => {
    const manager = new ConnectionManager();
    (manager as any).lastDisconnectDiagnostic = BigInt(1);

    (manager as any).emitDeviceBondLostAlert(401, 'loggedOut', { fallback: 'unused' });

    const evidence = alertCalls.at(-1)?.[3];
    expect(evidence).toEqual(expect.stringContaining('lastDisconnectSanitized: <unserializable>'));
  });

  it('ignores graceful reconnect requests while one is in flight or the socket is stale', async () => {
    const { manager, mockSock, emit } = await connectRegistered();
    emit(openEvent());

    (manager as any).gracefulReconnectInFlight = true;
    await (manager as any).gracefulReconnect(mockSock, 'keepalive_failed');
    expect(mockSock.end).not.toHaveBeenCalled();

    (manager as any).gracefulReconnectInFlight = false;
    await (manager as any).gracefulReconnect({ ...mockSock }, 'keepalive_failed');
    expect(mockSock.end).not.toHaveBeenCalled();
  });
});
