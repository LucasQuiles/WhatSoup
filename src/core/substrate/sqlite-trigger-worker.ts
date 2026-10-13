// Isolated read-only executor for poll.sqlite triggers. The parent owns the
// deadline and process lifecycle; this child owns only a bounded JSON request
// and a bounded, content-free result.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { TRIGGER_BUDGETS, type SqliteJsonBind } from './trigger-budgets.ts';

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

function emit(reply: Reply): void {
  const encoded = JSON.stringify(reply);
  if (Buffer.byteLength(encoded, 'utf8') > TRIGGER_BUDGETS.maxWorkerStdoutBytes) {
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

function rowBytes(row: Record<string, unknown>): number | null {
  let bytes = 2;
  for (const [key, value] of Object.entries(row)) {
    bytes += Buffer.byteLength(key, 'utf8') + 4;
    if (value === null) {
      bytes += 4;
    } else if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf8') + 2;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      bytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
    } else if (value instanceof Uint8Array) {
      bytes += value.byteLength;
    } else {
      return null;
    }
    if (bytes > TRIGGER_BUDGETS.maxSqliteOutputBytes) return bytes;
  }
  return bytes;
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
    db = new DatabaseSync(request.databasePath, { readOnly: true, timeout: 5_000 });
    databaseOpened = true;
    const stmt = db.prepare(request.sql);
    let rowCount = 0;
    for (const row of stmt.iterate(...request.binds as SQLInputValue[])) {
      rowCount++;
      if (rowCount > request.maxRows) {
        emit({ status: 'resource_exhausted', limit: 'rows' });
        return;
      }
      const bytes = rowBytes(row as Record<string, unknown>);
      if (bytes === null || bytes > request.maxOutputBytes) {
        emit({ status: 'resource_exhausted', limit: 'output' });
        return;
      }
    }
    // The aggregate result is the fixed `{rowCount}` protocol, independently
    // capped in emit(). Individual rows are never serialized into the response.
    emit({ status: 'ok', rowCount });
  } catch {
    // Query failures are distinct from a budget hit. Never include the query,
    // bind values, SQLite error, or response data in the cross-process reply.
    emit(databaseOpened ? { status: 'sql_error' } : { status: 'unavailable' });
  } finally {
    try { db?.close(); } catch { /* process exit releases the read-only handle */ }
  }
}

void main();
