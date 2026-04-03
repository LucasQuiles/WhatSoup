/**
 * Tests for src/fleet/routes/feed.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parsePinoLine, handleGetFeed, type FeedDeps } from '../../../src/fleet/routes/feed.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CTX = { instanceName: 'test-line', instanceType: 'passive' as const };

function makeLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ level: 30, time: 1700000000000, ...fields });
}

function mockReq(url = '/'): IncomingMessage {
  return { url, method: 'GET', headers: {} } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _status: number; _body: unknown } {
  const res = {
    _status: 0,
    _body: undefined as unknown,
    writeHead(status: number) { res._status = status; },
    end(data?: string) { if (data) res._body = JSON.parse(data); },
  };
  return res as any;
}

function fakeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
  return {
    name: 'test-line',
    type: 'passive',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/data/test-line/bot.db',
    stateRoot: '/state/test-line',
    logDir: '/tmp/whatsoup-feed-test-logs',
    healthToken: null,
    configPath: '/config/test-line/config.json',
    socketPath: null,
    ...overrides,
  };
}

const noopDbReader = {
  getMessagesByIds: vi.fn(() => ({ ok: true, data: [] })),
  getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
} as any;

function makeDeps(overrides: Partial<FeedDeps> = {}): FeedDeps {
  return {
    discovery: {
      getInstances: vi.fn(() => new Map()),
    } as any,
    healthPoller: {
      getStatus: vi.fn(() => undefined),
    } as any,
    dbReader: noopDbReader,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parsePinoLine — unit tests
// ---------------------------------------------------------------------------

describe('parsePinoLine', () => {
  it('returns null for invalid JSON', () => {
    expect(parsePinoLine('not json', CTX)).toBeNull();
  });

  it('returns null for a line with no msg', () => {
    expect(parsePinoLine(makeLine({ msg: '' }), CTX)).toBeNull();
    expect(parsePinoLine(makeLine({ msg: 42 }), CTX)).toBeNull();
  });

  it('identifies connection error — stream errored out (marked as _streamError for coalescing)', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'stream errored out', fullErrorNode: { tag: 'stream:error', attrs: { code: '408' } } }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'connection', statusCode: 408, reason: '_streamError' });
    }
  });

  it('extracts statusCode from fullErrorNode when no top-level statusCode', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'stream errored out', level: 50, fullErrorNode: { tag: 'stream:error', attrs: { code: '503' } } }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'connection', statusCode: 503 });
    }
  });

  it('identifies connection error — WhatsApp connection closed', () => {
    const result = parsePinoLine(makeLine({ msg: 'WhatsApp connection closed' }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'connection' });
    }
  });

  it('parses "Connecting to WhatsApp" as connection state', () => {
    const result = parsePinoLine(makeLine({ msg: 'Connecting to WhatsApp', component: 'connection' }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'connection', state: 'connecting' });
    }
  });

  it('parses "WhatsApp connected" as connection state', () => {
    const result = parsePinoLine(makeLine({ msg: 'WhatsApp connected', component: 'connection' }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'connection', state: 'connected' });
    }
  });

  it('parses "client disconnected" as connection state', () => {
    const result = parsePinoLine(makeLine({ msg: 'client disconnected', component: 'WhatSoupSocketServer' }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'connection', state: 'disconnected' });
    }
  });

  it('identifies reconnect scheduling', () => {
    const result = parsePinoLine(makeLine({ msg: 'Scheduling reconnect in 5s' }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'connection', reconnecting: true });
    }
  });

  it('identifies tool_error', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'tool error reported', toolName: 'send_message', error: 'timeout' }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'tool_error', toolName: 'send_message', error: 'timeout' });
    }
  });

  it('identifies session spawn', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'session spawn requested', sessionId: 'abc123', chatJid: '15551234567@s.whatsapp.net' }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({
        type: 'session',
        action: 'session spawn requested',
        sessionId: 'abc123',
        chatJid: '15551234567@s.whatsapp.net',
      });
    }
  });

  it('identifies session kill', () => {
    const result = parsePinoLine(makeLine({ msg: 'session kill complete' }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'session' });
    }
  });

  it('identifies agent idle', () => {
    const result = parsePinoLine(makeLine({ msg: 'agent idle timeout reached' }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'session' });
    }
  });

  it('identifies outbound message — exact "Sending message"', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'Sending message', chatJid: '15551234567@s.whatsapp.net' }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'message', direction: 'outbound' });
    }
  });

  it('parses outbound message with messageId', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'Sending message', chatJid: '15551234567@s.whatsapp.net', messageId: 'ABCD1234' }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({
        type: 'message',
        direction: 'outbound',
        chatJid: '15551234567@s.whatsapp.net',
        messageId: 'ABCD1234',
      });
    }
  });

  it('parses inbound message received with messageId, senderName, contentType', () => {
    const result = parsePinoLine(
      makeLine({
        msg: 'inbound message received',
        chatJid: '15550100001@s.whatsapp.net',
        messageId: 'XYZ9876',
        senderName: 'Alice',
        contentType: 'text',
      }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({
        type: 'message',
        direction: 'inbound',
        chatJid: '15550100001@s.whatsapp.net',
        messageId: 'XYZ9876',
        senderName: 'Alice',
        contentType: 'text',
      });
    }
  });

  it('does NOT match durability recovery log as inbound message', () => {
    // Durability logs contain "inbound" but are not the exact phrase "inbound message received"
    const result = parsePinoLine(
      makeLine({ msg: 'inbound message recovery: replaying 3 events' }),
      CTX,
    );
    // Should NOT produce a message event — falls through to generic or null
    if (result) {
      expect(result.detail?.type).not.toBe('message');
    }
  });

  it('identifies legacy import', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'legacy import complete', table: 'messages' }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'import', table: 'messages', skipped: false });
    }
  });

  it('identifies legacy skipping import', () => {
    const result = parsePinoLine(makeLine({ msg: 'legacy skipping table' }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'import', skipped: true });
    }
  });

  it('returns null for "Credentials saved" (noise suppressed)', () => {
    expect(parsePinoLine(makeLine({ msg: 'Credentials saved' }), CTX)).toBeNull();
  });

  it('returns null for "Health check OK" (noise suppressed)', () => {
    expect(parsePinoLine(makeLine({ msg: 'Health check OK' }), CTX)).toBeNull();
  });

  it('returns null for "health endpoint responded" (noise suppressed)', () => {
    expect(parsePinoLine(makeLine({ msg: 'health endpoint responded' }), CTX)).toBeNull();
  });

  it('returns null for non-business info line', () => {
    const result = parsePinoLine(makeLine({ msg: 'Some random debug message', level: 30 }), CTX);
    expect(result).toBeNull();
  });

  it('returns generic for warn-level non-pattern message', () => {
    const result = parsePinoLine(makeLine({ msg: 'Unexpected internal state', level: 40 }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'generic' });
      expect(result.isError).toBe(true);
      expect(result.level).toBe('warn');
    }
  });

  it('returns generic for error-level non-pattern message', () => {
    const result = parsePinoLine(makeLine({ msg: 'Fatal internal error', level: 50 }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'generic' });
      expect(result.level).toBe('error');
    }
  });

  it('attaches instance and mode from context', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'session end detected' }),
      { instanceName: 'my-agent', instanceType: 'agent' },
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.instance).toBe('my-agent');
      expect(result.mode).toBe('agent');
      expect(result.text).toMatch(/^my-agent:/);
    }
  });

  it('includes component in text when present', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'session start', component: 'agent-runner' }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.text).toContain('[agent-runner]');
      expect(result.component).toBe('agent-runner');
    }
  });
});

// ---------------------------------------------------------------------------
// health transition events via handleGetFeed
// ---------------------------------------------------------------------------

describe('health transition events via handleGetFeed', () => {
  it('emits structured health detail when instance goes unreachable', () => {
    const inst = fakeInstance({ name: 'alpha', type: 'agent' });
    const instances = new Map([['alpha', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => ({ status: 'online', error: null })) } as any,
    });

    // First call — establish baseline
    const res1 = mockRes();
    handleGetFeed(mockReq(), res1, deps);

    // Now simulate transition to unreachable
    (deps.healthPoller.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'unreachable',
      error: 'ECONNREFUSED',
    });

    const res2 = mockRes();
    handleGetFeed(mockReq(), res2, deps);

    const body = res2._body as any[];
    const healthEvent = body.find((e: any) => e.detail?.type === 'health');
    expect(healthEvent).toBeDefined();
    expect(healthEvent.detail).toMatchObject({
      type: 'health',
      status: 'unreachable',
      previousStatus: 'online',
      error: 'ECONNREFUSED',
    });
    expect(healthEvent.component).toBe('health');
    expect(healthEvent.level).toBe('error');
    expect(healthEvent.instance).toBe('alpha');
  });

  it('emits structured health detail when instance recovers (degraded → online)', () => {
    const inst = fakeInstance({ name: 'beta', type: 'chat' });
    const instances = new Map([['beta', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => ({ status: 'degraded', error: 'stale' })) } as any,
    });

    // Establish degraded baseline
    const res1 = mockRes();
    handleGetFeed(mockReq(), res1, deps);

    // Simulate recovery
    (deps.healthPoller.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'online',
      error: null,
    });

    const res2 = mockRes();
    handleGetFeed(mockReq(), res2, deps);

    const body = res2._body as any[];
    const healthEvent = body.find((e: any) => e.detail?.type === 'health' && e.detail?.status === 'online');
    expect(healthEvent).toBeDefined();
    expect(healthEvent.detail).toMatchObject({
      type: 'health',
      status: 'online',
      previousStatus: 'degraded',
    });
    expect(healthEvent.level).toBe('info');
  });

  it('emits no health events when status is unchanged', () => {
    const inst = fakeInstance({ name: 'gamma', type: 'passive' });
    const instances = new Map([['gamma', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => ({ status: 'online', error: null })) } as any,
    });

    // Two identical calls
    handleGetFeed(mockReq(), mockRes(), deps);
    const res2 = mockRes();
    handleGetFeed(mockReq(), res2, deps);

    const body = res2._body as any[];
    const healthEvents = body.filter((e: any) => e.detail?.type === 'health');
    expect(healthEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// noise suppression via handleGetFeed
// ---------------------------------------------------------------------------

describe('noise suppression via handleGetFeed', () => {
  let tmpDir: string;
  let logDir: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-feed-test-'));
    logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'app.log');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fully suppresses Credentials saved and Health check OK (no cards at all)', async () => {
    const lines = [
      makeLine({ msg: 'Credentials saved' }),
      makeLine({ msg: 'Credentials saved' }),
      makeLine({ msg: 'Credentials saved' }),
      makeLine({ msg: 'Health check OK' }),
      makeLine({ msg: 'Health check OK' }),
      makeLine({ msg: 'session start', sessionId: 'abc' }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'delta', type: 'passive', logDir });
    const instances = new Map([['delta', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq(), res, deps);

    const body = res._body as any[];

    // No "Credentials saved" or "Health check OK" cards at all — no raw, no summary
    const credEvents = body.filter((e: any) =>
      e.text?.toLowerCase().includes('credentials') || e.text?.toLowerCase().includes('credential'),
    );
    expect(credEvents).toHaveLength(0);

    const healthCheckEvents = body.filter((e: any) =>
      e.text?.toLowerCase().includes('health check'),
    );
    expect(healthCheckEvents).toHaveLength(0);

    // The session event should still appear
    const sessionEvent = body.find((e: any) => e.detail?.type === 'session');
    expect(sessionEvent).toBeDefined();
    expect(sessionEvent.instance).toBe('delta');
  });

  it('emits business events from log without suppressing them', () => {
    const lines = [
      makeLine({ msg: 'session start', sessionId: 'abc' }),
      makeLine({ msg: 'inbound message received', level: 30, chatJid: '15550100001@s.whatsapp.net' }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'zeta', type: 'agent', logDir });
    const instances = new Map([['zeta', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq(), res, deps);

    const body = res._body as any[];
    const sessionEvent = body.find((e: any) => e.detail?.type === 'session');
    const messageEvent = body.find((e: any) => e.detail?.type === 'message');
    expect(sessionEvent).toBeDefined();
    expect(messageEvent).toBeDefined();
  });

  it('skips non-existent log directories gracefully', () => {
    const inst = fakeInstance({ name: 'eta', type: 'passive', logDir: '/nonexistent/path/logs' });
    const instances = new Map([['eta', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    expect(() => handleGetFeed(mockReq(), res, deps)).not.toThrow();
    expect(res._status).toBe(200);
  });

  it('preserves two distinct messages in the same minute (dedupe by messageId)', () => {
    const lines = [
      makeLine({ msg: 'Sending message', chatJid: 'chat@s.whatsapp.net', messageId: 'msg-001' }),
      makeLine({ msg: 'Sending message', chatJid: 'chat@s.whatsapp.net', messageId: 'msg-002' }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'theta', type: 'passive', logDir });
    const instances = new Map([['theta', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq(), res, deps);

    const body = res._body as any[];
    const messageEvents = body.filter((e: any) => e.detail?.type === 'message' && e.detail?.direction === 'outbound');
    // Both distinct messageIds must survive dedupe
    expect(messageEvents).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// message preview enrichment via handleGetFeed
// ---------------------------------------------------------------------------

describe('message preview enrichment via handleGetFeed', () => {
  it('enriches outbound message with preview via messageId lookup', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-test-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100001@s.whatsapp.net', messageId: 'msg-out-1',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'enrich-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['enrich-test', fakeInst]]);
    const poller = { getStatus: vi.fn(() => null) };
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [
        { message_id: 'msg-out-1', content: 'Hello from the bot!', sender_name: null, content_type: 'text', pk: 1, conversation_key: '15550100001', chat_jid: '15550100001@s.whatsapp.net', sender_jid: 'bot', timestamp: 1700000000, is_from_me: 1, raw_message: null },
      ] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq('/api/feed?limit=10'), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const events = res._body as any[];
    const msgEvent = events.find((e: any) => e.detail?.type === 'message');
    expect(msgEvent).toBeTruthy();
    expect(msgEvent.detail.preview).toBe('Hello from the bot!');
    expect(dbReader.getMessagesByIds).toHaveBeenCalledWith('enrich-test', '/unused', ['msg-out-1']);

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('falls back to conversationKey + timestamp when no messageId', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-fb-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100001@s.whatsapp.net',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'fb-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['fb-test', fakeInst]]);
    const poller = { getStatus: vi.fn(() => null) };
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [
        { message_id: 'msg-fallback', content: 'Fallback content', sender_name: null, content_type: 'text', pk: 1, conversation_key: '15550100001', chat_jid: '15550100001@s.whatsapp.net', sender_jid: 'bot', timestamp: 1700000000, is_from_me: 1, raw_message: null },
      ] })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq('/api/feed?limit=10'), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const events = res._body as any[];
    const msgEvent = events.find((e: any) => e.detail?.type === 'message');
    expect(msgEvent).toBeTruthy();
    expect(msgEvent.detail.preview).toBe('Fallback content');
    // Verify fallback used derived conversationKey (not raw chatJid)
    expect(dbReader.getRecentMessagesByChat).toHaveBeenCalledWith(
      'fb-test', '/unused',
      '15550100001',  // derived via toConversationKey('15550100001@s.whatsapp.net')
      'outbound',
      expect.any(Number),
      1,
    );

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('gracefully handles missing DB rows (best-effort)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-miss-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100001@s.whatsapp.net', messageId: 'msg-missing',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'miss-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['miss-test', fakeInst]]);
    const poller = { getStatus: vi.fn(() => null) };
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq('/api/feed?limit=10'), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const events = res._body as any[];
    const msgEvent = events.find((e: any) => e.detail?.type === 'message');
    expect(msgEvent).toBeTruthy();
    expect(msgEvent.detail.preview).toBeUndefined();

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });
});
