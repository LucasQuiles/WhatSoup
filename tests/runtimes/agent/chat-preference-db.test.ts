/**
 * Unit tests for the per-sender chat model preference store (schema v2).
 *
 * Contract (owner-approved PR-plan v2, 2026-07-04): composite
 * (chat_jid, sender_jid) key — never per-chat alone — idempotent upserts,
 * TTL expiry via pruneExpired that DELETES rows (not just ignores them),
 * strict-pin fields, and fail-safe load validation mirroring
 * fallback-state-db (a corrupt row reads back as null, never as garbage).
 *
 * Construction pattern mirrors fallback-state-db.test.ts: real Database,
 * temp file, cleanup after each test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import {
  ensureChatPreferenceSchema,
  getPreference,
  setPreference,
  clearPreference,
  pruneExpired,
  type ChatModelPreference,
} from '../../../src/runtimes/agent/chat-preference-db.ts';

// Deterministic clock for reads — fixture rows use toy epochs, so every
// getPreference call passes `NOW` explicitly (no wall clock in tests).
const NOW = 1_500;

const CHAT_A = '111222333@g.us';
const CHAT_B = '444555666@g.us';
const SENDER_A = '15550000001@s.whatsapp.net';
const SENDER_B = '15550000002@s.whatsapp.net';

function pref(overrides: Partial<ChatModelPreference> = {}): ChatModelPreference {
  return {
    chatJid: CHAT_A,
    senderJid: SENDER_A,
    intent: 'strongest',
    requestedProvider: null,
    scope: 'this_thread',
    pinStrict: true,
    fallbackPermitted: false,
    updatedAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}

let dbPath: string;
let db: Database;

beforeEach(() => {
  dbPath = join(tmpdir(), `chat-pref-test-${randomBytes(6).toString('hex')}.db`);
  db = new Database(dbPath);
  ensureChatPreferenceSchema(db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

describe('ensureChatPreferenceSchema', () => {
  it('is idempotent — a second call against an existing table is a no-op', () => {
    expect(() => ensureChatPreferenceSchema(db)).not.toThrow();
    setPreference(db, pref());
    ensureChatPreferenceSchema(db);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)?.intent).toBe('strongest');
  });
});

describe('set/get roundtrip', () => {
  it('returns exactly what was stored, including pin fields', () => {
    const p = pref({ intent: 'provider_specific', requestedProvider: 'claude-cli', fallbackPermitted: true });
    setPreference(db, p);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toEqual(p);
  });

  it('returns null when no row exists', () => {
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toBeNull();
  });

  it('defaults: pinStrict true, fallbackPermitted false survive the roundtrip', () => {
    setPreference(db, pref());
    const got = getPreference(db, CHAT_A, SENDER_A, NOW);
    expect(got?.pinStrict).toBe(true);
    expect(got?.fallbackPermitted).toBe(false);
  });
});

describe('per-sender isolation (group-bleed guard)', () => {
  it('a preference for (chat A, sender A) is invisible to sender B in the same chat', () => {
    setPreference(db, pref());
    expect(getPreference(db, CHAT_A, SENDER_B, NOW)).toBeNull();
  });

  it('and invisible to the same sender in another chat', () => {
    setPreference(db, pref());
    expect(getPreference(db, CHAT_B, SENDER_A, NOW)).toBeNull();
  });

  it('two senders in one chat hold independent preferences', () => {
    setPreference(db, pref({ intent: 'strongest' }));
    setPreference(db, pref({ senderJid: SENDER_B, intent: 'fastest' }));
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)?.intent).toBe('strongest');
    expect(getPreference(db, CHAT_A, SENDER_B, NOW)?.intent).toBe('fastest');
  });
});

describe('idempotent upsert', () => {
  it('repeated identical writes converge to one row with the same values', () => {
    setPreference(db, pref());
    setPreference(db, pref());
    setPreference(db, pref());
    const rows = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM chat_model_preference WHERE chat_jid = ? AND sender_jid = ?`)
      .get(CHAT_A, SENDER_A) as { n: number };
    expect(rows.n).toBe(1);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toEqual(pref());
  });

  it('a later write replaces the earlier one (last write wins)', () => {
    setPreference(db, pref({ intent: 'strongest', updatedAt: 1_000 }));
    setPreference(db, pref({ intent: 'fastest', updatedAt: 1_500 }));
    const got = getPreference(db, CHAT_A, SENDER_A, NOW);
    expect(got?.intent).toBe('fastest');
    expect(got?.updatedAt).toBe(1_500);
  });
});

describe('clearPreference', () => {
  it('removes the row and is idempotent (double /reset is a no-op)', () => {
    setPreference(db, pref());
    clearPreference(db, CHAT_A, SENDER_A);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toBeNull();
    expect(() => clearPreference(db, CHAT_A, SENDER_A)).not.toThrow();
  });

  it('only clears the addressed (chat, sender) pair', () => {
    setPreference(db, pref());
    setPreference(db, pref({ senderJid: SENDER_B, intent: 'fastest' }));
    clearPreference(db, CHAT_A, SENDER_A);
    expect(getPreference(db, CHAT_A, SENDER_B, NOW)?.intent).toBe('fastest');
  });
});

describe('pruneExpired', () => {
  it('deletes expired rows (TTL cleanup deletes, not merely ignores)', () => {
    setPreference(db, pref({ expiresAt: 2_000 }));
    pruneExpired(db, 2_001);
    const rows = db.raw.prepare(`SELECT COUNT(*) AS n FROM chat_model_preference`).get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('keeps unexpired rows and sticky (expiresAt null) rows', () => {
    setPreference(db, pref({ expiresAt: 5_000 }));
    setPreference(db, pref({ senderJid: SENDER_B, scope: 'sticky', expiresAt: null }));
    pruneExpired(db, 2_001);
    expect(getPreference(db, CHAT_A, SENDER_A, 2_001)).not.toBeNull();
    expect(getPreference(db, CHAT_A, SENDER_B, 2_001)).not.toBeNull();
  });

  it('an expired row also reads back as null via getPreference even before prune runs', () => {
    setPreference(db, pref({ expiresAt: 2_000 }));
    expect(getPreference(db, CHAT_A, SENDER_A, 2_001)).toBeNull();
  });
});

describe('load validation (fail-safe, mirrors fallback-state-db)', () => {
  it('a corrupt row reads back as null, never as garbage', () => {
    setPreference(db, pref());
    db.raw
      .prepare(`UPDATE chat_model_preference SET intent = 42 WHERE chat_jid = ? AND sender_jid = ?`)
      .run(CHAT_A, SENDER_A);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toBeNull();
  });

  it('an out-of-contract intent value reads back as null (fail-safe, not fail-open)', () => {
    setPreference(db, pref());
    db.raw
      .prepare(`UPDATE chat_model_preference SET intent = 'banana' WHERE chat_jid = ? AND sender_jid = ?`)
      .run(CHAT_A, SENDER_A);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toBeNull();
  });
});
