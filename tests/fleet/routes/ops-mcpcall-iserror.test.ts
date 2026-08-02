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
import { handleSend, handleSaveContact } from '../../../src/fleet/routes/ops.ts';
import type { DiscoveredInstance } from '../../../src/fleet/discovery.ts';
import { makeDeps, mockReq, mockRes } from '../../helpers/http-mocks.ts';

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
        mockReq({ method: 'POST', body: JSON.stringify({ chatJid: 'x@s.whatsapp.net', text: 'hi' }) }),
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
        mockReq({ method: 'POST', body: JSON.stringify({ chatJid: 'x@s.whatsapp.net', text: 'hi' }) }),
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
        mockReq({ method: 'POST', body: JSON.stringify({ chatJid: 'x@s.whatsapp.net', text: 'hi' }) }),
        res,
        deps,
        { name: 'test-line' },
      );

      expect(res._status).toBe(200);
    });

    // ---------------------------------------------------------------------
    //  Publish gate — explicit regression test pinning the `!toolError`
    //  guard at ops.ts L208. Without this gate, a tool-level failure would
    //  fan out fake `message_received` / `chat_updated` / `feed_event`
    //  signals to every WebSocket client and lie about delivery state.
    //
    //  RED-GREEN proof: temporarily replacing
    //    `if (result.success && !result.toolError) {`
    //  with
    //    `if (result.success) {`
    //  in ops.ts makes this test fail with `publish` called 3 times.
    //  Restoring the gate makes it pass. Recorded in commit body.
    // ---------------------------------------------------------------------
    it('does NOT publish realtime events when mcpCall returns toolError: true', async () => {
      const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
      const publishSpy = vi.fn();
      const deps = makeDeps({
        discovery: { getInstance: vi.fn(() => inst) } as any,
        realtime: { publish: publishSpy },
      });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        toolError: true,
        result: toolErrorEnvelope('Invalid parameters for tool "send_message": chatJid is required'),
      });

      const res = mockRes();
      await handleSend(
        mockReq({ method: 'POST', body: JSON.stringify({ chatJid: 'x@s.whatsapp.net', text: 'hi' }) }),
        res,
        deps,
        { name: 'test-line' },
      );

      // Sanity: the failure path was actually taken.
      expect(res._status).toBe(422);
      // Core assertion: NO fan-out on a tool-level failure.
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('DOES publish realtime events on clean MCP success (counter-test)', async () => {
      const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
      const publishSpy = vi.fn();
      const deps = makeDeps({
        discovery: { getInstance: vi.fn(() => inst) } as any,
        realtime: { publish: publishSpy },
      });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { sent: true } });

      const res = mockRes();
      await handleSend(
        mockReq({ method: 'POST', body: JSON.stringify({ chatJid: 'x@s.whatsapp.net', text: 'hi' }) }),
        res,
        deps,
        { name: 'test-line' },
      );

      expect(res._status).toBe(200);
      // Exactly three signals: message_received, chat_updated, feed_event.
      expect(publishSpy).toHaveBeenCalledTimes(3);
      const eventTypes = publishSpy.mock.calls.map((c) => c[0].type);
      expect(eventTypes).toEqual(
        expect.arrayContaining(['message_received', 'chat_updated', 'feed_event']),
      );
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
        mockReq({ method: 'POST', body: JSON.stringify({ jid: 'malformed', firstName: 'X' }) }),
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
        mockReq({ method: 'POST', body: JSON.stringify({ jid: 'x@s.whatsapp.net', firstName: 'X' }) }),
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
        mockReq({ method: 'POST', body: JSON.stringify({ jid: 'x@s.whatsapp.net', firstName: 'X' }) }),
        res,
        deps,
        { name: 'test-line' },
      );

      expect(res._status).toBe(200);
    });

    // ---------------------------------------------------------------------
    //  Publish gate — handleSaveContact currently does NOT publish on any
    //  path (success or failure). This regression test pins that contract
    //  so a future maintainer who adds publish-on-success cannot land it
    //  without also gating on `!toolError`.
    // ---------------------------------------------------------------------
    it('does NOT publish realtime events when mcpCall returns toolError: true', async () => {
      const inst = fakeInstance({ type: 'passive', socketPath: '/state/test-line/whatsoup.sock' });
      const publishSpy = vi.fn();
      const deps = makeDeps({
        discovery: { getInstance: vi.fn(() => inst) } as any,
        realtime: { publish: publishSpy },
      });
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        toolError: true,
        result: toolErrorEnvelope('Invalid parameters for tool "add_or_edit_contact": jid must be a valid JID'),
      });

      const res = mockRes();
      await handleSaveContact(
        mockReq({ method: 'POST', body: JSON.stringify({ jid: 'malformed', firstName: 'X' }) }),
        res,
        deps,
        { name: 'test-line' },
      );

      // Sanity: the failure path was actually taken.
      expect(res._status).toBe(422);
      // Core assertion: NO realtime fan-out on a tool-level failure.
      expect(publishSpy).not.toHaveBeenCalled();
    });
  });
});
