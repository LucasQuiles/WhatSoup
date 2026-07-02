import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, afterEach } from 'vitest';
import { Database } from '../../src/core/database.ts';
import { buildLidMappings, formatMentions, ContactsDirectory } from '../../src/core/mentions.ts';

function openMentionsDb(): Database {
  const db = new Database(':memory:');
  db.open();
  return db;
}

function seedLidMapping(raw: DatabaseSync, lid: string, phoneJid: string): void {
  raw
    .prepare('INSERT INTO lid_mappings (lid, phone_jid, updated_at) VALUES (?, ?, ?)')
    .run(lid, phoneJid, '2026-06-15T00:00:00.000Z');
}

// ---------------------------------------------------------------------------
// formatMentions — no contacts (pure number detection)
// ---------------------------------------------------------------------------

describe('formatMentions (no contacts)', () => {
  it('returns unchanged text when no mentions present', () => {
    const result = formatMentions('Hello world, no mentions here');
    expect(result.hasMentions).toBe(false);
    expect(result.jids).toEqual([]);
    expect(result.text).toBe('Hello world, no mentions here');
  });

  it('detects bare @number mention — emits only @s.whatsapp.net (no @lid)', () => {
    const result = formatMentions('Hey @15551230008 check this');
    expect(result.hasMentions).toBe(true);
    expect(result.jids).toContain('15551230008@s.whatsapp.net');
    // @lid variant is NOT emitted
    expect(result.jids).not.toContain('15551230008@lid');
    expect(result.jids).toHaveLength(1);
    expect(result.text).toBe('Hey @15551230008 check this');
  });

  it('detects @+number with leading plus and rewrites to bare number', () => {
    const result = formatMentions('Hey @+15551230008 check this');
    expect(result.hasMentions).toBe(true);
    expect(result.jids).toContain('15551230008@s.whatsapp.net');
    expect(result.text).toBe('Hey @15551230008 check this');
  });

  it('detects multiple number mentions — one JID per phone', () => {
    const result = formatMentions('@15551230008 and @15551230004 are here');
    expect(result.hasMentions).toBe(true);
    expect(result.jids).toHaveLength(2); // 1 JID per phone (no @lid)
    expect(result.jids).toContain('15551230008@s.whatsapp.net');
    expect(result.jids).toContain('15551230004@s.whatsapp.net');
  });

  it('deduplicates repeated mentions of the same number', () => {
    const result = formatMentions('@15551230008 said hi, @15551230008 again');
    expect(result.hasMentions).toBe(true);
    expect(result.jids).toHaveLength(1); // one set only
  });

  it('ignores short numbers (< 5 digits)', () => {
    const result = formatMentions('Order @1234 is ready');
    expect(result.hasMentions).toBe(false);
  });

  it('handles mention followed by punctuation', () => {
    const result = formatMentions('Hey @15551230008, what do you think?');
    expect(result.hasMentions).toBe(true);
    expect(result.jids).toContain('15551230008@s.whatsapp.net');
  });

  it('leaves unresolved @name patterns unchanged when no contacts', () => {
    const result = formatMentions('Hey @Jason check this out');
    expect(result.hasMentions).toBe(false);
    expect(result.text).toBe('Hey @Jason check this out');
  });
});

// ---------------------------------------------------------------------------
// formatMentions — with contacts directory
// ---------------------------------------------------------------------------

describe('formatMentions (with contacts)', () => {
  function buildContacts(): ContactsDirectory {
    const dir = new ContactsDirectory();
    dir.observe('15550100001@s.whatsapp.net', 'Q');
    dir.observe('15551230004@s.whatsapp.net', 'Loops');
    dir.observe('15551234567@s.whatsapp.net', 'Jason Bradshaw');
    return dir;
  }

  it('rewrites @name to @number using contacts map', () => {
    const dir = buildContacts();
    const result = formatMentions('Hey @Q check this', dir.contacts);
    expect(result.text).toBe('Hey @15550100001 check this');
    expect(result.jids).toContain('15550100001@s.whatsapp.net');
    // @lid NOT emitted
    expect(result.jids).not.toContain('15550100001@lid');
    expect(result.hasMentions).toBe(true);
  });

  it('is case-insensitive for name lookup', () => {
    const dir = buildContacts();
    const result = formatMentions('Hey @loops whats up', dir.contacts);
    expect(result.text).toBe('Hey @15551230004 whats up');
    expect(result.jids).toContain('15551230004@s.whatsapp.net');
  });

  it('resolves first name from multi-word display name', () => {
    const dir = buildContacts();
    const result = formatMentions('@Jason can you look at this?', dir.contacts);
    expect(result.text).toBe('@15551234567 can you look at this?');
    expect(result.jids).toContain('15551234567@s.whatsapp.net');
  });

  it('resolves full name (lowercase)', () => {
    const dir = buildContacts();
    const result = formatMentions('@jason can you look?', dir.contacts);
    expect(result.text).toBe('@15551234567 can you look?');
  });

  it('handles mix of @number and @name in same message', () => {
    const dir = buildContacts();
    const result2 = formatMentions('@Q and @15551230004 should both see this', dir.contacts);
    expect(result2.text).toBe('@15550100001 and @15551230004 should both see this');
    expect(result2.jids).toHaveLength(2); // 2 phones * 1 suffix each
  });

  it('leaves unresolved names unchanged', () => {
    const dir = buildContacts();
    const result = formatMentions('Hey @UnknownPerson check this', dir.contacts);
    expect(result.text).toBe('Hey @UnknownPerson check this');
    expect(result.hasMentions).toBe(false);
  });

  it('deduplicates when @name and @number refer to same phone', () => {
    const dir = buildContacts();
    const result = formatMentions('@Q and @15550100001 same person', dir.contacts);
    expect(result.text).toBe('@15550100001 and @15550100001 same person');
    expect(result.jids).toHaveLength(1); // one set only
  });
});

// ---------------------------------------------------------------------------
// formatMentions — with LID mappings
// ---------------------------------------------------------------------------

describe('formatMentions (with LID mappings)', () => {
  it('rewrites pasted LID numbers to phone mentions and emits both phone and LID JIDs', () => {
    const lidMappings = {
      phoneToLid: new Map([['15550100001', '1111111888666']]),
      lidToPhone: new Map([['1111111888666', '15550100001']]),
    };

    const result = formatMentions('Hey @1111111888666 review this', undefined, lidMappings);

    expect(result.text).toBe('Hey @15550100001 review this');
    expect(result.jids).toEqual(['15550100001@s.whatsapp.net', '1111111888666@lid']);
    expect(result.hasMentions).toBe(true);
  });

  it('adds the corresponding LID JID for phone-number mentions when mapping is known', () => {
    const lidMappings = {
      phoneToLid: new Map([['15550100001', '1111111888666']]),
      lidToPhone: new Map([['1111111888666', '15550100001']]),
    };

    const result = formatMentions('Hey @15550100001 review this', undefined, lidMappings);

    expect(result.text).toBe('Hey @15550100001 review this');
    expect(result.jids).toEqual(['15550100001@s.whatsapp.net', '1111111888666@lid']);
  });

  it('adds the corresponding LID JID for contact-name mentions when mapping is known', () => {
    const dir = new ContactsDirectory();
    dir.observe('15550100001@s.whatsapp.net', 'Q');
    const lidMappings = {
      phoneToLid: new Map([['15550100001', '1111111888666']]),
      lidToPhone: new Map([['1111111888666', '15550100001']]),
    };

    const result = formatMentions('Hey @Q review this', dir.contacts, lidMappings);

    expect(result.text).toBe('Hey @15550100001 review this');
    expect(result.jids).toEqual(['15550100001@s.whatsapp.net', '1111111888666@lid']);
  });

  it('deduplicates phone and LID mentions that resolve to the same person', () => {
    const lidMappings = {
      phoneToLid: new Map([['15550100001', '1111111888666']]),
      lidToPhone: new Map([['1111111888666', '15550100001']]),
    };

    const result = formatMentions('@1111111888666 and @15550100001 same person', undefined, lidMappings);

    expect(result.text).toBe('@15550100001 and @15550100001 same person');
    expect(result.jids).toEqual(['15550100001@s.whatsapp.net', '1111111888666@lid']);
  });
});

// ---------------------------------------------------------------------------
// LID mapping hydration
// ---------------------------------------------------------------------------

describe('buildLidMappings', () => {
  let db: Database | undefined;
  let rawDb: DatabaseSync | undefined;

  afterEach(() => {
    db?.close();
    rawDb?.close();
    db = undefined;
    rawDb = undefined;
  });

  it('builds bidirectional mappings from the Database wrapper', () => {
    db = openMentionsDb();
    seedLidMapping(db.raw, '1111111888666', '15550100001@s.whatsapp.net');
    seedLidMapping(db.raw, '', '15550200002@s.whatsapp.net');
    seedLidMapping(db.raw, '111222333444', '');

    const mappings = buildLidMappings(db);

    expect(mappings.phoneToLid.get('15550100001')).toBe('1111111888666');
    expect(mappings.lidToPhone.get('1111111888666')).toBe('15550100001');
    expect(mappings.phoneToLid.has('15550200002')).toBe(false);
    expect(mappings.lidToPhone.has('111222333444')).toBe(false);
  });

  it('builds bidirectional mappings from a raw DatabaseSync instance', () => {
    rawDb = new DatabaseSync(':memory:');
    rawDb.exec('CREATE TABLE lid_mappings (lid TEXT, phone_jid TEXT)');
    rawDb
      .prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('1111111444333', '15550300003@s.whatsapp.net');

    const mappings = buildLidMappings(rawDb);

    expect(mappings.phoneToLid.get('15550300003')).toBe('1111111444333');
    expect(mappings.lidToPhone.get('1111111444333')).toBe('15550300003');
  });
});

// ---------------------------------------------------------------------------
// ContactsDirectory
// ---------------------------------------------------------------------------

describe('ContactsDirectory', () => {
  let db: Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('indexes by phone, full name, and first name', () => {
    const dir = new ContactsDirectory();
    dir.observe('15551234567@s.whatsapp.net', 'Jason Bradshaw');

    expect(dir.resolve('15551234567')).toBe('15551234567');
    expect(dir.resolve('jason bradshaw')).toBe('15551234567');
    expect(dir.resolve('jason')).toBe('15551234567');
    expect(dir.resolve('Jason')).toBe('15551234567'); // case-insensitive
  });

  it('handles JIDs with @lid suffix', () => {
    const dir = new ContactsDirectory();
    dir.observe('81536414179557@lid', 'Bot User');

    expect(dir.resolve('81536414179557')).toBe('81536414179557');
    expect(dir.resolve('bot user')).toBe('81536414179557');
  });

  it('handles null sender name gracefully', () => {
    const dir = new ContactsDirectory();
    dir.observe('15551234567@s.whatsapp.net', null);

    // Still indexes by phone
    expect(dir.resolve('15551234567')).toBe('15551234567');
    expect(dir.size).toBe(1);
  });

  it('updates mapping when name changes for same phone', () => {
    const dir = new ContactsDirectory();
    dir.observe('15551234567@s.whatsapp.net', 'Old Name');
    dir.observe('15551234567@s.whatsapp.net', 'New Name');

    expect(dir.resolve('new name')).toBe('15551234567');
    // Old name still maps (we don't evict — it's a feature)
    expect(dir.resolve('old name')).toBe('15551234567');
  });

  it('evicts oldest entries when at capacity (while loop fix)', () => {
    const dir = new ContactsDirectory(5); // tiny capacity
    dir.observe('11111@s.whatsapp.net', 'A');
    dir.observe('22222@s.whatsapp.net', 'B');
    dir.observe('33333@s.whatsapp.net', 'C');

    // At this point we have entries for: 11111, a, 22222, b, 33333
    // Adding more should evict the oldest
    dir.observe('44444@s.whatsapp.net', 'D');
    dir.observe('55555@s.whatsapp.net', 'E');

    // Newest entries should be resolvable
    expect(dir.resolve('55555')).toBe('55555');
    expect(dir.resolve('e')).toBe('55555');
    // Map should not exceed capacity
    expect(dir.size).toBeLessThanOrEqual(5);
  });

  it('skips short JIDs (< 5 digits)', () => {
    const dir = new ContactsDirectory();
    dir.observe('123@s.whatsapp.net', 'Short');

    expect(dir.resolve('123')).toBeUndefined();
    expect(dir.resolve('short')).toBeUndefined();
    expect(dir.size).toBe(0);
  });

  it('returns undefined LID mappings until a database is attached', () => {
    const dir = new ContactsDirectory();
    expect(dir.getLidMappings()).toBeUndefined();

    db = openMentionsDb();
    seedLidMapping(db.raw, '1111111888666', '15550100001@s.whatsapp.net');
    dir.setDatabase(db);

    const mappings = dir.getLidMappings();
    expect(mappings?.phoneToLid.get('15550100001')).toBe('1111111888666');
  });

  it('resolves LID senders through the attached database and caches the result', () => {
    db = openMentionsDb();
    seedLidMapping(db.raw, '1111111888666', '15550100001@s.whatsapp.net');
    const dir = new ContactsDirectory(db);

    dir.observe('1111111888666@lid', 'Q');
    dir.observe('1111111888666@lid', 'Queue');

    expect(dir.resolve('q')).toBe('15550100001');
    expect(dir.resolve('queue')).toBe('15550100001');
    expect(dir.resolve('1111111888666')).toBeUndefined();
  });

  it('evicts oldest entries when the LID-backed directory reaches capacity', () => {
    db = openMentionsDb();
    seedLidMapping(db.raw, '1111111888666', '15550100001@s.whatsapp.net');
    seedLidMapping(db.raw, '1111111444333', '15550200002@s.whatsapp.net');
    const dir = new ContactsDirectory(db, 1);

    dir.observe('1111111888666@lid', 'Q');
    dir.observe('1111111444333@lid', 'Loops');

    expect(dir.resolve('q')).toBeUndefined();
    expect(dir.resolve('loops')).toBe('15550200002');
  });

  it('invalidateLidCache clears cached LID resolutions for subsequent observations', () => {
    db = openMentionsDb();
    seedLidMapping(db.raw, '1111111888666', '15550100001@s.whatsapp.net');
    const dir = new ContactsDirectory(db);

    dir.observe('1111111888666@lid', 'Before');
    db.raw
      .prepare('UPDATE lid_mappings SET phone_jid = ? WHERE lid = ?')
      .run('15550999999@s.whatsapp.net', '1111111888666');
    dir.invalidateLidCache();
    dir.observe('1111111888666@lid', 'After');

    expect(dir.resolve('before')).toBe('15550100001');
    expect(dir.resolve('after')).toBe('15550999999');
  });

  it('resolves non-LID JIDs through the attached database path', () => {
    db = openMentionsDb();
    const dir = new ContactsDirectory(db);

    dir.observe('15550100001@s.whatsapp.net', 'Q');

    expect(dir.resolve('q')).toBe('15550100001');
    expect(dir.resolve('15550100001')).toBe('15550100001');
  });

  it('handles whitespace-only sender names by indexing the phone only', () => {
    const dir = new ContactsDirectory();
    dir.observe('15551234567@s.whatsapp.net', '   ');

    expect(dir.resolve('15551234567')).toBe('15551234567');
    expect(dir.resolve('')).toBeUndefined();
    expect(dir.size).toBe(1);
  });

  it('does not index numeric first-name tokens from display names', () => {
    const dir = new ContactsDirectory();
    dir.observe('15551239999@s.whatsapp.net', '12345 Dispatch');

    expect(dir.resolve('12345 dispatch')).toBe('15551239999');
    expect(dir.resolve('12345')).toBeUndefined();
  });

});
// ---------------------------------------------------------------------------
// formatMentions — LID mapping coverage gaps
// ---------------------------------------------------------------------------

describe('formatMentions (LID mapping coverage)', () => {
  it('emits only @s.whatsapp.net for a phone mention when lidMappings is empty', () => {
    const lidMappings = {
      phoneToLid: new Map<string, string>(),
      lidToPhone: new Map<string, string>(),
    };

    const result = formatMentions('Hey @15551230008 check this', undefined, lidMappings);

    expect(result.text).toBe('Hey @15551230008 check this');
    expect(result.jids).toEqual(['15551230008@s.whatsapp.net']);
    expect(result.jids).not.toContain('15551230008@lid');
  });

  it('emits only @s.whatsapp.net for an unknown digit mention when lidMappings is partially populated', () => {
    const lidMappings = {
      phoneToLid: new Map([['15550100001', '1111111888666']]),
      lidToPhone: new Map([['1111111888666', '15550100001']]),
    };

    const result = formatMentions('Hey @15559998888 unknown', undefined, lidMappings);

    expect(result.text).toBe('Hey @15559998888 unknown');
    expect(result.jids).toEqual(['15559998888@s.whatsapp.net']);
  });

  it('emits phone+lid JID pairs for multiple distinct LID mentions', () => {
    const lidMappings = {
      phoneToLid: new Map([
        ['15550100001', '1111111888666'],
        ['15550200002', '1111111444333'],
      ]),
      lidToPhone: new Map([
        ['1111111888666', '15550100001'],
        ['1111111444333', '15550200002'],
      ]),
    };

    const result = formatMentions('@1111111888666 and @1111111444333 hi', undefined, lidMappings);

    expect(result.text).toBe('@15550100001 and @15550200002 hi');
    expect(result.jids).toEqual([
      '15550100001@s.whatsapp.net',
      '1111111888666@lid',
      '15550200002@s.whatsapp.net',
      '1111111444333@lid',
    ]);
  });

  it('resolves @+LID with leading plus to phone and emits both JIDs', () => {
    const lidMappings = {
      phoneToLid: new Map([['15550100001', '1111111888666']]),
      lidToPhone: new Map([['1111111888666', '15550100001']]),
    };

    const result = formatMentions('Hey @+1111111888666 review this', undefined, lidMappings);

    expect(result.text).toBe('Hey @15550100001 review this');
    expect(result.jids).toEqual(['15550100001@s.whatsapp.net', '1111111888666@lid']);
  });

  it('deduplicates LID + contact-name mention that resolve to the same phone', () => {
    const dir = new ContactsDirectory();
    dir.observe('15550100001@s.whatsapp.net', 'Q');
    const lidMappings = {
      phoneToLid: new Map([['15550100001', '1111111888666']]),
      lidToPhone: new Map([['1111111888666', '15550100001']]),
    };

    const result = formatMentions('@1111111888666 and @Q same person', dir.contacts, lidMappings);

    expect(result.text).toBe('@15550100001 and @15550100001 same person');
    expect(result.jids).toEqual(['15550100001@s.whatsapp.net', '1111111888666@lid']);
  });

  it('deduplicates LID + phone + contact-name mention that all resolve to the same person', () => {
    const dir = new ContactsDirectory();
    dir.observe('15550100001@s.whatsapp.net', 'Q');
    const lidMappings = {
      phoneToLid: new Map([['15550100001', '1111111888666']]),
      lidToPhone: new Map([['1111111888666', '15550100001']]),
    };

    const result = formatMentions('@Q @15550100001 @1111111888666', dir.contacts, lidMappings);

    expect(result.text).toBe('@15550100001 @15550100001 @15550100001');
    expect(result.jids).toEqual(['15550100001@s.whatsapp.net', '1111111888666@lid']);
  });

  it('emits only @s.whatsapp.net for a contact-name mention when no LID mapping exists for that phone', () => {
    const dir = new ContactsDirectory();
    dir.observe('15550100001@s.whatsapp.net', 'Q');
    const lidMappings = {
      phoneToLid: new Map<string, string>(),
      lidToPhone: new Map<string, string>(),
    };

    const result = formatMentions('Hey @Q review this', dir.contacts, lidMappings);

    expect(result.text).toBe('Hey @15550100001 review this');
    expect(result.jids).toEqual(['15550100001@s.whatsapp.net']);
  });

  it('leaves name mention unchanged when contacts is undefined even if lidMappings is provided', () => {
    const lidMappings = {
      phoneToLid: new Map([['15550100001', '1111111888666']]),
      lidToPhone: new Map([['1111111888666', '15550100001']]),
    };

    const result = formatMentions('Hey @Jason check', undefined, lidMappings);

    expect(result.text).toBe('Hey @Jason check');
    expect(result.jids).toEqual([]);
    expect(result.hasMentions).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatMentions — text boundary and regex edge cases
// ---------------------------------------------------------------------------

describe('formatMentions (text edge cases)', () => {
  it('returns empty result for an empty input string', () => {
    const result = formatMentions('');
    expect(result.text).toBe('');
    expect(result.jids).toEqual([]);
    expect(result.hasMentions).toBe(false);
  });

  it('handles a mention at the very start of the text with no preceding characters', () => {
    const result = formatMentions('@15551230008 hi there');
    expect(result.text).toBe('@15551230008 hi there');
    expect(result.jids).toEqual(['15551230008@s.whatsapp.net']);
  });

  it('handles a mention at the very end of the text with no trailing characters', () => {
    const result = formatMentions('hi there @15551230008');
    expect(result.text).toBe('hi there @15551230008');
    expect(result.jids).toEqual(['15551230008@s.whatsapp.net']);
  });


  it('resolves name mentions that include trailing digits', () => {
    const dir = new ContactsDirectory();
    dir.observe('15550100001@s.whatsapp.net', 'Jason99');
    const result = formatMentions('Hey @Jason99 hi', dir.contacts);
    expect(result.text).toBe('Hey @15550100001 hi');
    expect(result.jids).toEqual(['15550100001@s.whatsapp.net']);
  });

  it('leaves name mention unchanged when contacts is an empty Map (not undefined)', () => {
    const emptyContacts = new Map<string, string>();
    const result = formatMentions('Hey @Jason check', emptyContacts);
    expect(result.text).toBe('Hey @Jason check');
    expect(result.jids).toEqual([]);
    expect(result.hasMentions).toBe(false);
  });

  it('leaves @ followed by a non-word, non-digit character unchanged', () => {
    const result = formatMentions('rate is @#45 per hour');
    expect(result.text).toBe('rate is @#45 per hour');
    expect(result.hasMentions).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ContactsDirectory — constructor and lifecycle
// ---------------------------------------------------------------------------

describe('ContactsDirectory (constructor and lifecycle)', () => {
  let db: Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('defaults maxEntries to 500 when called with no arguments', () => {
    const dir = new ContactsDirectory();
    dir.observe('15550100001@s.whatsapp.net', 'A');
    expect(dir.size).toBe(2); // phone + lowercase 'a'
    expect(dir.resolve('a')).toBe('15550100001');
  });

  it('defaults maxEntries to 500 when only a db is provided', () => {
    db = openMentionsDb();
    const dir = new ContactsDirectory(db);
    dir.observe('15550100001@s.whatsapp.net', 'A');
    expect(dir.resolve('a')).toBe('15550100001');
  });

  it('exposes the live contacts map via the contacts getter', () => {
    const dir = new ContactsDirectory();
    dir.observe('15550100001@s.whatsapp.net', 'A');
    expect(dir.contacts).toBeInstanceOf(Map);
    expect(dir.contacts.get('15550100001')).toBe('15550100001');
    expect(dir.contacts.get('a')).toBe('15550100001');
    expect(dir.contacts.size).toBe(dir.size);
  });

  it('attaches a database later via setDatabase and then reports LID mappings', () => {
    const dir = new ContactsDirectory();
    expect(dir.getLidMappings()).toBeUndefined();

    db = openMentionsDb();
    seedLidMapping(db.raw, '1111111888666', '15550100001@s.whatsapp.net');
    dir.setDatabase(db);

    const mappings = dir.getLidMappings();
    expect(mappings).toBeDefined();
    expect(mappings!.phoneToLid.get('15550100001')).toBe('1111111888666');
    expect(mappings!.lidToPhone.get('1111111888666')).toBe('15550100001');
  });

  it('invalidateLidCache is a safe no-op when no database is attached', () => {
    const dir = new ContactsDirectory();
    expect(() => dir.invalidateLidCache()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ContactsDirectory — observe() edge cases
// ---------------------------------------------------------------------------

describe('ContactsDirectory (observe edge cases)', () => {
  let db: Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });


  it('keeps size stable when observing the same phone and name repeatedly', () => {
    const dir = new ContactsDirectory();
    dir.observe('15550100001@s.whatsapp.net', 'A');
    const sizeAfterFirst = dir.size;
    dir.observe('15550100001@s.whatsapp.net', 'A');
    dir.observe('15550100001@s.whatsapp.net', 'A');
    expect(dir.size).toBe(sizeAfterFirst);
    expect(dir.resolve('a')).toBe('15550100001');
    expect(dir.resolve('15550100001')).toBe('15550100001');
  });

  it('re-resolves a LID sender from the DB after the LID cache entry was evicted', () => {
    db = openMentionsDb();
    seedLidMapping(db.raw, '1111111888666', '15550100001@s.whatsapp.net');
    seedLidMapping(db.raw, '1111111444333', '15550200002@s.whatsapp.net');
    const dir = new ContactsDirectory(db, 1);

    dir.observe('1111111888666@lid', 'Q');
    dir.observe('1111111444333@lid', 'Loops');
    // The first LID's cache entry was evicted on the second observe (lidCache bounded by maxEntries).
    db.raw
      .prepare('UPDATE lid_mappings SET phone_jid = ? WHERE lid = ?')
      .run('15550999999@s.whatsapp.net', '1111111888666');
    dir.observe('1111111888666@lid', 'QUpdated');

    expect(dir.resolve('qupdated')).toBe('15550999999');
  });

  it('skips an empty-string sender name (only the phone key is indexed)', () => {
    const dir = new ContactsDirectory();
    dir.observe('15550100001@s.whatsapp.net', '');
    expect(dir.size).toBe(1);
    expect(dir.resolve('15550100001')).toBe('15550100001');
    expect(dir.resolve('')).toBeUndefined();
  });

  it('resolves a non-LID JID through the db path with a multi-word name (first name indexed)', () => {
    db = openMentionsDb();
    const dir = new ContactsDirectory(db);
    dir.observe('15551234567@s.whatsapp.net', 'Loop Bot');
    expect(dir.resolve('loop bot')).toBe('15551234567');
    expect(dir.resolve('15551234567')).toBe('15551234567');
    expect(dir.resolve('loop')).toBe('15551234567');
  });
});

// ---------------------------------------------------------------------------
// buildLidMappings — additional edge cases
// ---------------------------------------------------------------------------

describe('buildLidMappings (edge cases)', () => {
  let db: Database | undefined;
  let rawDb: DatabaseSync | undefined;

  afterEach(() => {
    db?.close();
    rawDb?.close();
    db = undefined;
    rawDb = undefined;
  });

  it('returns empty maps when the lid_mappings table has no rows', () => {
    db = openMentionsDb();
    const mappings = buildLidMappings(db);
    expect(mappings.phoneToLid.size).toBe(0);
    expect(mappings.lidToPhone.size).toBe(0);
  });

});

describe('ContactsDirectory eviction guard (#1091)', () => {
  it('floors maxEntries to >=1 and does not hang when constructed with 0', () => {
    const dir = new ContactsDirectory(0);
    // Pre-fix this spun forever: `size >= 0` is always true and insertOrder is empty.
    dir.observe('15550100001@s.whatsapp.net', 'Q');
    expect(dir.size).toBe(1);
    expect(dir.resolve('Q')).toBeDefined();
  });

  it('does not hang with a negative maxEntries', () => {
    const dir = new ContactsDirectory(-5);
    dir.observe('15550100001@s.whatsapp.net', 'Q');
    expect(dir.size).toBe(1);
  });
});

describe('ContactsDirectory — pushName spoofing guard (QR-044)', () => {
  it('keeps the first-seen name→phone mapping; a spoofed pushName from a different phone cannot hijack @Name', () => {
    const dir = new ContactsDirectory();
    // Legit: phone ...001 is known as 'Boss'.
    dir.observe('15550100001@s.whatsapp.net', 'Boss');
    expect(dir.resolve('boss')).toBe('15550100001');

    // Attacker (...099) sets their pushName to 'Boss' and messages the bot.
    dir.observe('15550100099@s.whatsapp.net', 'Boss');

    // The @Boss mention must STILL resolve to the original contact, not the attacker.
    expect(dir.resolve('boss')).toBe('15550100001');
    // The attacker's own phone self-key still resolves (not spoofable).
    expect(dir.resolve('15550100099')).toBe('15550100099');
  });

  it('still lets the SAME phone re-observe (idempotent) and index new aliases', () => {
    const dir = new ContactsDirectory();
    dir.observe('15550100001@s.whatsapp.net', 'Bob');
    expect(dir.resolve('bob')).toBe('15550100001');

    // Same phone, a new display name → the new alias is added; the old one is preserved.
    dir.observe('15550100001@s.whatsapp.net', 'Robert');
    expect(dir.resolve('robert')).toBe('15550100001');
    expect(dir.resolve('bob')).toBe('15550100001');
  });
});
