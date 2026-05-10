import type { Database as SqliteDatabase } from 'better-sqlite3';
import { sign, verify } from '../hmac.ts';
import type { BaselineRow } from '../types.ts';

export interface BaselineSetInput {
  probe_id: string;
  scope_id: string;
  expected_doc: string;
  captured_at: string;
  captured_by: string;
}

export interface BaselineIntegrityFailure {
  probe_id: string;
  scope_id: string;
}

type LogLevel = 'info' | 'error';
type LogPayload = Record<string, string | number>;

export interface BaselineStoreLogger {
  info?: (payload: LogPayload, message?: string) => void;
  error?: (payload: LogPayload, message?: string) => void;
}

export interface BaselineStoreOptions {
  logger?: BaselineStoreLogger;
}

export class BaselineIntegrityError extends Error {
  readonly probe_id: string;
  readonly scope_id: string;

  constructor(probeId: string, scopeId: string) {
    super('baseline integrity failed');
    this.name = 'BaselineIntegrityError';
    this.probe_id = probeId;
    this.scope_id = scopeId;
  }
}

export class BaselineStore {
  readonly db: SqliteDatabase;
  private readonly hmacKey: Buffer;
  private readonly options: BaselineStoreOptions;

  constructor(db: SqliteDatabase, hmacKey: Buffer, options: BaselineStoreOptions = {}) {
    this.db = db;
    this.hmacKey = hmacKey;
    this.options = options;
  }

  set(input: BaselineSetInput): void {
    const signature = sign(this.hmacKey, input.probe_id, input.scope_id, input.expected_doc, input.captured_at);
    this.db
      .prepare(
        `INSERT INTO baseline (probe_id, scope_id, expected_doc, captured_at, captured_by, hmac)
         VALUES (@probe_id, @scope_id, @expected_doc, @captured_at, @captured_by, @hmac)
         ON CONFLICT(probe_id, scope_id) DO UPDATE SET
           expected_doc = excluded.expected_doc,
           captured_at = excluded.captured_at,
           captured_by = excluded.captured_by,
           hmac = excluded.hmac`,
      )
      .run({ ...input, hmac: signature });
    this.emit('info', {
      event: 'baseline_row_set',
      probe_id: input.probe_id,
      scope_id: input.scope_id,
    }, 'baseline row set');
  }

  get(probeId: string, scopeId: string): BaselineRow | undefined {
    const row = this.db
      .prepare(
        `SELECT probe_id, scope_id, expected_doc, captured_at, captured_by, hmac
         FROM baseline
         WHERE probe_id = ? AND scope_id = ?`,
      )
      .get(probeId, scopeId) as BaselineRow | undefined;

    if (!row) return undefined;
    if (!this.isValid(row)) {
      this.emit('error', {
        event: 'baseline_integrity_fail',
        probe_id: probeId,
        scope_id: scopeId,
      }, 'baseline row integrity check failed');
      throw new BaselineIntegrityError(probeId, scopeId);
    }
    return row;
  }

  listIntegrityFailures(): BaselineIntegrityFailure[] {
    const failures = this.db
      .prepare(
        `SELECT probe_id, scope_id, expected_doc, captured_at, captured_by, hmac
         FROM baseline
         ORDER BY probe_id ASC, scope_id ASC`,
      )
      .all()
      .filter((row): row is BaselineRow => !this.isValid(row as BaselineRow))
      .map((row) => ({ probe_id: row.probe_id, scope_id: row.scope_id }));
    for (const failure of failures) {
      this.emit('error', {
        event: 'baseline_integrity_fail',
        probe_id: failure.probe_id,
        scope_id: failure.scope_id,
      }, 'baseline row integrity check failed');
    }
    return failures;
  }

  clear(scopeId: string): void {
    const info = this.db.prepare('DELETE FROM baseline WHERE scope_id = ?').run(scopeId);
    this.emit('info', {
      event: 'baseline_clear',
      scope_id: scopeId,
      deleted_count: Number(info.changes),
    }, 'baseline rows cleared');
  }

  private isValid(row: BaselineRow): boolean {
    return verify(this.hmacKey, row.probe_id, row.scope_id, row.expected_doc, row.captured_at, row.hmac);
  }

  private emit(level: LogLevel, payload: LogPayload, message: string): void {
    this.options.logger?.[level]?.({ component: 'store.baseline', ...payload }, message);
  }
}
