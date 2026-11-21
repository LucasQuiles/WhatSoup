import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { INCIDENT_SCHEMA_VERSION, MIGRATIONS } from '../../../src/fleet/incidents/schema.ts';

// The flush calls are observed through node:fs in a file of their own, so the
// module mock cannot reach the main incident-db suite. fsyncSync still runs
// for real unless a test asks for a failure.
type FlushKind = 'file' | 'directory';
const flush = vi.hoisted(() => ({
  watch: null as null | { dbPath: string; copyPath: string },
  calls: [] as Array<{ kind: FlushKind; ino: number; copyLinked: boolean; liveVersion: string | undefined }>,
  failOn: null as null | FlushKind,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (flush.watch !== null) {
        const info = actual.fstatSync(fd);
        const kind: FlushKind = info.isDirectory() ? 'directory' : 'file';
        flush.calls.push({
          kind,
          ino: info.ino,
          copyLinked: actual.existsSync(flush.watch.copyPath),
          liveVersion: readMeta(flush.watch.dbPath, 'schema_version'),
        });
        if (flush.failOn === kind) {
          throw Object.assign(new Error('EIO: injected fsync failure'), { code: 'EIO' });
        }
      }
      return actual.fsyncSync(fd);
    },
  };
});

const { openIncidentDb, IncidentStoreCorruptError } = await import('../../../src/fleet/incidents/db.ts');

function readMeta(path: string, key: string): string | undefined {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

// A database at the schema version before the current one, in its own folder.
function previousVersionCase(): { root: string; dbPath: string; copyPath: string; previous: string } {
  const root = mkdtempSync(join(tmpdir(), 'whatsoup-incident-db-flush-'));
  const previous = INCIDENT_SCHEMA_VERSION - 1;
  mkdirSync(join(root, 'fleet'), { recursive: true, mode: 0o700 });
  const dbPath = join(root, 'fleet', 'incidents.db');
  const old = new DatabaseSync(dbPath);
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= previous)) {
    for (const statement of migration.statements) old.exec(statement);
  }
  old.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(previous));
  old.close();
  return { root, dbPath, copyPath: `${dbPath}.schema-v${previous}.bak`, previous: String(previous) };
}

function watching<T>(paths: { dbPath: string; copyPath: string }, failOn: FlushKind | null, run: () => T): T {
  flush.watch = paths;
  flush.calls = [];
  flush.failOn = failOn;
  try {
    return run();
  } finally {
    flush.watch = null;
    flush.failOn = null;
  }
}

describe('openIncidentDb pre-migration copy flushes', () => {
  it('flushes the copy before it is linked and the directory after, both before the migration', () => {
    const { root, dbPath, copyPath, previous } = previousVersionCase();
    try {
      watching({ dbPath, copyPath }, null, () => openIncidentDb(dbPath).close());
      expect(flush.calls).toEqual([
        { kind: 'file', ino: lstatSync(copyPath).ino, copyLinked: false, liveVersion: previous },
        { kind: 'directory', ino: statSync(join(root, 'fleet')).ino, copyLinked: true, liveVersion: previous },
      ]);
      expect(readMeta(dbPath, 'schema_version')).toBe(String(INCIDENT_SCHEMA_VERSION));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the copy cannot be flushed, before linking or migrating', () => {
    const { root, dbPath, copyPath, previous } = previousVersionCase();
    try {
      expect(() => watching({ dbPath, copyPath }, 'file', () => openIncidentDb(dbPath))).toThrow(
        IncidentStoreCorruptError,
      );
      expect(readdirSync(join(root, 'fleet')).filter((name) => name.includes('.bak'))).toEqual([]);
      expect(readMeta(dbPath, 'schema_version')).toBe(previous);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the directory cannot be flushed, and the next open keeps that copy', () => {
    const { root, dbPath, copyPath, previous } = previousVersionCase();
    try {
      expect(() => watching({ dbPath, copyPath }, 'directory', () => openIncidentDb(dbPath))).toThrow(
        IncidentStoreCorruptError,
      );
      expect(readMeta(dbPath, 'schema_version')).toBe(previous);
      const inode = lstatSync(copyPath).ino;

      openIncidentDb(dbPath).close();
      expect(lstatSync(copyPath).ino).toBe(inode);
      expect(readMeta(copyPath, 'schema_version')).toBe(previous);
      expect(readMeta(dbPath, 'schema_version')).toBe(String(INCIDENT_SCHEMA_VERSION));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
