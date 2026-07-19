// tests/core/chat-display-name.test.ts
//
// B23 UX polish — owner ruling (verbatim): "sessions should show contact
// names, group names, etc — not unrecognizable JID/LID mappings or phone
// numbers". Contract tests for the display-name resolution ladder used by
// the /sessions list and the /kill-session ack:
//
//   1. chat_aliases.alias      — the owner's own name for the chat
//                                (config chatAliases seeds this table,
//                                main.ts → seedChatAliases); most recently
//                                updated wins; lid refs resolve to phone
//                                forms BEFORE this rung (B25 F7)
//   2. groups.subject          — WhatsApp group subject
//      then chats.name         — chat-level name (chat-sync)
//   3. contacts.display_name / notify_name — contact address-book/push name
//      (via resolveLid for @lid refs, plus the '@lid'-keyed row itself)
//   4. messages.sender_name    — most recent non-blank push name for the jid
//   5. formatted phone (+digits) — proven phone-origin or mapped lids only;
//      never fabricated from a bare/unmapped lid (B25 F1)
//   6. the raw ref, unchanged  — last resort; NEVER throws on a miss
//
// Inputs may be a conversation_key ('123_at_g.us' / bare phone) or a raw JID
// ('123@g.us' / '123@s.whatsapp.net' / '123@lid') — the runtime's session
// map keys carry both shapes.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveChatDisplayName as resolveImpl,
  formatChatRefForOwner as formatImpl,
  sanitizeDisplayNameForRender,
} from '../../src/core/chat-display-name.ts';
import { setLidAuthDir } from '../../src/core/lid-resolver.ts';
import type { Database } from '../../src/core/database.ts';

// The resolver takes the `Database` wrapper (resolveLid's contract — its L1.5
// disk fallback writes through it). Tests drive a real raw handle through a
// minimal structural wrapper, the same shape runtime tests fake.
function resolveChatDisplayName(raw: DatabaseSync, ref: string): string {
  return resolveImpl({ raw } as unknown as Database, ref);
}

function formatChatRefForOwner(raw: DatabaseSync, ref: string): string {
  return formatImpl({ raw } as unknown as Database, ref);
}

// --- Helpers ---------------------------------------------------------------

// Schema mirrors src/core/database.ts (chat_aliases / groups / chats /
// contacts / lid_mappings — the columns the resolver reads).
function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE chat_aliases (
      alias TEXT NOT NULL PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE groups (
      jid TEXT PRIMARY KEY,
      subject TEXT,
      description TEXT,
      owner TEXT,
      creation_time INTEGER,
      participant_count INTEGER,
      restrict_mode INTEGER DEFAULT 0,
      announce_mode INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE chats (
      jid TEXT PRIMARY KEY,
      conversation_key TEXT NOT NULL,
      name TEXT,
      unread_count INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0,
      is_pinned INTEGER DEFAULT 0,
      mute_until TEXT,
      ephemeral_duration INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE contacts (
      jid TEXT PRIMARY KEY,
      canonical_phone TEXT,
      display_name TEXT,
      notify_name TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE lid_mappings (
      lid TEXT PRIMARY KEY,
      phone_jid TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE messages (
      pk INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT,
      conversation_key TEXT,
      sender_jid TEXT NOT NULL,
      sender_name TEXT,
      timestamp INTEGER NOT NULL
    );
  `);
  return db;
}

const GROUP_JID = '111222333444555666@g.us';
const GROUP_KEY = '111222333444555666_at_g.us';
const DM_JID = '15550001111@s.whatsapp.net';
const DM_KEY = '15550001111';

describe('resolveChatDisplayName — B23 ladder', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeDb();
  });

  it('owner chatAlias wins over group subject and everything else', () => {
    db.prepare('INSERT INTO chat_aliases (alias, chat_jid) VALUES (?, ?)').run('ops-crew', GROUP_JID);
    db.prepare('INSERT INTO groups (jid, subject) VALUES (?, ?)').run(GROUP_JID, 'Some Subject');
    expect(resolveChatDisplayName(db, GROUP_JID)).toBe('ops-crew');
    expect(resolveChatDisplayName(db, GROUP_KEY)).toBe('ops-crew');
  });

  it('owner chatAlias wins for DMs over the contact name', () => {
    db.prepare('INSERT INTO chat_aliases (alias, chat_jid) VALUES (?, ?)').run('boss', DM_JID);
    db.prepare('INSERT INTO contacts (jid, canonical_phone, display_name) VALUES (?, ?, ?)')
      .run(DM_JID, DM_KEY, 'Lucas');
    expect(resolveChatDisplayName(db, DM_JID)).toBe('boss');
    expect(resolveChatDisplayName(db, DM_KEY)).toBe('boss');
  });

  it('group subject when no alias exists (both jid and conversation_key inputs)', () => {
    db.prepare('INSERT INTO groups (jid, subject) VALUES (?, ?)').run(GROUP_JID, 'Ops Crew Test');
    expect(resolveChatDisplayName(db, GROUP_JID)).toBe('Ops Crew Test');
    expect(resolveChatDisplayName(db, GROUP_KEY)).toBe('Ops Crew Test');
  });

  it('chats.name when there is no groups row', () => {
    db.prepare('INSERT INTO chats (jid, conversation_key, name) VALUES (?, ?, ?)')
      .run(GROUP_JID, GROUP_KEY, 'Family Group');
    expect(resolveChatDisplayName(db, GROUP_JID)).toBe('Family Group');
    expect(resolveChatDisplayName(db, GROUP_KEY)).toBe('Family Group');
  });

  it('DM contact display_name, with notify_name as its fallback', () => {
    db.prepare('INSERT INTO contacts (jid, canonical_phone, display_name, notify_name) VALUES (?, ?, ?, ?)')
      .run(DM_JID, DM_KEY, 'Lucas', 'lucas-push');
    expect(resolveChatDisplayName(db, DM_JID)).toBe('Lucas');
    expect(resolveChatDisplayName(db, DM_KEY)).toBe('Lucas');

    db.prepare('UPDATE contacts SET display_name = NULL').run();
    expect(resolveChatDisplayName(db, DM_JID)).toBe('lucas-push');
  });

  it('a device-suffixed DM jid resolves the same contact', () => {
    db.prepare('INSERT INTO contacts (jid, canonical_phone, display_name) VALUES (?, ?, ?)')
      .run(DM_JID, DM_KEY, 'Lucas');
    expect(resolveChatDisplayName(db, '15550001111:5@s.whatsapp.net')).toBe('Lucas');
  });

  it('blank-string names are misses, not hits', () => {
    db.prepare('INSERT INTO contacts (jid, canonical_phone, display_name, notify_name) VALUES (?, ?, ?, ?)')
      .run('15551112222@s.whatsapp.net', '15551112222', '', '   ');
    expect(resolveChatDisplayName(db, '15551112222')).toBe('+15551112222');
  });

  it('formatted phone for a DM with no metadata at all', () => {
    expect(resolveChatDisplayName(db, '15551112222')).toBe('+15551112222');
    expect(resolveChatDisplayName(db, '15551112222@s.whatsapp.net')).toBe('+15551112222');
  });

  it('@lid ref resolves through lid_mappings to the contact name', () => {
    db.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111110000099', DM_JID);
    db.prepare('INSERT INTO contacts (jid, canonical_phone, display_name) VALUES (?, ?, ?)')
      .run(DM_JID, DM_KEY, 'Lucas');
    expect(resolveChatDisplayName(db, '11111110000099@lid')).toBe('Lucas');
  });

  it('@lid ref with a mapping but no contact falls to the mapped formatted phone', () => {
    db.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111110000099', DM_JID);
    expect(resolveChatDisplayName(db, '11111110000099@lid')).toBe('+15550001111');
  });

  it('an UNMAPPED @lid ref falls back to the raw ref — never a fake phone', () => {
    expect(resolveChatDisplayName(db, '11111110000777@lid')).toBe('11111110000777@lid');
  });

  it('a group with no metadata falls back to the raw ref', () => {
    expect(resolveChatDisplayName(db, GROUP_JID)).toBe(GROUP_JID);
    expect(resolveChatDisplayName(db, GROUP_KEY)).toBe(GROUP_KEY);
  });

  it('a non-numeric unknown DM ref falls back to the raw ref', () => {
    expect(resolveChatDisplayName(db, 'owner@s.whatsapp.net')).toBe('owner@s.whatsapp.net');
  });

  // ── B25 resolver hardening ─────────────────────────────────────────────────

  it('F1: an unmapped 12+-digit bare lid-shaped key falls back to the raw ref, never a fabricated phone', () => {
    // Execution-verified defect: '11111119876543' rendered '+11111119876543' —
    // a fake phone minted from a bare-lid conversation key.
    expect(resolveChatDisplayName(db, '11111119876543')).toBe('11111119876543');
  });

  it('F1: a mapped bare lid key renders the mapped phone, not "+<lid>"', () => {
    db.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111119876543', DM_JID);
    expect(resolveChatDisplayName(db, '11111119876543')).toBe('+15550001111');
  });

  it('F1: a mapped bare lid key reaches the contact name (regression guard)', () => {
    db.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111119876543', DM_JID);
    db.prepare('INSERT INTO contacts (jid, canonical_phone, display_name) VALUES (?, ?, ?)')
      .run(DM_JID, DM_KEY, 'Lucas');
    expect(resolveChatDisplayName(db, '11111119876543')).toBe('Lucas');
  });

  it('F7: an owner alias keyed by the phone JID wins for a lid-keyed ref', () => {
    db.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111110000099', DM_JID);
    db.prepare('INSERT INTO chat_aliases (alias, chat_jid) VALUES (?, ?)').run('boss', DM_JID);
    expect(resolveChatDisplayName(db, '11111110000099@lid')).toBe('boss');
    expect(resolveChatDisplayName(db, '11111110000099')).toBe('boss');
  });

  it('F6: a contact row keyed by the @lid jid is reachable for an UNMAPPED lid ref', () => {
    // contacts-sync stores raw Baileys ids including '@lid' jids with
    // canonical_phone = bare lid digits.
    db.prepare('INSERT INTO contacts (jid, canonical_phone, notify_name) VALUES (?, ?, ?)')
      .run('11111110000888@lid', '11111110000888', 'Push Name');
    expect(resolveChatDisplayName(db, '11111110000888@lid')).toBe('Push Name');
  });

  it('F6: an @lid-keyed contact row also wins for a MAPPED lid with no phone-keyed contact', () => {
    db.prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111110000888', DM_JID);
    db.prepare('INSERT INTO contacts (jid, canonical_phone, notify_name) VALUES (?, ?, ?)')
      .run('11111110000888@lid', '11111110000888', 'Push Name');
    expect(resolveChatDisplayName(db, '11111110000888@lid')).toBe('Push Name');
  });

  it('F9: a named contact row beats an unnamed row matching the same OR-lookup', () => {
    // Row order must not decide the render: the NULL-named row (matched by
    // jid) precedes the named row (matched by canonical_phone) in rowid order.
    db.prepare('INSERT INTO contacts (jid, canonical_phone, display_name, notify_name) VALUES (?, ?, NULL, NULL)')
      .run(DM_JID, DM_KEY);
    db.prepare('INSERT INTO contacts (jid, canonical_phone, display_name) VALUES (?, ?, ?)')
      .run('15550001111:2@s.whatsapp.net', DM_KEY, 'Lucas');
    expect(resolveChatDisplayName(db, DM_JID)).toBe('Lucas');
  });

  it('F9: a named chats row beats an unnamed row matching the same OR-lookup', () => {
    db.prepare('INSERT INTO chats (jid, conversation_key, name) VALUES (?, ?, NULL)')
      .run(GROUP_JID, GROUP_KEY);
    db.prepare('INSERT INTO chats (jid, conversation_key, name) VALUES (?, ?, ?)')
      .run('secondary-device-row@g.us', GROUP_KEY, 'Family Group');
    expect(resolveChatDisplayName(db, GROUP_KEY)).toBe('Family Group');
  });

  it('reconstructs the raw jid for ANY _at_ domain when probing chat_aliases', () => {
    db.prepare('INSERT INTO chat_aliases (alias, chat_jid) VALUES (?, ?)')
      .run('newsline', '123456789@newsletter');
    expect(resolveChatDisplayName(db, '123456789_at_newsletter')).toBe('newsline');
  });

  it('picks the most recently updated alias, not the alphabetical first', () => {
    db.prepare("INSERT INTO chat_aliases (alias, chat_jid, updated_at) VALUES ('alpha', ?, '2026-01-01 00:00:00')")
      .run(DM_JID);
    db.prepare("INSERT INTO chat_aliases (alias, chat_jid, updated_at) VALUES ('zulu', ?, '2026-06-01 00:00:00')")
      .run(DM_JID);
    expect(resolveChatDisplayName(db, DM_JID)).toBe('zulu');
  });

  it('falls back to the most recent non-blank messages.sender_name before the phone rung', () => {
    db.prepare('INSERT INTO messages (sender_jid, sender_name, timestamp) VALUES (?, ?, ?)')
      .run(DM_JID, 'Old Name', 100);
    db.prepare('INSERT INTO messages (sender_jid, sender_name, timestamp) VALUES (?, ?, ?)')
      .run(DM_JID, 'Push Lucas', 200);
    db.prepare('INSERT INTO messages (sender_jid, sender_name, timestamp) VALUES (?, NULL, ?)')
      .run(DM_JID, 300);
    expect(resolveChatDisplayName(db, DM_KEY)).toBe('Push Lucas');
  });

  it('contacts beat sender_name; sender_name beats the formatted phone', () => {
    db.prepare('INSERT INTO messages (sender_jid, sender_name, timestamp) VALUES (?, ?, ?)')
      .run(DM_JID, 'Push Lucas', 200);
    expect(resolveChatDisplayName(db, DM_KEY)).toBe('Push Lucas');
    db.prepare('INSERT INTO contacts (jid, canonical_phone, display_name) VALUES (?, ?, ?)')
      .run(DM_JID, DM_KEY, 'Lucas');
    expect(resolveChatDisplayName(db, DM_KEY)).toBe('Lucas');
  });

  it('sender_name keyed by the lid jid is reachable for a lid ref', () => {
    db.prepare('INSERT INTO messages (sender_jid, sender_name, timestamp) VALUES (?, ?, ?)')
      .run('11111110000888@lid', 'Lid Sender', 100);
    expect(resolveChatDisplayName(db, '11111110000888@lid')).toBe('Lid Sender');
  });

  // Malformed-@lid sibling fold (B25 addendum): some lids carry the PHONE as
  // their userpart. Inherit the '<userpart>@s.whatsapp.net' identity ONLY on
  // observed evidence (existing contacts/chats/named-sender rows keyed by that
  // pn jid) — never on phone shape alone, which would recreate the F1 bug.

  it('fold: a phone-userpart @lid WITH an observed pn contact row inherits that identity', () => {
    // canonical_phone deliberately NULL — the inheritance must come from the
    // pn-jid evidence probe, not the canonical_phone OR-match.
    db.prepare('INSERT INTO contacts (jid, canonical_phone, display_name) VALUES (?, NULL, ?)')
      .run(DM_JID, 'Lucas');
    expect(resolveChatDisplayName(db, '15550001111@lid')).toBe('Lucas');
  });

  it('fold: a phone-userpart @lid WITH named pn sender history inherits the name', () => {
    // Live class: '<phone>@lid' with zero lid-keyed rows but a fully-named
    // pn-keyed message history for the same person.
    db.prepare('INSERT INTO messages (sender_jid, sender_name, timestamp) VALUES (?, ?, ?)')
      .run(DM_JID, 'Owner Line', 100);
    expect(resolveChatDisplayName(db, '15550001111@lid')).toBe('Owner Line');
  });

  it('fold: a phone-shaped @lid WITHOUT sibling data stays raw — shape alone never inherits', () => {
    expect(resolveChatDisplayName(db, '15550009999@lid')).toBe('15550009999@lid');
  });

  it('fold: an unmapped 12+-digit BARE key with named pn sender history is rescued by evidence', () => {
    db.prepare('INSERT INTO messages (sender_jid, sender_name, timestamp) VALUES (?, ?, ?)')
      .run('111111100777@s.whatsapp.net', 'Roamer', 100);
    expect(resolveChatDisplayName(db, '111111100777')).toBe('Roamer');
  });

  it('F5: lid resolution rides resolveLid — the L1.5 disk fallback finds a mapping the DB lacks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdn-lid-'));
    writeFileSync(join(dir, 'lid-mapping-11111110000012_reverse.json'), JSON.stringify('15550001111'));
    setLidAuthDir(dir);
    try {
      db.prepare('INSERT INTO contacts (jid, canonical_phone, display_name) VALUES (?, ?, ?)')
        .run(DM_JID, DM_KEY, 'Lucas');
      expect(resolveChatDisplayName(db, '11111110000012@lid')).toBe('Lucas');
    } finally {
      setLidAuthDir('');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('memoizes prepared statements and table-absent misses per db handle', () => {
    const prepare = vi.fn(() => { throw new Error('no such table'); });
    const fake = { prepare } as unknown as DatabaseSync;
    // Table-less handle fail-opens to the pure-string phone rung (pn-origin ref).
    expect(resolveChatDisplayName(fake, DM_JID)).toBe('+15550001111');
    const after = prepare.mock.calls.length;
    expect(after).toBeGreaterThan(0);
    expect(resolveChatDisplayName(fake, DM_JID)).toBe('+15550001111');
    // Second pass re-prepares nothing: hits AND table-absent misses memoized.
    expect(prepare.mock.calls.length).toBe(after);
  });

  it('NEVER throws — a db with no tables at all degrades to the string ladder', () => {
    const bare = new DatabaseSync(':memory:');
    expect(() => resolveChatDisplayName(bare, GROUP_JID)).not.toThrow();
    expect(resolveChatDisplayName(bare, GROUP_JID)).toBe(GROUP_JID);
    // Phone formatting is a pure string step, so it still applies.
    expect(resolveChatDisplayName(bare, '15551112222')).toBe('+15551112222');
  });
});

// B25 F2/F3: the render choke point — names are remote-controlled, so every
// owner-facing interpolation sanitizes AND disambiguates in ONE place.
describe('sanitizeDisplayNameForRender / formatChatRefForOwner — B25 F2/F3', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeDb();
  });

  it('strips control chars, newlines and markdown metachars; collapses whitespace', () => {
    expect(sanitizeDisplayNameForRender('Evil\n2. Ghost *p* `q` ~r~ _s_')).toBe('Evil 2. Ghost p q r s');
    expect(sanitizeDisplayNameForRender('a\u0007b\u2028c\rd')).toBe('a b c d');
  });

  it('caps the length at 40 with an ellipsis', () => {
    const out = sanitizeDisplayNameForRender('x'.repeat(60));
    expect(out.length).toBe(40);
    expect(out.endsWith('…')).toBe(true);
  });

  it('formats the resolved name with the stable ref suffix from the RAW key', () => {
    db.prepare('INSERT INTO contacts (jid, canonical_phone, display_name) VALUES (?, ?, ?)')
      .run(DM_JID, DM_KEY, 'Lucas');
    expect(formatChatRefForOwner(db, DM_KEY)).toBe('Lucas (…1111)');
    expect(formatChatRefForOwner(db, DM_JID)).toBe('Lucas (…1111)');
    // Device suffix never leaks into the suffix.
    expect(formatChatRefForOwner(db, '15550001111:5@s.whatsapp.net')).toBe('Lucas (…1111)');
  });

  it('group refs get the suffix from the group id local part', () => {
    db.prepare('INSERT INTO groups (jid, subject) VALUES (?, ?)').run(GROUP_JID, 'Ops Crew Test');
    expect(formatChatRefForOwner(db, GROUP_KEY)).toBe('Ops Crew Test (…5666)');
    expect(formatChatRefForOwner(db, GROUP_JID)).toBe('Ops Crew Test (…5666)');
  });

  it('a name that sanitizes to empty falls back to the sanitized ref, never an empty render', () => {
    db.prepare('INSERT INTO contacts (jid, canonical_phone, display_name) VALUES (?, ?, ?)')
      .run(DM_JID, DM_KEY, '***');
    expect(formatChatRefForOwner(db, DM_KEY)).toBe('15550001111 (…1111)');
  });

  it('never throws on a table-less handle and keeps the suffix', () => {
    const bare = new DatabaseSync(':memory:');
    expect(formatChatRefForOwner(bare, DM_KEY)).toBe('+15550001111 (…1111)');
  });
});
