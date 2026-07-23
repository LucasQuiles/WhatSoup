import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/store/connection.ts';
import { EventStore } from '../../src/store/events.ts';
import { MuteStore, type MuteCreateInput } from '../../src/store/mutes.ts';
import { MuteSchema } from '../../src/types.ts';

const NOW = new Date('2026-05-08T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const dbs: Database[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): Database {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}

function freshStore(options: ConstructorParameters<typeof MuteStore>[1] = {}): MuteStore {
  const db = freshDb();
  return new MuteStore(db, { now: () => NOW, ...options });
}

function freshEvents(db: Database): EventStore {
  const dir = mkdtempSync(join(tmpdir(), 'wg-mutes-'));
  dirs.push(dir);
  return new EventStore(db, join(dir, 'events.jsonl'));
}

function input(overrides: Partial<MuteCreateInput> = {}): MuteCreateInput {
  return {
    host: 'scope-a',
    domain: 'exposure',
    expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
    reason: 'maintenance',
    created_by: 'operator',
    ...overrides,
  };
}

describe('MuteStore', () => {
  it('creates a mute and lists active rows in deterministic expiry order', () => {
    const store = freshStore();
    const later = store.create(input({ host: 'scope-later', expires_at: new Date(NOW.getTime() + 3 * HOUR).toISOString() }));
    const earlier = store.create(input({ host: 'scope-earlier', expires_at: new Date(NOW.getTime() + HOUR).toISOString() }));

    const active = store.listActive(NOW.toISOString());

    expect(active.map((mute) => mute.id)).toEqual([earlier, later]);
    expect(active.map((mute) => MuteSchema.parse(mute).id)).toEqual([earlier, later]);
  });

  it('appends mute_set when a mute is created with an event store', () => {
    const db = freshDb();
    const events = freshEvents(db);
    const store = new MuteStore(db, { now: () => NOW, events });

    const id = store.create(input({ reason: 'maintenance window' }));

    expect(id).toBeGreaterThan(0);
    expect(events.queryByKind('mute_set')[0]?.payload).toMatchObject({
      mute_id: id,
      host: 'scope-a',
      domain: 'exposure',
      expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
      reason: 'maintenance window',
      created_by: 'operator',
    });
  });

  it('rolls back the active mute row when mute_set audit append fails', () => {
    const db = freshDb();
    const failingEvents = {
      append: () => {
        throw new Error('audit append failed');
      },
    } as unknown as EventStore;
    const store = new MuteStore(db, { now: () => NOW, events: failingEvents });

    expect(() => store.create(input())).toThrow('audit append failed');
    expect(store.listActive(NOW.toISOString())).toHaveLength(0);
  });

  it('appends mute_expire for mutes crossing the expiration window', () => {
    const db = freshDb();
    const events = freshEvents(db);
    const store = new MuteStore(db, { now: () => NOW, events });
    const id = store.create(input({ expires_at: new Date(NOW.getTime() + 2 * HOUR).toISOString() }));

    const expired = store.recordExpirations(
      new Date(NOW.getTime() + HOUR).toISOString(),
      new Date(NOW.getTime() + 3 * HOUR).toISOString(),
    );

    expect(expired.map((mute) => mute.id)).toEqual([id]);
    expect(events.queryByKind('mute_expire')[0]?.payload).toMatchObject({
      mute_id: id,
      host: 'scope-a',
      domain: 'exposure',
      expired_at: new Date(NOW.getTime() + 2 * HOUR).toISOString(),
    });
  });

  it('excludes expired mutes from active list', () => {
    const store = freshStore();
    store.create(input({ expires_at: new Date(NOW.getTime() + HOUR).toISOString() }));

    expect(store.listActive(new Date(NOW.getTime() + 2 * HOUR).toISOString())).toHaveLength(0);
  });

  it('returns expired mutes for the half-open expiry window', () => {
    const store = freshStore();
    const atPrev = store.create(input({ host: 'at-prev', expires_at: new Date(NOW.getTime() + HOUR).toISOString() }));
    const inside = store.create(input({ host: 'inside', expires_at: new Date(NOW.getTime() + 2 * HOUR).toISOString() }));
    const atNow = store.create(input({ host: 'at-now', expires_at: new Date(NOW.getTime() + 3 * HOUR).toISOString() }));

    const expired = store.listExpiredSince(
      new Date(NOW.getTime() + HOUR).toISOString(),
      new Date(NOW.getTime() + 3 * HOUR).toISOString(),
    );

    expect(expired.map((mute) => mute.id)).toEqual([inside, atNow]);
    expect(expired.map((mute) => mute.id)).not.toContain(atPrev);
  });

  it('round-trips allow_revert_suppression default false and explicit true', () => {
    const store = freshStore();
    const normal = store.create(input({ host: 'normal' }));
    const explicit = store.create(input({ host: 'explicit', allow_revert_suppression: true }));

    const active = store.listActive(NOW.toISOString());

    expect(active.find((mute) => mute.id === normal)?.allow_revert_suppression).toBe(false);
    expect(active.find((mute) => mute.id === explicit)?.allow_revert_suppression).toBe(true);
  });

  it('delete removes one row and is idempotent for missing ids', () => {
    const store = freshStore();
    const one = store.create(input({ host: 'one' }));
    const two = store.create(input({ host: 'two' }));

    store.delete(one);
    store.delete(999_999);

    expect(store.listActive(NOW.toISOString()).map((mute) => mute.id)).toEqual([two]);
  });

  it('rejects empty and whitespace-only fields', () => {
    const store = freshStore();

    for (const key of ['host', 'domain', 'reason', 'created_by'] as const) {
      expect(() => store.create(input({ [key]: '  ' }))).toThrow(new RegExp(key));
    }
  });

  it('rejects invalid, current, past, and overlong expiry timestamps', () => {
    const store = freshStore({ maxDurationMs: 2 * HOUR });

    expect(() => store.create(input({ expires_at: 'bad-date' }))).toThrow(/ISO timestamp/);
    expect(() => store.create(input({ expires_at: NOW.toISOString() }))).toThrow(/future/);
    expect(() => store.create(input({ expires_at: new Date(NOW.getTime() - 1).toISOString() }))).toThrow(/future/);
    expect(() => store.create(input({ expires_at: new Date(NOW.getTime() + 3 * HOUR).toISOString() }))).toThrow(/maximum/);
  });

  it('reports the requested and maximum duration truthfully on rejection, never silently clamping', () => {
    const store = freshStore({ maxDurationMs: 2 * HOUR });

    expect(() => store.create(input({ expires_at: new Date(NOW.getTime() + 3 * HOUR).toISOString() })))
      .toThrow('mute duration exceeds maximum (requested 3h, max 2h)');
    expect(store.listActive(NOW.toISOString())).toHaveLength(0);
  });

  it('accepts a policy-derived 72h maxDurationMs while a 24h store still rejects the same request', () => {
    const permissive = freshStore({ maxDurationMs: 72 * HOUR });
    const strict = freshStore({ maxDurationMs: 24 * HOUR });
    const seventyTwoHours = input({ expires_at: new Date(NOW.getTime() + 72 * HOUR).toISOString() });

    expect(permissive.create(seventyTwoHours)).toBeGreaterThan(0);
    expect(() => strict.create(seventyTwoHours)).toThrow('mute duration exceeds maximum (requested 3d, max 1d)');
  });

  it('rejects forbidden domains by default', () => {
    const store = freshStore();

    expect(() => store.create(input({ domain: 'alerting' }))).toThrow(/forbidden/);
  });

  it('always rejects alerting even when policy forbidden domains are empty', () => {
    const store = freshStore({ forbiddenDomains: [] });

    expect(() => store.create(input({ domain: 'alerting' }))).toThrow(/forbidden/);
  });

  it('also rejects policy-declared forbidden domains', () => {
    const store = freshStore({ forbiddenDomains: ['change'] });

    expect(() => store.create(input({ domain: 'change' }))).toThrow(/forbidden/);
  });

  it('requires explicit opt-in for wildcard storage', () => {
    const strict = freshStore();
    expect(() => strict.create(input({ host: '*' }))).toThrow(/wildcard/);
    expect(() => strict.create(input({ domain: '*' }))).toThrow(/wildcard/);

    const wildcard = freshStore({ allowWildcard: true });
    const id = wildcard.create(input({ host: '*', domain: '*' }));
    expect(wildcard.listActive(NOW.toISOString()).map((mute) => mute.id)).toEqual([id]);
  });

  it('allows duplicate and overlapping mutes but lists them deterministically', () => {
    const store = freshStore();
    const expiresAt = new Date(NOW.getTime() + HOUR).toISOString();
    const one = store.create(input({ expires_at: expiresAt }));
    const two = store.create(input({ expires_at: expiresAt }));

    expect(store.listActive(NOW.toISOString()).map((mute) => mute.id)).toEqual([one, two]);
  });
});
