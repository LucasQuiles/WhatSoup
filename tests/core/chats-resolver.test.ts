// tests/core/chats-resolver.test.ts
//
// P1-B red contract tests for the chat alias resolver.
//
// Per phase1-design.md Decisions 1, 2, 3:
//   - Per-line dedicated SQLite alias table in each instance DB
//   - Resolver is per-instance (DB-bound); line identity is implicit-per-DB
//   - resolve() accepts a target = { chatJid } or { to } (alias)
//   - Mutually exclusive: both -> MutuallyExclusiveError; neither -> MissingTargetError
//   - Unknown alias -> AliasNotFoundError
//
// Decision 6 ("no separate resolve_chat tool") is enforced in P1-E (MCP tests),
// not at this unit-test layer.
//
// Implementation lands in P1-C at src/core/chats-resolver.ts.
// Fleet route + MCP tool integration in P1-D / P1-E.
//
// EXPECTED STATE: this file is RED until P1-C lands the resolver module.
// Vitest's suite collection fails because the module doesn't exist; all 15
// declared cases are unreached.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  createChatResolver,
  seedChatAliases,
  type ChatResolver,
  AliasNotFoundError,
  MutuallyExclusiveError,
  MissingTargetError,
} from '../../src/core/chats-resolver.ts';

// --- Helpers ---------------------------------------------------------------

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // Schema sketch from phase1-design.md Decision 1; exact migration shape
  // decided in P1-C. Use db.exec for one-shot DDL per project convention
  // (see tests/core/database.test.ts:572, src/core/chat-sync.ts:399).
  db.exec(`
    CREATE TABLE chat_aliases (
      alias TEXT NOT NULL PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return db;
}

function seedAlias(db: DatabaseSync, alias: string, chatJid: string): void {
  db.prepare('INSERT INTO chat_aliases (alias, chat_jid) VALUES (?, ?)').run(
    alias,
    chatJid,
  );
}

// --- Contract: chatJid passthrough -----------------------------------------

describe('ChatResolver contract -- chatJid passthrough', () => {
  let db: DatabaseSync;
  let resolver: ChatResolver;

  beforeEach(() => {
    db = makeDb();
    resolver = createChatResolver({ db });
  });

  it('returns the raw chatJid unchanged when target = { chatJid }', () => {
    const result = resolver.resolve({ chatJid: '120363555555555002@g.us' });
    expect(result).toBe('120363555555555002@g.us');
  });

  it('returns the raw chatJid for an individual JID (s.whatsapp.net)', () => {
    const result = resolver.resolve({ chatJid: '15551230001@s.whatsapp.net' });
    expect(result).toBe('15551230001@s.whatsapp.net');
  });

  it('does NOT consult the alias table when chatJid is provided', () => {
    seedAlias(db, 'kio', '120363555555555002@g.us');
    // Pass a different chatJid; resolver must return the chatJid as-is.
    const result = resolver.resolve({ chatJid: '99999999999@s.whatsapp.net' });
    expect(result).toBe('99999999999@s.whatsapp.net');
  });
});

// --- Contract: alias resolution via { to } ---------------------------------

describe('ChatResolver contract -- alias resolution', () => {
  let db: DatabaseSync;
  let resolver: ChatResolver;

  beforeEach(() => {
    db = makeDb();
    resolver = createChatResolver({ db });
  });

  it('resolves a known alias to its chatJid', () => {
    seedAlias(db, 'kio', '120363555555555002@g.us');
    const result = resolver.resolve({ to: 'kio' });
    expect(result).toBe('120363555555555002@g.us');
  });

  it('resolves multiple distinct aliases independently', () => {
    seedAlias(db, 'kio', '120363555555555002@g.us');
    seedAlias(db, 'flow-bots', '120363555555555004@g.us');
    expect(resolver.resolve({ to: 'kio' })).toBe('120363555555555002@g.us');
    expect(resolver.resolve({ to: 'flow-bots' })).toBe('120363555555555004@g.us');
  });

  it('throws AliasNotFoundError when alias is unknown', () => {
    expect(() => resolver.resolve({ to: 'nonexistent' })).toThrow(
      AliasNotFoundError,
    );
  });

  it('treats alias lookup as exact-match (case-sensitive)', () => {
    seedAlias(db, 'kio', '120363555555555002@g.us');
    expect(() => resolver.resolve({ to: 'KIO' })).toThrow(AliasNotFoundError);
  });
});

// --- Contract: per-DB isolation (Decision 1+2: line is implicit per DB) ---

describe('ChatResolver contract -- per-DB isolation', () => {
  it('aliases seeded in DB-A are not visible to a resolver from DB-B', () => {
    const dbA = makeDb();
    const dbB = makeDb();
    const resolverA = createChatResolver({ db: dbA });
    const resolverB = createChatResolver({ db: dbB });

    // Seed only into DB-A.
    seedAlias(dbA, 'kio', '120363555555555002@g.us');

    // Resolver-A sees its own alias.
    expect(resolverA.resolve({ to: 'kio' })).toBe('120363555555555002@g.us');

    // Resolver-B does NOT see DB-A's alias. Locks the contract that the
    // resolver caches nothing at module scope and queries its own DB
    // exclusively. A P1-C implementation that uses a shared/global Map
    // for aliases would fail this test.
    expect(() => resolverB.resolve({ to: 'kio' })).toThrow(AliasNotFoundError);
  });
});

// --- Contract: mutual exclusion of chatJid and to --------------------------

describe('ChatResolver contract -- mutual exclusion', () => {
  let db: DatabaseSync;
  let resolver: ChatResolver;

  beforeEach(() => {
    db = makeDb();
    resolver = createChatResolver({ db });
  });

  it('throws MutuallyExclusiveError when both chatJid and to are provided (inconsistent)', () => {
    // Seed kio -> JID-A, then call with chatJid = JID-B and to = 'kio'.
    // The two refer to different chats; resolver must NOT silently pick one.
    seedAlias(db, 'kio', '120363555555555002@g.us');
    expect(() =>
      resolver.resolve({
        chatJid: '99999999999@s.whatsapp.net',
        to: 'kio',
      }),
    ).toThrow(MutuallyExclusiveError);
  });

  it('throws MutuallyExclusiveError even when chatJid and to point to the same chat (consistent)', () => {
    // Seed kio -> JID-A, then call with chatJid = JID-A and to = 'kio'.
    // The two refer to the same chat; the rule still rejects. Caller must
    // commit to exactly one form. Locks: consistency does not relax mutex.
    seedAlias(db, 'kio', '120363555555555002@g.us');
    expect(() =>
      resolver.resolve({
        chatJid: '120363555555555002@g.us',
        to: 'kio',
      }),
    ).toThrow(MutuallyExclusiveError);
  });

  it('throws MissingTargetError when target object is empty', () => {
    expect(() => resolver.resolve({})).toThrow(MissingTargetError);
  });
});

// --- Contract: empty / null target handling --------------------------------
// Locks: empty string is treated as not-provided (no DB lookup), not as a
// real lookup that returns AliasNotFoundError. Prevents a P1-C implementation
// that hits the DB with empty-string keys.

describe('ChatResolver contract -- empty / null target handling', () => {
  let db: DatabaseSync;
  let resolver: ChatResolver;

  beforeEach(() => {
    db = makeDb();
    resolver = createChatResolver({ db });
  });

  it('throws MissingTargetError when chatJid is empty string', () => {
    expect(() => resolver.resolve({ chatJid: '' })).toThrow(MissingTargetError);
  });

  it('throws MissingTargetError when to is empty string', () => {
    expect(() => resolver.resolve({ to: '' })).toThrow(MissingTargetError);
  });

  it('treats whitespace-only chatJid as missing (consistent with fleet xor validation)', () => {
    expect(() => resolver.resolve({ chatJid: '   ' })).toThrow(MissingTargetError);
  });

  it('treats whitespace-only to as missing (consistent with fleet xor validation)', () => {
    expect(() => resolver.resolve({ to: '   ' })).toThrow(MissingTargetError);
  });
});

// --- Contract: error type discrimination -----------------------------------

describe('ChatResolver contract -- error type discrimination', () => {
  let db: DatabaseSync;
  let resolver: ChatResolver;

  beforeEach(() => {
    db = makeDb();
    resolver = createChatResolver({ db });
  });

  it('AliasNotFoundError, MutuallyExclusiveError, MissingTargetError are distinct classes', () => {
    expect(AliasNotFoundError).not.toBe(MutuallyExclusiveError);
    expect(AliasNotFoundError).not.toBe(MissingTargetError);
    expect(MutuallyExclusiveError).not.toBe(MissingTargetError);
  });

  it('all resolver errors extend Error (instanceof Error)', () => {
    seedAlias(db, 'kio', '120363555555555002@g.us');

    let caughtAliasNotFound: Error | undefined;
    try {
      resolver.resolve({ to: 'unknown' });
    } catch (e) {
      caughtAliasNotFound = e as Error;
    }
    expect(caughtAliasNotFound).toBeInstanceOf(Error);
    expect(caughtAliasNotFound).toBeInstanceOf(AliasNotFoundError);

    let caughtMutEx: Error | undefined;
    try {
      resolver.resolve({ chatJid: 'x@s.whatsapp.net', to: 'kio' });
    } catch (e) {
      caughtMutEx = e as Error;
    }
    expect(caughtMutEx).toBeInstanceOf(Error);
    expect(caughtMutEx).toBeInstanceOf(MutuallyExclusiveError);

    let caughtMissing: Error | undefined;
    try {
      resolver.resolve({});
    } catch (e) {
      caughtMissing = e as Error;
    }
    expect(caughtMissing).toBeInstanceOf(Error);
    expect(caughtMissing).toBeInstanceOf(MissingTargetError);
  });
});

describe('seedChatAliases', () => {
  it('inserts alias seeds and resolves them', () => {
    const db = makeDb();

    expect(seedChatAliases(db, {
      ops: '15555550100@s.whatsapp.net',
      support: '120363001@g.us',
    })).toBe(2);

    const resolver = createChatResolver({ db });
    expect(resolver.resolve({ to: 'ops' })).toBe('15555550100@s.whatsapp.net');
    expect(resolver.resolve({ to: 'support' })).toBe('120363001@g.us');
    db.close();
  });

  it('is idempotent for unchanged aliases and updates changed targets', () => {
    const db = makeDb();

    expect(seedChatAliases(db, { ops: '15555550100@s.whatsapp.net' })).toBe(1);
    expect(seedChatAliases(db, { ops: '15555550100@s.whatsapp.net' })).toBe(0);
    expect(seedChatAliases(db, { ops: '15555550101@s.whatsapp.net' })).toBe(1);

    expect(createChatResolver({ db }).resolve({ to: 'ops' })).toBe('15555550101@s.whatsapp.net');
    db.close();
  });
});

// --- Residual branch coverage ---------------------------------------------
// Targets the single uncovered branch in src/core/chats-resolver.ts:
//   line 134: `changes += result.changes ?? 0;`
// node:sqlite's StatementSync.run() always returns a { changes: N } object,
// so reaching the `?? 0` fallback requires a mock where the upsert run()
// omits the .changes field. Pattern mirrors tests/core/label-sync.test.ts
// "cleanupOrphanedAssociations returns 0 when result.changes is undefined".

describe('residual-branch coverage', () => {
  it('seedChatAliases falls back to 0 when result.changes is undefined (line 134 ?? 0 branch)', () => {
    const db = makeDb();
    const originalPrepare = db.prepare.bind(db);
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      // Intercept only the upsert INSERT into chat_aliases so its .run()
      // returns an object with no `changes` field, forcing the `?? 0`
      // fallback on line 134.
      if (sql.includes('INSERT INTO chat_aliases')) {
        return {
          run: () => ({}),
        } as unknown as ReturnType<typeof originalPrepare>;
      }
      return originalPrepare(sql);
    });

    try {
      const result = seedChatAliases(db, {
        foo: '12036300001@g.us',
        bar: '1555XXXXXXX@s.whatsapp.net',
      });
      // Each upsert.run() returned {} (no .changes) -> 0 + 0 = 0.
      // Concrete terminal assertion locks the `?? 0` fallback branch.
      expect(result).toBe(0);
    } finally {
      prepareSpy.mockRestore();
      db.close();
    }
  });
});
