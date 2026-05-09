import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { canonicalize } from '../canonical.ts';
import { EventSchema, type Event, type EventKind } from '../types.ts';

export type EventInput = Omit<Event, 'id' | 'correlation_id'> & { correlation_id?: string | undefined };

export interface AppendResult {
  id: number;
  correlation_id: string;
  mirror_failed?: { event_id: number; kind: 'jsonl_mirror_failed' };
}

interface NormalizedEventInput extends Omit<Event, 'id' | 'correlation_id'> {
  correlation_id: string;
  payload: Record<string, unknown>;
}

interface EventRow {
  id: number;
  ts: string;
  kind: string;
  domain: string | null;
  scope_id: string | null;
  probe_id: string | null;
  severity: string | null;
  fingerprint: string | null;
  correlation_id: string | null;
  payload: string;
  alerted_to: string | null;
}

const INSERT_SQL = `
  INSERT INTO events (ts, kind, domain, scope_id, probe_id, severity, fingerprint, correlation_id, payload, alerted_to)
  VALUES (@ts, @kind, @domain, @scope_id, @probe_id, @severity, @fingerprint, @correlation_id, @payload, @alerted_to)
`;

export class EventStore {
  private readonly db: Database;
  private readonly jsonlPath: string;

  constructor(db: Database, jsonlPath: string) {
    this.db = db;
    this.jsonlPath = jsonlPath;
    mkdirSync(dirname(jsonlPath), { recursive: true });
  }

  append(input: EventInput): AppendResult {
    const event = this.normalizeInput(input);
    let id: number;
    try {
      id = this.insertSqlite(event);
    } catch (error) {
      throw new Error('event sqlite append failed', { cause: error });
    }

    try {
      this.mirrorJsonl({ id, ...event });
      return { id, correlation_id: event.correlation_id };
    } catch (error) {
      const failureId = this.insertMirrorFailure(event, id, error);
      return {
        id,
        correlation_id: event.correlation_id,
        mirror_failed: { event_id: failureId, kind: 'jsonl_mirror_failed' },
      };
    }
  }

  queryByKind(kind: EventKind): Event[] {
    return this.rowsToEvents(
      this.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind) as EventRow[],
    );
  }

  queryByFingerprintSince(fp: string, sinceIso: string): Event[] {
    return this.rowsToEvents(
      this.db.prepare(
        'SELECT * FROM events WHERE fingerprint = ? AND ts >= ? ORDER BY id',
      ).all(fp, sinceIso) as EventRow[],
    );
  }

  countByKindSince(kind: EventKind, sinceIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM events WHERE kind = ? AND ts >= ?')
      .get(kind, sinceIso) as { count: number };
    return row.count;
  }

  latestByKind(kind: EventKind): Event | undefined {
    const row = this.db
      .prepare('SELECT * FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1')
      .get(kind) as EventRow | undefined;
    return row ? this.rowToEvent(row) : undefined;
  }

  private normalizeInput(input: EventInput): NormalizedEventInput {
    const correlationId = input.correlation_id ?? `evt_${randomUUID()}`;
    const payloadJson = this.serializePayload(input.payload);
    const event = {
      ...input,
      correlation_id: correlationId,
      payload: JSON.parse(payloadJson) as Record<string, unknown>,
    };
    const parsed = EventSchema.omit({ id: true }).safeParse(event);
    if (!parsed.success) throw new Error('invalid event input');
    return parsed.data as NormalizedEventInput;
  }

  private serializePayload(payload: Record<string, unknown>): string {
    try {
      return canonicalize(payload);
    } catch (error) {
      throw new Error('invalid event payload', { cause: error });
    }
  }

  private insertSqlite(event: NormalizedEventInput): number {
    const payload = this.serializePayload(event.payload);
    const info = this.db.prepare(INSERT_SQL).run({
      ts: event.ts,
      kind: event.kind,
      domain: event.domain ?? null,
      scope_id: event.scope_id ?? null,
      probe_id: event.probe_id ?? null,
      severity: event.severity ?? null,
      fingerprint: event.fingerprint ?? null,
      correlation_id: event.correlation_id,
      payload,
      alerted_to: event.alerted_to ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  private mirrorJsonl(event: Event): void {
    appendFileSync(this.jsonlPath, `${JSON.stringify(event)}\n`);
  }

  private insertMirrorFailure(original: NormalizedEventInput, originalId: number, error: unknown): number {
    const failure: NormalizedEventInput = {
      ts: original.ts,
      kind: 'jsonl_mirror_failed',
      severity: 'low',
      correlation_id: original.correlation_id,
      payload: {
        original_event_id: originalId,
        original_kind: original.kind,
        error: 'jsonl mirror append failed',
        sink: basename(this.jsonlPath),
        error_name: error instanceof Error ? error.name : 'unknown',
      },
    };
    return this.insertSqlite(failure);
  }

  private rowsToEvents(rows: EventRow[]): Event[] {
    return rows.map((row) => this.rowToEvent(row));
  }

  private rowToEvent(row: EventRow): Event {
    const event: Record<string, unknown> = {
      id: row.id,
      ts: row.ts,
      kind: row.kind,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    };
    for (const [key, value] of [
      ['domain', row.domain],
      ['scope_id', row.scope_id],
      ['probe_id', row.probe_id],
      ['severity', row.severity],
      ['fingerprint', row.fingerprint],
      ['correlation_id', row.correlation_id],
      ['alerted_to', row.alerted_to],
    ] as const) {
      if (value !== null) event[key] = value;
    }
    return EventSchema.parse(event);
  }
}
