// tests/core/chat-display-name.test.ts
//
// B23 UX polish — owner ruling (verbatim): "sessions should show contact
// names, group names, etc — not unrecognizable JID/LID mappings or phone
// numbers". Contract tests for the display-name resolution ladder used by
// the /sessions list and the /kill-session ack:
//
//   1. chat_aliases.alias      — the owner's own name for the chat
//                                (config chatAliases seeds this table,
//                                main.ts → seedChatAliases)
//   2. groups.subject          — WhatsApp group subject
//      then chats.name         — chat-level name (chat-sync)
//   3. contacts.display_name / notify_name — contact address-book/push name
//      (via lid_mappings indirection for @lid refs)
//   4. formatted phone (+digits) for DMs
//   5. the raw ref, unchanged  — last resort; NEVER throws on a miss
//
// Inputs may be a conversation_key ('123_at_g.us' / bare phone) or a raw JID
// ('123@g.us' / '123@s.whatsapp.net' / '123@lid') — the runtime's session
// map keys carry both shapes.

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { resolveChatDisplayName } from '../../src/core/chat-display-name.ts';

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
    db.prepare('INSERT INTO groups (jid, subject) VALUES (?, ?)').run(GROUP_JID, 'Loopicus Ops');
    expect(resolveChatDisplayName(db, GROUP_JID)).toBe('Loopicus Ops');
    expect(resolveChatDisplayName(db, GROUP_KEY)).toBe('Loopicus Ops');
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

  it('NEVER throws — a db with no tables at all degrades to the string ladder', () => {
    const bare = new DatabaseSync(':memory:');
    expect(() => resolveChatDisplayName(bare, GROUP_JID)).not.toThrow();
    expect(resolveChatDisplayName(bare, GROUP_JID)).toBe(GROUP_JID);
    // Phone formatting is a pure string step, so it still applies.
    expect(resolveChatDisplayName(bare, '15551112222')).toBe('+15551112222');
  });
});
