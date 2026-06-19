import { describe, it, expect, afterAll, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { Database } from '../../../src/core/database.ts';
import {
  ensureHandoffArtifactSchema,
  upsertHandoffArtifact,
  getHandoffArtifact,
  deleteHandoffArtifact,
  type HandoffArtifact,
} from '../../../src/runtimes/agent/handoff-artifact.ts';

const dbPath = join(tmpdir(), `whatsoup-handoff-test-${randomBytes(4).toString('hex')}.db`);
const db = new Database(dbPath);
db.open();
ensureHandoffArtifactSchema(db);

afterAll(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

function artifact(over: Partial<HandoffArtifact> = {}): HandoffArtifact {
  return {
    conversationKey: 'conv-1',
    summary: 'debugging fallback handoff',
    seededArtifacts: 'open PRs: #1',
    updatedAt: 1_781_000_000_000,
    sourceProvider: 'claude-cli',
    sourceModel: 'claude-opus-4-8',
    tokenBaseline: 1234,
    ...over,
  };
}

describe('handoff-artifact store', () => {
  it('round-trips an artifact through upsert/get', () => {
    upsertHandoffArtifact(db, artifact({ conversationKey: 'rt' }));
    expect(getHandoffArtifact(db, 'rt')).toEqual(artifact({ conversationKey: 'rt' }));
  });

  it('upsert replaces an existing row by conversation_key', () => {
    upsertHandoffArtifact(db, artifact({ conversationKey: 'ov', summary: 'first', updatedAt: 1 }));
    upsertHandoffArtifact(db, artifact({ conversationKey: 'ov', summary: 'second', updatedAt: 2 }));
    const got = getHandoffArtifact(db, 'ov');
    expect(got?.summary).toBe('second');
    expect(got?.updatedAt).toBe(2);
  });

  it('preserves null summary / seeded / model', () => {
    upsertHandoffArtifact(db, artifact({ conversationKey: 'nulls', summary: null, seededArtifacts: null, sourceModel: null }));
    const got = getHandoffArtifact(db, 'nulls');
    expect(got).toMatchObject({ summary: null, seededArtifacts: null, sourceModel: null });
  });

  it('returns null for a missing conversation', () => {
    expect(getHandoffArtifact(db, 'does-not-exist')).toBeNull();
  });

  it('deletes an artifact (idempotently)', () => {
    upsertHandoffArtifact(db, artifact({ conversationKey: 'del' }));
    expect(getHandoffArtifact(db, 'del')).not.toBeNull();
    deleteHandoffArtifact(db, 'del');
    expect(getHandoffArtifact(db, 'del')).toBeNull();
    // Deleting again is a no-op, not an error.
    expect(() => deleteHandoffArtifact(db, 'del')).not.toThrow();
    expect(getHandoffArtifact(db, 'del')).toBeNull();
  });

  it('ensureHandoffArtifactSchema is idempotent', () => {
    expect(() => {
      ensureHandoffArtifactSchema(db);
      ensureHandoffArtifactSchema(db);
    }).not.toThrow();
    // Table still usable after re-ensuring.
    upsertHandoffArtifact(db, artifact({ conversationKey: 'after-reensure' }));
    expect(getHandoffArtifact(db, 'after-reensure')?.tokenBaseline).toBe(1234);
  });
});

describe('residual-branch coverage', () => {
  // handoff-artifact.ts line 45 — `tokenBaseline: Number(row['token_baseline'] ?? 0)`
  // The NOT NULL DEFAULT 0 column in the schema means a real SQLite row never
  // surfaces `null`, so we feed `rowToArtifact` directly via a mock prepare/get
  // chain to exercise the `?? 0` fallback path.
  it('falls back to 0 when stored token_baseline is null', () => {
    const getFn = vi.fn().mockReturnValue({
      conversation_key: 'null-baseline',
      summary: null,
      seeded_artifacts: null,
      updated_at: 1_781_000_000_000,
      source_provider: 'claude-cli',
      source_model: null,
      token_baseline: null,
    });
    const prepareFn = vi.fn().mockReturnValue({ get: getFn });
    const mockDb = { raw: { prepare: prepareFn } } as unknown as Database;

    const result = getHandoffArtifact(mockDb, 'null-baseline');

    expect(prepareFn).toHaveBeenCalledWith(
      'SELECT * FROM agent_handoff_artifacts WHERE conversation_key = ?',
    );
    expect(getFn).toHaveBeenCalledWith('null-baseline');
    expect(result?.tokenBaseline).toBe(0);
  });
});
