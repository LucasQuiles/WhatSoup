/**
 * Parity follow-up for issue #257 (PR #285): the proxy routes in
 * `mcp-proxy.ts` now honor `mcpCall` `toolError` envelopes and map them to
 * HTTP 4xx/5xx via `respondMcp`. Two other `mcpCall` consumers in
 * `routes/ops.ts` still gated purely on `result.success` and would return
 * HTTP 200 even when the tool envelope set `isError: true`:
 *
 *   - `handleSend`        (send_message)        ops.ts:~203
 *   - `handleSaveContact` (add_or_edit_contact) ops.ts:~335
 *
 * These tests pin the parity: when `mcpCall` returns `toolError: true`, the
 * HTTP response MUST be 4xx/5xx (not 200/201) and must carry the original
 * MCP envelope so console callers see the failure on their only signal
 * channel — HTTP status.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSend, handleSaveContact } from '../../../src/fleet/routes/ops.ts';
import type { OpsDeps } from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({
  mcpCall: vi.fn(),
}));
vi.mock('../../../src/fleet/http-proxy.ts', () => ({
  proxyToInstance: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

import { mcpCall } from '../../../src/fleet/mcp-client.ts';

function mockReq(body = '', url = '/'): IncomingMessage {
  const stream = new PassThrough() as unknown as IncomingMessage;
  (stream as any).headers = {};
  (stream as any).url = url;
  (stream as any).method = 'POST';
  process.nextTick(() => {
    (stream as unknown as PassThrough).write(body);
    (stream as unknown as PassThrough).end();
  });
  return stream;
}

function mockRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string } {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
    },
    end(data?: string) {
      if (data) res._body = data;
    },
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
    logDir: '/data/test-line/logs',
    healthToken: 'tok123',
    configPath: '/config/test-line/config.json',
    socketPath: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<OpsDeps> = {}): OpsDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => undefined),
      getInstances: vi.fn(() => new Map()),
    } as any,
    realtime: { publish: vi.fn() },
    serviceManager: {
      enable: vi.fn(),
      disable: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      startFire: vi.fn(),
    } as any,
    ...overrides,
  };
}

/** MCP envelope shape for a tool-level error. */
function toolErrorEnvelope(text: string) {
  return { content: [{ type: 'text', text }], isError: true };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ops.ts mcpCall consumers honor isError tool envelopes (parity follow-up #257)', () => {
  describe('handleSend (send_message)', () => {
    it('maps validation-shaped isError to HTTP 422 (not 200) and preserves envelope', async () => {
      const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
      const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        toolError: true,
        result: toolErrorEnvelope('Invalid parameters for tool "send_message": chatJid is required'),
      });

      const res = mockRes();
      await handleSend(
        mockReq(JSON.stringify({ chatJid: 'x@s.whatsapp.net', text: 'hi' })),
        res,
        deps,
        { name: 'test-line' },
      );

      expect(res._status).toBe(422);
      const body = JSON.parse(res._body);
      expect(body.isError).toBe(true);
      expect(body.error).toMatch(/Invalid parameters/i);
    });

    it('maps non-validation isError (handler throw) to HTTP 500', async () => {
      const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
      const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        toolError: true,
        result: toolErrorEnvelope('Internal error executing tool send_message'),
      });

      const res = mockRes();
      await handleSend(
        mockReq(JSON.stringify({ chatJid: 'x@s.whatsapp.net', text: 'hi' })),
        res,
        deps,
        { name: 'test-line' },
      );

      expect(res._status).toBe(500);
      expect(JSON.parse(res._body).isError).toBe(true);
    });

    it('clean success path still returns 200 (no regression)', async () => {
      const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
      const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { sent: true } });

      const res = mockRes();
      await handleSend(
        mockReq(JSON.stringify({ chatJid: 'x@s.whatsapp.net', text: 'hi' })),
        res,
        deps,
        { name: 'test-line' },
      );

      expect(res._status).toBe(200);
    });
  });

  describe('handleSaveContact (add_or_edit_contact)', () => {
    it('maps validation-shaped isError to HTTP 422 (not 200) and preserves envelope', async () => {
      const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
      const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        toolError: true,
        result: toolErrorEnvelope('Invalid parameters for tool "add_or_edit_contact": jid must be a valid JID'),
      });

      const res = mockRes();
      await handleSaveContact(
        mockReq(JSON.stringify({ jid: 'malformed', firstName: 'X' })),
        res,
        deps,
        { name: 'test-line' },
      );

      expect(res._status).toBe(422);
      const body = JSON.parse(res._body);
      expect(body.isError).toBe(true);
      expect(body.error).toMatch(/Invalid parameters/i);
    });

    it('maps non-validation isError (handler throw) to HTTP 500', async () => {
      const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
      const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        toolError: true,
        result: toolErrorEnvelope('Internal error executing tool add_or_edit_contact'),
      });

      const res = mockRes();
      await handleSaveContact(
        mockReq(JSON.stringify({ jid: 'x@s.whatsapp.net', firstName: 'X' })),
        res,
        deps,
        { name: 'test-line' },
      );

      expect(res._status).toBe(500);
      expect(JSON.parse(res._body).isError).toBe(true);
    });

    it('clean success path still returns 200 (no regression)', async () => {
      const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
      const deps = makeDeps({ discovery: { getInstance: vi.fn(() => inst) } as any });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { saved: true } });

      const res = mockRes();
      await handleSaveContact(
        mockReq(JSON.stringify({ jid: 'x@s.whatsapp.net', firstName: 'X' })),
        res,
        deps,
        { name: 'test-line' },
      );

      expect(res._status).toBe(200);
    });
  });
});
