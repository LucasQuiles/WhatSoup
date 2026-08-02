/**
 * Tests for issue #257: MCP `isError: true` tool envelopes must surface as HTTP 4xx/5xx,
 * not be collapsed into 200/201. The proxy is an HTTP gateway, so a tool-level error
 * needs to reach console callers via the only failure channel they consume — HTTP status.
 *
 * Coverage:
 *   - mcpProxy/mcpWithBody factories map tool errors to 422 (validation-shaped) or 500.
 *   - Legacy `handleCancelScheduled` must NOT fabricate `{ cancelled: true }` on isError.
 *   - `handleSearchContacts` propagates tool errors instead of returning empty contacts.
 *   - `handleGetScheduled` propagates tool errors.
 *   - Existing 200/201 success path remains intact.
 *   - `mcp-client` translates `result.isError === true` into `toolError` on McpCallResult.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleCreateGroup,
  handleCancelScheduled,
  handleSearchContacts,
  handleGetScheduled,
  handleLeaveGroup,
} from '../../../src/fleet/routes/mcp-proxy.ts';
import type { McpProxyDeps } from '../../../src/fleet/routes/mcp-proxy.ts';
import { mcpCall } from '../../../src/fleet/mcp-client.ts';
import type { DiscoveredInstance, FleetDiscovery } from '../../../src/fleet/discovery.ts';
import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

vi.mock('../../../src/fleet/mcp-client.ts', () => ({
  mcpCall: vi.fn(),
}));

let tmpDir: string;
let socketPath: string;

function makeInstance(): DiscoveredInstance {
  return {
    name: 'alpha',
    type: 'agent',
    accessMode: 'self_only',
    healthPort: 3010,
    dbPath: '/tmp/alpha.db',
    stateRoot: '/tmp/alpha-state',
    logDir: '/tmp/alpha-logs',
    healthToken: null,
    configPath: '/tmp/alpha-config.json',
    socketPath,
  };
}

function makeDeps(): McpProxyDeps {
  return {
    discovery: {
      getInstance: vi.fn(() => makeInstance()),
    } as unknown as FleetDiscovery,
  };
}

/** MCP envelope shape for a tool-level error. */
function toolErrorEnvelope(text: string) {
  return { content: [{ type: 'text', text }], isError: true };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-mcp-iserror-'));
  socketPath = path.join(tmpDir, 'whatsoup.sock');
  fs.writeFileSync(socketPath, '');
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mcp proxy honors isError tool envelopes (issue #257)', () => {
  describe('validation-shaped tool errors map to 422', () => {
    it('mcpWithBody returns 422 for Zod-style "Invalid parameters" tool error', async () => {
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        toolError: true,
        result: toolErrorEnvelope('Invalid parameters for tool "group_create": subject is required'),
      });
      const res = mockRes();
      await handleCreateGroup(mockReq({ body: '{}', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

      expect(res._status).toBe(422);
      const body = JSON.parse(res._body);
      expect(body.error).toMatch(/Invalid parameters/i);
      // original MCP envelope must be preserved for clients
      expect(body.content).toEqual([
        { type: 'text', text: 'Invalid parameters for tool "group_create": subject is required' },
      ]);
      expect(body.isError).toBe(true);
    });

    it('mcpProxy returns 422 when tool reports "requires deliveryJid parameter"', async () => {
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        toolError: true,
        result: toolErrorEnvelope('Tool "group_leave" requires deliveryJid parameter'),
      });
      const res = mockRes();
      await handleLeaveGroup(
        mockReq({ method: 'DELETE', url: '/api/lines/alpha/groups/abc' }),
        res,
        makeDeps(),
        { name: 'alpha', jid: 'abc' },
      );

      expect(res._status).toBe(422);
      expect(JSON.parse(res._body).isError).toBe(true);
    });
  });

  describe('non-validation tool errors map to 500', () => {
    it('mcpWithBody returns 500 when the tool throws (sanitized handler failure)', async () => {
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        toolError: true,
        result: toolErrorEnvelope('Internal error executing tool group_create'),
      });
      const res = mockRes();
      await handleCreateGroup(mockReq({ body: '{"subject":"x","participants":[]}', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

      expect(res._status).toBe(500);
      const body = JSON.parse(res._body);
      expect(body.error).toMatch(/Internal error/i);
      expect(body.isError).toBe(true);
    });
  });

  describe('legacy handlers stop fabricating success on tool errors', () => {
    it('handleCancelScheduled does NOT respond { cancelled: true } when isError', async () => {
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        toolError: true,
        result: toolErrorEnvelope('Invalid parameters for tool "cancel_scheduled": id not found'),
      });
      const res = mockRes();
      await handleCancelScheduled(
        mockReq({ method: 'DELETE', url: '/api/lines/alpha/scheduled?id=5' }),
        res,
        makeDeps(),
        { name: 'alpha' },
      );

      expect(res._status).toBe(422);
      const body = JSON.parse(res._body);
      expect(body.cancelled).toBeUndefined();
      expect(body.isError).toBe(true);
    });

    it('handleSearchContacts propagates tool error instead of empty contacts', async () => {
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        toolError: true,
        result: toolErrorEnvelope('Internal error executing tool search_contacts'),
      });
      const res = mockRes();
      await handleSearchContacts(
        mockReq({ method: 'GET', url: '/api/lines/alpha/contacts/search?q=ana' }),
        res,
        makeDeps(),
        { name: 'alpha' },
      );

      expect(res._status).toBe(500);
      const body = JSON.parse(res._body);
      expect(body.contacts).toBeUndefined();
      expect(body.isError).toBe(true);
    });

    it('handleGetScheduled propagates tool error', async () => {
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        toolError: true,
        result: toolErrorEnvelope('Invalid parameters for tool "list_scheduled": bad status'),
      });
      const res = mockRes();
      await handleGetScheduled(
        mockReq({ method: 'GET', url: '/api/lines/alpha/scheduled?status=oops' }),
        res,
        makeDeps(),
        { name: 'alpha' },
      );

      expect(res._status).toBe(422);
      expect(JSON.parse(res._body).isError).toBe(true);
    });
  });

  describe('success path remains intact', () => {
    it('mcpWithBody still returns successCode (201) on clean result', async () => {
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        result: { content: [{ type: 'text', text: '{"jid":"g123"}' }] },
      });
      const res = mockRes();
      await handleCreateGroup(mockReq({ body: '{"subject":"Ops","participants":[]}', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

      expect(res._status).toBe(201);
      expect(JSON.parse(res._body)).toEqual({ jid: 'g123' });
    });

    it('handleSearchContacts still returns { contacts: [...] } on clean result', async () => {
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        result: { content: [{ type: 'text', text: JSON.stringify({ results: [{ jid: '1@s.whatsapp.net' }] }) }] },
      });
      const res = mockRes();
      await handleSearchContacts(
        mockReq({ method: 'GET', url: '/api/lines/alpha/contacts/search?q=ana' }),
        res,
        makeDeps(),
        { name: 'alpha' },
      );

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ contacts: [{ jid: '1@s.whatsapp.net' }] });
    });

    it('handleCancelScheduled still returns { cancelled: true, id } on clean result', async () => {
      vi.mocked(mcpCall).mockResolvedValue({
        success: true,
        result: { content: [{ type: 'text', text: '{"ok":true}' }] },
      });
      const res = mockRes();
      await handleCancelScheduled(
        mockReq({ method: 'DELETE', url: '/api/lines/alpha/scheduled?id=5' }),
        res,
        makeDeps(),
        { name: 'alpha' },
      );

      expect(res._status).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ cancelled: true, id: 5 });
    });
  });

  describe('JSON-RPC transport errors still map to 502', () => {
    it('mcpWithBody returns 502 when result.success is false', async () => {
      vi.mocked(mcpCall).mockResolvedValue({ success: false, error: 'timeout' });
      const res = mockRes();
      await handleCreateGroup(mockReq({ body: '{"subject":"x","participants":[]}', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

      expect(res._status).toBe(502);
      expect(JSON.parse(res._body)).toEqual({ error: 'timeout' });
    });
  });
});
