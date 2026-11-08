// Regression for PR #3876: the realtime poller must release a marker handle
// when discovery stops returning that instance, while preserving live handles.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FleetDbReader } from '../../src/fleet/db-reader.ts';
import { FleetRealtimeEventPoller } from '../../src/fleet/realtime-event-poller.ts';
import type { FleetRealtimePublisher } from '../../src/fleet/realtime-publisher.ts';

const SCHEMA = `
  CREATE TABLE messages (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_key TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE TABLE access_list (
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_at TEXT,
    decided_at TEXT,
    PRIMARY KEY (subject_type, subject_id)
  );
`;

function createInstanceDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO messages (conversation_key, updated_at) VALUES ('chat', '2026-11-07T00:00:00.000Z')",
  ).run();
  return db;
}

function instance(name: string, dbPath: string, root: string) {
  return { name, dbPath, logDir: join(root, `${name}-logs`), healthPort: 0 };
}

function publisher(): FleetRealtimePublisher {
  return { publish: vi.fn() } as FleetRealtimePublisher;
}

function observeMarkerPreparation() {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const handles: DatabaseSync[] = [];
  let markerReads = 0;
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === 'PRAGMA data_version') handles.push(this);
    if (sql.includes('SELECT MAX(pk) AS pk')) markerReads += 1;
    return originalPrepare.call(this, sql);
  });
  return { handles, markerReads: () => markerReads };
}

describe('FleetRealtimeEventPoller marker-handle lifecycle', () => {
  let root: string | null = null;
  let selfDb: DatabaseSync | null = null;
  let writers: DatabaseSync[] = [];
  let reader: FleetDbReader | null = null;
  let poller: FleetRealtimeEventPoller | null = null;

  afterEach(() => {
    try {
      poller?.stop();
      reader?.close();
      for (const writer of writers) if (writer.isOpen) writer.close();
      if (selfDb?.isOpen) selfDb.close();
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
      vi.restoreAllMocks();
      root = null;
      selfDb = null;
      writers = [];
      reader = null;
      poller = null;
    }
  });

  it('closes only a removed remote marker handle while retained and self readers remain usable', async () => {
    root = mkdtempSync(join(tmpdir(), 'fleet-marker-lifecycle-'));
    selfDb = new DatabaseSync(':memory:');
    selfDb.exec(SCHEMA);
    selfDb.prepare(
      "INSERT INTO messages (conversation_key, updated_at) VALUES ('self-chat', '2026-11-07T00:00:00.000Z')",
    ).run();
    const retainedPath = join(root, 'retained.db');
    const removedPath = join(root, 'removed.db');
    writers = [createInstanceDatabase(retainedPath), createInstanceDatabase(removedPath)];
    const instances = new Map([
      ['retained', instance('retained', retainedPath, root)],
      ['removed', instance('removed', removedPath, root)],
    ]);
    reader = new FleetDbReader('self', selfDb);
    poller = new FleetRealtimeEventPoller(
      { discovery: { getInstances: () => new Map(instances) } as never, dbReader: reader, realtime: publisher() },
    );
    const observed = observeMarkerPreparation();
    const close = vi.spyOn(DatabaseSync.prototype, 'close');

    await poller.poll();
    expect(observed.handles).toHaveLength(2);
    const [retainedHandle, removedHandle] = observed.handles;

    instances.delete('removed');
    await poller.poll();

    expect(close.mock.contexts.includes(removedHandle)).toBe(true);
    expect(removedHandle.isOpen).toBe(false);
    expect(close.mock.contexts.includes(retainedHandle)).toBe(false);
    expect(retainedHandle.isOpen).toBe(true);
    expect(close.mock.contexts.includes(selfDb)).toBe(false);
    expect(selfDb.isOpen).toBe(true);
    expect(reader.getLatestMarkers('retained', retainedPath)).toMatchObject({ ok: true });
    expect(reader.getLatestMarkers('self', '')).toMatchObject({ ok: true });
  });

  it('recalculates markers when a removed instance returns at the same path', async () => {
    root = mkdtempSync(join(tmpdir(), 'fleet-marker-lifecycle-'));
    selfDb = new DatabaseSync(':memory:');
    selfDb.exec(SCHEMA);
    const temporaryPath = join(root, 'temporary.db');
    writers = [createInstanceDatabase(temporaryPath)];
    const instances = new Map([['temporary', instance('temporary', temporaryPath, root)]]);
    reader = new FleetDbReader('self', selfDb);
    poller = new FleetRealtimeEventPoller(
      { discovery: { getInstances: () => new Map(instances) } as never, dbReader: reader, realtime: publisher() },
    );
    const observed = observeMarkerPreparation();

    await poller.poll();
    expect(observed.markerReads()).toBe(1);

    instances.delete('temporary');
    await poller.poll();
    instances.set('temporary', instance('temporary', temporaryPath, root));
    await poller.poll();

    expect(observed.markerReads()).toBe(2);
  });

  it('closes a shared marker handle only after its last discovered alias disappears', async () => {
    root = mkdtempSync(join(tmpdir(), 'fleet-marker-lifecycle-'));
    selfDb = new DatabaseSync(':memory:');
    selfDb.exec(SCHEMA);
    const sharedPath = join(root, 'shared.db');
    writers = [createInstanceDatabase(sharedPath)];
    const instances = new Map([
      ['first', instance('first', sharedPath, root)],
      ['second', instance('second', sharedPath, root)],
    ]);
    reader = new FleetDbReader('self', selfDb);
    poller = new FleetRealtimeEventPoller(
      { discovery: { getInstances: () => new Map(instances) } as never, dbReader: reader, realtime: publisher() },
    );
    const observed = observeMarkerPreparation();

    await poller.poll();
    const [sharedHandle] = observed.handles;
    expect(new Set(observed.handles).size).toBe(1);
    instances.delete('first');
    await poller.poll();
    expect(sharedHandle.isOpen).toBe(true);
    expect(observed.markerReads()).toBe(1);
    instances.delete('second');
    await poller.poll();
    expect(sharedHandle.isOpen).toBe(false);
    expect(selfDb.isOpen).toBe(true);
  });

  it('keeps remote marker handles when discovery fails', async () => {
    root = mkdtempSync(join(tmpdir(), 'fleet-marker-lifecycle-'));
    selfDb = new DatabaseSync(':memory:');
    selfDb.exec(SCHEMA);
    const remotePath = join(root, 'remote.db');
    writers = [createInstanceDatabase(remotePath)];
    let discoveryFailed = false;
    const discovery = {
      getInstances: () => {
        if (discoveryFailed) throw new Error('discovery unavailable');
        return new Map([['remote', instance('remote', remotePath, root!)]]);
      },
    };
    reader = new FleetDbReader('self', selfDb);
    poller = new FleetRealtimeEventPoller(
      { discovery: discovery as never, dbReader: reader, realtime: publisher() },
    );
    const observed = observeMarkerPreparation();

    await poller.poll();
    const [remoteHandle] = observed.handles;
    discoveryFailed = true;
    await expect(poller.poll()).rejects.toThrow('discovery unavailable');
    expect(remoteHandle.isOpen).toBe(true);
    expect(reader.getLatestMarkers('remote', remotePath)).toMatchObject({ ok: true });
    expect(observed.markerReads()).toBe(1);
  });
});
