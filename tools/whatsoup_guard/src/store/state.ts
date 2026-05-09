import type { Database } from 'better-sqlite3';

interface RuntimeStateRow {
  value: string;
}

export class RuntimeStateStore {
  constructor(private readonly db: Database) {}

  get(key: string): string | undefined {
    assertKey(key);
    const row = this.db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(key) as RuntimeStateRow | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    assertKey(key);
    this.db.prepare(`
      INSERT INTO runtime_state (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
}

function assertKey(key: string): void {
  if (key.trim().length === 0) throw new Error('runtime state key must not be empty');
}
