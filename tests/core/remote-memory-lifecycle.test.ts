import { afterEach, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import {
  REMOTE_MEMORY_EXPIRY_QUEUE_MARGIN_MS,
  REMOTE_MEMORY_MAX_ATTEMPTS,
  REMOTE_MEMORY_PROVIDER_CALL_TIMEOUT_MS,
  REMOTE_MEMORY_RETENTION_MS,
  REMOTE_MEMORY_TERMINAL_RECEIPT_RETENTION_MS,
  RemoteMemoryLifecycle,
  RemoteMemoryLifecycleTimer,
} from '../../src/core/remote-memory-lifecycle.ts';

const lifecycleLog = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => lifecycleLog,
}));

type LifecycleModule = {
  RemoteMemoryLifecycle: new (db: Database, options: {
    accountId: string;
    indexName: string;
    now?: () => number;
  }) => {
    registerWrite(input: {
      conversationKey: string;
      senderJid: string;
      memoryType: string;
      remoteRecordId: string;
    }): { remoteRecordId: string; admitted: boolean };
  };
  RemoteMemoryLifecycleTimer: new (
    lifecycle: {
      processDue: () => Promise<'idle' | 'verified_absent' | 'retry_scheduled'>;
      pruneVerifiedReceipts: () => number;
      queueExpired: () => number;
    },
    provider: () => { deleteRecord: (recordId: string, signal?: AbortSignal) => Promise<void>; recordExists: (recordId: string, signal?: AbortSignal) => Promise<boolean> } | null,
    leaseOwner: string,
    intervalMs?: number,
    maxRowsPerRun?: number,
  ) => { start(): void; stop(): void; run(): Promise<void> };
};

const lifecycleModulePath = '../../src/core/remote-memory-lifecycle.ts';

describe('remote memory lifecycle', () => {
  let db: Database | undefined;

  afterEach(() => db?.close());

  it('commits a content-free write intent before provider execution', async () => {
    const module = await import(lifecycleModulePath).catch(() => undefined) as LifecycleModule | undefined;
    expect(module, 'remote memory lifecycle implementation is missing').toBeDefined();
    if (!module) return;

    db = new Database(':memory:');
    db.open();
    const lifecycle = new module.RemoteMemoryLifecycle(db, {
      accountId: 'bot@example',
      indexName: 'memory-index',
      now: () => 1_700_000_000_000,
    });

    const registration = lifecycle.registerWrite({
      conversationKey: '15550000001',
      senderJid: '15550000001@s.whatsapp.net',
      memoryType: 'preference',
      remoteRecordId: 'preference_ee0f9dbe7c2f22e938e0ed47',
    });

    expect(registration).toEqual({
      remoteRecordId: 'preference_ee0f9dbe7c2f22e938e0ed47',
      admitted: true,
    });
    const receipt = db.raw.prepare(`
      SELECT remote_record_id, account_id, index_name, namespace, conversation_key,
             sender_jid, memory_type, source, state, expires_at
      FROM remote_memory_lifecycle
    `).get() as Record<string, unknown>;
    expect(receipt).toMatchObject({
      remote_record_id: registration.remoteRecordId,
      account_id: 'bot@example',
      index_name: 'memory-index',
      namespace: '',
      conversation_key: '15550000001',
      sender_jid: '15550000001@s.whatsapp.net',
      memory_type: 'preference',
      source: 'memory_write',
      state: 'write_intent',
      expires_at: 1_700_000_000_000 + REMOTE_MEMORY_RETENTION_MS - REMOTE_MEMORY_EXPIRY_QUEUE_MARGIN_MS,
    });
    expect(JSON.stringify(receipt)).not.toContain('secret red notebook');
  });

  it('contains timer claim failures and keeps the interval alive', async () => {
    const module = await import(lifecycleModulePath).catch(() => undefined) as LifecycleModule | undefined;
    expect(module).toBeDefined();
    if (!module) return;

    const processDue = vi.fn()
      .mockRejectedValueOnce(new Error('sqlite claim failed'))
      .mockResolvedValue('idle');
    const timer = new module.RemoteMemoryLifecycleTimer(
      { processDue, pruneVerifiedReceipts: vi.fn(() => 0), queueExpired: vi.fn(() => 0) },
      () => ({ deleteRecord: async () => {}, recordExists: async () => false }),
      'test-timer',
      25,
    );
    timer.start();
    try {
      await vi.waitFor(() => expect(lifecycleLog.error).toHaveBeenCalledWith(
        { error: expect.objectContaining({ message: 'sqlite claim failed' }) },
        'remote memory lifecycle timer run failed',
      ));
      await vi.waitFor(() => expect(processDue.mock.calls.length).toBeGreaterThanOrEqual(2));
    } finally {
      timer.stop();
    }
  });

  it('prunes terminal receipts while the provider is unavailable without claiming remote work', async () => {
    const module = await import(lifecycleModulePath).catch(() => undefined) as LifecycleModule | undefined;
    expect(module).toBeDefined();
    if (!module) return;

    const processDue = vi.fn().mockResolvedValue('idle');
    const pruneVerifiedReceipts = vi.fn(() => 1);
    const timer = new module.RemoteMemoryLifecycleTimer(
      { processDue, pruneVerifiedReceipts, queueExpired: vi.fn(() => 0) },
      () => null,
      'unavailable-provider',
    );

    await timer.run();

    expect(pruneVerifiedReceipts).toHaveBeenCalledOnce();
    expect(processDue).not.toHaveBeenCalled();
  });

  it('queues expiry while provider construction is unavailable and resumes reconciliation after recovery', async () => {
    let now = 1_700_000_000_000;
    db = new Database(':memory:');
    db.open();
    const lifecycle = new RemoteMemoryLifecycle(db, {
      accountId: 'bot@example', indexName: 'memory-index', now: () => now,
    });
    const remoteRecordId = 'preference_010101010101010101010101';
    lifecycle.registerWrite({
      remoteRecordId, conversationKey: 'one', senderJid: 'alice@s.whatsapp.net', memoryType: 'preference',
    });
    now += REMOTE_MEMORY_RETENTION_MS - REMOTE_MEMORY_EXPIRY_QUEUE_MARGIN_MS;

    let provider: { deleteRecord: (recordId: string, signal?: AbortSignal) => Promise<void>; recordExists: (recordId: string, signal?: AbortSignal) => Promise<boolean> } | null = null;
    const timer = new RemoteMemoryLifecycleTimer(lifecycle, () => provider, 'provider-recovery');
    await timer.run();
    expect(lifecycle.get(remoteRecordId)).toMatchObject({ state: 'erase_pending', attemptCount: 0 });

    provider = { deleteRecord: async () => {}, recordExists: async () => false };
    await timer.run();
    expect(lifecycle.get(remoteRecordId)).toMatchObject({ state: 'absence_verified', attemptCount: 1 });
  });

  it('bounds a provider call that ignores its abort signal so the lifecycle timer cannot remain held', async () => {
    db = new Database(':memory:');
    db.open();
    const lifecycle = new RemoteMemoryLifecycle(db, { accountId: 'bot@example', indexName: 'memory-index' });
    const remoteRecordId = 'preference_020202020202020202020202';
    lifecycle.registerWrite({
      remoteRecordId, conversationKey: 'one', senderJid: 'alice@s.whatsapp.net', memoryType: 'preference',
    });
    lifecycle.requestErase({ scope: 'conversation', conversationKey: 'one' });
    let aborted = false;
    const neverResolving = {
      deleteRecord: async (_recordId: string, signal?: AbortSignal) => {
        signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
        await new Promise<void>(() => {});
      },
      recordExists: async () => false,
    };

    const outcome = await lifecycle.processDue(neverResolving, 'deadline-test', 5);
    expect(outcome).toBe('retry_scheduled');
    expect(aborted).toBe(true);
    expect(REMOTE_MEMORY_PROVIDER_CALL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(lifecycle.get(remoteRecordId)).toMatchObject({ state: 'retry_wait', attemptCount: 1 });
  });

  it('keeps provider acknowledgement distinct from verified current absence', async () => {
    let now = 1_700_000_000_000;
    db = new Database(':memory:');
    db.open();
    const lifecycle = new RemoteMemoryLifecycle(db, {
      accountId: 'bot@example', indexName: 'memory-index', now: () => now,
    });
    const remoteRecordId = 'preference_111111111111111111111111';
    lifecycle.registerWrite({
      remoteRecordId, conversationKey: '15550000001', senderJid: '15550000001@s.whatsapp.net', memoryType: 'preference',
    });
    lifecycle.requestErase({ scope: 'conversation', conversationKey: '15550000001' });

    const deleteRecord = vi.fn(async () => {});
    const recordExists = vi.fn()
      .mockRejectedValueOnce(new Error('fetch timed out'))
      .mockResolvedValueOnce(false);
    expect(await lifecycle.processDue({ deleteRecord, recordExists }, 'lifecycle-test')).toBe('retry_scheduled');
    expect(lifecycle.get(remoteRecordId)).toMatchObject({ state: 'provider_acknowledged', attemptCount: 1 });
    const acknowledged = db.raw.prepare(
      'SELECT provider_acknowledged_at, absence_verified_at FROM remote_memory_lifecycle WHERE remote_record_id = ?',
    ).get(remoteRecordId) as { provider_acknowledged_at: number; absence_verified_at: number | null };
    expect(acknowledged).toEqual({ provider_acknowledged_at: now, absence_verified_at: null });

    now += 1_000;
    expect(await lifecycle.processDue({ deleteRecord, recordExists }, 'lifecycle-test')).toBe('verified_absent');
    expect(lifecycle.get(remoteRecordId)).toMatchObject({ state: 'absence_verified', attemptCount: 2 });
    expect(deleteRecord).toHaveBeenCalledTimes(1);
    expect(recordExists).toHaveBeenCalledTimes(2);
  });

  it('makes erasure scopes idempotent and does not cross a sender boundary', () => {
    db = new Database(':memory:');
    db.open();
    const lifecycle = new RemoteMemoryLifecycle(db, { accountId: 'bot@example', indexName: 'memory-index' });
    const first = 'preference_222222222222222222222222';
    const second = 'preference_333333333333333333333333';
    const third = 'preference_444444444444444444444444';
    lifecycle.registerWrite({ remoteRecordId: first, conversationKey: 'one', senderJid: 'alice@s.whatsapp.net', memoryType: 'preference' });
    lifecycle.registerWrite({ remoteRecordId: second, conversationKey: 'two', senderJid: 'alice@s.whatsapp.net', memoryType: 'preference' });
    lifecycle.registerWrite({ remoteRecordId: third, conversationKey: 'one', senderJid: 'bob@s.whatsapp.net', memoryType: 'preference' });

    expect(lifecycle.requestErase({ scope: 'sender', senderJid: 'alice@s.whatsapp.net' })).toMatchObject({
      matched: 2, queued: 2, states: { erase_pending: 2 },
    });
    expect(lifecycle.requestErase({ scope: 'sender', senderJid: 'alice@s.whatsapp.net' })).toMatchObject({
      matched: 2, queued: 0, states: { erase_pending: 2 },
    });
    expect(lifecycle.get(first)).toMatchObject({ state: 'erase_pending' });
    expect(lifecycle.get(second)).toMatchObject({ state: 'erase_pending' });
    expect(lifecycle.get(third)).toMatchObject({ state: 'write_intent' });
  });

  it('tombstones a record before a delayed write retry can be admitted', () => {
    db = new Database(':memory:');
    db.open();
    const lifecycle = new RemoteMemoryLifecycle(db, { accountId: 'bot@example', indexName: 'memory-index' });
    const remoteRecordId = 'preference_555555555555555555555555';
    lifecycle.registerWrite({
      remoteRecordId, conversationKey: 'one', senderJid: 'alice@s.whatsapp.net', memoryType: 'preference',
    });
    lifecycle.requestErase({ scope: 'conversation', conversationKey: 'one' });

    expect(() => lifecycle.assertWriteAdmission(remoteRecordId)).toThrow(/tombstoned/);
    expect(lifecycle.registerWrite({
      remoteRecordId, conversationKey: 'one', senderJid: 'alice@s.whatsapp.net', memoryType: 'preference',
    })).toEqual({ remoteRecordId, admitted: false });
  });

  it('fails closed when an existing stable record ID has different provenance', () => {
    db = new Database(':memory:');
    db.open();
    const lifecycle = new RemoteMemoryLifecycle(db, { accountId: 'bot@example', indexName: 'memory-index' });
    const remoteRecordId = 'preference_999999999999999999999999';
    lifecycle.registerWrite({
      remoteRecordId, conversationKey: 'one', senderJid: 'alice@s.whatsapp.net', memoryType: 'preference',
    });

    expect(() => lifecycle.registerWrite({
      remoteRecordId, conversationKey: 'other', senderJid: 'alice@s.whatsapp.net', memoryType: 'preference',
    })).toThrow(/conflicts with existing provenance/);
  });

  it('allows the same legacy provider record ID to coexist in a different account and index', () => {
    db = new Database(':memory:');
    db.open();
    const recordId = 'preference_909090909090909090909090';
    const first = new RemoteMemoryLifecycle(db, { accountId: 'first@example', indexName: 'first-index' });
    const second = new RemoteMemoryLifecycle(db, { accountId: 'second@example', indexName: 'second-index' });
    first.registerWrite({ remoteRecordId: recordId, conversationKey: 'one', senderJid: 'alice@s.whatsapp.net', memoryType: 'preference' });
    second.registerWrite({ remoteRecordId: recordId, conversationKey: 'two', senderJid: 'bob@s.whatsapp.net', memoryType: 'preference' });

    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM remote_memory_lifecycle WHERE remote_record_id = ?').get(recordId)).toEqual({ n: 2 });
    first.requestErase({ scope: 'account' });
    expect(first.get(recordId)).toMatchObject({ state: 'erase_pending' });
    expect(second.get(recordId)).toMatchObject({ state: 'write_intent' });
  });

  it('uses bounded backoff, reaches a visible retry cap, and resumes an expired lease after restart', async () => {
    let now = 1_700_000_000_000;
    db = new Database(':memory:');
    db.open();
    const lifecycle = new RemoteMemoryLifecycle(db, {
      accountId: 'bot@example', indexName: 'memory-index', now: () => now,
    });
    const remoteRecordId = 'preference_666666666666666666666666';
    lifecycle.registerWrite({
      remoteRecordId, conversationKey: 'one', senderJid: 'alice@s.whatsapp.net', memoryType: 'preference',
    });
    lifecycle.requestErase({ scope: 'account' });
    const unavailable = { deleteRecord: async () => { throw new Error('provider unavailable'); }, recordExists: async () => false };

    for (let attempt = 1; attempt <= REMOTE_MEMORY_MAX_ATTEMPTS; attempt += 1) {
      expect(await lifecycle.processDue(unavailable, 'first-process')).toBe('retry_scheduled');
      const row = db.raw.prepare(
        'SELECT state, attempt_count, next_attempt_at FROM remote_memory_lifecycle WHERE remote_record_id = ?',
      ).get(remoteRecordId) as { state: string; attempt_count: number; next_attempt_at: number | null };
      if (attempt < REMOTE_MEMORY_MAX_ATTEMPTS) {
        expect(row).toEqual({ state: 'retry_wait', attempt_count: attempt, next_attempt_at: now + 1_000 * (2 ** (attempt - 1)) });
        now = row.next_attempt_at!;
      } else {
        expect(row).toEqual({ state: 'retry_exhausted', attempt_count: attempt, next_attempt_at: null });
      }
    }

    const recoveringId = 'preference_777777777777777777777777';
    lifecycle.registerWrite({
      remoteRecordId: recoveringId, conversationKey: 'two', senderJid: 'alice@s.whatsapp.net', memoryType: 'preference',
    });
    lifecycle.requestErase({ scope: 'conversation', conversationKey: 'two' });
    db.raw.prepare(`
      UPDATE remote_memory_lifecycle
         SET state = 'leased', lease_owner = 'crashed-process', lease_expires_at = ?, attempt_count = 1
       WHERE remote_record_id = ?
    `).run(now + 1, recoveringId);
    now += 2;
    expect(await lifecycle.processDue(
      { deleteRecord: async () => {}, recordExists: async () => false },
      'restored-process',
    )).toBe('verified_absent');
    expect(lifecycle.get(recoveringId)).toMatchObject({ state: 'absence_verified', attemptCount: 2 });
  });

  it('queues automatic expiry without discarding the receipt before reconciliation', async () => {
    let now = 1_700_000_000_000;
    db = new Database(':memory:');
    db.open();
    const lifecycle = new RemoteMemoryLifecycle(db, {
      accountId: 'bot@example', indexName: 'memory-index', now: () => now,
    });
    const remoteRecordId = 'preference_888888888888888888888888';
    lifecycle.registerWrite({
      remoteRecordId, conversationKey: 'one', senderJid: 'alice@s.whatsapp.net', memoryType: 'preference',
    });
    now += 90 * 24 * 60 * 60 * 1000;

    expect(await lifecycle.processDue(
      { deleteRecord: async () => {}, recordExists: async () => false },
      'expiry-process',
    )).toBe('verified_absent');
    expect(lifecycle.get(remoteRecordId)).toMatchObject({ state: 'absence_verified' });
    now += REMOTE_MEMORY_TERMINAL_RECEIPT_RETENTION_MS;
    expect(await lifecycle.processDue(
      { deleteRecord: async () => {}, recordExists: async () => false },
      'expiry-process',
    )).toBe('idle');
    expect(lifecycle.get(remoteRecordId)).toBeUndefined();
  });
});
