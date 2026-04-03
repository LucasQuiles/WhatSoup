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
  handleGetAccess,
  handleGetLogs,
} from '../../../src/fleet/routes/data.ts';
import type { DataDeps } from '../../../src/fleet/routes/data.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockReq(url = '/'): IncomingMessage {
  return { url, method: 'GET', headers: {} } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    writeHead(status: number) { res._status = status; },
    end(data?: string) { if (data) res._body = data; },
  };
  return res as any;
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
    expect(JSON.parse(res._body)).toEqual(chatData);
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
    const accessData = [{ subjectType: 'user', subjectId: '123', status: 'approved' }];
    const deps = makeDeps({
      discovery: { getInstance: vi.fn(() => inst) } as any,
      dbReader: { getAccessList: vi.fn(() => ({ ok: true, data: accessData })) } as any,
    });

    const res = mockRes();
    handleGetAccess(mockReq(), res, deps, { name: 'test-line' });
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual(accessData);
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

  it('parses NDJSON log lines and returns them', () => {
    const inst = fakeInstance({ logDir: tmpDir });
    const logLines = [
      JSON.stringify({ level: 30, msg: 'started', time: 1 }),
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
});
