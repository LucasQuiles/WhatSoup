import type { Database } from './database.ts';
import { withImmediateTransaction } from './db-tx.ts';
import { classifyMemoryOperationFailure } from '../lib/memory-operation-telemetry.ts';
import { systemClock } from '../lib/clock.ts';
import { createChildLogger } from '../logger.ts';

export const REMOTE_MEMORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const REMOTE_MEMORY_TERMINAL_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const REMOTE_MEMORY_MAX_ATTEMPTS = 5;
export const REMOTE_MEMORY_LEASE_MS = 60_000;
const REMOTE_MEMORY_MAX_BACKOFF_MS = 60 * 60 * 1000;

export type RemoteMemoryEraseScope = 'account' | 'sender' | 'conversation' | 'expiry';
export type RemoteMemoryLifecycleState =
  | 'write_intent'
  | 'active'
  | 'write_ambiguous'
  | 'erase_pending'
  | 'leased'
  | 'retry_wait'
  | 'provider_acknowledged'
  | 'absence_verified'
  | 'retry_exhausted';

export interface RemoteMemoryLifecycleOptions {
  accountId: string;
  indexName: string;
  now?: () => number;
}

export interface RemoteMemoryWriteInput {
  remoteRecordId: string;
  conversationKey: string;
  senderJid: string;
  memoryType: string;
}

export interface RemoteMemoryEraseRequest {
  scope: Exclude<RemoteMemoryEraseScope, 'expiry'>;
  senderJid?: string;
  conversationKey?: string;
}

export interface RemoteMemoryProvider {
  deleteRecord(recordId: string): Promise<void>;
  /** True when the record still exists; false includes a verified not-found response. */
  recordExists(recordId: string): Promise<boolean>;
}

export interface RemoteMemoryEraseResult {
  matched: number;
  queued: number;
  states: Partial<Record<RemoteMemoryLifecycleState, number>>;
}

export interface RemoteMemoryLifecycleRow {
  remoteRecordId: string;
  state: RemoteMemoryLifecycleState;
  attemptCount: number;
  providerAcknowledgedAt: number | null;
}

interface StoredRow extends RemoteMemoryLifecycleRow {
  leaseOwner: string | null;
}

export class RemoteMemoryTombstonedError extends Error {
  constructor() {
    super('remote memory record is tombstoned for erasure');
    this.name = 'RemoteMemoryTombstonedError';
  }
}

function assertStoredIdentifier(name: string, value: string): void {
  if (
    value.length === 0
    || value !== value.trim()
    || value.length > 512
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`remote memory ${name} is malformed`);
  }
}

function assertMemoryType(value: string): void {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    throw new Error('remote memory memoryType is malformed');
  }
}

function boundedFailureCode(error: unknown): string {
  const code = classifyMemoryOperationFailure(error).code;
  return code === 'timeout'
    || code === 'network_error'
    || code === 'provider_unavailable'
    || code === 'project_guard_failed'
    ? code
    : 'unknown';
}

function backoffMs(attemptCount: number): number {
  return Math.min(REMOTE_MEMORY_MAX_BACKOFF_MS, 1_000 * (2 ** Math.max(0, attemptCount - 1)));
}

export class RemoteMemoryLifecycle {
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    private readonly options: RemoteMemoryLifecycleOptions,
  ) {
    assertStoredIdentifier('accountId', options.accountId);
    assertStoredIdentifier('indexName', options.indexName);
    this.now = options.now ?? (() => systemClock.now());
  }

  registerWrite(input: RemoteMemoryWriteInput): { remoteRecordId: string; admitted: boolean } {
    if (!/^[a-z][a-z0-9_-]{0,63}_[a-f0-9]{24}$/.test(input.remoteRecordId)) {
      throw new Error('remote memory record id is malformed');
    }
    assertStoredIdentifier('conversationKey', input.conversationKey);
    assertStoredIdentifier('senderJid', input.senderJid);
    assertMemoryType(input.memoryType);

    const remoteRecordId = input.remoteRecordId;
    const now = this.now();
    const state = withImmediateTransaction(this.db, () => {
      this.db.raw.prepare(`
        INSERT OR IGNORE INTO remote_memory_lifecycle (
          remote_record_id, account_id, index_name, namespace, conversation_key,
          sender_jid, memory_type, source, accepted_at, expires_at, state,
          created_at, updated_at
        ) VALUES (?, ?, ?, '', ?, ?, ?, 'memory_write', ?, ?, 'write_intent', ?, ?)
      `).run(
        remoteRecordId,
        this.options.accountId,
        this.options.indexName,
        input.conversationKey,
        input.senderJid,
        input.memoryType,
        now,
        now + REMOTE_MEMORY_RETENTION_MS,
        now,
        now,
      );
      return this.db.raw.prepare(`
        SELECT account_id, index_name, namespace, conversation_key, sender_jid, memory_type,
               source, state, erase_requested_at
          FROM remote_memory_lifecycle
         WHERE remote_record_id = ?
      `).get(remoteRecordId) as {
        account_id: string;
        index_name: string;
        namespace: string;
        conversation_key: string;
        sender_jid: string;
        memory_type: string;
        source: string;
        state: RemoteMemoryLifecycleState;
        erase_requested_at: number | null;
      } | undefined;
    });
    if (!state) throw new Error('remote memory write receipt was not persisted');
    if (
      state.account_id !== this.options.accountId
      || state.index_name !== this.options.indexName
      || state.namespace !== ''
      || state.conversation_key !== input.conversationKey
      || state.sender_jid !== input.senderJid
      || state.memory_type !== input.memoryType
      || state.source !== 'memory_write'
    ) {
      throw new Error('remote memory record id conflicts with existing provenance');
    }
    const admitted = state.erase_requested_at === null
      && (state.state === 'write_intent' || state.state === 'active' || state.state === 'write_ambiguous');
    return { remoteRecordId, admitted };
  }

  assertWriteAdmission(remoteRecordId: string): void {
    if (!this.isWriteAdmitted(remoteRecordId)) throw new RemoteMemoryTombstonedError();
  }

  isWriteAdmitted(remoteRecordId: string): boolean {
    const row = this.db.raw.prepare(`
      SELECT state, erase_requested_at
        FROM remote_memory_lifecycle
       WHERE remote_record_id = ? AND account_id = ? AND index_name = ?
    `).get(remoteRecordId, this.options.accountId, this.options.indexName) as {
      state: RemoteMemoryLifecycleState;
      erase_requested_at: number | null;
    } | undefined;
    return row !== undefined
      && row.erase_requested_at === null
      && (row.state === 'write_intent' || row.state === 'active' || row.state === 'write_ambiguous');
  }

  markWriteFinalized(remoteRecordId: string): boolean {
    const now = this.now();
    const result = this.db.raw.prepare(`
      UPDATE remote_memory_lifecycle
         SET state = 'active', write_finalized_at = ?, updated_at = ?
       WHERE remote_record_id = ? AND account_id = ? AND index_name = ?
         AND erase_requested_at IS NULL
         AND state IN ('write_intent', 'write_ambiguous', 'active')
    `).run(now, now, remoteRecordId, this.options.accountId, this.options.indexName);
    return Number(result.changes) === 1;
  }

  markWriteAmbiguous(remoteRecordId: string): void {
    const now = this.now();
    this.db.raw.prepare(`
      UPDATE remote_memory_lifecycle
         SET state = 'write_ambiguous', updated_at = ?
       WHERE remote_record_id = ? AND account_id = ? AND index_name = ?
         AND erase_requested_at IS NULL AND state IN ('write_intent', 'active')
    `).run(now, remoteRecordId, this.options.accountId, this.options.indexName);
  }

  requestErase(request: RemoteMemoryEraseRequest): RemoteMemoryEraseResult {
    if (request.scope === 'account' && (request.senderJid !== undefined || request.conversationKey !== undefined)) {
      throw new Error('remote memory account scope must not include a sender or conversation');
    }
    if (request.scope === 'sender') {
      if (request.senderJid === undefined) throw new Error('remote memory sender scope is unresolved');
      assertStoredIdentifier('senderJid', request.senderJid);
      if (request.conversationKey !== undefined) {
        throw new Error('remote memory sender scope must not include a conversation');
      }
    }
    if (request.scope === 'conversation') {
      if (request.conversationKey === undefined) throw new Error('remote memory conversation scope is unresolved');
      assertStoredIdentifier('conversationKey', request.conversationKey);
      if (request.senderJid !== undefined) {
        throw new Error('remote memory conversation scope must not include a sender');
      }
    }
    const now = this.now();
    const scopeClause = request.scope === 'sender'
      ? 'AND sender_jid = ?'
      : request.scope === 'conversation'
        ? 'AND conversation_key = ?'
        : '';
    const scopeValue = request.scope === 'sender' ? request.senderJid : request.conversationKey;
    return withImmediateTransaction(this.db, () => {
      const matched = this.db.raw.prepare(`
        SELECT COUNT(*) AS n FROM remote_memory_lifecycle
         WHERE account_id = ? AND index_name = ? ${scopeClause}
      `).get(
        this.options.accountId,
        this.options.indexName,
        ...(scopeValue === undefined ? [] : [scopeValue]),
      ) as { n: number };
      const newlyQueued = this.db.raw.prepare(`
        SELECT COUNT(*) AS n FROM remote_memory_lifecycle
         WHERE account_id = ? AND index_name = ?
           AND erase_requested_at IS NULL AND state <> 'absence_verified' ${scopeClause}
      `).get(
        this.options.accountId,
        this.options.indexName,
        ...(scopeValue === undefined ? [] : [scopeValue]),
      ) as { n: number };
      this.db.raw.prepare(`
        UPDATE remote_memory_lifecycle
           SET state = CASE
                 WHEN state = 'absence_verified' THEN state
                 WHEN erase_requested_at IS NULL THEN 'erase_pending'
                 ELSE state END,
               erase_scope = COALESCE(erase_scope, ?),
               erase_requested_at = COALESCE(erase_requested_at, ?),
               next_attempt_at = CASE
                 WHEN state <> 'absence_verified' AND erase_requested_at IS NULL THEN ?
                 ELSE next_attempt_at END,
               updated_at = CASE WHEN erase_requested_at IS NULL THEN ? ELSE updated_at END
         WHERE account_id = ? AND index_name = ? ${scopeClause}
      `).run(
        request.scope,
        now,
        now,
        now,
        this.options.accountId,
        this.options.indexName,
        ...(scopeValue === undefined ? [] : [scopeValue]),
      );
      const stateRows = this.db.raw.prepare(`
        SELECT state, COUNT(*) AS n FROM remote_memory_lifecycle
         WHERE account_id = ? AND index_name = ? ${scopeClause}
         GROUP BY state
      `).all(
        this.options.accountId,
        this.options.indexName,
        ...(scopeValue === undefined ? [] : [scopeValue]),
      ) as Array<{ state: RemoteMemoryLifecycleState; n: number }>;
      return {
        matched: matched.n,
        queued: newlyQueued.n,
        states: Object.fromEntries(stateRows.map((row) => [row.state, row.n])),
      };
    });
  }

  pruneVerifiedReceipts(): number {
    const cutoff = this.now() - REMOTE_MEMORY_TERMINAL_RECEIPT_RETENTION_MS;
    return Number(this.db.raw.prepare(`
      DELETE FROM remote_memory_lifecycle
       WHERE account_id = ? AND index_name = ? AND state = 'absence_verified'
         AND absence_verified_at IS NOT NULL AND absence_verified_at <= ?
    `).run(this.options.accountId, this.options.indexName, cutoff).changes);
  }

  queueExpired(): number {
    const now = this.now();
    return Number(this.db.raw.prepare(`
      UPDATE remote_memory_lifecycle
         SET state = 'erase_pending', erase_scope = 'expiry', erase_requested_at = ?,
             next_attempt_at = ?, updated_at = ?
       WHERE account_id = ? AND index_name = ? AND expires_at <= ?
         AND erase_requested_at IS NULL AND state <> 'absence_verified'
    `).run(now, now, now, this.options.accountId, this.options.indexName, now).changes);
  }

  reclaimExpiredLeases(): number {
    const now = this.now();
    return Number(this.db.raw.prepare(`
      UPDATE remote_memory_lifecycle
         SET state = CASE
                 WHEN attempt_count >= ? THEN 'retry_exhausted'
                 WHEN provider_acknowledged_at IS NOT NULL THEN 'provider_acknowledged'
                 ELSE 'retry_wait' END,
             lease_owner = NULL, lease_expires_at = NULL,
             next_attempt_at = CASE WHEN attempt_count >= ? THEN NULL ELSE ? END,
             failure_code = CASE WHEN attempt_count >= ? THEN 'unknown' ELSE failure_code END,
             updated_at = ?
       WHERE state = 'leased' AND lease_expires_at <= ?
         AND account_id = ? AND index_name = ?
    `).run(
      REMOTE_MEMORY_MAX_ATTEMPTS,
      REMOTE_MEMORY_MAX_ATTEMPTS,
      now,
      REMOTE_MEMORY_MAX_ATTEMPTS,
      now,
      now,
      this.options.accountId,
      this.options.indexName,
    ).changes);
  }

  private claimDue(owner: string): StoredRow | undefined {
    assertStoredIdentifier('leaseOwner', owner);
    const now = this.now();
    return withImmediateTransaction(this.db, () => {
      this.pruneVerifiedReceipts();
      this.queueExpired();
      this.reclaimExpiredLeases();
      const row = this.db.raw.prepare(`
        SELECT remote_record_id, state, attempt_count, provider_acknowledged_at
          FROM remote_memory_lifecycle
         WHERE account_id = ? AND index_name = ?
           AND state IN ('erase_pending', 'retry_wait', 'provider_acknowledged')
           AND attempt_count < ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY COALESCE(next_attempt_at, accepted_at), remote_record_id
         LIMIT 1
      `).get(
        this.options.accountId,
        this.options.indexName,
        REMOTE_MEMORY_MAX_ATTEMPTS,
        now,
      ) as {
        remote_record_id: string;
        state: RemoteMemoryLifecycleState;
        attempt_count: number;
        provider_acknowledged_at: number | null;
      } | undefined;
      if (!row) return undefined;
      const changes = this.db.raw.prepare(`
        UPDATE remote_memory_lifecycle
           SET state = 'leased', lease_owner = ?, lease_expires_at = ?,
               attempt_count = attempt_count + 1, next_attempt_at = NULL, updated_at = ?
         WHERE remote_record_id = ? AND state = ? AND attempt_count = ?
      `).run(owner, now + REMOTE_MEMORY_LEASE_MS, now, row.remote_record_id, row.state, row.attempt_count).changes;
      if (Number(changes) !== 1) return undefined;
      return {
        remoteRecordId: row.remote_record_id,
        state: 'leased',
        attemptCount: row.attempt_count + 1,
        providerAcknowledgedAt: row.provider_acknowledged_at,
        leaseOwner: owner,
      };
    });
  }

  private markAcknowledged(row: StoredRow): void {
    const now = this.now();
    this.db.raw.prepare(`
      UPDATE remote_memory_lifecycle
         SET provider_acknowledged_at = COALESCE(provider_acknowledged_at, ?), updated_at = ?
       WHERE remote_record_id = ? AND state = 'leased' AND lease_owner = ?
    `).run(now, now, row.remoteRecordId, row.leaseOwner);
  }

  private markVerifiedAbsent(row: StoredRow): boolean {
    const now = this.now();
    const changes = this.db.raw.prepare(`
      UPDATE remote_memory_lifecycle
         SET state = 'absence_verified', absence_verified_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, next_attempt_at = NULL, failure_code = NULL, updated_at = ?
       WHERE remote_record_id = ? AND state = 'leased' AND lease_owner = ?
    `).run(now, now, row.remoteRecordId, row.leaseOwner).changes;
    return Number(changes) === 1;
  }

  private retry(row: StoredRow, error: unknown): void {
    const now = this.now();
    const exhausted = row.attemptCount >= REMOTE_MEMORY_MAX_ATTEMPTS;
    this.db.raw.prepare(`
      UPDATE remote_memory_lifecycle
         SET state = CASE
               WHEN ? THEN 'retry_exhausted'
               WHEN provider_acknowledged_at IS NOT NULL THEN 'provider_acknowledged'
               ELSE 'retry_wait' END,
             lease_owner = NULL, lease_expires_at = NULL,
             failure_code = ?,
             next_attempt_at = CASE WHEN ? THEN NULL ELSE ? END,
             updated_at = ?
       WHERE remote_record_id = ? AND state = 'leased' AND lease_owner = ?
    `).run(
      exhausted ? 1 : 0,
      boundedFailureCode(error),
      exhausted ? 1 : 0,
      now + backoffMs(row.attemptCount),
      now,
      row.remoteRecordId,
      row.leaseOwner,
    );
  }

  async processDue(provider: RemoteMemoryProvider, leaseOwner: string): Promise<
    'idle' | 'verified_absent' | 'retry_scheduled'
  > {
    const row = this.claimDue(leaseOwner);
    if (!row) return 'idle';
    try {
      if (row.providerAcknowledgedAt === null) {
        await provider.deleteRecord(row.remoteRecordId);
        this.markAcknowledged(row);
      }
      const exists = await provider.recordExists(row.remoteRecordId);
      if (!exists && this.markVerifiedAbsent(row)) return 'verified_absent';
      this.retry(row, new Error('remote memory record still present'));
      return 'retry_scheduled';
    } catch (error) {
      this.retry(row, error);
      return 'retry_scheduled';
    }
  }

  get(remoteRecordId: string): RemoteMemoryLifecycleRow | undefined {
    const row = this.db.raw.prepare(`
      SELECT remote_record_id, state, attempt_count, provider_acknowledged_at
        FROM remote_memory_lifecycle
       WHERE remote_record_id = ? AND account_id = ? AND index_name = ?
    `).get(remoteRecordId, this.options.accountId, this.options.indexName) as {
      remote_record_id: string;
      state: RemoteMemoryLifecycleState;
      attempt_count: number;
      provider_acknowledged_at: number | null;
    } | undefined;
    return row && {
      remoteRecordId: row.remote_record_id,
      state: row.state,
      attemptCount: row.attempt_count,
      providerAcknowledgedAt: row.provider_acknowledged_at,
    };
  }
}

/**
 * One bounded timer for the lifecycle ledger. It reuses the database-backed
 * claim/lease contract above instead of introducing a general job framework.
 */
export class RemoteMemoryLifecycleTimer {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly lifecycle: RemoteMemoryLifecycle,
    private readonly provider: RemoteMemoryProvider | null,
    private readonly leaseOwner: string,
    private readonly intervalMs = 60 * 60 * 1000,
    private readonly maxRowsPerRun = 50,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.runSafely();
    this.timer = setInterval(() => { void this.runSafely(); }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async run(): Promise<void> {
    this.lifecycle.pruneVerifiedReceipts();
    if (!this.provider) return;
    for (let count = 0; count < this.maxRowsPerRun; count += 1) {
      const result = await this.lifecycle.processDue(this.provider, this.leaseOwner);
      if (result === 'idle') return;
    }
  }

  private async runSafely(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      lifecycleLog.error({ error }, 'remote memory lifecycle timer run failed');
    }
  }
}

const lifecycleLog = createChildLogger('remote-memory-lifecycle');
