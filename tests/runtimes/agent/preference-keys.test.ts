/**
 * Canonical-key tests for the preference identity spine (review finding F01:
 * raw chat_jid/sender_jid keys split identities under LID↔PN aliasing and
 * orphan rows when a DM chat re-keys from @lid to the phone JID).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import { preferenceKeys } from '../../../src/runtimes/agent/preference-keys.ts';

let db: Database;
let dbPath: string;

beforeEach(() => {
  dbPath = join(tmpdir(), `pref-keys-test-${randomBytes(6).toString('hex')}.db`);
  db = new Database(dbPath);
  // Database() does not run migrations; create the one table resolveLid reads
  // (MIGRATION_6 DDL). The unmapped-LID test below deliberately relies on the
  // resolver's graceful degradation instead.
  db.raw.exec(`CREATE TABLE IF NOT EXISTS lid_mappings (
    lid TEXT PRIMARY KEY,
    phone_jid TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const fp = dbPath + suffix;
    if (existsSync(fp)) unlinkSync(fp);
  }
});

describe('preferenceKeys', () => {
  it('passes a phone DM through and strips the sender device suffix', () => {
    const k = preferenceKeys(db, '15555550100@s.whatsapp.net', '15555550111:12@s.whatsapp.net');
    expect(k).toEqual({
      chatKey: '15555550100@s.whatsapp.net',
      senderKey: '15555550111@s.whatsapp.net',
    });
  });

  it('maps a LID sender and its PN form to the SAME sender key', () => {
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111110000042', '15555550111@s.whatsapp.net');
    const viaLid = preferenceKeys(db, '15555550100@s.whatsapp.net', '11111110000042@lid');
    const viaPn = preferenceKeys(db, '15555550100@s.whatsapp.net', '15555550111@s.whatsapp.net');
    expect(viaLid.senderKey).toBe('15555550111@s.whatsapp.net');
    expect(viaLid.senderKey).toBe(viaPn.senderKey);
  });

  it('resolves a mapped LID DM chat to the phone-JID chat key (survives re-keying)', () => {
    db.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run('11111110000042', '15555550111@s.whatsapp.net');
    const k = preferenceKeys(db, '11111110000042@lid', '11111110000042@lid');
    expect(k.chatKey).toBe('15555550111@s.whatsapp.net');
  });

  it('degrades gracefully for an unmapped LID sender (normalized, device suffix stripped)', () => {
    const k = preferenceKeys(db, '15555550100@s.whatsapp.net', '11111110000042:4@lid');
    expect(k.senderKey).toBe('11111110000042@lid');
  });

  it('leaves group chat JIDs unchanged', () => {
    const k = preferenceKeys(db, '111222333@g.us', '15555550111@s.whatsapp.net');
    expect(k.chatKey).toBe('111222333@g.us');
  });
});
