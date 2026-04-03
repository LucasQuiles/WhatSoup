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

function makeDeps(overrides: Partial<FeedDeps> = {}): FeedDeps {
  return {
    discovery: {
      getInstances: vi.fn(() => new Map()),
    } as any,
    healthPoller: {
      getStatus: vi.fn(() => undefined),
    } as any,
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
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'connection', statusCode: 408, reason: '_streamError' });
    }
  });

  it('extracts statusCode from fullErrorNode when no top-level statusCode', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'stream errored out', level: 50, fullErrorNode: { tag: 'stream:error', attrs: { code: '503' } } }),
      CTX,
    );
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'connection', statusCode: 503 });
    }
  });

  it('identifies connection error — WhatsApp connection closed', () => {
    const result = parsePinoLine(makeLine({ msg: 'WhatsApp connection closed' }), CTX);
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'connection' });
    }
  });

  it('parses "Connecting to WhatsApp" as connection state', () => {
    const result = parsePinoLine(makeLine({ msg: 'Connecting to WhatsApp', component: 'connection' }), CTX);
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'connection', state: 'connecting' });
    }
  });

  it('parses "WhatsApp connected" as connection state', () => {
    const result = parsePinoLine(makeLine({ msg: 'WhatsApp connected', component: 'connection' }), CTX);
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'connection', state: 'connected' });
    }
  });

  it('parses "client disconnected" as connection state', () => {
    const result = parsePinoLine(makeLine({ msg: 'client disconnected', component: 'WhatSoupSocketServer' }), CTX);
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'connection', state: 'disconnected' });
    }
  });

  it('identifies reconnect scheduling', () => {
    const result = parsePinoLine(makeLine({ msg: 'Scheduling reconnect in 5s' }), CTX);
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'connection', reconnecting: true });
    }
  });

  it('identifies tool_error', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'tool error reported', toolName: 'send_message', error: 'timeout' }),
      CTX,
    );
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'tool_error', toolName: 'send_message', error: 'timeout' });
    }
  });

  it('identifies session spawn', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'session spawn requested', sessionId: 'abc123', chatJid: '15551234567@s.whatsapp.net' }),
      CTX,
    );
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
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
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'session' });
    }
  });

  it('identifies agent idle', () => {
    const result = parsePinoLine(makeLine({ msg: 'agent idle timeout reached' }), CTX);
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'session' });
    }
  });

  it('identifies outbound message — exact "Sending message"', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'Sending message', chatJid: '15551234567@s.whatsapp.net' }),
      CTX,
    );
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'message', direction: 'outbound' });
    }
  });

  it('identifies inbound message', () => {
    const result = parsePinoLine(makeLine({ msg: 'inbound message from user' }), CTX);
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'message', direction: 'inbound' });
    }
  });

  it('identifies legacy import', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'legacy import complete', table: 'messages' }),
      CTX,
    );
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'import', table: 'messages', skipped: false });
    }
  });

  it('identifies legacy skipping import', () => {
    const result = parsePinoLine(makeLine({ msg: 'legacy skipping table' }), CTX);
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'import', skipped: true });
    }
  });

  it('returns noise for "Credentials saved"', () => {
    expect(parsePinoLine(makeLine({ msg: 'Credentials saved' }), CTX)).toBe('noise');
  });

  it('returns noise for "Health check OK"', () => {
    expect(parsePinoLine(makeLine({ msg: 'Health check OK' }), CTX)).toBe('noise');
  });

  it('returns noise for "health endpoint responded"', () => {
    expect(parsePinoLine(makeLine({ msg: 'health endpoint responded' }), CTX)).toBe('noise');
  });

  it('returns null for non-business info line', () => {
    const result = parsePinoLine(makeLine({ msg: 'Some random debug message', level: 30 }), CTX);
    expect(result).toBeNull();
  });

  it('returns generic for warn-level non-pattern message', () => {
    const result = parsePinoLine(makeLine({ msg: 'Unexpected internal state', level: 40 }), CTX);
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
      expect(result.detail).toMatchObject({ type: 'generic' });
      expect(result.isError).toBe(true);
      expect(result.level).toBe('warn');
    }
  });

  it('returns generic for error-level non-pattern message', () => {
    const result = parsePinoLine(makeLine({ msg: 'Fatal internal error', level: 50 }), CTX);
    expect(result).not.toBeNull();
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
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
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
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
    expect(result).not.toBe('noise');
    if (result && result !== 'noise') {
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
// noise summary aggregation via handleGetFeed
// ---------------------------------------------------------------------------

describe('noise summary aggregation via handleGetFeed', () => {
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

  it('collapses repeated "Credentials saved" into a summary', () => {
    const lines = [
      makeLine({ msg: 'Credentials saved' }),
      makeLine({ msg: 'Credentials saved' }),
      makeLine({ msg: 'Credentials saved' }),
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
    // No raw "Credentials saved" events
    const rawCredEvents = body.filter((e: any) => e.text?.includes('Credentials saved'));
    expect(rawCredEvents).toHaveLength(0);

    // A summary event should appear
    const summaryEvent = body.find((e: any) => e.text?.includes('credentials refreshed'));
    expect(summaryEvent).toBeDefined();
    expect(summaryEvent.instance).toBe('delta');
  });

  it('collapses "Health check OK" into a summary with count', () => {
    const lines = [
      makeLine({ msg: 'Health check OK' }),
      makeLine({ msg: 'Health check OK' }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'epsilon', type: 'chat', logDir });
    const instances = new Map([['epsilon', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq(), res, deps);

    const body = res._body as any[];
    const rawHealthEvents = body.filter((e: any) => e.text === 'Health check OK');
    expect(rawHealthEvents).toHaveLength(0);

    const summaryEvent = body.find((e: any) => e.text?.includes('health check ok'));
    expect(summaryEvent).toBeDefined();
  });

  it('emits business events from log without collapsing them', () => {
    const lines = [
      makeLine({ msg: 'session start', sessionId: 'abc' }),
      makeLine({ msg: 'inbound message received', level: 30 }),
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
});
