// Isolated read-only executor for poll.sqlite triggers. The parent owns the
// deadline and process lifecycle; this child owns only a bounded JSON request
// and a bounded, content-free result.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SQLITE_BUSY_TIMEOUT_MS } from '../../lib/sqlite-constants.ts';
import {
  TRIGGER_BUDGETS,
  isSafeSqliteSql,
  sqliteBoundedCountQuery,
  type SqliteJsonBind,
} from './trigger-budgets.ts';

interface Request {
  databasePath: string;
  sql: string;
  binds: SqliteJsonBind[];
  maxRows: number;
  maxOutputBytes: number;
}

type Reply =
  | { status: 'ok'; rowCount: number }
  | { status: 'resource_exhausted'; limit: 'rows' | 'output' }
  | { status: 'sql_error' }
  | { status: 'unavailable' };

function emit(reply: Reply, maxOutputBytes: number): void {
  const encoded = JSON.stringify(reply);
  if (Buffer.byteLength(encoded, 'utf8') > Math.min(maxOutputBytes, TRIGGER_BUDGETS.maxWorkerStdoutBytes)) {
    process.exitCode = 70;
    return;
  }
  process.stdout.write(encoded);
}

function isJsonBind(value: unknown): value is SqliteJsonBind {
  return value === null
    || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function boundedBindBytes(binds: readonly SqliteJsonBind[]): boolean {
  if (binds.length > TRIGGER_BUDGETS.maxSqliteBinds) return false;
  let total = 0;
  for (const bind of binds) {
    const bytes = Buffer.byteLength(JSON.stringify(bind), 'utf8');
    if (bytes > TRIGGER_BUDGETS.maxSqliteBindBytes) return false;
    total += bytes;
    if (total > TRIGGER_BUDGETS.maxSqliteBindPayloadBytes) return false;
  }
  return true;
}

async function readRequest(): Promise<Request | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > TRIGGER_BUDGETS.maxWorkerStdinBytes) return null;
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<Request>;
    const maxRows = parsed.maxRows;
    const maxOutputBytes = parsed.maxOutputBytes;
    if (
      typeof parsed.databasePath !== 'string'
      || typeof parsed.sql !== 'string'
      || !Array.isArray(parsed.binds)
      || typeof maxRows !== 'number'
      || !Number.isInteger(maxRows)
      || maxRows <= 0
      || maxRows > TRIGGER_BUDGETS.maxSqliteRows
      || typeof maxOutputBytes !== 'number'
      || !Number.isInteger(maxOutputBytes)
      || maxOutputBytes <= 0
      || maxOutputBytes > TRIGGER_BUDGETS.maxSqliteOutputBytes
      || Buffer.byteLength(parsed.sql, 'utf8') > TRIGGER_BUDGETS.maxSqlBytes
      || !isSafeSqliteSql(parsed.sql)
      || !parsed.binds.every(isJsonBind)
      || !boundedBindBytes(parsed.binds)
    ) return null;
    return {
      databasePath: parsed.databasePath,
      sql: parsed.sql,
      binds: parsed.binds,
      maxRows,
      maxOutputBytes,
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const request = await readRequest();
  if (!request) {
    process.exitCode = 64;
    return;
  }

  let db: DatabaseSync | undefined;
  let databaseOpened = false;
  try {
    // This connection cannot persist writes. The parent checks the original
    // connection's main-database location before it grants this path.
    db = new DatabaseSync(request.databasePath, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
    databaseOpened = true;
    const countSql = sqliteBoundedCountQuery(request.sql, request.maxRows);
    if (!countSql) {
      emit({ status: 'sql_error' }, request.maxOutputBytes);
      return;
    }
    const row = db.prepare(countSql).get(...request.binds as SQLInputValue[]) as { row_count?: unknown } | undefined;
    const rawCount = row?.row_count;
    const rowCount = typeof rawCount === 'bigint'
      ? (rawCount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(rawCount) : null)
      : (typeof rawCount === 'number' && Number.isSafeInteger(rawCount) ? rawCount : null);
    if (rowCount === null || rowCount < 0) {
      emit({ status: 'resource_exhausted', limit: 'output' }, request.maxOutputBytes);
      return;
    }
    if (rowCount > request.maxRows) {
      emit({ status: 'resource_exhausted', limit: 'rows' }, request.maxOutputBytes);
      return;
    }
    // The fixed scalar reply is the independent output budget. Caller-selected
    // rows are never materialized by JavaScript or serialized across IPC.
    emit({ status: 'ok', rowCount }, request.maxOutputBytes);
  } catch {
    // Query failures are distinct from a budget hit. Never include the query,
    // bind values, SQLite error, or response data in the cross-process reply.
    emit(databaseOpened ? { status: 'sql_error' } : { status: 'unavailable' }, request.maxOutputBytes);
  } finally {
    try { db?.close(); } catch { /* intentional: process exit releases the already read-only database handle */ }
  }
}

void main();
