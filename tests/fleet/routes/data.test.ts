/**
 * Tests for src/fleet/routes/data.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleGetChats,
  handleGetMessages,
  handleSearchMessages,
  handleGetAccess,
  handleGetLogs,
  handleGetTyping,
  handleCheckDirectory,
  handleCheckExists,
} from '../../../src/fleet/routes/data.ts';
import type { DataDeps } from '../../../src/fleet/routes/data.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { proxyToInstance } from '../../../src/fleet/http-proxy.ts';

vi.mock('../../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: vi.fn(),
}));

const mockProxyToInstance = vi.mocked(proxyToInstance);

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

import { mockReq as helperMockReq, mockRes } from '../../helpers/http-mocks.ts';

function mockReq(url = '/'): IncomingMessage {
  return helperMockReq({ url });
}

function fakeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
  return {
    name: 'test-line',
    type: 'chat',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/data/test-line/bot.db',
    stateRoot: '/state/test-line',
    logDir: '/tmp/whatsoup-test-logs',
    healthToken: null,
    configPath: '/config/test-line/config.json',
    socketPath: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DataDeps> = {}): DataDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => undefined),
      getInstances: vi.fn(() => new Map()),
    } as any,
    dbReader: {
      getChats: vi.fn(() => ({ ok: true, data: [] })),
      getMessages: vi.fn(() => ({ ok: true, data: [] })),
      searchMessages: vi.fn(() => ({ ok: true, data: [] })),
      getAccessList: vi.fn(() => ({ ok: true, data: [] })),
      getSummaryStats: vi.fn(),
      query: vi.fn(() => ({ ok: true, data: [] })),
    } as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// handleGetChats
// ---------------------------------------------------------------------------

describe('handleGetChats', () => {
  it('returns 404 for unknown instance', () => {
    const deps = makeDeps();
    const res = mockRes();
    handleGetChats(mockReq(), res, deps, { name: 'nope' });
    expect(res._status).toBe(404);
  });

  it('returns chats with default pagination', () => {
    const inst = fakeInstance();
    const chatData = [{ conversationKey: '123@s.whatsapp.net', messageCount: 10 }];
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getChats: vi.fn(() => ({ ok: true, data: chatData })),
        query: vi.fn(() => ({ ok: true, data: chatData })),
      } as any,
    });

    const res = mockRes();
    handleGetChats(mockReq('/api/lines/test-line/chats'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([{
      conversationKey: '123@s.whatsapp.net',
      messageCount: 10,
      name: '123@s.whatsapp.net',
      lastMessagePreview: '',
      lastMessageAt: '',
    }]);
    expect(deps.dbReader.getChats).toHaveBeenCalledWith('test-line', inst.dbPath, { limit: 50, offset: 0 });
  });

  it('parses custom limit and offset from query', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getChats: vi.fn(() => ({ ok: true, data: [] })),
        query: vi.fn(() => ({ ok: true, data: [] })),
      } as any,
    });

    const res = mockRes();
    handleGetChats(mockReq('/api/lines/test-line/chats?limit=10&offset=20'), res, deps, { name: 'test-line' });
    expect(deps.dbReader.getChats).toHaveBeenCalledWith('test-line', inst.dbPath, { limit: 10, offset: 20 });
  });

  it('clamps limit to 500 max', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getChats: vi.fn(() => ({ ok: true, data: [] })),
        query: vi.fn(() => ({ ok: true, data: [] })),
      } as any,
    });

    const res = mockRes();
    handleGetChats(mockReq('/api/lines/test-line/chats?limit=9999'), res, deps, { name: 'test-line' });
    expect(deps.dbReader.getChats).toHaveBeenCalledWith('test-line', inst.dbPath, { limit: 500, offset: 0 });
  });

  it('returns 500 when db query fails', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: { getChats: vi.fn(() => ({ ok: false, error: 'db locked' })) } as any,
    });

    const res = mockRes();
    handleGetChats(mockReq(), res, deps, { name: 'test-line' });
    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toBe('db locked');
  });

  it('returns display-safe strings for null preview and timestamp fields', () => {
    const inst = fakeInstance();
    const chatData = [{
      conversationKey: '123@s.whatsapp.net',
      senderName: null,
      messageCount: 1,
      lastMessageAt: null,
      isGroup: false,
      lastMessagePreview: null,
      lastMessageSender: null,
    }];
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getChats: vi.fn(() => ({ ok: true, data: chatData })),
        query: vi.fn(() => ({ ok: true, data: [{
          conversationKey: '123@s.whatsapp.net',
          name: '123@s.whatsapp.net',
          lastMessagePreview: null,
          lastMessageAt: null,
          unreadCount: 0,
          isGroup: false,
        }] })),
      } as any,
    });

    const res = mockRes();
    handleGetChats(mockReq('/api/lines/test-line/chats'), res, deps, { name: 'test-line' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([{
      conversationKey: '123@s.whatsapp.net',
      name: '123@s.whatsapp.net',
      lastMessagePreview: '',
      lastMessageAt: '',
      unreadCount: 0,
      isGroup: false,
    }]);
  });

  it('enriches chat display names, unread counts, previews, and group backfill state', () => {
    const inst = fakeInstance({ healthToken: 'token' });
    mockProxyToInstance.mockResolvedValue({ status: 404, body: '{}' });
    const chatData = [
      { conversationKey: '111_at_g.us', messageCount: 4, senderName: null, lastMessageAt: 1712332800 },
      { conversationKey: '222_at_g.us', messageCount: 2, senderName: null, lastMessageAt: 1712332900 },
      { conversationKey: '333@s.whatsapp.net', messageCount: 1, senderName: 'Fallback Name', lastMessageAt: 1712333000 },
      { conversationKey: '444_at_g.us', messageCount: 3, senderName: null, lastMessageAt: 1712333100 },
    ];
    const previews = new Map([
      ['111_at_g.us', { content: 'deploy ready', sender_name: 'Alex Example', is_from_me: 0 }],
      ['222_at_g.us', { content: 'done', sender_name: 'Self', is_from_me: 1 }],
      ['333@s.whatsapp.net', { content: 'hello', sender_name: 'Pat', is_from_me: 0 }],
      ['444_at_g.us', { content: 'saved name preview', sender_name: 'Jordan', is_from_me: 0 }],
    ]);
    const unread = new Map([
      ['111_at_g.us', { unread_count: 2 }],
      ['222_at_g.us', { unread_count: 0 }],
      ['333@s.whatsapp.net', { unread_count: 1 }],
      ['444_at_g.us', { unread_count: 3 }],
    ]);

    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT content, sender_name, is_from_me')) {
          return { get: (conversationKey: string) => previews.get(conversationKey) };
        }
        if (sql.includes('SELECT unread_count')) {
          return { get: (conversationKey: string) => unread.get(conversationKey) };
        }
        if (sql.includes('SELECT subject FROM groups')) {
          return { get: (jid: string) => (jid === '111@g.us' ? { subject: 'Ops Room' } : undefined) };
        }
        if (sql.includes('SELECT name FROM chats')) {
          return { get: (conversationKey: string) => (conversationKey === '444_at_g.us' ? { name: 'Saved Group Name' } : undefined) };
        }
        if (sql.includes('SELECT sender_name FROM messages') && sql.includes('ORDER BY timestamp DESC')) {
          return { get: (conversationKey: string) => (conversationKey === '333@s.whatsapp.net' ? { sender_name: 'Pat' } : undefined) };
        }
        if (sql.includes('SELECT DISTINCT sender_name')) {
          return { all: () => [{ sender_name: 'Sam' }, { sender_name: 'Lee' }] };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    };

    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getChats: vi.fn(() => ({ ok: true, data: chatData })),
        query: vi.fn((_name, _dbPath, fn) => ({ ok: true, data: fn(db as any) })),
      } as any,
    });

    const res = mockRes();
    handleGetChats(mockReq('/api/lines/test-line/chats'), res, deps, { name: 'test-line' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([
      expect.objectContaining({
        conversationKey: '111_at_g.us',
        name: 'Ops Room',
        lastMessagePreview: 'Alex: deploy ready',
        unreadCount: 2,
        isGroup: true,
      }),
      expect.objectContaining({
        conversationKey: '222_at_g.us',
        name: 'Sam, Lee',
        lastMessagePreview: 'You: done',
        unreadCount: 0,
        isGroup: true,
      }),
      expect.objectContaining({
        conversationKey: '333@s.whatsapp.net',
        name: 'Pat',
        lastMessagePreview: 'hello',
        unreadCount: 1,
        isGroup: false,
      }),
      expect.objectContaining({
        conversationKey: '444_at_g.us',
        name: 'Saved Group Name',
        lastMessagePreview: 'Jordan: saved name preview',
        unreadCount: 3,
        isGroup: true,
      }),
    ]);
    expect(JSON.stringify(JSON.parse(res._body))).not.toContain('_needsBackfill');
  });

  it('returns 500 when chat enrichment fails after the base query succeeds', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getChats: vi.fn(() => ({ ok: true, data: [{ conversationKey: 'abc', messageCount: 1 }] })),
        query: vi.fn(() => ({ ok: false, error: 'preview query failed' })),
      } as any,
    });

    const res = mockRes();
    handleGetChats(mockReq('/api/lines/test-line/chats'), res, deps, { name: 'test-line' });

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toBe('preview query failed');
  });
});

// ---------------------------------------------------------------------------
// handleGetMessages
// ---------------------------------------------------------------------------

describe('handleGetMessages', () => {
  it('returns 404 for unknown instance', () => {
    const deps = makeDeps();
    const res = mockRes();
    handleGetMessages(mockReq(), res, deps, { name: 'nope' });
    expect(res._status).toBe(404);
  });

  it('returns 400 when conversation_key is missing', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });

    const res = mockRes();
    handleGetMessages(mockReq('/api/lines/test-line/messages'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/conversation_key/);
  });

  it('passes conversation_key and defaults to db reader', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: { getMessages: vi.fn(() => ({ ok: true, data: [] })) } as any,
    });

    const res = mockRes();
    handleGetMessages(
      mockReq('/api/lines/test-line/messages?conversation_key=123%40s.whatsapp.net'),
      res, deps, { name: 'test-line' },
    );
    expect(res._status).toBe(200);
    expect(deps.dbReader.getMessages).toHaveBeenCalledWith(
      'test-line', inst.dbPath,
      { conversationKey: '123@s.whatsapp.net', beforePk: undefined, limit: 50 },
    );
  });

  it('passes before_pk when provided', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: { getMessages: vi.fn(() => ({ ok: true, data: [] })) } as any,
    });

    const res = mockRes();
    handleGetMessages(
      mockReq('/api/lines/test-line/messages?conversation_key=abc&before_pk=42&limit=10'),
      res, deps, { name: 'test-line' },
    );
    expect(deps.dbReader.getMessages).toHaveBeenCalledWith(
      'test-line', inst.dbPath,
      { conversationKey: 'abc', beforePk: 42, limit: 10 },
    );
  });

  it('returns display-safe message DTOs when database fields are null', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getMessages: vi.fn(() => ({ ok: true, data: [{
          pk: 42,
          conversation_key: 'abc',
          chat_jid: 'abc@s.whatsapp.net',
          sender_jid: null,
          sender_name: null,
          message_id: null,
          content: null,
          content_type: null,
          timestamp: null,
          is_from_me: null,
          raw_message: null,
        }] })),
      } as any,
    });

    const res = mockRes();
    handleGetMessages(mockReq('/api/lines/test-line/messages?conversation_key=abc'), res, deps, { name: 'test-line' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([{
      pk: 42,
      conversationKey: 'abc',
      senderJid: '',
      senderName: '',
      content: null,
      type: 'unknown',
      timestamp: '',
      fromMe: false,
    }]);
  });

  it('returns raw message evidence and normalizes finite timestamps', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getMessages: vi.fn(() => ({ ok: true, data: [{
          pk: 44,
          conversation_key: 'abc',
          chat_jid: 'abc@s.whatsapp.net',
          sender_jid: 'abc@s.whatsapp.net',
          sender_name: 'Pat',
          message_id: 'msg-1',
          content: 'hello',
          content_type: 'text',
          timestamp: 1712332800,
          is_from_me: 1,
          raw_message: '{"conversation":"hello"}',
        }] })),
      } as any,
    });

    const res = mockRes();
    handleGetMessages(mockReq('/api/lines/test-line/messages?conversation_key=abc'), res, deps, { name: 'test-line' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([{
      pk: 44,
      conversationKey: 'abc',
      senderJid: 'abc@s.whatsapp.net',
      senderName: 'Pat',
      content: 'hello',
      type: 'text',
      timestamp: '2024-04-05T16:00:00.000Z',
      fromMe: true,
      rawMessage: '{"conversation":"hello"}',
    }]);
  });

  it('returns 500 when message retrieval fails', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: { getMessages: vi.fn(() => ({ ok: false, error: 'message query failed' })) } as any,
    });

    const res = mockRes();
    handleGetMessages(mockReq('/api/lines/test-line/messages?conversation_key=abc'), res, deps, { name: 'test-line' });

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toBe('message query failed');
  });
});

// ---------------------------------------------------------------------------
// handleSearchMessages
// ---------------------------------------------------------------------------

describe('handleSearchMessages', () => {
  it('returns 404 for unknown instance', () => {
    const deps = makeDeps();
    const res = mockRes();
    handleSearchMessages(mockReq(), res, deps, { name: 'nope' });
    expect(res._status).toBe(404);
  });

  it('returns 400 when q is missing', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });

    const res = mockRes();
    handleSearchMessages(mockReq('/api/lines/test-line/messages/search'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/q/);
  });

  it('passes query, conversation_key, and limit to db reader', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: { searchMessages: vi.fn(() => ({ ok: true, data: [] })) } as any,
    });

    const res = mockRes();
    handleSearchMessages(
      mockReq('/api/lines/test-line/messages/search?q=receipt&conversation_key=abc&limit=7'),
      res, deps, { name: 'test-line' },
    );

    expect(res._status).toBe(200);
    expect(deps.dbReader.searchMessages).toHaveBeenCalledWith(
      'test-line', inst.dbPath,
      { query: 'receipt', conversationKey: 'abc', limit: 7 },
    );
  });

  it('returns display-safe search result DTOs when database fields are null', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        searchMessages: vi.fn(() => ({ ok: true, data: [{
          pk: 43,
          conversation_key: 'abc',
          chat_jid: 'abc@s.whatsapp.net',
          sender_jid: null,
          sender_name: null,
          message_id: null,
          content: null,
          content_type: null,
          timestamp: null,
          is_from_me: null,
          raw_message: null,
        }] })),
      } as any,
    });

    const res = mockRes();
    handleSearchMessages(mockReq('/api/lines/test-line/messages/search?q=receipt'), res, deps, { name: 'test-line' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      results: [{
        pk: 43,
        conversationKey: 'abc',
        senderJid: '',
        senderName: '',
        content: null,
        type: 'unknown',
        timestamp: '',
        fromMe: false,
      }],
      total: 1,
      query: 'receipt',
    });
  });

  it('returns 500 when message search fails', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: { searchMessages: vi.fn(() => ({ ok: false, error: 'fts failed' })) } as any,
    });

    const res = mockRes();
    handleSearchMessages(mockReq('/api/lines/test-line/messages/search?q=receipt'), res, deps, { name: 'test-line' });

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toBe('fts failed');
  });
});

// ---------------------------------------------------------------------------
// handleSearchMessages
// ---------------------------------------------------------------------------

describe('handleSearchMessages', () => {
  it('returns 400 when q is whitespace only', () => {
    const inst = fakeInstance();
    const searchMessages = vi.fn(() => ({ ok: true, data: [] }));
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: { searchMessages } as any,
    });

    const res = mockRes();
    handleSearchMessages(mockReq('/api/lines/test-line/messages/search?q=%20%20%20'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/q/);
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it('trims q before searching and echoing the query', () => {
    const inst = fakeInstance();
    const searchMessages = vi.fn(() => ({ ok: true, data: [] }));
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: { searchMessages } as any,
    });

    const res = mockRes();
    handleSearchMessages(mockReq('/api/lines/test-line/messages/search?q=%20hello%20&conversation_key=chat-1'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(200);
    expect(searchMessages).toHaveBeenCalledWith('test-line', inst.dbPath, {
      query: 'hello',
      conversationKey: 'chat-1',
      limit: 20,
    });
    expect(JSON.parse(res._body).query).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// handleSearchMessages
// ---------------------------------------------------------------------------

describe('handleSearchMessages', () => {
  it('returns 400 when q is missing', () => {
    const inst = fakeInstance();
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });

    const res = mockRes();
    handleSearchMessages(mockReq('/api/lines/test-line/messages/search'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/q/);
  });

  it('returns 400 for blank q without querying the database', () => {
    const inst = fakeInstance();
    const searchMessages = vi.fn(() => ({ ok: false, error: 'Invalid FTS MATCH query: query must not be empty' }));
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: { searchMessages } as any,
    });

    const res = mockRes();
    handleSearchMessages(mockReq('/api/lines/test-line/messages/search?q=%20%20%20'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toMatch(/q/);
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it('trims q before searching and echoing the response query', () => {
    const inst = fakeInstance();
    const searchMessages = vi.fn(() => ({ ok: true, data: [] }));
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: { searchMessages } as any,
    });

    const res = mockRes();
    handleSearchMessages(mockReq('/api/lines/test-line/messages/search?q=%20hello%20&conversation_key=abc'), res, deps, { name: 'test-line' });
    expect(res._status).toBe(200);
    expect(searchMessages).toHaveBeenCalledWith('test-line', inst.dbPath, {
      query: 'hello',
      conversationKey: 'abc',
      limit: 20,
    });
    expect(JSON.parse(res._body).query).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// handleGetAccess
// ---------------------------------------------------------------------------

describe('handleGetAccess', () => {
  it('returns 404 for unknown instance', () => {
    const deps = makeDeps();
    const res = mockRes();
    handleGetAccess(mockReq(), res, deps, { name: 'nope' });
    expect(res._status).toBe(404);
  });

  it('returns access list data', () => {
    const inst = fakeInstance();
    const accessData = [{
      subjectType: 'user',
      subjectId: '123',
      displayName: 'Pat',
      status: 'approved',
      requestedAt: '2026-04-01T00:00:00.000Z',
      decidedAt: '2026-04-02T00:00:00.000Z',
    }];
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: { getAccessList: vi.fn(() => ({ ok: true, data: accessData })) } as any,
    });

    const res = mockRes();
    handleGetAccess(mockReq(), res, deps, { name: 'test-line' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([{
      subjectType: 'user',
      subjectId: '123',
      subjectName: 'Pat',
      status: 'approved',
      updatedAt: '2026-04-02T00:00:00.000Z',
    }]);
  });

  it('falls back to requestedAt and returns 500 for access-list failures', () => {
    const inst = fakeInstance();
    const okDeps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: {
        getAccessList: vi.fn(() => ({ ok: true, data: [{
          subjectType: 'group',
          subjectId: '111@g.us',
          displayName: null,
          status: 'pending',
          requestedAt: '2026-04-03T00:00:00.000Z',
          decidedAt: null,
        }] })),
      } as any,
    });
    const okRes = mockRes();
    handleGetAccess(mockReq(), okRes, okDeps, { name: 'test-line' });
    expect(JSON.parse(okRes._body)[0]).toMatchObject({
      subjectName: null,
      updatedAt: '2026-04-03T00:00:00.000Z',
    });

    const failDeps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: { getAccessList: vi.fn(() => ({ ok: false, error: 'access query failed' })) } as any,
    });
    const failRes = mockRes();
    handleGetAccess(mockReq(), failRes, failDeps, { name: 'test-line' });
    expect(failRes._status).toBe(500);
    expect(JSON.parse(failRes._body).error).toBe('access query failed');
  });
});

// ---------------------------------------------------------------------------
// handleGetLogs
// ---------------------------------------------------------------------------

describe('handleGetLogs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-log-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 404 for unknown instance', () => {
    const deps = makeDeps();
    const res = mockRes();
    handleGetLogs(mockReq(), res, deps, { name: 'nope' });
    expect(res._status).toBe(404);
  });

  it('returns empty array when log file is missing', () => {
    const inst = fakeInstance({ logDir: tmpDir });
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });

    const res = mockRes();
    handleGetLogs(mockReq(), res, deps, { name: 'test-line' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([]);
  });

  it('returns an explicit degraded response when the log path cannot be scanned', () => {
    const notADir = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(notADir, 'not a directory');
    const inst = fakeInstance({ logDir: notADir });
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });

    const res = mockRes();
    handleGetLogs(mockReq(), res, deps, { name: 'test-line' });

    expect(res._status).toBe(503);
    expect(JSON.parse(res._body)).toMatchObject({
      error: 'log evidence unavailable',
      code: 'ENOTDIR',
    });
  });

  it('parses NDJSON log lines and returns them', () => {
    const inst = fakeInstance({ logDir: tmpDir });
    const logLines = [
      JSON.stringify({ level: 30, msg: 'started', time: '2026-04-05 19:30:00' }),
      JSON.stringify({ level: 40, msg: 'warning', time: 2 }),
      JSON.stringify({ level: 30, msg: 'request', time: 3 }),
    ];
    fs.writeFileSync(path.join(tmpDir, 'current.log'), logLines.join('\n') + '\n');

    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });

    const res = mockRes();
    handleGetLogs(mockReq(), res, deps, { name: 'test-line' });
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body).toHaveLength(3);
    expect(body[0].msg).toBe('started');
    expect(body[0].timestamp).toBe('2026-04-05T19:30:00.000Z');
  });

  it('filters by numeric level', () => {
    const inst = fakeInstance({ logDir: tmpDir });
    const logLines = [
      JSON.stringify({ level: 30, msg: 'info' }),
      JSON.stringify({ level: 40, msg: 'warn' }),
      JSON.stringify({ level: 50, msg: 'error' }),
    ];
    fs.writeFileSync(path.join(tmpDir, 'current.log'), logLines.join('\n') + '\n');

    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });

    const res = mockRes();
    handleGetLogs(mockReq('/api/lines/test-line/logs?level=40'), res, deps, { name: 'test-line' });
    const body = JSON.parse(res._body);
    expect(body).toHaveLength(1);
    expect(body[0].msg).toBe('warn');
  });

  it('filters by string level name', () => {
    const inst = fakeInstance({ logDir: tmpDir });
    const logLines = [
      JSON.stringify({ level: 30, msg: 'info-line' }),
      JSON.stringify({ level: 50, msg: 'error-line' }),
    ];
    fs.writeFileSync(path.join(tmpDir, 'current.log'), logLines.join('\n') + '\n');

    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });

    const res = mockRes();
    handleGetLogs(mockReq('/api/lines/test-line/logs?level=error'), res, deps, { name: 'test-line' });
    const body = JSON.parse(res._body);
    expect(body).toHaveLength(1);
    expect(body[0].msg).toBe('error-line');
  });

  it('respects limit parameter', () => {
    const inst = fakeInstance({ logDir: tmpDir });
    const logLines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ level: 30, msg: `line-${i}` }),
    );
    fs.writeFileSync(path.join(tmpDir, 'current.log'), logLines.join('\n') + '\n');

    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });

    const res = mockRes();
    handleGetLogs(mockReq('/api/lines/test-line/logs?limit=3'), res, deps, { name: 'test-line' });
    const body = JSON.parse(res._body);
    expect(body).toHaveLength(3);
    // Should return the LAST 3 entries
    expect(body[0].msg).toBe('line-7');
    expect(body[2].msg).toBe('line-9');
  });

  it('skips non-JSON lines gracefully', () => {
    const inst = fakeInstance({ logDir: tmpDir });
    const content = `${JSON.stringify({ level: 30, msg: 'valid' })}\ngarbage line\n${JSON.stringify({ level: 30, msg: 'also valid' })}\n`;
    fs.writeFileSync(path.join(tmpDir, 'current.log'), content);

    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });

    const res = mockRes();
    handleGetLogs(mockReq(), res, deps, { name: 'test-line' });
    const body = JSON.parse(res._body);
    expect(body).toHaveLength(2);
  });

  it('returns degraded log evidence when the newest log cannot be tailed', () => {
    const inst = fakeInstance({ logDir: tmpDir });
    fs.mkdirSync(path.join(tmpDir, 'current.log'));

    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });

    const res = mockRes();
    handleGetLogs(mockReq(), res, deps, { name: 'test-line' });

    expect(res._status).toBe(503);
    expect(JSON.parse(res._body)).toMatchObject({
      error: 'log evidence unavailable',
    });
  });

  it('normalizes non-string log fields before returning entries', () => {
    const inst = fakeInstance({ logDir: tmpDir });
    const repeated = { level: 40, msg: { error: 'socket hung up' }, name: { worker: 'fleet' }, component: ['ws'] };
    fs.writeFileSync(
      path.join(tmpDir, 'current.log'),
      [JSON.stringify(repeated), JSON.stringify(repeated)].join('\n') + '\n',
    );

    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });

    const res = mockRes();
    expect(() => handleGetLogs(mockReq(), res, deps, { name: 'test-line' })).not.toThrow();
    const body = JSON.parse(res._body);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      level: 'warn',
      msg: '{"error":"socket hung up"} (×2)',
      source: '{"worker":"fleet"}',
      component: '["ws"]',
    });
    expect(typeof body[0].msg).toBe('string');
    expect(typeof body[0].source).toBe('string');
    expect(typeof body[0].component).toBe('string');
  });

  it('increments existing repeated-message suffixes when log lines already contain them', () => {
    const inst = fakeInstance({ logDir: tmpDir });
    const repeated = { level: 30, msg: 'heartbeat (×2)', name: 'system' };
    fs.writeFileSync(
      path.join(tmpDir, 'current.log'),
      [JSON.stringify(repeated), JSON.stringify(repeated)].join('\n') + '\n',
    );

    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
    });

    const res = mockRes();
    handleGetLogs(mockReq(), res, deps, { name: 'test-line' });

    expect(JSON.parse(res._body)).toEqual([
      expect.objectContaining({
        msg: 'heartbeat (×3)',
        source: 'system',
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// handleGetTyping
// ---------------------------------------------------------------------------

describe('handleGetTyping', () => {
  beforeEach(() => {
    mockProxyToInstance.mockReset();
  });

  it('ignores malformed typing entries from instance health responses', async () => {
    const inst = fakeInstance({ name: 'test-line', healthPort: 3010, healthToken: 'token' });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([[inst.name, inst]])),
      } as any,
    });
    mockProxyToInstance.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({
        composing: [
          {},
          { jid: '', since: 10 },
          { jid: 'bad-since@g.us', since: 'now' },
          { jid: 12345, since: 20 },
          { jid: ' group@g.us ', since: 30 },
        ],
      }),
    });

    const res = mockRes();
    await handleGetTyping(mockReq('/api/typing'), res, deps);

    expect(mockProxyToInstance).toHaveBeenCalledWith(3010, '/typing', 'GET', null, 'token', 2000);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([
      { instance: 'test-line', jid: 'group@g.us', since: 30 },
    ]);
  });

  it('skips no-port, non-OK, and malformed typing probes without failing the aggregate response', async () => {
    const noPort = fakeInstance({ name: 'no-port', healthPort: undefined });
    const nonOk = fakeInstance({ name: 'non-ok', healthPort: 3011 });
    const malformed = fakeInstance({ name: 'malformed', healthPort: 3012 });
    const valid = fakeInstance({ name: 'valid', healthPort: 3013 });
    const deps = makeDeps({
      discovery: {
        getInstances: vi.fn(() => new Map([
          [noPort.name, noPort],
          [nonOk.name, nonOk],
          [malformed.name, malformed],
          [valid.name, valid],
        ])),
      } as any,
    });
    mockProxyToInstance
      .mockResolvedValueOnce({ status: 503, body: '{}' })
      .mockResolvedValueOnce({ status: 200, body: '{not-json' })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ composing: [{ jid: 'valid@g.us', since: 40 }] }) });

    const res = mockRes();
    await handleGetTyping(mockReq('/api/typing'), res, deps);

    expect(mockProxyToInstance).toHaveBeenCalledTimes(3);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([
      { instance: 'valid', jid: 'valid@g.us', since: 40 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// handleCheckDirectory
// ---------------------------------------------------------------------------

describe('handleCheckDirectory', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-dir-check-'));
    originalHome = process.env.HOME;
    process.env.HOME = path.join(tmpDir, 'home');
    fs.mkdirSync(process.env.HOME, { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('requires a path inside the home directory', () => {
    const missing = mockRes();
    handleCheckDirectory(mockReq('/api/directories/check'), missing);
    expect(missing._status).toBe(400);
    expect(JSON.parse(missing._body).error).toMatch(/path/);

    const outside = mockRes();
    handleCheckDirectory(mockReq('/api/directories/check?path=/tmp'), outside);
    expect(outside._status).toBe(400);
    expect(JSON.parse(outside._body).error).toMatch(/home directory/);
  });

  it('reports existing writable directories and missing home children', () => {
    const existingDir = path.join(process.env.HOME!, 'workspace');
    fs.mkdirSync(existingDir);

    const existing = mockRes();
    handleCheckDirectory(mockReq(`/api/directories/check?path=${encodeURIComponent(existingDir)}`), existing);
    expect(existing._status).toBe(200);
    expect(JSON.parse(existing._body)).toEqual({ exists: true, writable: true });

    const missing = mockRes();
    handleCheckDirectory(mockReq(`/api/directories/check?path=${encodeURIComponent(path.join(process.env.HOME!, 'missing'))}`), missing);
    expect(missing._status).toBe(200);
    expect(JSON.parse(missing._body)).toEqual({ exists: false, writable: false });
  });
});

// ---------------------------------------------------------------------------
// handleCheckExists
// ---------------------------------------------------------------------------

describe('handleCheckExists', () => {
  let tmpDir: string;
  let originalConfigHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-exists-check-'));
    originalConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  });

  afterEach(() => {
    if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfigHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports names found in discovery, config directories, or neither', () => {
    const inst = fakeInstance({ name: 'known-line' });
    const deps = makeDeps({
      discovery: { getInstance: vi.fn((name: string) => (name === 'known-line' ? inst : undefined)) } as any,
    });

    const discovered = mockRes();
    handleCheckExists(mockReq('/api/lines/known-line/exists'), discovered, deps, { name: 'known-line' });
    expect(JSON.parse(discovered._body)).toEqual({ exists: true });

    const configDir = path.join(process.env.XDG_CONFIG_HOME!, 'whatsoup', 'instances', 'config-line');
    fs.mkdirSync(configDir, { recursive: true });
    const configured = mockRes();
    handleCheckExists(mockReq('/api/lines/config-line/exists'), configured, deps, { name: 'config-line' });
    expect(JSON.parse(configured._body)).toEqual({ exists: true });

    const available = mockRes();
    handleCheckExists(mockReq('/api/lines/new-line/exists'), available, deps, { name: 'new-line' });
    expect(JSON.parse(available._body)).toEqual({ exists: false });
  });
});
