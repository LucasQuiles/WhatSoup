/**
 * Direct tests for src/fleet/routes/ops-messages.ts (#2239 slice 4/5).
 *
 * The four message handlers (send, access update, mark-read, save contact)
 * moved out of ops.ts. These cases import the new module directly and exercise
 * the moved behaviour; the shim case pins that ops.ts still re-exports the
 * same functions, so existing callers keep working unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({ mcpCall: vi.fn() }));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({ proxyToInstance: vi.fn() }));

import {
  handleAccessUpdate,
  handleMarkRead,
  handleSaveContact,
  handleSend,
} from '../../../src/fleet/routes/ops-messages.ts';
import * as opsShim from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { proxyToInstance } from '../../../src/fleet/http-proxy.ts';
import { Database } from '../../../src/core/database.ts';
import { toConversationKey } from '../../../src/core/conversation-key.ts';
import { FleetDbReader } from '../../../src/fleet/db-reader.ts';
import { handleGetChats } from '../../../src/fleet/routes/data.ts';
import { __resetAttemptedCacheForTests } from '../../../src/fleet/group-resolver.ts';
import { mcpCall } from '../../../src/fleet/mcp-client.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

function fakeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
  return {
    name: 'test-line',
    type: 'chat',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/data/test-line/bot.db',
    stateRoot: '/state/test-line',
    logDir: '/data/test-line/logs',
    healthToken: 'tok123',
    configPath: '/config/test-line/config.json',
    socketPath: null,
    ...overrides,
  };
}

function depsFor(instance: DiscoveredInstance): OpsDeps {
  return makeDeps<any>({ discovery: { getInstance: vi.fn(() => instance) } });
}

describe('ops-messages handlers', () => {
  beforeEach(() => {
    vi.mocked(proxyToInstance).mockReset();
    vi.mocked(mcpCall).mockReset();
    __resetAttemptedCacheForTests();
  });

  it('are the same functions ops.ts re-exports', () => {
    expect(opsShim.handleSend).toBe(handleSend);
    expect(opsShim.handleAccessUpdate).toBe(handleAccessUpdate);
    expect(opsShim.handleMarkRead).toBe(handleMarkRead);
    expect(opsShim.handleSaveContact).toBe(handleSaveContact);
  });

  it('send refuses a body carrying both chatJid and to, without proxying', async () => {
    const res = mockRes();

    await handleSend(
      mockReq({ method: 'POST', body: JSON.stringify({ chatJid: '15551230006', to: 'alias', text: 'hi' }) }),
      res, depsFor(fakeInstance()), { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({
      error: 'chatJid and to are mutually exclusive; provide exactly one',
    });
    expect(proxyToInstance).not.toHaveBeenCalled();
  });

  it('send normalizes a bare phone chatJid before proxying to the health port', async () => {
    vi.mocked(proxyToInstance).mockResolvedValue({ status: 200, body: '{"ok":true}' });
    const deps = depsFor(fakeInstance());
    const res = mockRes();

    await handleSend(
      mockReq({ method: 'POST', body: JSON.stringify({ chatJid: '15551230006', text: 'hi' }) }),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    const [port, route, method, forwarded, token] = vi.mocked(proxyToInstance).mock.calls[0]!;
    expect([port, route, method, token]).toEqual([3010, '/send', 'POST', 'tok123']);
    expect(JSON.parse(forwarded as string).chatJid).toBe('15551230006@s.whatsapp.net');
    expect(deps.realtime.publish).toHaveBeenCalled();
  });

  it.each([
    ['iMessage;+;chat-example@imessage', 'Project group'],
    ['abcdefghijklmnop==@signal', 'Project group'],
    ['iMessage;+;chat-unnamed@imessage', null],
    ['qrstuvwxyzabcdef==@signal', null],
  ] as const)('sends a listed transport group back to its original JID: %s (name: %s)', async (jid, name) => {
    const db = new Database(':memory:');
    db.open();
    try {
      const key = toConversationKey(jid);
      db.raw.prepare(`INSERT INTO messages
        (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(jid, key, 'participant', 'Pat Example', 'message-1', 'hello', 1712332800);
      db.raw.prepare('INSERT INTO chats (jid, conversation_key, name) VALUES (?, ?, ?)')
        .run(jid, key, name);
      const deps = depsFor(fakeInstance());
      const listed = mockRes();
      handleGetChats(mockReq(), listed, {
        discovery: deps.discovery,
        dbReader: new FleetDbReader('test-line', db.raw),
      }, { name: 'test-line' });
      expect(listed._status).toBe(200);
      const chats = JSON.parse(listed._body);
      expect(chats).toHaveLength(1);
      expect(chats[0].conversationKey).toBe(key);
      expect(proxyToInstance).not.toHaveBeenCalled();
      expect(mcpCall).not.toHaveBeenCalled();

      vi.mocked(proxyToInstance).mockResolvedValue({ status: 200, body: '{"ok":true}' });
      const sent = mockRes();
      await handleSend(mockReq({ method: 'POST', body: JSON.stringify({
        chatJid: chats[0].conversationKey, text: 'reply',
      }) }), sent, deps, { name: 'test-line' });

      expect(sent._status).toBe(200);
      expect(proxyToInstance).toHaveBeenCalledExactlyOnceWith(
        3010, '/send', 'POST', JSON.stringify({ chatJid: jid, text: 'reply' }), 'tok123',
      );
      expect(chats[0]).toMatchObject({
        isGroup: true, name: name ?? 'Pat Example', lastMessagePreview: 'Pat: hello',
      });
    } finally {
      db.close();
    }
  });

  it('still backfills an unnamed WhatsApp group while returning its participant fallback', () => {
    const db = new Database(':memory:');
    db.open();
    try {
      const jid = 'backfill-room@g.us';
      const key = toConversationKey(jid);
      db.raw.prepare(`INSERT INTO messages
        (chat_jid, conversation_key, sender_jid, sender_name, message_id, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(jid, key, 'participant', 'Pat Example', 'wa-message', 'hello', 1712332800);
      vi.mocked(proxyToInstance).mockResolvedValue({ status: 503, body: '{}' });
      const listed = mockRes();
      handleGetChats(mockReq(), listed, {
        discovery: depsFor(fakeInstance()).discovery,
        dbReader: new FleetDbReader('test-line', db.raw),
      }, { name: 'test-line' });

      expect(listed._status).toBe(200);
      expect(JSON.parse(listed._body)).toMatchObject([
        { conversationKey: key, isGroup: true, name: 'Pat Example', lastMessagePreview: 'Pat: hello' },
      ]);
      expect(proxyToInstance).toHaveBeenCalledExactlyOnceWith(
        3010, '/group-metadata', 'POST', JSON.stringify({ groupJid: jid }), 'tok123',
      );
    } finally {
      db.close();
    }
  });

  it('access update rejects an invalid action with the unchanged 400 message', async () => {
    const res = mockRes();

    await handleAccessUpdate(
      mockReq({ method: 'POST', body: JSON.stringify({ subjectType: 'phone', subjectId: '1555', action: 'maybe' }) }),
      res, depsFor(fakeInstance()), { name: 'test-line' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({
      error: 'body must include subjectType (phone|group), subjectId (string), action (allow|block)',
    });
    expect(proxyToInstance).not.toHaveBeenCalled();
  });

  it('mark-read passes the upstream status and body through', async () => {
    vi.mocked(proxyToInstance).mockResolvedValue({ status: 422, body: '{"error":"unprocessable"}' });
    const res = mockRes();

    await handleMarkRead(
      mockReq({ method: 'POST', body: '{"chatJid":"x"}' }),
      res, depsFor(fakeInstance()), { name: 'test-line' },
    );

    expect(res._status).toBe(422);
    expect(res._body).toBe('{"error":"unprocessable"}');
  });

  it('save contact reports 503 when no MCP socket is available', async () => {
    const res = mockRes();

    await handleSaveContact(
      mockReq({ method: 'POST', body: JSON.stringify({ jid: '15551230006@s.whatsapp.net', firstName: 'A' }) }),
      res, depsFor(fakeInstance({ socketPath: null })), { name: 'test-line' },
    );

    expect(res._status).toBe(503);
    expect(JSON.parse(res._body)).toEqual({
      error: 'MCP socket not available — contact management requires a running instance with MCP',
    });
  });

  it('keeps direct file writes off bare utf-8 string encoding (mirrors ops-private-writes)', () => {
    const source = fs.readFileSync('src/fleet/routes/ops-messages.ts', 'utf-8');
    const unsafeWrites = source
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter(({ text }) => text.includes('fs.writeFileSync('))
      .filter(({ text }) => /,\s*['"]utf-8['"]\s*\)/.test(text));

    expect(source).toContain('export async function handleSend(');
    expect(unsafeWrites).toEqual([]);
  });
});
