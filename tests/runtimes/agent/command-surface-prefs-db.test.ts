/**
 * Unit tests for the per-sender command-surface preference store (W1-T9a).
 *
 * Mirrors chat-preference-db.test.ts construction (real Database, temp file,
 * cleanup after each test) and its contract: composite (chat_jid, sender_jid)
 * key, idempotent upserts, fail-safe load validation (a corrupt row reads
 * back as null, never as garbage). Additionally covers BOTH first-touch
 * cases the SELF-MANAGED schema must support: a virgin db (table never
 * existed — lazy creation) and a db whose table already exists (idempotent
 * re-open, including across a fresh connection to the same file).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import {
  ensureCommandSurfacePrefsSchema,
  getSurfacePrefs,
  setSurfacePrefs,
  clearSurfacePrefs,
  type UserSurfacePrefs,
} from '../../../src/runtimes/agent/command-surface-prefs-db.ts';

const NOW = 1_500;

const CHAT_A = '111222333@g.us';
const CHAT_B = '444555666@g.us';
const SENDER_A = '15550000001@s.whatsapp.net';
const SENDER_B = '15550000002@s.whatsapp.net';

function prefs(overrides: Partial<UserSurfacePrefs> = {}): UserSurfacePrefs {
  return {
    hidden: ['status'],
    verbosity: 'terse',
    locale: 'en-US',
    optionDefaults: { model: { provider: 'claude-cli' } },
    ...overrides,
  };
}

function tmpDbPath(): string {
  return join(tmpdir(), `command-surface-prefs-test-${randomBytes(6).toString('hex')}.db`);
}

function cleanupDbFile(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = path + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
}

let dbPath: string;
let db: Database;

beforeEach(() => {
  dbPath = tmpDbPath();
  db = new Database(dbPath);
  ensureCommandSurfacePrefsSchema(db);
});

afterEach(() => {
  db.close();
  cleanupDbFile(dbPath);
});

describe('ensureCommandSurfacePrefsSchema — first-touch cases', () => {
  it('lazy creation: a db where the table has never existed gets it created on first call', () => {
    const freshPath = tmpDbPath();
    const freshDb = new Database(freshPath);
    try {
      // No prior ensureCommandSurfacePrefsSchema call against this db/file —
      // this is the true virgin-table path (the module-level beforeEach
      // already primed `db`, so this proves the path independently).
      const tableCountBefore = freshDb.raw
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'command_surface_prefs'`)
        .get() as { n: number };
      expect(tableCountBefore.n).toBe(0);

      expect(() => ensureCommandSurfacePrefsSchema(freshDb)).not.toThrow();
      setPrefsAndAssert(freshDb);
    } finally {
      freshDb.close();
      cleanupDbFile(freshPath);
    }
  });

  it('idempotent re-open: a db whose schema already exists tolerates a second ensure call (same connection)', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    expect(() => ensureCommandSurfacePrefsSchema(db)).not.toThrow();
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toEqual(prefs());
  });

  it('idempotent re-open: a fresh connection to a file whose table already exists does not throw or lose data', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    db.close(); // Database.close() is idempotent — the outer afterEach's db.close() is a safe no-op after this.

    // Re-open the SAME file with a brand-new Database/connection — the table
    // already exists on disk from the prior connection's CREATE TABLE.
    const reopened = new Database(dbPath);
    try {
      expect(() => ensureCommandSurfacePrefsSchema(reopened)).not.toThrow();
      expect(getSurfacePrefs(reopened, CHAT_A, SENDER_A)).toEqual(prefs());
    } finally {
      reopened.close();
    }
  });
});

function setPrefsAndAssert(target: Database): void {
  setSurfacePrefs(target, CHAT_A, SENDER_A, prefs(), NOW);
  expect(getSurfacePrefs(target, CHAT_A, SENDER_A)).toEqual(prefs());
}

describe('set/get roundtrip', () => {
  it('returns exactly what was stored', () => {
    const p = prefs();
    setSurfacePrefs(db, CHAT_A, SENDER_A, p, NOW);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toEqual(p);
  });

  it('returns null when no row exists', () => {
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toBeNull();
  });

  it('round-trips a minimal prefs object (all fields optional)', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, {}, NOW);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toEqual({});
  });

  it('hidden naming an unknown/non-catalog command is stored but harmless (resolution ignores it)', () => {
    const p = prefs({ hidden: ['not-a-real-command', 'status'] });
    setSurfacePrefs(db, CHAT_A, SENDER_A, p, NOW);
    // The store itself has no opinion on catalog membership — it persists
    // whatever the caller passed. Filtering against the T1 catalog happens
    // in resolveCommandSurface (T9b), not here.
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)?.hidden).toEqual(['not-a-real-command', 'status']);
  });
});

describe('per-sender isolation (group-bleed guard)', () => {
  it('sender A prefs are invisible to sender B in the same chat', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_B)).toBeNull();
  });

  it('and invisible to the same sender in another chat', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    expect(getSurfacePrefs(db, CHAT_B, SENDER_A)).toBeNull();
  });

  it('two senders in one chat hold independent prefs', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs({ verbosity: 'terse' }), NOW);
    setSurfacePrefs(db, CHAT_A, SENDER_B, prefs({ verbosity: 'normal' }), NOW);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)?.verbosity).toBe('terse');
    expect(getSurfacePrefs(db, CHAT_A, SENDER_B)?.verbosity).toBe('normal');
  });
});

describe('idempotent upsert', () => {
  it('repeated identical writes converge to one row', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    const rows = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM command_surface_prefs WHERE chat_jid = ? AND sender_jid = ?`)
      .get(CHAT_A, SENDER_A) as { n: number };
    expect(rows.n).toBe(1);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toEqual(prefs());
  });

  it('a later write replaces the earlier one (last write wins)', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs({ verbosity: 'terse' }), 1_000);
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs({ verbosity: 'normal' }), 1_500);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)?.verbosity).toBe('normal');
  });
});

describe('clearSurfacePrefs', () => {
  it('removes the row and is idempotent', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    clearSurfacePrefs(db, CHAT_A, SENDER_A);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toBeNull();
    expect(() => clearSurfacePrefs(db, CHAT_A, SENDER_A)).not.toThrow();
  });

  it('only clears the addressed (chat, sender) pair', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    setSurfacePrefs(db, CHAT_A, SENDER_B, prefs({ verbosity: 'normal' }), NOW);
    clearSurfacePrefs(db, CHAT_A, SENDER_A);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_B)?.verbosity).toBe('normal');
  });
});

describe('load validation (fail-safe, mirrors chat-preference-db)', () => {
  it('a corrupt (binary garbage) row reads back as null, never as garbage', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    db.raw
      .prepare(`UPDATE command_surface_prefs SET prefs_json = x'DEADBEEF' WHERE chat_jid = ? AND sender_jid = ?`)
      .run(CHAT_A, SENDER_A);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toBeNull();
  });

  it('invalid JSON reads back as null', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    db.raw
      .prepare(`UPDATE command_surface_prefs SET prefs_json = '{not valid json' WHERE chat_jid = ? AND sender_jid = ?`)
      .run(CHAT_A, SENDER_A);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toBeNull();
  });

  it('a non-array hidden field (out-of-contract shape) reads back as null', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    db.raw
      .prepare(`UPDATE command_surface_prefs SET prefs_json = '{"hidden":"status"}' WHERE chat_jid = ? AND sender_jid = ?`)
      .run(CHAT_A, SENDER_A);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toBeNull();
  });

  it('an out-of-contract verbosity value reads back as null (fail-safe, not fail-open)', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    db.raw
      .prepare(`UPDATE command_surface_prefs SET prefs_json = '{"verbosity":"loud"}' WHERE chat_jid = ? AND sender_jid = ?`)
      .run(CHAT_A, SENDER_A);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toBeNull();
  });

  it('an optionDefaults value that is not a string reads back as null', () => {
    setSurfacePrefs(db, CHAT_A, SENDER_A, prefs(), NOW);
    db.raw
      .prepare(
        `UPDATE command_surface_prefs SET prefs_json = '{"optionDefaults":{"model":{"provider":42}}}' WHERE chat_jid = ? AND sender_jid = ?`,
      )
      .run(CHAT_A, SENDER_A);
    expect(getSurfacePrefs(db, CHAT_A, SENDER_A)).toBeNull();
  });
});

describe('no widening mechanism (structural — UserSurfacePrefs has no enable field)', () => {
  it('the persisted shape cannot carry an "enable"/"enabled" field even via a cast-in adversarial write', () => {
    // Cast-in adversarial: attempt to smuggle an "enabled" widening field
    // through the type system. TypeScript's structural typing would allow
    // excess-property checks to fail at the object-literal site, so this
    // proves it at the runtime layer instead — the getter's fail-safe
    // shape validator does not recognize "enabled" as a field and simply
    // drops it (extra keys ignored, forward-compatible), so no widening
    // signal ever reaches a caller.
    const adversarial = { hidden: ['status'], enabled: ['kill-session'] } as unknown as UserSurfacePrefs;
    setSurfacePrefs(db, CHAT_A, SENDER_A, adversarial, NOW);
    const got = getSurfacePrefs(db, CHAT_A, SENDER_A) as unknown as Record<string, unknown>;
    expect(got['enabled']).toBeUndefined();
    expect(got['hidden']).toEqual(['status']);
  });
});
