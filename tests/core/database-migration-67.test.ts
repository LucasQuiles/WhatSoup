import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { trackTmpDirs } from '../helpers/tmp-dir.ts';

const tmp = trackTmpDirs('whatsoup-migration-67-');

afterEach(() => {
  vi.doUnmock('../../src/core/database-schema-version.ts');
  vi.resetModules();
});

it('records the transport identity fence without relabeling existing checkpoints', () => {
  const path = join(tmp.make('upgrade'), 'bot.db');
  const original = new Database(path);
  original.open();
  original.raw.exec(`
    INSERT INTO session_checkpoints (conversation_key, session_id)
    VALUES ('15550100001', 'existing-session');
    DELETE FROM schema_migrations WHERE version >= 67;
  `);
  const before = original.raw.prepare('SELECT * FROM session_checkpoints').all();
  original.close();
  const upgraded = new Database(path);
  upgraded.open();
  try {
    expect(upgraded.raw.prepare('SELECT version FROM schema_migrations WHERE version = 67').get())
      .toEqual({ version: 67 });
    expect(upgraded.raw.prepare('SELECT * FROM session_checkpoints').all()).toEqual(before);
  } finally {
    upgraded.close();
  }
});

it('the existing schema gate at ceiling 66 refuses the migrated file without changing it', async () => {
  const path = join(tmp.make('old-reader'), 'bot.db');
  const current = new Database(path);
  current.open();
  current.close();
  const before = readFileSync(path);
  vi.resetModules();
  vi.doMock('../../src/core/database-schema-version.ts', () => ({ CURRENT_SCHEMA_MIGRATION: 66 }));
  const { assertSchemaCeiling } = await import('../../src/core/database-compatibility.ts');
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    expect(() => assertSchemaCeiling(raw, path)).toThrowError(expect.objectContaining({ reason: 'future_schema' }));
  } finally {
    raw.close();
  }
  expect(readFileSync(path)).toEqual(before);
});
