// tests/mcp/tools/messaging-send-resolved-jid-3150.test.ts
//
// Issue 3150 remainder: the send response echoes the resolved (alias- and
// `@lid`-canonicalized) chatJid, and a `dryRun` param resolves + reports the
// resolved target WITHOUT sending. These live in their own file because
// messaging.test.ts sits ~17 lines under the 2000-line arch.file-size warn
// budget at base, so appending here instead of there keeps that file under
// budget and avoids grandfathering a 36th warning file for three tests. The
// small fixture harness below mirrors messaging.test.ts's per-file setup (the
// repo norm — each messaging test file rolls its own db/connection fixture).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../helpers/resolved-tool-registry.ts';
import { registerMessagingTools, type MessagingDeps } from '../../../src/mcp/tools/messaging.ts';
import { createProfileRegistry } from '../../../src/core/profiles.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
}));

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE messages (
      pk INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      sender_name TEXT,
      message_id TEXT UNIQUE,
      content TEXT,
      content_type TEXT NOT NULL DEFAULT 'text',
      is_from_me INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL,
      quoted_message_id TEXT,
      edited_at TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE chat_aliases (
      alias TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  return db;
}

function seedMessage(
  db: DatabaseSync,
  overrides: {
    message_id: string;
    chat_jid: string;
    conversation_key: string;
    sender_jid: string;
  },
): void {
  db.prepare(`
    INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, is_from_me, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.chat_jid,
    overrides.conversation_key,
    overrides.sender_jid,
    overrides.message_id,
    'hello',
    0,
    1_700_000_000,
  );
}

function seedAlias(db: DatabaseSync, alias: string, chatJid: string): void {
  db.prepare('INSERT INTO chat_aliases (alias, chat_jid) VALUES (?, ?)').run(alias, chatJid);
}

// Trimmed connection fixture — send_message only reaches sendRaw and reads
// contactsDir for mention formatting; the poll/media transports are unused here.
function makeConnection(calls: string[]) {
  return {
    contactsDir: {
      contacts: new Map<string, string>(),
      getLidMappings: () => undefined,
    },
    sendRaw: async (jid: string, content: unknown) => {
      calls.push(JSON.stringify({ jid, content }));
      return { waMessageId: null };
    },
  } as unknown as import('../../../src/transport/connection.ts').ConnectionManager;
}

describe('send_message resolved-chatJid echo + dryRun (issue 3150 remainder)', () => {
  const PIN_PHONE = '15551230777';
  const PIN_PHONE_JID = '15551230777@s.whatsapp.net';
  const PIN_LID = '11111110777';
  const PIN_LID_JID = '11111110777@lid';

  let registry: ToolRegistry;
  let db: DatabaseSync;
  let dbWrapper: Database;
  let calls: string[];

  beforeEach(() => {
    registry = new ToolRegistry();
    db = makeDb();
    dbWrapper = new Database(':memory:');
    dbWrapper.open();
    calls = [];
    const deps: MessagingDeps = {
      connection: makeConnection(calls),
      db,
      dbWrapper,
      adminPhones: new Set<string>(),
      instanceName: 'test-bot',
      profiles: createProfileRegistry({}),
    };
    registerMessagingTools(registry, deps);
  });

  function seedPinMapping(lid: string, phoneJid: string): void {
    // lid_mappings lives in the wrapper's full schema — consulted by both the
    // send-path @lid canonicalization (resolveLidsForPhone) and the pin fold.
    dbWrapper.raw
      .prepare('INSERT INTO lid_mappings (lid, phone_jid) VALUES (?, ?)')
      .run(lid, phoneJid);
  }

  function seedOwnLidThread(): void {
    seedPinMapping(PIN_LID, PIN_PHONE_JID);
    // Existing @lid thread so canonicalization fires: phone JID in -> @lid out.
    seedMessage(db, {
      message_id: `msg-3150-${calls.length}`,
      chat_jid: PIN_LID_JID,
      conversation_key: PIN_PHONE,
      sender_jid: PIN_LID_JID,
    });
  }

  it('echoes the resolved @lid chatJid when a phone-JID target canonicalizes onto the existing thread', async () => {
    seedOwnLidThread();

    const result = await registry.call(
      'send_message',
      { chatJid: PIN_PHONE_JID, text: 'echo my resolved target' },
      { tier: 'global', conversationKey: PIN_PHONE },
    );

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    // Transport received the canonicalized @lid JID; the response echoes it
    // even though the caller passed the phone JID.
    expect(JSON.parse(calls[0]).jid).toBe(PIN_LID_JID);
    const body = JSON.parse(result.content[0].text);
    expect(body.sent).toBe(true);
    expect(body.resolved_chatJid).toBe(PIN_LID_JID);
  });

  it('dryRun resolves the target and reports the resolved chatJid without sending', async () => {
    seedOwnLidThread();

    const result = await registry.call(
      'send_message',
      { chatJid: PIN_PHONE_JID, text: 'would route here', dryRun: true },
      { tier: 'global', conversationKey: PIN_PHONE },
    );

    expect(result.isError).toBeUndefined();
    // Nothing transmitted, no audit record.
    expect(calls).toHaveLength(0);
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      sent: false,
      dryRun: true,
      resolved_chatJid: PIN_LID_JID,
    });
  });

  it('dryRun still rejects a foreign @lid alias mapped to a different phone without sending', async () => {
    seedPinMapping(PIN_LID, PIN_PHONE_JID);
    seedPinMapping('11111110888', '15551230999@s.whatsapp.net');
    seedAlias(db, 'foreign-lid', '11111110888@lid');

    const result = await registry.call(
      'send_message',
      { to: 'foreign-lid', text: 'cross-conversation dry run', dryRun: true },
      { tier: 'global', conversationKey: PIN_PHONE },
    );

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/does not match session conversation/);
  });
});
