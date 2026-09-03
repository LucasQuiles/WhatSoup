import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthBondCaptureResult, AuthBondRestoreResult, AuthBondSnapshot } from '../../src/transport/auth-bond.ts';
import { usePerTestBotErrorsMarkerIsolation } from '../../tests/setup/bot-errors-vitest-isolation.ts';

type AuthBondSnapshotOverrides = Partial<Omit<AuthBondSnapshot, 'authDir' | 'creds' | 'backup'>> & {
  authDir?: Partial<AuthBondSnapshot['authDir']>;
  creds?: Partial<AuthBondSnapshot['creds']>;
  backup?: Partial<AuthBondSnapshot['backup']>;
};

const { mockConfig, mockAuth, alertCalls, clearCalls, logger } = vi.hoisted(() => {
  // Baileys-style logger shell: the asserted info/warn/error/debug spies and
  // fatal are assigned from the shared helper inside the vi.mock factory
  // below; only the members the helper does not provide live here.
  const log = {
    level: 'error',
    child: vi.fn(() => log),
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  return {
    mockConfig: {
      adminPhones: new Set<string>(),
      authDir: '/tmp/wa-test-auth-bond-edge',
      stateRoot: '/tmp/wa-test-auth-bond-edge-state',
      dataRoot: '/tmp/wa-test-auth-bond-edge-data',
      lockPath: '/tmp/wa-test-auth-bond-edge.lock',
      dbPath: ':memory:',
      mediaDir: '/tmp/whatsoup-test-media-connection-auth-bond-edge/tmp',
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

vi.mock('../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../helpers/logger-mock.ts');
  Object.assign(logger, singletonLoggerMock(), { fatal: vi.fn() });
  return { createChildLogger: () => logger };
});

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
      // The tree-cache half of the guard surface. ConnectionManager reaches all
      // three on paths these tests drive: warmTreeCache on socket open,
      // invalidateTreeCache from the credential saver, inspectCached from the
      // health projection. Omitting them did not fail a test — the calls are
      // unawaited, so they rejected into the void and only surfaced as vitest
      // "unhandled errors" with a passing test count and exit 1. The surface
      // assertion at the end of this file is what stops that recurring.
      warmTreeCache: vi.fn(async () => {}),
      invalidateTreeCache: vi.fn(),
      inspectCached: vi.fn(() => mockAuth.snapshot),
    };
  }),
}));

vi.mock('../../src/lib/emit-alert.ts', () => ({ emitObservationChecked: vi.fn(() => true),
  emitAlertChecked: vi.fn((...args: unknown[]) => {
    alertCalls.push(args);
    return true;
  }),
  clearAlertSourceChecked: vi.fn((...args: unknown[]) => {
    clearCalls.push(args);
    return true;
  }),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { ConnectionManager } from '../../src/transport/connection.ts';
import { AuthBondGuard } from '../../src/transport/auth-bond.ts';

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
      error: null,
    },
    creds: {
      path: `${mockConfig.authDir}/creds.json`,
      exists: true,
      mode: '600',
      size: 2048,
      mtime: '2026-07-01T00:00:00.000Z',
      sha256: 'a'.repeat(64),
      error: null,
    },
    meHash: 'me-hash',
    treeHash: 'tree-hash',
    fileCount: 42,
    totalBytes: 4096,
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
      lastSweepError: null,
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

usePerTestBotErrorsMarkerIsolation();

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

  /**
   * A review finding on the withheld restore. The guard refuses to run the
   * destructive repair on a transient read, which is right, but the connect
   * path ignored `attempted: false` and carried on: it loaded the auth state,
   * and that reader initialises FRESH credentials when the existing ones
   * cannot be read or parsed. So a credential that was merely unreadable for
   * one open could be replaced by an empty one and taken to QR — and the QR
   * handler returns without scheduling anything, so nothing retried. A
   * `/health` read cannot rescue it either: /health re-reads the credential
   * but never calls the restore.
   *
   * The activation must therefore abort BEFORE the auth state is loaded and
   * schedule the retry itself.
   */
  function deferredRestore(transientReadPersistent: boolean): AuthBondRestoreResult {
    const snapshot = makeSnapshot({
      status: 'invalid',
      creds: { exists: false, mode: null, size: null, mtime: null, sha256: null },
      issues: ['creds_json_read_transient:EAGAIN'],
      transientReadPersistent,
    });
    return {
      attempted: false,
      restored: false,
      source: null,
      snapshot,
      deferred: true,
      error: 'auth bond read was transient; restore withheld pending a definite read',
    };
  }

  it('aborts the activation and schedules a reconnect when the restore is withheld', async () => {
    vi.useFakeTimers();
    try {
      mockAuth.snapshot = makeSnapshot();
      mockAuth.restore = deferredRestore(false);

      const manager = new ConnectionManager();
      await manager.connect();

      // The load-bearing half: the auth state is never loaded, so the reader
      // that would initialise fresh credentials never runs, and no socket is
      // created off them.
      expect(vi.mocked(useMultiFileAuthState)).not.toHaveBeenCalled();
      expect(vi.mocked(makeWASocket)).not.toHaveBeenCalled();

      // The retry is arranged rather than hoped for.
      expect(manager.getConnectionState()).toMatchObject({
        state: 'reconnecting',
        reconnectAttempts: 1,
      });
      expect(lifecycleEventCount(manager, 'auth_restore_deferred')).toBe(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('stops deferring once the transient outlives the bound and lets the definite read decide', async () => {
    vi.useFakeTimers();
    try {
      mockAuth.snapshot = makeSnapshot();
      // Same withheld restore, one field different: the streak has outlived
      // treeStaleRiskMs. The deferral is bounded by that flag, so this is the
      // case that must NOT loop — /health reports the persistent class and the
      // ordinary path runs.
      mockAuth.restore = deferredRestore(true);

      const { mockSock } = makeMockSocket();
      vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
      const manager = new ConnectionManager();
      await manager.connect();

      expect(vi.mocked(useMultiFileAuthState)).toHaveBeenCalled();
      expect(vi.mocked(makeWASocket)).toHaveBeenCalled();
      expect(lifecycleEventCount(manager, 'auth_restore_deferred')).toBe(0);
      expect(manager.getConnectionState().reconnectAttempts).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not defer a restore that was declined for any other reason', async () => {
    vi.useFakeTimers();
    try {
      mockAuth.snapshot = makeSnapshot();
      // Coverage assertion for the two tests above: `deferred` is what gates
      // the abort, not merely `attempted: false`. Auto-restore being off
      // produces the same attempted/restored pair and must still proceed.
      mockAuth.restore = {
        attempted: false,
        restored: false,
        source: null,
        snapshot: makeSnapshot(),
        error: 'auto-restore disabled',
      };

      const { mockSock } = makeMockSocket();
      vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
      const manager = new ConnectionManager();
      await manager.connect();

      expect(vi.mocked(useMultiFileAuthState)).toHaveBeenCalled();
      expect(lifecycleEventCount(manager, 'auth_restore_deferred')).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  /**
   * The paging consequence of aborting early, asserted rather than assumed.
   *
   * The abort returns before the `connect-preflight` inspection, so the
   * local-auth-bond alert no longer fires for a deferred attempt. That is the
   * intended severity: a credential that could not be READ must not page as
   * `WA_AUTH_BOND_LOCAL_*`, which asserts something about the credential's
   * integrity that a transient read never established. The condition is not
   * lost — it surfaces on the health endpoint through the persistent-read class
   * and reaches the fleet through the poller's non-healthy set.
   *
   * The snapshot here is deliberately INVALID and carries the transient issue,
   * so the alert path is one the preflight WOULD take. Without that, a zero
   * alert count would pass because nothing could ever have emitted.
   */
  it('does not page a local-auth-bond failure for a deferred attempt', async () => {
    vi.useFakeTimers();
    try {
      const transientSnapshot = makeSnapshot({
        status: 'invalid',
        issues: ['creds_json_read_transient:EAGAIN'],
      });
      mockAuth.snapshot = transientSnapshot;
      mockAuth.restore = deferredRestore(false);

      const manager = new ConnectionManager();
      await manager.connect();

      const localBondAlerts = alertCalls.filter(
        (call) => call[1] === 'whatsapp_auth_bond_local_failure',
      );
      expect(localBondAlerts).toHaveLength(0);
      // The disclosure that replaces it, so the attempt is not silent.
      expect(lifecycleEventCount(manager, 'auth_restore_deferred')).toBe(1);
      expect(lifecycleEventCount(manager, 'auth_preflight_invalid')).toBe(0);

      // Control: the SAME invalid snapshot, declined for a non-deferred reason,
      // does reach the preflight and does page. This is what makes the zero
      // above a property of the abort rather than of the fixture.
      alertCalls.length = 0;
      mockAuth.restore = {
        attempted: false,
        restored: false,
        source: null,
        snapshot: transientSnapshot,
        error: 'auto-restore disabled',
      };
      const { mockSock } = makeMockSocket();
      vi.mocked(makeWASocket).mockReturnValue(mockSock as any);
      const control = new ConnectionManager();
      await control.connect();

      const controlAlerts = alertCalls.filter(
        (call) => call[1] === 'whatsapp_auth_bond_local_failure',
      );
      expect(controlAlerts.length).toBeGreaterThanOrEqual(1);
      expect(
        String((controlAlerts[0]?.[5] as { failure?: { code?: unknown } })?.failure?.code ?? ''),
      ).toMatch(/^WA_AUTH_BOND_LOCAL_/);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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

// #2394 (auth-bond): restart-safe recovery authority + contributor predicate.
// Uses the REAL recovery-authority store under a per-test BOT_ERRORS_STATE_DIR
// temp dir; emit/clear stay mocked (checked results controlled per test).
describe('#2394 auth-bond restart recovery authority', () => {
  const MARKER = 'whatsapp_auth_bond_local_failure:WhatSoup';

  async function withMarkerDir(
    fn: (tools: {
      markerPresent: () => Promise<boolean>;
      writeMarker: () => Promise<void>;
    }) => Promise<void>,
  ): Promise<void> {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'auth-bond-recovery-'));
    const prior = process.env['BOT_ERRORS_STATE_DIR'];
    process.env['BOT_ERRORS_STATE_DIR'] = dir;
    const store = () => import('../../src/lib/recovery-authority-store.ts');
    try {
      await fn({
        markerPresent: async () => (await store()).loadRecoveryMarkers().has(MARKER),
        writeMarker: async () => (await store()).setRecoveryMarker(MARKER),
      });
    } finally {
      if (prior === undefined) delete process.env['BOT_ERRORS_STATE_DIR'];
      else process.env['BOT_ERRORS_STATE_DIR'] = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('restores incident ownership from a prior-process marker and clears on full proof', async () => {
    await withMarkerDir(async ({ markerPresent, writeMarker }) => {
      await writeMarker();

      const { manager, emit } = await connectRegistered();
      // Ownership restored at construction — without emitting anything.
      expect((manager as any).localAuthAlertEmitted).toBe(true);
      expect(clearCalls).toHaveLength(0);

      emit(openEvent());
      // Socket open is observation, not recovery: ownership survives.
      expect((manager as any).localAuthAlertEmitted).toBe(true);
      expect(clearCalls).toHaveLength(0);

      mockAuth.snapshot = makeSnapshot();
      (manager as any).clearLocalAuthBondFailureAfterVerifiedSend(clearCandidate(), clearProof());

      expect(clearCalls).toHaveLength(1);
      expect(clearCalls[0]?.[1]).toBe('whatsapp_auth_bond_local_failure');
      expect((manager as any).localAuthAlertEmitted).toBe(false);
      // Durable clear dropped the restart marker.
      expect(await markerPresent()).toBe(false);
    });
  });

  it('starts without ownership when no prior-process marker exists', async () => {
    await withMarkerDir(async () => {
      const { manager, emit } = await connectRegistered();
      expect((manager as any).localAuthAlertEmitted).toBe(false);
      emit(openEvent());
      (manager as any).clearLocalAuthBondFailureAfterVerifiedSend(clearCandidate(), clearProof());
      // No prior incident — proof alone must not manufacture a clear.
      expect(clearCalls).toHaveLength(0);
    });
  });

  it('persists a marker on durable alert emit', async () => {
    await withMarkerDir(async ({ markerPresent }) => {
      const { emit } = await connectRegistered();
      expect(await markerPresent()).toBe(false);

      emit({ 'connection.update': { qr: 'pairing-required' } });

      expect(alertCalls.some((call) => call[1] === 'whatsapp_auth_bond_local_failure')).toBe(true);
      expect(await markerPresent()).toBe(true);
    });
  });

  it.each([
    ['current capture error', { backup: { lastCaptureError: 'disk full' } }],
    ['current restore error', { backup: { lastRestoreError: 'restore failed' } }],
    ['unresolved issues', { issues: ['auth dir mode drift'] }],
  ])('refuses to clear while a contributor is still failing (%s)', async (_label, overrides) => {
    await withMarkerDir(async () => {
      const { manager, emit } = await connectRegistered();
      emit(openEvent());
      (manager as any).localAuthAlertEmitted = true;
      mockAuth.snapshot = makeSnapshot(overrides as AuthBondSnapshotOverrides);

      (manager as any).clearLocalAuthBondFailureAfterVerifiedSend(clearCandidate(), clearProof());

      expect(clearCalls).toHaveLength(0);
      expect((manager as any).localAuthAlertEmitted).toBe(true);
    });
  });
});

/**
 * Surface guard for the auth-bond double.
 *
 * A test double that has fallen behind the class it stands in for does not
 * fail like a wrong answer; it fails like nothing at all. The three tree-cache
 * methods were missing here for two rounds, and because ConnectionManager calls
 * them unawaited the misses surfaced only as vitest "unhandled errors" beside a
 * passing test count and a nonzero exit — a shape that reads green at a glance.
 *
 * The member list is DERIVED from the production source rather than written out
 * here, so a newly added `this.authBond.<member>` call fails this test on the
 * commit that adds it instead of rejecting into the void. Each member is
 * checked twice: it must exist on the REAL prototype, which catches a stale
 * list after a rename, and on the double, which catches the drift itself.
 */
describe('auth-bond double surface', () => {
  it('exposes every guard member ConnectionManager calls', async () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'transport', 'connection.ts'),
      'utf8',
    );
    const reached = [...new Set(
      Array.from(source.matchAll(/this\.authBond\.([A-Za-z_]+)/g), (m) => m[1]),
    )].sort();

    // Coverage assertion: the scan found the call sites at all. Without it a
    // regex that stopped matching would make every check below vacuous.
    expect(reached).toContain('warmTreeCache');
    expect(reached.length).toBeGreaterThanOrEqual(5);

    const real = await vi.importActual<typeof import('../../src/transport/auth-bond.ts')>(
      '../../src/transport/auth-bond.ts',
    );
    const realPrototype = real.AuthBondGuard.prototype as unknown as Record<string, unknown>;
    const double = new (AuthBondGuard as unknown as new () => Record<string, unknown>)();

    for (const member of reached) {
      expect(typeof realPrototype[member]).toBe('function');
      expect(typeof double[member]).toBe('function');
    }
  });
});
