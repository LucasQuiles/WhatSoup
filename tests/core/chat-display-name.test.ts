// tests/core/chat-display-name.test.ts
//
// Contract tests for the display-name resolution ladder used by the
// /sessions list and the /kill-session ack. The ladder itself — owner
// ruling, step order, accepted input shapes — is documented at the source
// module: src/core/chat-display-name.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Database as RealDatabase } from '../../src/core/database.ts';
import { resolveChatDisplayName } from '../../src/core/chat-display-name.ts';

const GROUP_JID = '111222333444555666@g.us';
const GROUP_KEY = '111222333444555666_at_g.us';
const DM_JID = '15550001111@s.whatsapp.net';
const DM_KEY = '15550001111';

describe('resolveChatDisplayName — B23 ladder', () => {
  // Real schema (B25 3c): this suite used to hand-mirror five CREATE TABLE
  // blocks, so drift in src/core/database.ts could false-green it. The real
  // Database migration chain is the schema authority; the resolver reads
  // through the raw node:sqlite handle exactly as the runtime does (the
  // `new RealDatabase(':memory:')` + `db.raw` idiom from
  // command-gate-contract.test.ts).
  let realDb: RealDatabase;
  let db: DatabaseSync;

  beforeEach(() => {
    realDb = new RealDatabase(':memory:');
    realDb.open();
    db = realDb.raw;
  });

  afterEach(() => {
    realDb.close();
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

  it('NEVER throws — a db with no tables at all degrades to the string ladder', () => {
    const bare = new DatabaseSync(':memory:');
    try {
      expect(() => resolveChatDisplayName(bare, GROUP_JID)).not.toThrow();
      expect(resolveChatDisplayName(bare, GROUP_JID)).toBe(GROUP_JID);
      // Phone formatting is a pure string step, so it still applies.
      expect(resolveChatDisplayName(bare, '15551112222')).toBe('+15551112222');
    } finally {
      bare.close();
    }
  });
});
