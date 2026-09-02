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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  getLatestChatPreference,
  clearChatPreference,
  promoteToSticky,
  recordKeepReceiptMessageId,
  getKeepReceiptMessageId,
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
    requestedModel: null,
    validatedProvider: null,
    modelPinVerified: null,
    requestedEffort: null,
    keepReceiptMessageId: null,
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
      // BLOB survives TEXT affinity; an integer 42 would be converted to the
      // TEXT '42' and rejected as out-of-contract, NOT as wrong-typed — the
      // original assertion passed for the wrong reason (F14; affinity probe
      // captured in runs/hardening-20260704/a14-affinity-probe.txt).
      .prepare(`UPDATE chat_model_preference SET intent = x'DEADBEEF' WHERE chat_jid = ? AND sender_jid = ?`)
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

describe('cross-field contract (F12)', () => {
  it('provider_specific with NULL requested_provider reads back as null', () => {
    setPreference(db, pref({ intent: 'provider_specific', requestedProvider: 'claude-cli' }));
    db.raw.prepare('UPDATE chat_model_preference SET requested_provider = NULL').run();
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toBeNull();
  });

  it('a non-pin intent carrying a requested_provider reads back as null', () => {
    setPreference(db, pref({ intent: 'strongest', requestedProvider: null }));
    db.raw.prepare("UPDATE chat_model_preference SET requested_provider = 'claude-cli'").run();
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toBeNull();
  });
});

// Model pin (Q 2026-07-20, provider-qualified). The pin carries requestedModel +
// validatedProvider + a verified bit; the three move together, NULL model = no pin.
describe('model pin storage', () => {
  it('round-trips a verified model pin (model + validated provider + verified bit)', () => {
    const p = pref({ requestedModel: 'claude-opus-4-8', validatedProvider: 'claude-cli', modelPinVerified: true });
    setPreference(db, p);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toEqual(p);
  });

  it('round-trips an UNVERIFIED pin (accepted during an outage → verified=false, deferred re-validation)', () => {
    const p = pref({ requestedModel: 'claude-opus-4-8', validatedProvider: 'claude-cli', modelPinVerified: false });
    setPreference(db, p);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)?.modelPinVerified).toBe(false);
  });

  it('allows a pin with NULL validated_provider (UNVALIDATED — re-validated on resolution, never blessed as current)', () => {
    const p = pref({ requestedModel: 'claude-opus-4-8', validatedProvider: null, modelPinVerified: false });
    setPreference(db, p);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toEqual(p);
  });

  it('a legacy row (model columns NULL) reads back as NO model pin', () => {
    // Simulate a pre-migration row: insert without the model columns (they default NULL).
    db.raw
      .prepare(
        `INSERT INTO chat_model_preference
           (chat_jid, sender_jid, intent, requested_provider, scope, pin_strict, fallback_permitted, updated_at, expires_at)
         VALUES (?, ?, 'strongest', NULL, 'this_thread', 1, 0, 1000, 2000)`,
      )
      .run(CHAT_A, SENDER_A);
    const got = getPreference(db, CHAT_A, SENDER_A, NOW);
    expect(got).not.toBeNull();
    // The three model-pin fields read back together as "no model pin".
    expect(got).toMatchObject({ requestedModel: null, validatedProvider: null, modelPinVerified: null });
  });

  it('rejects a corrupt row: provider/verified context with NO model to attach it to', () => {
    setPreference(db, pref());
    db.raw.prepare("UPDATE chat_model_preference SET validated_provider = 'claude-cli'").run(); // requested_model still NULL
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toBeNull();
  });

  it('rejects a corrupt row: a live model pin missing its verified bit', () => {
    setPreference(db, pref({ requestedModel: 'claude-opus-4-8', validatedProvider: 'claude-cli', modelPinVerified: true }));
    db.raw.prepare('UPDATE chat_model_preference SET model_pin_verified = NULL').run();
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toBeNull();
  });

  // Slice 3 — reasoning-effort override on the pin.
  it('round-trips a model pin WITH a reasoning-effort override', () => {
    const p = pref({ requestedModel: 'claude-opus-4-8', validatedProvider: 'claude-cli', modelPinVerified: true, requestedEffort: 'high' });
    setPreference(db, p);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toEqual(p);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)?.requestedEffort).toBe('high');
  });

  it('a model pin with NO effort override reads back requestedEffort:null (additive-migration default)', () => {
    // Omitting requestedEffort (optional on write) must persist + read as null,
    // never undefined — the rollback-safe additive-column default.
    const p = pref({ requestedModel: 'claude-opus-4-8', validatedProvider: 'claude-cli', modelPinVerified: true });
    setPreference(db, p);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)?.requestedEffort).toBeNull();
  });

  it('rejects a corrupt row: an effort override with NO model to attach it to', () => {
    setPreference(db, pref());
    db.raw.prepare("UPDATE chat_model_preference SET requested_effort = 'high'").run(); // requested_model still NULL
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toBeNull();
  });

  it('migration is idempotent — model columns exist after a second ensure', () => {
    ensureChatPreferenceSchema(db);
    const cols = db.raw.prepare("PRAGMA table_info('chat_model_preference')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('requested_model');
    expect(names).toContain('validated_provider');
    expect(names).toContain('model_pin_verified');
    expect(names).toContain('requested_effort');
  });
});

// D13/D13a — chat-scoped READ-COLLAPSE. Per-sender rows are RETAINED (the
// primary key and write path are unchanged); these two functions add a
// chat-scoped VIEW over them: the newest row wins on read, and a clear
// removes every row for the chat. getPreference/clearPreference (above)
// keep their exact per-sender contract — only the new functions are
// chat-scoped.
describe('chat-scoped read-collapse (latest-writer-wins)', () => {
  it('returns the latest pin for the chat regardless of sender', () => {
    setPreference(
      db,
      pref({ chatJid: CHAT_A, senderJid: SENDER_A, intent: 'provider_specific', requestedProvider: 'openai', updatedAt: 100, expiresAt: null }),
    );
    setPreference(
      db,
      pref({ chatJid: CHAT_A, senderJid: SENDER_B, intent: 'provider_specific', requestedProvider: 'kimi', updatedAt: 200, expiresAt: null }),
    );
    const got = getLatestChatPreference(db, CHAT_A, NOW);
    expect(got?.requestedProvider).toBe('kimi');
    // Row-derived audit trail (D13a): the winning sender comes from the row,
    // not a passed arg — getLatestChatPreference has no sender parameter.
    expect(got?.senderJid).toBe(SENDER_B);
  });

  it('skips expired rows when choosing the latest', () => {
    setPreference(db, pref({ chatJid: CHAT_A, senderJid: SENDER_A, updatedAt: 300, expiresAt: 1_000 }));
    expect(getLatestChatPreference(db, CHAT_A, 2_000)).toBeNull();
  });

  it('a fresh row wins over a newer-but-expired row', () => {
    setPreference(
      db,
      pref({ chatJid: CHAT_A, senderJid: SENDER_A, intent: 'provider_specific', requestedProvider: 'openai', updatedAt: 100, expiresAt: null }),
    );
    // Newer updated_at than SENDER_A's row, but expired at NOW=1_500.
    setPreference(db, pref({ chatJid: CHAT_A, senderJid: SENDER_B, updatedAt: 400, expiresAt: 200 }));
    expect(getLatestChatPreference(db, CHAT_A, NOW)?.requestedProvider).toBe('openai');
  });

  it('defaults now to Date.now() the same way getPreference does', () => {
    setPreference(db, pref({ chatJid: CHAT_A, senderJid: SENDER_A, expiresAt: null }));
    expect(() => getLatestChatPreference(db, CHAT_A)).not.toThrow();
  });

  it('clearChatPreference deletes every row for the chat', () => {
    setPreference(db, pref({ chatJid: CHAT_A, senderJid: SENDER_A }));
    setPreference(db, pref({ chatJid: CHAT_A, senderJid: SENDER_B }));
    clearChatPreference(db, CHAT_A);
    expect(getLatestChatPreference(db, CHAT_A, NOW)).toBeNull();
    const rows = db.raw.prepare(`SELECT COUNT(*) AS n FROM chat_model_preference WHERE chat_jid = ?`).get(CHAT_A) as { n: number };
    expect(rows.n).toBe(0);
  });

  it('clearChatPreference is idempotent (double-clear does not throw)', () => {
    setPreference(db, pref({ chatJid: CHAT_A, senderJid: SENDER_A }));
    clearChatPreference(db, CHAT_A);
    expect(() => clearChatPreference(db, CHAT_A)).not.toThrow();
  });

  it('clearChatPreference is chat-scoped (leaves other chats intact)', () => {
    setPreference(db, pref({ chatJid: CHAT_A, senderJid: SENDER_A }));
    setPreference(db, pref({ chatJid: CHAT_B, senderJid: SENDER_A }));
    clearChatPreference(db, CHAT_A);
    expect(getLatestChatPreference(db, CHAT_B, NOW)).not.toBeNull();
  });

  it('a corrupt latest row reads back null (fail-safe preserved via the shared validator)', () => {
    // Older, valid row from SENDER_A, then a newer row from SENDER_B that
    // gets corrupted at the SQL layer after insert — mirrors the "out-of-
    // contract intent value" technique in the load-validation block above,
    // aimed at the row that ORDER BY updated_at DESC would otherwise pick.
    setPreference(db, pref({ chatJid: CHAT_A, senderJid: SENDER_A, updatedAt: 100 }));
    setPreference(db, pref({ chatJid: CHAT_A, senderJid: SENDER_B, updatedAt: 200 }));
    db.raw
      .prepare(`UPDATE chat_model_preference SET intent = 'banana' WHERE chat_jid = ? AND sender_jid = ?`)
      .run(CHAT_A, SENDER_B);
    // The corrupt row IS the latest by updated_at — the shared validator
    // rejects it fail-safe rather than falling through to SENDER_A's row.
    expect(getLatestChatPreference(db, CHAT_A, NOW)).toBeNull();
  });
});

// promoteToSticky — Q-CANARY model-pin `keep` contract (2026-07-23). The
// compare-and-set that turns the active preference row (the receipt itself,
// no parallel confirmation state) into a permanent pin: scope='sticky' and
// expires_at=NULL land in ONE statement, gated on the row still matching
// what was read, and only the sender who set the row may confirm it.
// Raw on-disk read, bypassing getPreference's own expiry-based nulling — used
// ONLY to confirm a rejected promoteToSticky call left the row's columns
// untouched, independent of whether that row would also read as "expired" at
// some arbitrary later probe time.
function rawRow(chatJid: string, senderJid: string): { scope: string; expires_at: number | null; updated_at: number } | undefined {
  return db.raw
    .prepare(`SELECT scope, expires_at, updated_at FROM chat_model_preference WHERE chat_jid = ? AND sender_jid = ?`)
    .get(chatJid, senderJid) as { scope: string; expires_at: number | null; updated_at: number } | undefined;
}

describe('promoteToSticky (CAS keep-promotion)', () => {
  it('promotes a live this_thread pin: scope and expires_at flip together, updated_at bumps', () => {
    setPreference(db, pref({ updatedAt: 1_000, expiresAt: 2_000 }));
    const result = promoteToSticky(db, CHAT_A, SENDER_A, 1_500);
    expect(result.outcome).toBe('promoted');
    expect(result.preference).toMatchObject({ scope: 'sticky', expiresAt: null });
    const row = getPreference(db, CHAT_A, SENDER_A, 9_999_999);
    expect(row).toMatchObject({ scope: 'sticky', expiresAt: null });
    expect(row?.updatedAt).toBeGreaterThan(1_000);
  });

  it('emits no further mutation for an already-sticky row (idempotent replay)', () => {
    setPreference(db, pref({ scope: 'sticky', updatedAt: 1_000, expiresAt: null }));
    const result = promoteToSticky(db, CHAT_A, SENDER_A, 1_500);
    expect(result.outcome).toBe('already_sticky');
    expect(getPreference(db, CHAT_A, SENDER_A, 9_999_999)?.updatedAt).toBe(1_000);
  });

  it('reports absent when nothing was ever pinned for the chat', () => {
    const result = promoteToSticky(db, CHAT_A, SENDER_A, 1_500);
    expect(result.preference).toBeNull();
    expect(result.outcome).toBe('absent');
  });

  it('reports expired (not absent) for a pin that lapsed before the eligibility instant — never resurrected', () => {
    setPreference(db, pref({ updatedAt: 1_000, expiresAt: 2_000 }));
    const result = promoteToSticky(db, CHAT_A, SENDER_A, 2_001); // nowMs past expiresAt
    expect(result.outcome).toBe('expired');
    expect(result.preference).toBeNull();
    expect(rawRow(CHAT_A, SENDER_A)).toMatchObject({ scope: 'this_thread' });
  });

  it('eligibility uses the CALLER-supplied nowMs, not wall-clock — an on-time receive survives late processing', () => {
    setPreference(db, pref({ updatedAt: 1_000, expiresAt: 2_000 }));
    // nowMs = the inbound's own receive time, still inside the window, even
    // though this assertion itself runs "later" in wall-clock terms.
    const result = promoteToSticky(db, CHAT_A, SENDER_A, 1_999);
    expect(result.outcome).toBe('promoted');
  });

  it('refuses a confirming sender who did not set the chat\'s winning row (actor_mismatch) — never resurrects it under a different actor', () => {
    setPreference(db, pref({ senderJid: SENDER_A, updatedAt: 1_000, expiresAt: 2_000 }));
    const result = promoteToSticky(db, CHAT_A, SENDER_B, 1_500);
    expect(result.outcome).toBe('actor_mismatch');
    expect(result.preference).toMatchObject({ senderJid: SENDER_A });
    expect(rawRow(CHAT_A, SENDER_A)).toMatchObject({ scope: 'this_thread' });
  });

  it('a later pin from a different sender becomes the chat winner — the original setter\'s "keep" is rejected, not resurrected', () => {
    setPreference(db, pref({ chatJid: CHAT_A, senderJid: SENDER_A, updatedAt: 1_000, expiresAt: 5_000 }));
    setPreference(db, pref({ chatJid: CHAT_A, senderJid: SENDER_B, updatedAt: 2_000, expiresAt: 5_000 }));
    const result = promoteToSticky(db, CHAT_A, SENDER_A, 2_500);
    expect(result.outcome).toBe('actor_mismatch');
    // Neither row was mutated by the rejected attempt.
    expect(rawRow(CHAT_A, SENDER_A)).toMatchObject({ scope: 'this_thread', expires_at: 5_000 });
    expect(rawRow(CHAT_A, SENDER_B)).toMatchObject({ scope: 'this_thread', expires_at: 5_000 });
  });

  it('rejects promotion when a concurrent writer changes the row between read and write (superseded) — never resurrects a stale receipt', () => {
    setPreference(db, pref({ updatedAt: 1_000, expiresAt: 5_000 }));
    const originalPrepare = db.raw.prepare.bind(db.raw);
    const prepareSpy = vi.spyOn(db.raw, 'prepare').mockImplementation((sql: string) => {
      const stmt = originalPrepare(sql);
      if (typeof sql === 'string' && sql.includes(`SET scope = 'sticky'`)) {
        // Race window: a concurrent writer (a fresh /model pin, a reset+repin,
        // a second "keep") lands between promoteToSticky's read and its own
        // CAS write, in the exact window the predicate exists to close.
        originalPrepare(
          `UPDATE chat_model_preference SET updated_at = ? WHERE chat_jid = ? AND sender_jid = ?`,
        ).run(1_200, CHAT_A, SENDER_A);
      }
      return stmt;
    });

    const result = promoteToSticky(db, CHAT_A, SENDER_A, 1_100);
    prepareSpy.mockRestore();

    expect(result.outcome).toBe('superseded');
    expect(result.preference).toBeNull();
    const row = rawRow(CHAT_A, SENDER_A);
    expect(row?.scope).toBe('this_thread'); // never resurrected as sticky
    expect(row?.updated_at).toBe(1_200); // the racing writer's version stands
  });

  it('a corrupt winning row (fail-safe validator) is treated as absent, never confirmed', () => {
    setPreference(db, pref({ updatedAt: 1_000, expiresAt: 5_000 }));
    db.raw.prepare(`UPDATE chat_model_preference SET intent = 'banana' WHERE chat_jid = ? AND sender_jid = ?`).run(CHAT_A, SENDER_A);
    const result = promoteToSticky(db, CHAT_A, SENDER_A, 1_500);
    expect(result.outcome).toBe('absent');
  });
});

/**
 * F2a (#2121, owner decision 2026-08-04) — the pin-receipt id column that lets
 * a reply-threaded `confirm`/`yes`/`pin` be authenticated against the receipt
 * it quotes. These tests own the two store-level properties the matcher
 * depends on and cannot verify for itself: the capture write must not disturb
 * the compare-and-set promotion, and the new column must stay outside the
 * model-pin fields' cross-field null-contract.
 */
describe('keep receipt id (F2a reply-threading)', () => {
  const RECEIPT = 'WA0123456789ABCDEF';

  it('is null until captured, then reads back from the chat-scoped winning row', () => {
    setPreference(db, pref({ updatedAt: 1_000, expiresAt: 5_000 }));
    expect(getKeepReceiptMessageId(db, CHAT_A)).toBeNull();

    recordKeepReceiptMessageId(db, CHAT_A, SENDER_A, RECEIPT);
    expect(getKeepReceiptMessageId(db, CHAT_A)).toBe(RECEIPT);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)?.keepReceiptMessageId).toBe(RECEIPT);
    // Scoped to its own chat — never leaks sideways into another conversation.
    expect(getKeepReceiptMessageId(db, CHAT_B)).toBeNull();
  });

  // The load-bearing store invariant. `updated_at` is promoteToSticky's CAS
  // token AND the chat-scoped last-writer-wins ordering key, so a capture that
  // bumped it would make the receipt supersede its own pin: the `keep` the
  // user was just invited to send would come back `superseded` instead of
  // `promoted`. This test fails the moment that regresses.
  it('capture leaves updated_at untouched, so a later keep still promotes', () => {
    setPreference(db, pref({ updatedAt: 1_000, expiresAt: 5_000 }));
    recordKeepReceiptMessageId(db, CHAT_A, SENDER_A, RECEIPT);
    expect(rawRow(CHAT_A, SENDER_A)?.updated_at).toBe(1_000);

    const result = promoteToSticky(db, CHAT_A, SENDER_A, 1_500);
    expect(result.outcome).toBe('promoted');
    expect(rawRow(CHAT_A, SENDER_A)?.expires_at).toBeNull();
  });

  // An INTENT pin carries no requested_model but still earns a keep-promising
  // receipt. If the receipt id were folded into the model-pin group's
  // null-contract, every such row would read back as null and route
  // resolution would silently lose the pin.
  it('survives read-back on an intent pin that has no model-pin fields', () => {
    setPreference(db, pref({ intent: 'strongest', requestedModel: null, updatedAt: 1_000, expiresAt: 5_000 }));
    recordKeepReceiptMessageId(db, CHAT_A, SENDER_A, RECEIPT);
    const loaded = getPreference(db, CHAT_A, SENDER_A, NOW);
    expect(loaded).not.toBeNull();
    expect(loaded?.intent).toBe('strongest');
    expect(loaded?.requestedModel).toBeNull();
    expect(loaded?.keepReceiptMessageId).toBe(RECEIPT);
    expect(getLatestChatPreference(db, CHAT_A, NOW)).not.toBeNull();
  });

  it('a fresh pin write clears the previous receipt id', () => {
    setPreference(db, pref({ updatedAt: 1_000, expiresAt: 5_000 }));
    recordKeepReceiptMessageId(db, CHAT_A, SENDER_A, RECEIPT);
    setPreference(db, pref({ updatedAt: 1_200, expiresAt: 5_000 }));
    expect(getKeepReceiptMessageId(db, CHAT_A)).toBeNull();
  });

  // A1 (#2121 follow-up) — promotion CONSUMES the receipt. The compare-and-set
  // used to set scope/expires_at/updated_at and leave the id behind, so a
  // sticky row went on authenticating replies to the very receipt that made it
  // sticky: every later threaded affirmative was intercepted and answered
  // "already kept" instead of reaching the agent. A permanent pin has nothing
  // left to confirm, so it must hold no receipt.
  it('promotion clears the receipt id it consumed', () => {
    setPreference(db, pref({ updatedAt: 1_000, expiresAt: 5_000 }));
    recordKeepReceiptMessageId(db, CHAT_A, SENDER_A, RECEIPT);
    expect(getKeepReceiptMessageId(db, CHAT_A)).toBe(RECEIPT);

    const result = promoteToSticky(db, CHAT_A, SENDER_A, 1_500);
    expect(result.outcome).toBe('promoted');
    // The promotion is one atomic write: scope, expiry and the consumed
    // receipt move together, and the RETURNED preference describes the row
    // that now exists — a caller renders its reply from it.
    expect(result.preference).toMatchObject({ scope: 'sticky', expiresAt: null, keepReceiptMessageId: null });
    // S4: the returned id is READ BACK from the row, so it cannot report
    // "consumed" while the row still holds one. Proven by agreement with a
    // direct read of the store rather than by the literal above alone.
    expect(result.preference?.keepReceiptMessageId).toBe(getKeepReceiptMessageId(db, CHAT_A));
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toMatchObject({
      scope: 'sticky',
      expiresAt: null,
      keepReceiptMessageId: null,
    });
  });

  // The other half of the same invariant, and the reason clearing at promotion
  // alone is not enough: a re-confirm of an ALREADY-sticky pin still renders a
  // keep-promising echo (owner-render-format.ts prints "reply keep to make it
  // permanent" on every branch), so the capture path can be reached with a
  // sticky row underneath. Refusing the write here makes "a receipt id exists
  // only on a pin that can still be promoted" a store invariant rather than a
  // property of who happens to call.
  it('a sticky row cannot acquire a receipt id', () => {
    setPreference(db, pref({ scope: 'sticky', updatedAt: 1_000, expiresAt: null }));
    recordKeepReceiptMessageId(db, CHAT_A, SENDER_A, RECEIPT);
    expect(getKeepReceiptMessageId(db, CHAT_A)).toBeNull();
    // A no-op, not a partial write: the sticky row is otherwise untouched.
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toMatchObject({
      scope: 'sticky',
      expiresAt: null,
      updatedAt: 1_000,
      keepReceiptMessageId: null,
    });
  });

  // Item 5 (#2121 follow-up, cross-model bench) — the INSTALLED BASE. The
  // writer guard and the promotion clear only govern rows this version writes.
  // A row the previous unguarded writer stamped, and which has since become
  // sticky, still carries an id in the column; answering it would let an old
  // receipt authenticate a threaded affirmative on a permanent pin. Seeded
  // with a raw UPDATE precisely because the fixed writer now refuses it: this
  // is base's state reproduced, not a state the current code can reach.
  it('a legacy sticky row that still carries a receipt id answers null', () => {
    setPreference(db, pref({ scope: 'sticky', updatedAt: 1_000, expiresAt: null }));
    db.raw
      .prepare(`UPDATE chat_model_preference SET keep_receipt_message_id = ? WHERE chat_jid = ? AND sender_jid = ?`)
      .run(RECEIPT, CHAT_A, SENDER_A);
    const storedId = (): unknown => (db.raw
      .prepare(`SELECT keep_receipt_message_id AS id FROM chat_model_preference WHERE chat_jid = ? AND sender_jid = ?`)
      .get(CHAT_A, SENDER_A) as { id: unknown } | undefined)?.id;
    // Coverage assertion: the legacy value really is in the column, so the
    // read below is exercising the repair rather than an empty cell.
    expect(storedId()).toBe(RECEIPT);

    // Repaired on READ — no migration, no write, and the stored byte is left
    // exactly as found.
    expect(getKeepReceiptMessageId(db, CHAT_A)).toBeNull();
    expect(storedId()).toBe(RECEIPT);
  });

  it('capturing against an absent row is a no-op, never an insert', () => {
    recordKeepReceiptMessageId(db, CHAT_A, SENDER_A, RECEIPT);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toBeNull();
    expect(getKeepReceiptMessageId(db, CHAT_A)).toBeNull();
  });

  // TEXT affinity silently coerces a stored number to its string form, so the
  // only value that reaches the reader wrong-typed is a BLOB — affinity leaves
  // those alone. That is the case the validator has to catch.
  it('a wrong-typed (blob) receipt id maps the row to null, like every other field', () => {
    setPreference(db, pref({ updatedAt: 1_000, expiresAt: 5_000 }));
    db.raw
      .prepare(`UPDATE chat_model_preference SET keep_receipt_message_id = x'00FF' WHERE chat_jid = ? AND sender_jid = ?`)
      .run(CHAT_A, SENDER_A);
    expect(getPreference(db, CHAT_A, SENDER_A, NOW)).toBeNull();
    expect(getKeepReceiptMessageId(db, CHAT_A)).toBeNull();
  });
});

/**
 * MED-1 (#2121 follow-up) — the "same winning row" invariant, which both
 * modules document as load-bearing and neither pinned with a test.
 * `getKeepReceiptMessageId` authenticates a threaded confirmation and
 * `promoteToSticky` performs it; if they ever resolved DIFFERENT rows, a reply
 * could authenticate against one sender's receipt while the promotion targeted
 * another's. Both read the chat's latest row across every sender, expired rows
 * included, so the cases below are the ones where a plausible-wrong
 * implementation (read the confirming sender's own row; apply the expiry
 * filter) would disagree — not a tautological "call both and compare".
 */
describe('the receipt reader and the promoter resolve the same winning row (MED-1)', () => {
  const RECEIPT_A = 'WA-RECEIPT-FOR-SENDER-A';
  const RECEIPT_B = 'WA-RECEIPT-FOR-SENDER-B';

  it("reports the WINNER's receipt, not the confirming sender's own", () => {
    // B pinned first, A pinned later: A's row wins the chat on updated_at.
    setPreference(db, pref({ senderJid: SENDER_B, updatedAt: 1_000, expiresAt: 5_000 }));
    recordKeepReceiptMessageId(db, CHAT_A, SENDER_B, RECEIPT_B);
    setPreference(db, pref({ senderJid: SENDER_A, updatedAt: 2_000, expiresAt: 5_000 }));
    recordKeepReceiptMessageId(db, CHAT_A, SENDER_A, RECEIPT_A);

    // A per-sender read would answer RECEIPT_B for a confirmation sent by B.
    expect(getKeepReceiptMessageId(db, CHAT_A)).toBe(RECEIPT_A);
    // And the promoter agrees about who owns that row: holding a receipt id of
    // one's own is not authority over the chat's winning pin.
    expect(promoteToSticky(db, CHAT_A, SENDER_B, 1_500).outcome).toBe('actor_mismatch');
    expect(promoteToSticky(db, CHAT_A, SENDER_A, 1_500).outcome).toBe('promoted');
  });

  it('keeps pointing at an EXPIRED winner, which is what the promoter refuses', () => {
    // B's row is still live; A's newer row has lapsed.
    setPreference(db, pref({ senderJid: SENDER_B, updatedAt: 1_000, expiresAt: 9_000 }));
    recordKeepReceiptMessageId(db, CHAT_A, SENDER_B, RECEIPT_B);
    setPreference(db, pref({ senderJid: SENDER_A, updatedAt: 2_000, expiresAt: 3_000 }));
    recordKeepReceiptMessageId(db, CHAT_A, SENDER_A, RECEIPT_A);

    // An expiry-FILTERED reader would fall back to B's live row and answer
    // RECEIPT_B here, authenticating a confirmation the promoter then refuses
    // as `expired` — the two would be describing different pins.
    expect(getKeepReceiptMessageId(db, CHAT_A)).toBe(RECEIPT_A);
    expect(promoteToSticky(db, CHAT_A, SENDER_A, 4_000).outcome).toBe('expired');
  });
});
