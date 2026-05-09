import type { Database } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, type EventInput } from '../../src/store/events.ts';
import { openDatabase } from '../../src/store/connection.ts';
import { EventSchema } from '../../src/types.ts';

const dirs: string[] = [];
const dbs: Database[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'wg-events-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const database of dbs.splice(0)) {
    try {
      if (database.open) database.close();
    } catch {
      // Test cases intentionally close handles to exercise write-failure paths.
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function db(): Database {
  const database = openDatabase(':memory:');
  dbs.push(database);
  return database;
}

function store(path = join(tmp(), 'events.jsonl')): EventStore {
  return new EventStore(db(), path);
}

function drift(overrides: Partial<EventInput> = {}): EventInput {
  return {
    ts: '2026-05-08T10:00:00.000Z',
    kind: 'drift',
    domain: 'exposure',
    scope_id: 'scope-a',
    probe_id: 'probe-a',
    severity: 'high',
    fingerprint: 'a'.repeat(64),
    correlation_id: 'corr-a',
    payload: { diff: { added: ['safe.example'] } },
    ...overrides,
  };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const body = readFileSync(path, 'utf8').trim();
  if (!body) return [];
  return body.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('EventStore', () => {
  it('appends a valid event, returns id and correlation_id, and returns schema-valid query rows', () => {
    const s = store();

    const result = s.append(drift());

    expect(result.id).toBeGreaterThan(0);
    expect(result.correlation_id).toBe('corr-a');
    expect(result.mirror_failed).toBeUndefined();

    const rows = s.queryByKind('drift');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ id: result.id, correlation_id: 'corr-a' }));
    expect(EventSchema.parse(rows[0])).toEqual(rows[0]);
  });

  it('generates a correlation_id when omitted and mirrors successful primary events to jsonl', () => {
    const path = join(tmp(), 'events.jsonl');
    const s = store(path);

    const one = s.append({ ts: '2026-05-08T10:00:00.000Z', kind: 'heartbeat', payload: { ok: true } });
    const two = s.append(drift({ correlation_id: undefined, fingerprint: 'b'.repeat(64) }));

    expect(one.correlation_id).toMatch(/^evt_/);
    expect(two.correlation_id).toMatch(/^evt_/);

    const lines = readJsonl(path);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.kind)).toEqual(['heartbeat', 'drift']);
    expect(lines[0]).toEqual(expect.objectContaining({ id: one.id, correlation_id: one.correlation_id }));
    expect(lines[1]).toEqual(expect.objectContaining({ id: two.id, correlation_id: two.correlation_id }));
  });

  it('queryByKind, latestByKind, countByKindSince, and queryByFingerprintSince read SQLite state', () => {
    const path = join(tmp(), 'events.jsonl');
    const s = store(path);
    const fp = 'c'.repeat(64);

    const first = s.append(drift({ ts: '2026-05-08T09:00:00.000Z', fingerprint: fp, payload: { seq: 1 } }));
    const second = s.append(drift({ ts: '2026-05-08T10:00:00.000Z', fingerprint: fp, payload: { seq: 2 } }));
    s.append({ ts: '2026-05-08T10:30:00.000Z', kind: 'heartbeat', payload: {} });
    rmSync(path, { force: true });

    expect(s.queryByKind('drift').map((event) => event.id)).toEqual([first.id, second.id]);
    expect(s.latestByKind('drift')).toEqual(expect.objectContaining({ id: second.id, payload: { seq: 2 } }));
    expect(s.countByKindSince('drift', '2026-05-08T09:30:00.000Z')).toBe(1);
    expect(s.queryByFingerprintSince(fp, '2026-05-08T08:00:00.000Z').map((event) => event.id)).toEqual([first.id, second.id]);
  });

  it('ignores corrupt jsonl when querying SQLite', () => {
    const path = join(tmp(), 'events.jsonl');
    const s = store(path);
    const appended = s.append(drift());
    rmSync(path, { force: true });

    expect(s.latestByKind('drift')).toEqual(expect.objectContaining({ id: appended.id }));
  });

  it('records jsonl_mirror_failed in SQLite without recursion when mirror append fails', () => {
    const d = tmp();
    const s = store(d);

    const result = s.append(drift());

    expect(result.mirror_failed).toEqual(expect.objectContaining({ event_id: expect.any(Number), kind: 'jsonl_mirror_failed' }));
    expect(s.queryByKind('drift')).toHaveLength(1);
    expect(s.queryByKind('jsonl_mirror_failed')).toHaveLength(1);
    expect(s.queryByKind('jsonl_mirror_failed')[0]?.payload).toEqual(expect.objectContaining({
      original_event_id: result.id,
      original_kind: 'drift',
      error: 'jsonl mirror append failed',
    }));
  });

  it('does not mirror when SQLite rejects the primary write', () => {
    const path = join(tmp(), 'events.jsonl');
    const database = db();
    const s = new EventStore(database, path);
    database.close();

    expect(() => s.append(drift())).toThrow(/event sqlite append failed/);
    expect(existsSync(path)).toBe(false);
  });

  it('rejects malformed or non-serializable payloads with no partial SQLite row', () => {
    const s = store();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => s.append(drift({ fingerprint: 'short' }))).toThrow(/invalid event input/);
    expect(() => s.append(drift({ payload: circular }))).toThrow(/invalid event payload/);
    expect(s.queryByKind('drift')).toHaveLength(0);
  });

  it('allows duplicate fingerprints and returns them in insertion order', () => {
    const s = store();
    const fp = 'd'.repeat(64);

    const one = s.append(drift({ fingerprint: fp, payload: { seq: 1 } }));
    const two = s.append(drift({ fingerprint: fp, payload: { seq: 2 } }));

    expect(s.queryByFingerprintSince(fp, '2026-05-08T00:00:00.000Z').map((event) => event.id)).toEqual([one.id, two.id]);
  });

  it('assigns monotonic ids over looped appends', () => {
    const s = store();

    const ids = Array.from({ length: 8 }, (_, index) => s.append({
      ts: `2026-05-08T10:00:0${index}.000Z`,
      kind: 'heartbeat',
      payload: { index },
    }).id);

    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
