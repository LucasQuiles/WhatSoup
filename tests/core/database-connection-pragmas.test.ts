import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../src/core/database.ts';

// Instance databases are 240-740 MB. SQLite's default 2 MiB page cache made
// every hot query re-read its pages through pread (~6k/s in production), so open()
// sizes the per-connection cache explicitly.

describe('Database.open() connection pragmas', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('sizes the page cache at 32 MiB on a file-backed instance database', () => {
    dir = mkdtempSync(join(tmpdir(), 'ws-pragmas-'));
    const db = new Database(join(dir, 'bot.db'));
    db.open();
    try {
      const row = db.raw.prepare('PRAGMA cache_size').get() as { cache_size: number };
      // Negative = KiB, so the cache is a byte budget independent of page size.
      expect(row.cache_size).toBe(-32768);
    } finally {
      db.close();
    }
  });
});
