// tests/mcp/tools/client-output-policy-tools.test.ts
// #3613: the MCP send tools enforce the per-conversation client output policy
// with the same evaluator call and audit line as the agent outbound queue.
// A withheld send returns a structured tool error and never echoes the text.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Database } from '../../../src/core/database.ts';
import { ToolRegistry } from '../../helpers/resolved-tool-registry.ts';
import { registerMessagingTools, type MessagingDeps } from '../../../src/mcp/tools/messaging.ts';
import { registerMediaTools, type MediaDeps } from '../../../src/mcp/tools/media.ts';
import { registerVoiceTools, type VoiceDeps } from '../../../src/mcp/tools/voice.ts';
import type { SessionContext } from '../../../src/mcp/types.ts';
import {
  parseClientOutputPolicies,
  type ClientOutputPolicyRegistry,
} from '../../../src/core/client-output-policy-config.ts';

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: vi.fn(() => true),
  emitObservationChecked: vi.fn(() => true),
}));

const mockLog = vi.hoisted(() => ({} as Record<string, ReturnType<typeof vi.fn>>));
const mockSynthesizeSpeech = vi.hoisted(() => vi.fn());

vi.mock('../../../src/runtimes/chat/providers/elevenlabs.ts', () => ({
  synthesizeSpeech: mockSynthesizeSpeech,
}));

vi.mock('../../../src/logger.ts', async () => {
  const { hoistedLoggerMock } = await import('../../helpers/logger-mock.ts');
  const { createChildLogger } = hoistedLoggerMock(mockLog);
  return { createChildLogger };
});

const KEY = '15550000000';
const JID = `${KEY}@s.whatsapp.net`;
const OTHER_KEY = '15551111111';
const OTHER_JID = `${OTHER_KEY}@s.whatsapp.net`;
const BLOCKED_TERM = 'zebracorn';

function registryFor(): ClientOutputPolicyRegistry {
  const parsed = parseClientOutputPolicies([{
    conversationKey: KEY,
    maxCodePoints: 4000,
    maxQuestionMarks: 1,
    blockedTerms: [{ value: BLOCKED_TERM, match: 'whole_word', caseSensitive: false }],
    rejectInternalArtifacts: true,
    rejectWhatsAppJids: true,
  }]);
  if (!parsed.ok) throw new Error('fixture policy invalid');
  return parsed.registry;
}

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

function seedMessage(db: DatabaseSync, messageId: string, conversationKey: string, chatJid: string, isFromMe: number): void {
  db.prepare(`
    INSERT INTO messages (chat_jid, conversation_key, sender_jid, message_id, content, is_from_me, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(chatJid, conversationKey, chatJid, messageId, 'earlier text', isFromMe, 1_700_000_000);
}

function session(conversationKey: string, deliveryJid: string, allowedRoot?: string): SessionContext {
  return { tier: 'chat-scoped', conversationKey, deliveryJid, allowedRoot };
}

function policyCalls(level: 'warn' | 'error'): unknown[][] {
  return mockLog[level]!.mock.calls.filter((call) => {
    const fields = call[0] as Record<string, unknown> | undefined;
    return fields?.['operation'] === 'client_output_policy';
  });
}

function bodyOf(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function expectWithheld(
  result: { isError?: boolean; content: Array<{ text: string }> },
  messageKind: string,
  leakedText: string,
): void {
  expect(result.isError).toBe(true);
  const body = bodyOf(result);
  expect(body).toEqual({
    sent: false,
    withheld: true,
    reason: 'client_output_policy',
    violationCodes: ['blocked_term'],
  });
  const serializedResult = JSON.stringify(result);
  expect(serializedResult).not.toContain(leakedText);
  const warns = policyCalls('warn');
  expect(warns).toHaveLength(1);
  expect(warns[0]![0]).toEqual({
    operation: 'client_output_policy',
    decision: 'rejected',
    conversationKey: KEY,
    reason: 'client_output_policy',
    violationCodes: ['blocked_term'],
    messageKind,
  });
  expect(JSON.stringify(warns).toLowerCase()).not.toContain(BLOCKED_TERM);
}

describe('MCP messaging tools enforce the client output policy (#3613)', () => {
  let registry: ToolRegistry;
  let db: DatabaseSync;
  let dbWrapper: Database;
  let calls: string[];
  let deps: MessagingDeps;

  beforeEach(() => {
    for (const fn of Object.values(mockLog)) fn.mockClear();
    registry = new ToolRegistry();
    db = makeDb();
    dbWrapper = new Database(':memory:');
    dbWrapper.open();
    calls = [];
    const connection = {
      contactsDir: { contacts: new Map<string, string>(), getLidMappings: () => undefined },
      sendRaw: async (jid: string, content: unknown) => {
        calls.push(JSON.stringify({ jid, content }));
        return { waMessageId: null };
      },
      sendPollMessage: async (jid: string, name: string, values: string[], selectableCount: number) => {
        calls.push(JSON.stringify({ jid, poll: { name, values, selectableCount } }));
        return { waMessageId: 'poll-1', hasSecret: true };
      },
    } as unknown as MessagingDeps['connection'];
    deps = {
      connection,
      db,
      dbWrapper,
      adminPhones: new Set<string>(),
      instanceName: 'test-bot',
      clientOutputPolicies: registryFor(),
    };
    registerMessagingTools(registry, deps);
  });

  afterEach(() => {
    dbWrapper.close();
  });

  it('send_message: withholds a rejected message', async () => {
    const text = `Tell them about ${BLOCKED_TERM} now.`;
    const result = await registry.call('send_message', { text }, session(KEY, JID));

    expect(calls).toHaveLength(0);
    expectWithheld(result, 'send_message', 'Tell them about');
  });

  it('send_message: sends an allowed message unchanged', async () => {
    const result = await registry.call('send_message', { text: 'Your order ships tomorrow.' }, session(KEY, JID));

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!).content.text).toBe('Your order ships tomorrow.');
    expect(policyCalls('warn')).toHaveLength(0);
  });

  it('send_message: leaves a conversation without a policy untouched', async () => {
    const text = `Two questions? About ${BLOCKED_TERM}?`;
    const result = await registry.call('send_message', { text }, session(OTHER_KEY, OTHER_JID));

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(calls[0]!).content.text).toBe(text);
    expect(policyCalls('warn')).toHaveLength(0);
  });

  it('send_message: a registry built without policies leaves every send untouched', async () => {
    const plain = new ToolRegistry();
    registerMessagingTools(plain, { ...deps, clientOutputPolicies: undefined });
    const text = `Two questions? About ${BLOCKED_TERM}?`;

    const result = await plain.call('send_message', { text }, session(KEY, JID));

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('reply_message: withholds a rejected reply', async () => {
    seedMessage(db, 'msg-in', KEY, JID, 0);
    const text = `Reply mentioning ${BLOCKED_TERM}.`;
    const result = await registry.call(
      'reply_message',
      { chatJid: JID, messageId: 'msg-in', text },
      session(KEY, JID),
    );

    expect(calls).toHaveLength(0);
    expectWithheld(result, 'reply_message', 'Reply mentioning');
  });

  it('edit_message: withholds a rejected edit', async () => {
    seedMessage(db, 'msg-out', KEY, JID, 1);
    const newText = `Edited to add ${BLOCKED_TERM}.`;
    const result = await registry.call(
      'edit_message',
      { chatJid: JID, messageId: 'msg-out', newText },
      session(KEY, JID),
    );

    expect(calls).toHaveLength(0);
    expectWithheld(result, 'edit_message', 'Edited to add');
  });

  it('send_poll: withholds a poll whose option breaks the policy', async () => {
    const result = await registry.call(
      'send_poll',
      { chatJid: JID, question: 'Which launch works best', options: ['Monday', `The ${BLOCKED_TERM} one`] },
      session(KEY, JID),
    );

    expect(calls).toHaveLength(0);
    expectWithheld(result, 'send_poll', 'Which launch works best');
  });

  it('send_poll: sends an allowed poll', async () => {
    const result = await registry.call(
      'send_poll',
      { chatJid: JID, question: 'Which day works best', options: ['Monday', 'Tuesday'] },
      session(KEY, JID),
    );

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe('MCP send_media enforces the client output policy on captions (#3613)', () => {
  let registry: ToolRegistry;
  let dbWrapper: Database;
  let mediaCalls: unknown[];
  let workspace: string;

  beforeEach(() => {
    for (const fn of Object.values(mockLog)) fn.mockClear();
    registry = new ToolRegistry();
    dbWrapper = new Database(':memory:');
    dbWrapper.open();
    mediaCalls = [];
    const connection = {
      sendMedia: async (chatJid: string, media: unknown) => {
        mediaCalls.push({ chatJid, media });
        const stream = (media as { stream?: { destroy?: () => void; on?: (e: 'error', l: () => void) => void } }).stream;
        stream?.on?.('error', () => {});
        stream?.destroy?.();
        return { waMessageId: null };
      },
    } as unknown as MediaDeps['connection'];
    registerMediaTools(registry, {
      connection,
      db: dbWrapper,
      adminPhones: new Set<string>(),
      clientOutputPolicies: registryFor(),
    });
    workspace = join(tmpdir(), `whatsoup-cop-media-${randomBytes(4).toString('hex')}`);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'photo.jpg'), 'fake-image');
  });

  afterEach(() => {
    dbWrapper.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('withholds media whose caption breaks the policy', async () => {
    const result = await registry.call(
      'send_media',
      { chatJid: JID, filePath: join(workspace, 'photo.jpg'), caption: `Caption about ${BLOCKED_TERM}` },
      session(KEY, JID, workspace),
    );

    expect(mediaCalls).toHaveLength(0);
    expectWithheld(result, 'send_media', 'Caption about');
  });

  it('sends media without a caption untouched', async () => {
    const result = await registry.call(
      'send_media',
      { chatJid: JID, filePath: join(workspace, 'photo.jpg') },
      session(KEY, JID, workspace),
    );

    expect(result.isError).toBeUndefined();
    expect(mediaCalls).toHaveLength(1);
    expect(policyCalls('warn')).toHaveLength(0);
  });
});

describe('MCP send_voice_reply enforces the client output policy (#3613)', () => {
  it('withholds rejected text before it is synthesized or sent', async () => {
    for (const fn of Object.values(mockLog)) fn.mockClear();
    mockSynthesizeSpeech.mockReset();
    const dbWrapper = new Database(':memory:');
    dbWrapper.open();
    try {
      const sendMedia = vi.fn(async () => ({ waMessageId: null }));
      const registry = new ToolRegistry();
      registerVoiceTools(registry, {
        connection: { sendMedia } as unknown as VoiceDeps['connection'],
        db: dbWrapper,
        clientOutputPolicies: registryFor(),
      });

      const result = await registry.call(
        'send_voice_reply',
        { text: `Spoken words about ${BLOCKED_TERM}` },
        session(KEY, JID),
      );

      expect(mockSynthesizeSpeech).not.toHaveBeenCalled();
      expect(sendMedia).not.toHaveBeenCalled();
      expectWithheld(result, 'send_voice_reply', 'Spoken words about');
    } finally {
      dbWrapper.close();
    }
  });
});
