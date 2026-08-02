/**
 * Tests for src/fleet/routes/feed.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parsePinoLine, handleGetFeed, type FeedDeps } from '../../../src/fleet/routes/feed.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CTX = { instanceName: 'test-line', instanceType: 'passive' as const };

function makeLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ level: 30, time: 1700000000000, ...fields });
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

  it('normalizes SQLite-style timestamp strings to ISO', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'WhatsApp connected', time: '2026-04-05 19:30:00', component: 'connection' }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.time).toBe('2026-04-05T19:30:00.000Z');
    }
  });

  it('uses timestamp, default level, and current-time fallbacks when pino fields are absent', () => {
    const timestampResult = parsePinoLine(
      JSON.stringify({ msg: 'session start', timestamp: 1700000000000 }),
      CTX,
    );
    expect(timestampResult).toMatchObject({
      time: '2023-11-14T22:13:20.000Z',
      level: 'info',
      detail: { type: 'session', action: 'session start' },
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
    try {
      const fallbackResult = parsePinoLine(JSON.stringify({ msg: 'session end' }), CTX);
      expect(fallbackResult).toMatchObject({
        time: '2026-01-02T03:04:05.000Z',
        level: 'info',
        detail: { type: 'session', action: 'session end' },
      });
    } finally {
      vi.useRealTimers();
    }
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

  it('extracts numeric stream status codes from malformed runtime payloads', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'stream errored out', level: 50, fullErrorNode: { tag: 'stream:error', attrs: { code: 418 } } }),
      CTX,
    );
    expect(result).toMatchObject({
      detail: { type: 'connection', statusCode: 418, reason: '_streamError' },
    });
  });

  it('omits malformed stream error status codes instead of surfacing NaN', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'stream errored out', level: 50, fullErrorNode: { tag: 'stream:error', attrs: { code: 'not-a-number' } } }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'connection', reason: '_streamError' });
      expect(result.detail).not.toHaveProperty('statusCode');
    }
  });

  it('omits absent stream error status codes and preserves unknown pino levels as info', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'stream errored out', level: 999, fullErrorNode: { tag: 'stream:error', attrs: {} } }),
      CTX,
    );
    expect(result).toMatchObject({
      level: 'info',
      isError: true,
      detail: { type: 'connection', reason: '_streamError' },
    });
    expect(result?.detail).not.toHaveProperty('statusCode');
  });

  it('identifies connection error — WhatsApp connection closed', () => {
    const result = parsePinoLine(makeLine({ msg: 'WhatsApp connection closed' }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'connection' });
    }
  });

  it('omits non-string connection close reason and non-number status code', () => {
    const result = parsePinoLine(makeLine({
      msg: 'WhatsApp connection closed',
      statusCode: '401',
      reason: { code: 'loggedOut' },
    }), CTX);
    expect(result).toMatchObject({ detail: { type: 'connection' } });
    expect((result?.detail as any).statusCode).toBeUndefined();
    expect((result?.detail as any).reason).toBeUndefined();
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

  it('normalizes malformed tool_error fields', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'tool error reported', toolName: 42, toolId: 'tool-1', error: { message: 'boom' } }),
      CTX,
    );
    expect(result).toMatchObject({
      detail: {
        type: 'tool_error',
        toolName: '',
        toolId: 'tool-1',
        error: '[object Object]',
      },
    });
  });

  it('normalizes null tool_error messages to an empty error string', () => {
    const result = parsePinoLine(makeLine({ msg: 'tool error reported', toolName: 'lookup_contact', error: null }), CTX);
    expect(result).toMatchObject({
      detail: {
        type: 'tool_error',
        toolName: 'lookup_contact',
        error: '',
      },
    });
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

  it('handles message events without usable chat JIDs', () => {
    const outbound = parsePinoLine(makeLine({ msg: 'Sending message' }), CTX);
    expect(outbound).toMatchObject({
      detail: { type: 'message', direction: 'outbound' },
    });
    expect((outbound?.detail as any).conversationKey).toBeUndefined();

    const inbound = parsePinoLine(makeLine({ msg: 'inbound message received' }), CTX);
    expect(inbound).toMatchObject({
      detail: { type: 'message', direction: 'inbound' },
    });
    expect((inbound?.detail as any).conversationKey).toBeUndefined();
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

  it('drops non-business info line while keeping warning fallback concrete', () => {
    const result = parsePinoLine(makeLine({ msg: 'Some random debug message', level: 30 }), CTX);
    expect(result).toBeNull();

    const warnResult = parsePinoLine(makeLine({ msg: 'Some random debug message', level: 40 }), CTX);
    expect(warnResult).toMatchObject({
      instance: 'test-line',
      mode: 'passive',
      text: 'test-line: Some random debug message',
      level: 'warn',
      isError: true,
      detail: { type: 'generic' },
    });
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

  it('falls back to name and module fields for component labels', () => {
    expect(parsePinoLine(makeLine({ msg: 'session start', name: 'named-runner' }), CTX)).toMatchObject({
      component: 'named-runner',
      text: 'test-line: [named-runner] session start',
    });
    expect(parsePinoLine(makeLine({ msg: 'session start', module: 'module-runner' }), CTX)).toMatchObject({
      component: 'module-runner',
      text: 'test-line: [module-runner] session start',
    });
  });

  it('ignores non-string component fields instead of rendering object text', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'session start', component: { name: 'agent-runner' }, name: ['fallback'], module: 42 }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.text).toBe('test-line: session start');
      expect(result.component).toBeUndefined();
    }
  });

  it('extracts conversationKey from chatJid on message events', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'Sending message', chatJid: '15550100001@s.whatsapp.net', messageId: 'msg-ck-1' }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({
        type: 'message', direction: 'outbound', conversationKey: '15550100001',
      });
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
      statusConfidence: 'confirmed',
      statusReason: 'health_poll_failed_threshold',
      statusEvidence: ['consecutive_failures=3', 'error=ECONNREFUSED'],
      error: 'ECONNREFUSED',
    });

    const res2 = mockRes();
    handleGetFeed(mockReq(), res2, deps);

    const body = JSON.parse(res2._body) as any[];
    const healthEvent = body.find((e: any) => e.detail?.type === 'health');
    expect(healthEvent).toBeDefined();
    expect(healthEvent.detail).toMatchObject({
      type: 'health',
      status: 'unreachable',
      previousStatus: 'online',
      error: 'ECONNREFUSED',
      confidence: 'confirmed',
      reason: 'health_poll_failed_threshold',
      evidence: ['consecutive_failures=3', 'error=ECONNREFUSED'],
    });
    expect(healthEvent.component).toBe('health');
    expect(healthEvent.level).toBe('error');
    expect(healthEvent.instance).toBe('alpha');
  });

  it('emits logged-out health transitions with confidence evidence', () => {
    const inst = fakeInstance({ name: 'logout-feed', type: 'agent' });
    const instances = new Map([['logout-feed', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: {
        getStatus: vi.fn(() => ({
          status: 'online',
          statusConfidence: 'confirmed',
          statusReason: 'health_ok',
          statusEvidence: ['health_status=healthy'],
          error: null,
        })),
      } as any,
    });

    handleGetFeed(mockReq(), mockRes(), deps);
    (deps.healthPoller.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'logged_out',
      statusConfidence: 'confirmed',
      statusReason: 'whatsapp_auth_loss_with_disconnect_corroboration',
      statusEvidence: [
        'account_jid_status=not_connected',
        'connection_state=disconnected',
        'last_disconnect_reason=loggedOut',
        'last_status_code=401',
        'auth_failure_class=serverside_logout_irreversible',
      ],
      error: null,
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    const body = JSON.parse(res._body) as any[];
    const healthEvent = body.find((e: any) => e.detail?.type === 'health' && e.detail?.status === 'logged_out');
    expect(healthEvent).toBeDefined();
    expect(healthEvent).toMatchObject({
      text: 'logout-feed: logged out',
      isError: true,
      level: 'error',
      instance: 'logout-feed',
      component: 'health',
      detail: {
        type: 'health',
        status: 'logged_out',
        previousStatus: 'online',
        confidence: 'confirmed',
        reason: 'whatsapp_auth_loss_with_disconnect_corroboration',
        evidence: [
          'account_jid_status=not_connected',
          'connection_state=disconnected',
          'last_disconnect_reason=loggedOut',
          'last_status_code=401',
          'auth_failure_class=serverside_logout_irreversible',
        ],
      },
    });
  });

  it('emits ambiguous degraded health transitions as warning, not critical error', () => {
    const inst = fakeInstance({ name: 'ambiguous-feed', type: 'chat' });
    const instances = new Map([['ambiguous-feed', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: {
        getStatus: vi.fn(() => ({
          status: 'online',
          statusConfidence: 'confirmed',
          statusReason: 'health_ok',
          statusEvidence: ['health_status=healthy'],
          error: null,
        })),
      } as any,
    });

    handleGetFeed(mockReq(), mockRes(), deps);
    (deps.healthPoller.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'whatsapp_backoff_zero_attempts_without_disconnect_corroboration',
      statusEvidence: ['reconnect_phase=backoff', 'reconnect_attempts=0'],
      error: 'reconnect hint without disconnect corroboration',
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    const body = JSON.parse(res._body) as any[];
    const healthEvent = body.find((e: any) => e.detail?.type === 'health' && e.detail?.status === 'degraded');
    expect(healthEvent).toEqual({
      time: expect.any(String),
      mode: 'chat',
      text: 'ambiguous-feed: degraded - reconnect hint without disconnect corroboration',
      level: 'warn',
      instance: 'ambiguous-feed',
      component: 'health',
      detail: {
        type: 'health',
        status: 'degraded',
        previousStatus: 'online',
        confidence: 'ambiguous',
        reason: 'whatsapp_backoff_zero_attempts_without_disconnect_corroboration',
        evidence: ['reconnect_phase=backoff', 'reconnect_attempts=0'],
        error: 'reconnect hint without disconnect corroboration',
      },
    });
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
      statusConfidence: 'confirmed',
      statusReason: 'health_body_ok',
      statusEvidence: ['health_status=healthy'],
      error: null,
    });

    const res2 = mockRes();
    handleGetFeed(mockReq(), res2, deps);

    const body = JSON.parse(res2._body) as any[];
    const healthEvent = body.find((e: any) => e.detail?.type === 'health' && e.detail?.status === 'online');
    expect(healthEvent).toBeDefined();
    expect(healthEvent.detail).toMatchObject({
      type: 'health',
      status: 'online',
      previousStatus: 'degraded',
      confidence: 'confirmed',
      reason: 'health_body_ok',
      evidence: ['health_status=healthy'],
    });
    expect(healthEvent.level).toBe('info');
  });

  it('emits ambiguous degraded health metadata without marking it as an error', () => {
    const inst = fakeInstance({ name: 'mini4', type: 'agent' });
    const instances = new Map([['mini4', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => ({ status: 'online', error: null })) } as any,
    });

    handleGetFeed(mockReq(), mockRes(), deps);

    (deps.healthPoller.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'degraded',
      statusConfidence: 'ambiguous',
      statusReason: 'whatsapp_backoff_zero_attempts_without_disconnect_corroboration',
      statusEvidence: ['reconnect_phase=backoff', 'reconnect_attempts=0'],
      error: null,
    });

    const res = mockRes();
    handleGetFeed(mockReq(), res, deps);

    const body = JSON.parse(res._body) as any[];
    const healthEvent = body.find((e: any) => e.detail?.type === 'health');
    expect(healthEvent).toEqual({
      time: expect.any(String),
      mode: 'agent',
      text: 'mini4: degraded - health signal degraded',
      component: 'health',
      level: 'warn',
      instance: 'mini4',
      detail: {
        type: 'health',
        status: 'degraded',
        previousStatus: 'online',
        confidence: 'ambiguous',
        reason: 'whatsapp_backoff_zero_attempts_without_disconnect_corroboration',
        evidence: ['reconnect_phase=backoff', 'reconnect_attempts=0'],
      },
    });
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

    const body = JSON.parse(res2._body) as any[];
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

    const body = JSON.parse(res._body) as any[];

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

    const body = JSON.parse(res._body) as any[];
    expect(body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        instance: 'zeta',
        mode: 'agent',
        text: 'zeta: session start',
        level: 'info',
        detail: expect.objectContaining({
          type: 'session',
          action: 'session start',
          sessionId: 'abc',
        }),
      }),
      expect.objectContaining({
        instance: 'zeta',
        mode: 'agent',
        text: 'zeta: inbound message received',
        level: 'info',
        detail: expect.objectContaining({
          type: 'message',
          direction: 'inbound',
          chatJid: '15550100001@s.whatsapp.net',
          conversationKey: '15550100001',
        }),
      }),
    ]));
  });

  it('skips non-existent log directories gracefully', () => {
    const inst = fakeInstance({ name: 'eta', type: 'passive', logDir: '/nonexistent/path/logs' });
    const instances = new Map([['eta', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq(), res, deps);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([]);
  });

  it('surfaces invalid log paths instead of making the feed look quiet', () => {
    const notADir = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(notADir, 'not a directory');
    const inst = fakeInstance({ name: 'eta', type: 'passive', logDir: notADir });
    const instances = new Map([['eta', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq(), res, deps);

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([
      expect.objectContaining({
        instance: 'eta',
        component: 'logs',
        level: 'warn',
        text: 'eta: log evidence unavailable (ENOTDIR)',
      }),
    ]);
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

    const body = JSON.parse(res._body) as any[];
    const messageEvents = body.filter((e: any) => e.detail?.type === 'message' && e.detail?.direction === 'outbound');
    expect(messageEvents.map((event) => event.detail.messageId).sort()).toEqual(['msg-001', 'msg-002']);
    expect(messageEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        instance: 'theta',
        mode: 'passive',
        text: 'theta: Sending message',
        detail: expect.objectContaining({
          chatJid: 'chat@s.whatsapp.net',
          conversationKey: 'chat',
          messageId: 'msg-001',
        }),
      }),
      expect.objectContaining({
        instance: 'theta',
        mode: 'passive',
        text: 'theta: Sending message',
        detail: expect.objectContaining({
          chatJid: 'chat@s.whatsapp.net',
          conversationKey: 'chat',
          messageId: 'msg-002',
        }),
      }),
    ]));
  });

  it('coalesces connection closure, stream error, reconnect, and recovery into one card', () => {
    const lines = [
      makeLine({ msg: 'stream errored out', level: 50, fullErrorNode: { attrs: { code: '515' } } }),
      makeLine({ msg: 'WhatsApp connection closed', level: 50, statusCode: 440, reason: 'connectionReplaced' }),
      makeLine({ msg: 'Scheduling reconnect in 5s' }),
      makeLine({ msg: 'Connecting to WhatsApp' }),
      makeLine({ msg: 'WhatsApp connected' }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'iota', type: 'agent', provider: 'claude', logDir });
    const instances = new Map([['iota', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    const body = JSON.parse(res._body) as any[];
    const connectionEvents = body.filter((e: any) => e.detail?.type === 'connection');
    expect(connectionEvents).toHaveLength(1);
    expect(connectionEvents[0]).toMatchObject({
      instance: 'iota',
      provider: 'claude',
      text: 'iota: connection replaced → reconnected',
      detail: {
        type: 'connection',
        statusCode: 440,
        reason: 'connectionReplaced',
        state: 'connected',
      },
    });
    expect(connectionEvents[0].detail).not.toHaveProperty('reconnecting');
  });

  it('coalesces stream-only failures into reconnecting or disconnected summaries', () => {
    const lines = [
      makeLine({ msg: 'stream errored out', level: 50, fullErrorNode: { attrs: { code: '515' } } }),
      makeLine({ msg: 'Scheduling reconnect in 5s' }),
      makeLine({ msg: 'stream errored out', level: 50, time: 1700000010000, fullErrorNode: { attrs: {} } }),
      makeLine({ msg: 'stream errored out', level: 50, time: 1700000011000, fullErrorNode: { attrs: {} } }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'stream-only', type: 'agent', logDir });
    const instances = new Map([['stream-only', inst]]);
    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    const connectionTexts = (JSON.parse(res._body) as any[])
      .filter((event: any) => event.detail?.type === 'connection')
      .map((event: any) => event.text);
    expect(connectionTexts).toEqual(expect.arrayContaining([
      'stream-only: 515 → reconnecting',
      'stream-only: disconnected',
    ]));
  });

  it('uses custom connection reasons when no friendly label exists', () => {
    const lines = [
      makeLine({ msg: 'WhatsApp connection closed', level: 50, statusCode: 499, reason: 'customDisconnect' }),
      makeLine({ msg: 'stream errored out', level: 50, fullErrorNode: { attrs: { code: '499' } } }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'custom-reason', type: 'passive', logDir });
    const instances = new Map([['custom-reason', inst]]);
    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    const event = (JSON.parse(res._body) as any[]).find((entry: any) => entry.detail?.type === 'connection');
    expect(event).toMatchObject({
      text: 'custom-reason: customDisconnect',
      detail: {
        type: 'connection',
        statusCode: 499,
        reason: 'customDisconnect',
      },
    });
  });

  it('coalesces state-only connection transitions without inventing an error', () => {
    const lines = [
      makeLine({ msg: 'Connecting to WhatsApp' }),
      makeLine({ msg: 'WhatsApp connected' }),
      makeLine({ msg: 'Connecting to WhatsApp', time: 'not-a-date' }),
      makeLine({ msg: 'client disconnected', time: 'not-a-date' }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'kappa', type: 'passive', logDir });
    const instances = new Map([['kappa', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    const connectionEvents = (JSON.parse(res._body) as any[]).filter((e: any) => e.detail?.type === 'connection');
    expect(connectionEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: 'kappa: WhatsApp connected',
        detail: { type: 'connection', state: 'connected' },
      }),
      expect.objectContaining({
        text: 'kappa: Connecting to WhatsApp',
        detail: { type: 'connection', state: 'connecting' },
      }),
    ]));
  });

  it('coalesces connection events with unparseable timestamps into the same fallback bucket', () => {
    const lines = [
      makeLine({ msg: 'Connecting to WhatsApp', time: 1700000000000 }),
      makeLine({ msg: 'WhatsApp connected', time: 1700000000000 }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'nan-time', type: 'passive', logDir });
    const instances = new Map([['nan-time', inst]]);
    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });
    const parseSpy = vi.spyOn(Date, 'parse').mockReturnValue(Number.NaN);

    try {
      const res = mockRes();
      handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);
      expect(JSON.parse(res._body)).toEqual([
        expect.objectContaining({
          text: 'nan-time: WhatsApp connected',
          detail: { type: 'connection', state: 'connected' },
        }),
      ]);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('collapses rapid outbound sends without message ids by instance and chat', () => {
    const lines = [
      makeLine({ msg: 'Sending message', chatJid: 'chat@s.whatsapp.net', time: 1700000000000 }),
      makeLine({ msg: 'Sending message', chatJid: 'chat@s.whatsapp.net', time: 1700000000500 }),
      makeLine({ msg: 'Sending message', chatJid: 'other@s.whatsapp.net', time: 1700000000000 }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'lambda', type: 'agent', logDir });
    const instances = new Map([['lambda', inst]]);

    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    const body = JSON.parse(res._body) as any[];
    expect(body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: 'lambda: sent ×2 to chat@s.whatsapp.net',
        detail: {
          type: 'message',
          direction: 'outbound',
          chatJid: 'chat@s.whatsapp.net',
        },
      }),
      expect.objectContaining({
        text: 'lambda: Sending message',
        detail: expect.objectContaining({
          type: 'message',
          direction: 'outbound',
          chatJid: 'other@s.whatsapp.net',
        }),
      }),
    ]));
  });

  it('collapses rapid outbound sends without chat JIDs as unknown recipients', () => {
    const lines = [
      makeLine({ msg: 'Sending message', time: 1700000000000 }),
      makeLine({ msg: 'Sending message', time: 1700000000500 }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'unknown-recipient', type: 'passive', logDir });
    const instances = new Map([['unknown-recipient', inst]]);
    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    expect((JSON.parse(res._body) as any[]).filter((event: any) => event.detail?.type === 'message')).toEqual([
      expect.objectContaining({
        text: 'unknown-recipient: sent ×2 to unknown',
        detail: { type: 'message', direction: 'outbound', chatJid: undefined },
      }),
    ]);
  });

  it('passes through single connection events without coalescing', () => {
    fs.writeFileSync(logFile, makeLine({ msg: 'Scheduling reconnect in 5s' }) + '\n');

    const inst = fakeInstance({ name: 'mu', type: 'chat', logDir });
    const instances = new Map([['mu', inst]]);
    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    expect(JSON.parse(res._body)).toEqual([
      expect.objectContaining({
        text: 'mu: Scheduling reconnect in 5s',
        detail: { type: 'connection', reconnecting: true },
      }),
    ]);
  });

  it('surfaces log tail read failures for latest .log paths', () => {
    const badLogPath = path.join(logDir, 'latest.log');
    fs.mkdirSync(badLogPath);
    const inst = fakeInstance({ name: 'nu', type: 'agent', logDir });
    const instances = new Map([['nu', inst]]);
    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    expect(JSON.parse(res._body)).toEqual([
      expect.objectContaining({
        instance: 'nu',
        component: 'logs',
        level: 'warn',
        text: 'nu: log evidence unavailable (EISDIR)',
      }),
    ]);
  });

  it('dedupes repeated non-message events within the same minute', () => {
    const lines = [
      makeLine({ msg: 'session start', sessionId: 'same' }),
      makeLine({ msg: 'session start', sessionId: 'same' }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'xi', type: 'agent', logDir });
    const instances = new Map([['xi', inst]]);
    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    const sessionEvents = (JSON.parse(res._body) as any[]).filter((event) => event.detail?.type === 'session');
    expect(sessionEvents).toHaveLength(1);
    expect(sessionEvents[0]).toMatchObject({
      text: 'xi: session start',
      detail: { type: 'session', sessionId: 'same' },
    });
  });

  it('preserves equal-time distinct events through final sorting', () => {
    const lines = [
      makeLine({ msg: 'session start', sessionId: 'same-time-start', time: 1700000000000 }),
      makeLine({ msg: 'session end', sessionId: 'same-time-end', time: 1700000000000 }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'same-time', type: 'agent', logDir });
    const instances = new Map([['same-time', inst]]);
    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    const actions = (JSON.parse(res._body) as any[])
      .filter((event: any) => event.detail?.type === 'session')
      .map((event: any) => event.detail.action);
    expect(actions.sort()).toEqual(['session end', 'session start']);
  });

  it('keeps the feed response alive when log parsing or post-processing fallbacks throw', () => {
    const throwingLogInstance = fakeInstance({ name: 'log-throw', type: 'passive' });
    Object.defineProperty(throwingLogInstance, 'logDir', {
      get() { throw new Error('log dir getter exploded'); },
    });
    const logThrowRes = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), logThrowRes, makeDeps({
      discovery: { getInstances: vi.fn(() => new Map([['log-throw', throwingLogInstance]])) } as any,
      healthPoller: { getStatus: vi.fn(() => undefined) } as any,
    }));
    expect(logThrowRes._status).toBe(200);
    expect(JSON.parse(logThrowRes._body)).toEqual([]);

    fs.writeFileSync(logFile, makeLine({ msg: 'WhatsApp connected', time: 1700000000000 }) + '\n');
    const inst = fakeInstance({ name: 'coalesce-throw', type: 'agent', logDir });
    const instances = new Map([['coalesce-throw', inst]]);
    const parseSpy = vi.spyOn(Date, 'parse').mockImplementation(() => { throw new Error('date parse exploded'); });
    try {
      const res = mockRes();
      handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, makeDeps({
        discovery: { getInstances: vi.fn(() => instances) } as any,
        healthPoller: { getStatus: vi.fn(() => undefined) } as any,
      }));
      expect(res._status).toBe(200);
      expect(JSON.parse(res._body)).toEqual([
        expect.objectContaining({
          text: 'coalesce-throw: WhatsApp connected',
          detail: { type: 'connection', state: 'connected' },
        }),
      ]);
    } finally {
      parseSpy.mockRestore();
    }

    fs.writeFileSync(logFile, makeLine({ msg: 'Sending message', chatJid: 'chat@s.whatsapp.net', time: 1700000000000 }) + '\n');
    const collapseSpy = vi.spyOn(Date, 'parse').mockImplementation(() => { throw new Error('collapse parse exploded'); });
    try {
      const res = mockRes();
      handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, makeDeps({
        discovery: { getInstances: vi.fn(() => instances) } as any,
        healthPoller: { getStatus: vi.fn(() => undefined) } as any,
      }));
      expect(res._status).toBe(200);
      expect((JSON.parse(res._body) as any[]).some((event: any) => event.detail?.type === 'message')).toBe(true);
    } finally {
      collapseSpy.mockRestore();
    }

    fs.writeFileSync(logFile, makeLine({ msg: 'session start', time: 1700000000000 }) + '\n');
    const originalFilter = Array.prototype.filter;
    const filterSpy = vi.spyOn(Array.prototype, 'filter').mockImplementation(function filterWithDedupeFailure(
      this: any[],
      callback: Parameters<typeof Array.prototype.filter>[0],
      thisArg?: unknown,
    ) {
      if (this.some((entry) => entry?.text === 'coalesce-throw: session start')) {
        throw new Error('dedupe filter exploded');
      }
      return originalFilter.call(this, callback, thisArg);
    });
    try {
      const res = mockRes();
      handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, makeDeps({
        discovery: { getInstances: vi.fn(() => instances) } as any,
        healthPoller: { getStatus: vi.fn(() => undefined) } as any,
      }));
      expect(res._status).toBe(200);
      expect(JSON.parse(res._body)).toEqual([
        expect.objectContaining({
          text: 'coalesce-throw: session start',
          detail: { type: 'session', action: 'session start' },
        }),
      ]);
    } finally {
      filterSpy.mockRestore();
    }
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
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const events = JSON.parse(res._body) as any[];
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
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const events = JSON.parse(res._body) as any[];
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
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const events = JSON.parse(res._body) as any[];
    const msgEvent = events.find((e: any) => e.detail?.type === 'message');
    expect(msgEvent).toBeTruthy();
    expect(msgEvent.detail.preview).toBeUndefined();

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('falls back after messageId lookup failure and records a preview miss', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-id-fail-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100001@s.whatsapp.net', messageId: 'msg-fallback-after-id-fail',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'id-fail-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['id-fail-test', fakeInst]]);
    const poller = { getStatus: vi.fn(() => null) };
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: false, error: 'message id index unavailable' })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const msgEvent = (JSON.parse(res._body) as any[]).find((e: any) => e.detail?.type === 'message');
    expect(msgEvent).toBeTruthy();
    expect(msgEvent.detail.preview).toBeUndefined();
    expect(dbReader.getMessagesByIds).toHaveBeenCalledWith('id-fail-test', '/unused', ['msg-fallback-after-id-fail']);
    expect(dbReader.getRecentMessagesByChat).toHaveBeenCalledWith(
      'id-fail-test',
      '/unused',
      '15550100001',
      'outbound',
      expect.any(Number),
      1,
    );

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('enriches via fallback when messageId rows do not include the logged id', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-id-fallback-hit-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100001@s.whatsapp.net', messageId: 'msg-fallback-hit',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'id-fallback-hit-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['id-fallback-hit-test', fakeInst]]);
    const poller = { getStatus: vi.fn(() => null) };
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [
        { message_id: null, content: 'ignored row', sender_name: null, content_type: 'text' },
      ] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [
        { message_id: 'msg-from-fallback', content: 'Fallback after id miss', sender_name: 'Fallback Sender', content_type: 'text', pk: 1, conversation_key: '15550100001', chat_jid: '15550100001@s.whatsapp.net', sender_jid: 'bot', timestamp: 1700000000, is_from_me: 1, raw_message: null },
      ] })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const msgEvent = (JSON.parse(res._body) as any[]).find((e: any) => e.detail?.type === 'message');
    expect(msgEvent.detail.preview).toBe('Fallback after id miss');
    expect(msgEvent.detail.senderName).toBe('Fallback Sender');
    expect(msgEvent.detail.messageId).toBe('msg-fallback-hit');
    expect(dbReader.getRecentMessagesByChat).toHaveBeenCalledOnce();

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('records fallback preview errors without failing the feed response', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-fallback-fail-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100001@s.whatsapp.net',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'fallback-fail-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['fallback-fail-test', fakeInst]]);
    const poller = { getStatus: vi.fn(() => null) };
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: false, error: 'fallback query failed' })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const msgEvent = (JSON.parse(res._body) as any[]).find((e: any) => e.detail?.type === 'message');
    expect(msgEvent).toBeTruthy();
    expect(msgEvent.detail.preview).toBeUndefined();
    expect(dbReader.getRecentMessagesByChat).toHaveBeenCalledOnce();

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('records thrown messageId and fallback preview errors without failing the feed response', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-thrown-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, [
      JSON.stringify({
        level: 30, time: 1775166900000, component: 'connection',
        chatJid: '15550100001@s.whatsapp.net', messageId: 'msg-throws',
        msg: 'Sending message',
      }),
      JSON.stringify({
        level: 30, time: 1775166901000, component: 'connection',
        chatJid: '15550100001@s.whatsapp.net',
        msg: 'Sending message',
      }),
    ].join('\n') + '\n');

    const fakeInst = {
      name: 'thrown-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['thrown-test', fakeInst]]);
    const poller = { getStatus: vi.fn(() => null) };
    const dbReader = {
      getMessagesByIds: vi.fn(() => { throw new Error('message id lookup exploded'); }),
      getRecentMessagesByChat: vi.fn(() => { throw new Error('fallback lookup exploded'); }),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const messageEvents = (JSON.parse(res._body) as any[]).filter((e: any) => e.detail?.type === 'message');
    expect(messageEvents.length).toBeGreaterThan(0);
    expect(messageEvents.every((event) => event.detail.preview === undefined)).toBe(true);
    expect(dbReader.getMessagesByIds).toHaveBeenCalledOnce();
    expect(dbReader.getRecentMessagesByChat).toHaveBeenCalled();

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('records instance-level preview enrichment errors without dropping message events', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-instance-throw-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100001@s.whatsapp.net', messageId: 'msg-instance-throw',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'instance-throw-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    class ThrowingGetMap<K, V> extends Map<K, V> {
      override get(key: K): V | undefined {
        if (key === 'instance-throw-test') throw new Error('instance lookup exploded');
        return super.get(key);
      }
    }
    const instances = new ThrowingGetMap<string, typeof fakeInst>([['instance-throw-test', fakeInst]]);
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, {
      discovery: { getInstances: () => instances } as any,
      healthPoller: { getStatus: vi.fn(() => null) } as any,
      dbReader,
    });

    const msgEvent = (JSON.parse(res._body) as any[]).find((event: any) => event.detail?.type === 'message');
    expect(msgEvent).toMatchObject({
      instance: 'instance-throw-test',
      detail: {
        type: 'message',
        messageId: 'msg-instance-throw',
      },
    });
    expect(Object.keys(msgEvent.detail).sort()).toEqual([
      'chatJid',
      'conversationKey',
      'direction',
      'messageId',
      'type',
    ]);
    expect(dbReader.getMessagesByIds).not.toHaveBeenCalled();
    expect(dbReader.getRecentMessagesByChat).not.toHaveBeenCalled();

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('skips preview enrichment when a parsed message instance is no longer discoverable', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-missing-instance-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100001@s.whatsapp.net', messageId: 'msg-missing-instance',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'missing-instance-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    class MissingGetMap<K, V> extends Map<K, V> {
      override get(): V | undefined {
        return undefined;
      }
    }
    const instances = new MissingGetMap<string, typeof fakeInst>([['missing-instance-test', fakeInst]]);
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, {
      discovery: { getInstances: () => instances } as any,
      healthPoller: { getStatus: vi.fn(() => null) } as any,
      dbReader,
    });

    const msgEvent = (JSON.parse(res._body) as any[]).find((event: any) => event.detail?.type === 'message');
    expect(msgEvent.detail.messageId).toBe('msg-missing-instance');
    expect(msgEvent.detail.preview).toBeUndefined();
    expect(dbReader.getMessagesByIds).not.toHaveBeenCalled();
    expect(dbReader.getRecentMessagesByChat).not.toHaveBeenCalled();

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('skips fallback preview lookup when message events lack a chat JID', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-no-chat-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'no-chat-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['no-chat-test', fakeInst]]);
    const poller = { getStatus: vi.fn(() => null) };
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const msgEvent = (JSON.parse(res._body) as any[]).find((e: any) => e.detail?.type === 'message');
    expect(msgEvent.detail.chatJid).toBeUndefined();
    expect(dbReader.getRecentMessagesByChat).not.toHaveBeenCalled();

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('skips fallback preview lookup when chat JID cannot become a conversation key', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-invalid-chat-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: 'not-a-jid',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'invalid-chat-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['invalid-chat-test', fakeInst]]);
    const poller = { getStatus: vi.fn(() => null) };
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const msgEvent = (JSON.parse(res._body) as any[]).find((e: any) => e.detail?.type === 'message');
    expect(msgEvent.detail.chatJid).toBe('not-a-jid');
    expect(msgEvent.detail.conversationKey).toBeUndefined();
    expect(dbReader.getRecentMessagesByChat).not.toHaveBeenCalled();

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('treats unparseable message timestamps as fallback preview misses', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-bad-time-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100001@s.whatsapp.net',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'bad-time-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['bad-time-test', fakeInst]]);
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
    } as any;
    const parseSpy = vi.spyOn(Date, 'parse').mockReturnValue(Number.NaN);

    try {
      const res = mockRes();
      handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, {
        discovery: { getInstances: () => instances } as any,
        healthPoller: { getStatus: vi.fn(() => null) } as any,
        dbReader,
      });

      const msgEvent = (JSON.parse(res._body) as any[]).find((event: any) => event.detail?.type === 'message');
      expect(msgEvent.detail.preview).toBeUndefined();
      expect(dbReader.getRecentMessagesByChat).not.toHaveBeenCalled();
    } finally {
      parseSpy.mockRestore();
      fs.unlinkSync(logFile);
      fs.rmdirSync(tmpDir);
    }
  });

  it('preserves log metadata when fallback preview rows provide alternate metadata', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-preserve-metadata-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100001@s.whatsapp.net',
      senderName: 'Log Sender',
      contentType: 'log-type',
      msg: 'inbound message received',
    }) + '\n');

    const fakeInst = {
      name: 'preserve-metadata-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['preserve-metadata-test', fakeInst]]);
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [
        { message_id: 'db-message-id', content: 'Fallback preview', sender_name: 'DB Sender', content_type: 'db-type', pk: 1, conversation_key: '15550100001', chat_jid: '15550100001@s.whatsapp.net', sender_jid: 'bot', timestamp: 1700000000, is_from_me: 0, raw_message: null },
      ] })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, {
      discovery: { getInstances: () => instances } as any,
      healthPoller: { getStatus: vi.fn(() => null) } as any,
      dbReader,
    });

    const msgEvent = (JSON.parse(res._body) as any[]).find((event: any) => event.detail?.type === 'message');
    expect(msgEvent.detail.preview).toBe('Fallback preview');
    expect(msgEvent.detail.senderName).toBe('Log Sender');
    expect(msgEvent.detail.contentType).toBe('log-type');
    expect(msgEvent.detail.messageId).toBe('db-message-id');
    expect(msgEvent.detail.conversationKey).toBe('15550100001');

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('keeps absent messageId row metadata absent on direct preview hits', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-undefined-row-metadata-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100001@s.whatsapp.net', messageId: 'msg-undefined-row-metadata',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'undefined-row-metadata-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['undefined-row-metadata-test', fakeInst]]);
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [
        { message_id: 'msg-undefined-row-metadata', content: 'Preview without metadata', sender_name: undefined, content_type: undefined },
      ] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, {
      discovery: { getInstances: () => instances } as any,
      healthPoller: { getStatus: vi.fn(() => null) } as any,
      dbReader,
    });

    const msgEvent = (JSON.parse(res._body) as any[]).find((event: any) => event.detail?.type === 'message');
    expect(msgEvent.detail.preview).toBe('Preview without metadata');
    expect(msgEvent.detail.senderName).toBeUndefined();
    expect(msgEvent.detail.contentType).toBeUndefined();

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('treats blank DB content as an absent preview while preserving metadata', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-blank-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100001@s.whatsapp.net', messageId: 'msg-blank-content',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'blank-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['blank-test', fakeInst]]);
    const poller = { getStatus: vi.fn(() => null) };
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [
        { message_id: 'msg-blank-content', content: '   ', sender_name: 'Operator', content_type: 'text', pk: 1, conversation_key: '15550100001', chat_jid: '15550100001@s.whatsapp.net', sender_jid: 'bot', timestamp: 1700000000, is_from_me: 1, raw_message: null },
      ] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const msgEvent = (JSON.parse(res._body) as any[]).find((e: any) => e.detail?.type === 'message');
    expect(msgEvent.detail.preview).toBeUndefined();
    expect(msgEvent.detail.senderName).toBe('Operator');
    expect(msgEvent.detail.contentType).toBe('text');

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });

  it('treats null DB content as an absent preview', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-null-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100001@s.whatsapp.net', messageId: 'msg-null-content',
      msg: 'Sending message',
    }) + '\n');

    const fakeInst = {
      name: 'null-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['null-test', fakeInst]]);
    const poller = { getStatus: vi.fn(() => null) };
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [
        { message_id: 'msg-null-content', content: null, sender_name: null, content_type: 'image', pk: 1, conversation_key: '15550100001', chat_jid: '15550100001@s.whatsapp.net', sender_jid: 'bot', timestamp: 1700000000, is_from_me: 1, raw_message: null },
      ] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
    } as any;

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, { discovery: { getInstances: () => instances } as any, healthPoller: poller as any, dbReader });

    const msgEvent = (JSON.parse(res._body) as any[]).find((e: any) => e.detail?.type === 'message');
    expect(msgEvent.detail.preview).toBeUndefined();
    expect(msgEvent.detail.contentType).toBe('image');

    fs.unlinkSync(logFile);
    fs.rmdirSync(tmpDir);
  });
});
describe('parsePinoLine — supplemental branch coverage', () => {
  const CTX = { instanceName: 'test-line', instanceType: 'passive' as const };

  function makeLine(fields: Record<string, unknown>): string {
    return JSON.stringify({ level: 30, time: 1700000000000, ...fields });
  }


  it('carries provider from parse context onto the event', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'session start' }),
      { instanceName: 'prov-line', instanceType: 'agent', provider: 'openai' },
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.provider).toBe('openai');
      expect(result.instance).toBe('prov-line');
      expect(result.mode).toBe('agent');
    }
  });

  it('omits the provider property entirely when context supplies no provider', () => {
    const result = parsePinoLine(makeLine({ msg: 'session start' }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result).not.toHaveProperty('provider');
    }
  });

  it('omits conversationKey for outbound messages whose chat JID cannot be converted', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'Sending message', chatJid: 'not-a-jid', messageId: 'bad-out-1' }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({
        type: 'message',
        direction: 'outbound',
        chatJid: 'not-a-jid',
        messageId: 'bad-out-1',
      });
      expect((result.detail as any).conversationKey).toBeUndefined();
    }
  });

  it('omits conversationKey for inbound messages whose chat JID cannot be converted', () => {
    const result = parsePinoLine(
      makeLine({ msg: 'inbound message received', chatJid: 'not-a-jid', messageId: 'bad-in-1' }),
      CTX,
    );
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({
        type: 'message',
        direction: 'inbound',
        chatJid: 'not-a-jid',
        messageId: 'bad-in-1',
      });
      expect((result.detail as any).conversationKey).toBeUndefined();
    }
  });

  it('normalizes a tool_error with every field absent to empty defaults', () => {
    const result = parsePinoLine(makeLine({ msg: 'tool error reported' }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({
        type: 'tool_error',
        toolName: '',
        error: '',
      });
      expect((result.detail as any).toolId).toBeUndefined();
    }
  });

  it('returns a non-error generic event for business-matching info-level messages', () => {
    const result = parsePinoLine(makeLine({ msg: 'queue processed 5 items', level: 30 }), CTX);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.detail).toMatchObject({ type: 'generic' });
      expect(result.level).toBe('info');
      expect(result.isError).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// health-status pruning when an instance leaves discovery
// ---------------------------------------------------------------------------

describe('health transition pruning via handleGetFeed', () => {
  function fakeInstance(overrides: Record<string, unknown> = {}): any {
    return {
      name: 'prune-alpha',
      type: 'agent',
      accessMode: 'self_only',
      healthPort: 3010,
      dbPath: '/data/prune/bot.db',
      stateRoot: '/state/prune',
      logDir: '/nonexistent/prune-logs',
      healthToken: null,
      configPath: '/config/prune/config.json',
      socketPath: null,
      ...overrides,
    };
  }
  function makeDeps(overrides: Record<string, unknown> = {}): any {
    return {
      discovery: { getInstances: vi.fn(() => new Map()) },
      healthPoller: { getStatus: vi.fn(() => undefined) },
      dbReader: {
        getMessagesByIds: vi.fn(() => ({ ok: true, data: [] })),
        getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
      },
      ...overrides,
    };
  }

  it('does not emit a stale health transition for a re-introduced instance after pruning', () => {
    const instA = fakeInstance({ name: 'prune-alpha', type: 'agent' });
    const instB = fakeInstance({ name: 'prune-beta', type: 'agent' });

    const deps = makeDeps({
      discovery: { getInstances: vi.fn() } as any,
      healthPoller: { getStatus: vi.fn() } as any,
    });

    // Call 1 — establish prune-alpha online baseline (first sighting → no transition)
    (deps.discovery.getInstances as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([['prune-alpha', instA]]),
    );
    (deps.healthPoller.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'online',
      error: null,
    });
    const res1 = mockRes();
    handleGetFeed(mockReq(), res1, deps);
    expect((JSON.parse(res1._body) as any[]).filter((e: any) => e.detail?.type === 'health')).toHaveLength(0);

    // Call 2 — discovery no longer contains prune-alpha → its previousStatus entry is pruned
    (deps.discovery.getInstances as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([['prune-beta', instB]]),
    );
    (deps.healthPoller.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'online',
      error: null,
    });
    handleGetFeed(mockReq(), mockRes(), deps);

    // Call 3 — prune-alpha returns as unreachable; prevStatus is undefined after pruning,
    // so NO transition may be emitted (it would be emitted if the stale 'online' survived).
    (deps.discovery.getInstances as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([['prune-alpha', instA]]),
    );
    (deps.healthPoller.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'unreachable',
      error: 'ECONNREFUSED',
    });
    const res3 = mockRes();
    handleGetFeed(mockReq(), res3, deps);
    expect((JSON.parse(res3._body) as any[]).filter((e: any) => e.detail?.type === 'health')).toHaveLength(0);

    // Call 4 — prune-alpha now degrades; baseline is the just-established 'unreachable'
    (deps.healthPoller.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
      status: 'degraded',
      error: 'flaky signal',
    });
    const res4 = mockRes();
    handleGetFeed(mockReq(), res4, deps);

    const healthEvent = (JSON.parse(res4._body) as any[]).find((e: any) => e.detail?.type === 'health');
    expect(healthEvent).toBeDefined();
    expect(healthEvent.detail).toMatchObject({
      type: 'health',
      status: 'degraded',
      previousStatus: 'unreachable',
      error: 'flaky signal',
    });
    expect(healthEvent.level).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// coalesce / collapse — supplemental branch coverage
// ---------------------------------------------------------------------------

describe('coalesce and collapse — supplemental branch coverage', () => {
  let tmpDir: string;
  let logDir: string;
  let logFile: string;

  function makeLine(fields: Record<string, unknown>): string {
    return JSON.stringify({ level: 30, time: 1700000000000, ...fields });
  }
  function fakeInstance(overrides: Record<string, unknown> = {}): any {
    return {
      name: 'coalesce-line',
      type: 'passive',
      accessMode: 'self_only',
      healthPort: 3010,
      dbPath: '/data/coalesce/bot.db',
      stateRoot: '/state/coalesce',
      logDir,
      healthToken: null,
      configPath: '/config/coalesce/config.json',
      socketPath: null,
      ...overrides,
    };
  }
  function makeDeps(overrides: Record<string, unknown> = {}): any {
    return {
      discovery: { getInstances: vi.fn(() => new Map()) },
      healthPoller: { getStatus: vi.fn(() => undefined) },
      dbReader: {
        getMessagesByIds: vi.fn(() => ({ ok: true, data: [] })),
        getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-feed-supplement-'));
    logDir = path.join(tmpDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'app.log');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('collapses repeated outbound sends that share a messageId into one summary card', () => {
    const lines = [
      makeLine({ msg: 'Sending message', chatJid: '15550100002@s.whatsapp.net', messageId: 'msg-dup', time: 1700000000000 }),
      makeLine({ msg: 'Sending message', chatJid: '15550100002@s.whatsapp.net', messageId: 'msg-dup', time: 1700000000500 }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'omicron', type: 'agent' });
    const instances = new Map([['omicron', inst]]);
    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    const messageEvents = (JSON.parse(res._body) as any[]).filter(
      (e: any) => e.detail?.type === 'message' && e.detail?.direction === 'outbound',
    );
    expect(messageEvents).toHaveLength(1);
    expect(messageEvents[0]).toMatchObject({
      instance: 'omicron',
      text: 'omicron: sent ×2 to 15550100002@s.whatsapp.net',
      detail: {
        type: 'message',
        direction: 'outbound',
        chatJid: '15550100002@s.whatsapp.net',
      },
    });
    expect(messageEvents[0].detail.messageId).toBeUndefined();
    expect(messageEvents[0].detail.direction).toBe('outbound');
  });

  it('coalesces repeated reconnect scheduling with no error into the first event', () => {
    const lines = [
      makeLine({ msg: 'Scheduling reconnect in 5s', time: 1700000000000 }),
      makeLine({ msg: 'Scheduling reconnect in 10s', time: 1700000000000 }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, lines);

    const inst = fakeInstance({ name: 'reconnect-only', type: 'passive' });
    const instances = new Map([['reconnect-only', inst]]);
    const deps = makeDeps({
      discovery: { getInstances: vi.fn(() => instances) } as any,
    });

    const res = mockRes();
    handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, deps);

    const connectionEvents = (JSON.parse(res._body) as any[]).filter(
      (e: any) => e.detail?.type === 'connection',
    );
    expect(connectionEvents).toHaveLength(1);
    expect(connectionEvents[0]).toMatchObject({
      instance: 'reconnect-only',
      text: 'reconnect-only: Scheduling reconnect in 5s',
      detail: { type: 'connection', reconnecting: true },
    });
  });
});

// ---------------------------------------------------------------------------
// preview enrichment — sanitizePreview truncation
// ---------------------------------------------------------------------------

describe('message preview enrichment — supplemental edge cases', () => {
  it('truncates long preview content to 120 characters', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-enrich-truncate-'));
    const logFile = path.join(tmpDir, 'current.log');
    fs.writeFileSync(logFile, JSON.stringify({
      level: 30, time: 1775166900000, component: 'connection',
      chatJid: '15550100003@s.whatsapp.net', messageId: 'msg-long-preview',
      msg: 'Sending message',
    }) + '\n');

    const longBody = 'a'.repeat(150);
    const fakeInst = {
      name: 'truncate-test', type: 'agent' as const, healthPort: 9090,
      logDir: tmpDir, dbPath: '/unused', healthToken: null,
      accessMode: 'self_only', configPath: '/x', stateRoot: '/x', socketPath: null,
    };
    const instances = new Map([['truncate-test', fakeInst]]);
    const dbReader = {
      getMessagesByIds: vi.fn(() => ({ ok: true, data: [
        { message_id: 'msg-long-preview', content: longBody, sender_name: null, content_type: 'text' },
      ] })),
      getRecentMessagesByChat: vi.fn(() => ({ ok: true, data: [] })),
    } as any;

    const res = mockRes();
    try {
      handleGetFeed(mockReq({ url: '/api/feed?limit=10' }), res, {
        discovery: { getInstances: () => instances } as any,
        healthPoller: { getStatus: vi.fn(() => null) } as any,
        dbReader,
      });

      const msgEvent = (JSON.parse(res._body) as any[]).find((e: any) => e.detail?.type === 'message');
      expect(msgEvent).toBeTruthy();
      expect(msgEvent.detail.preview).toBe('a'.repeat(120));
      expect(msgEvent.detail.preview.length).toBe(120);
    } finally {
      fs.unlinkSync(logFile);
      fs.rmdirSync(tmpDir);
    }
  });
});
