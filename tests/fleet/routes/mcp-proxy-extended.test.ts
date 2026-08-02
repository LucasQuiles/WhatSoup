/**
 * Extended coverage for src/fleet/routes/mcp-proxy.ts beyond the existing
 * mcp-proxy.test.ts: covers the manual handlers (handleGetScheduled,
 * handleCancelScheduled, handleSearchContacts variants), shared error paths
 * (missing socket, MCP call failure), and a representative slice of the
 * factory-generated group handlers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  handleGetScheduled,
  handleCreateScheduled,
  handleGetScheduledById,
  handleUpdateScheduled,
  handleCancelScheduledById,
  handleCancelScheduled,
  handleGetGroups,
  handleGetGroupDetail,
  handleLeaveGroup,
  handleUpdateGroupSubject,
  handleGetGroupInvite,
  handleRevokeGroupInvite,
  handleSearchContacts,
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

function makeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
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
    ...overrides,
  };
}

function makeDeps(instance?: DiscoveredInstance): McpProxyDeps {
  const inst = instance ?? makeInstance();
  return {
    discovery: {
      getInstance: vi.fn(() => inst),
    } as unknown as FleetDiscovery,
  };
}

function happyMcpResult(data: unknown) {
  return {
    success: true,
    result: { content: [{ type: 'text', text: JSON.stringify(data) }] },
  } as const;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-mcp-proxy-ext-'));
  socketPath = path.join(tmpDir, 'whatsoup.sock');
  fs.writeFileSync(socketPath, '');
  vi.mocked(mcpCall).mockResolvedValue(happyMcpResult({ ok: true }));
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleGetScheduled (manual handler)', () => {
  it('lists scheduled messages without filter', async () => {
    vi.mocked(mcpCall).mockResolvedValueOnce(happyMcpResult({ scheduled: [{ id: 1 }] }));
    const res = mockRes();
    await handleGetScheduled(
      mockReq({ method: 'POST', url: '/api/lines/alpha/scheduled' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ scheduled: [{ id: 1 }] });
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'list_scheduled', {});
  });

  it('forwards ?status= as a filter arg to list_scheduled', async () => {
    const res = mockRes();
    await handleGetScheduled(
      mockReq({ method: 'POST', url: '/api/lines/alpha/scheduled?status=pending' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'list_scheduled', { status: 'pending' });
  });

  it('returns 502 when the MCP call fails', async () => {
    vi.mocked(mcpCall).mockResolvedValueOnce({ success: false, error: 'mcp down' });
    const res = mockRes();
    await handleGetScheduled(
      mockReq({ method: 'POST', url: '/api/lines/alpha/scheduled' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(res._status).toBe(502);
    expect(JSON.parse(res._body)).toEqual({ error: 'mcp down' });
  });

  it('returns 503 when socket is missing', async () => {
    fs.unlinkSync(socketPath);
    const res = mockRes();
    await handleGetScheduled(
      mockReq({ method: 'POST', url: '/api/lines/alpha/scheduled' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(res._status).toBe(503);
    expect(mcpCall).not.toHaveBeenCalled();
  });
});

describe('handleCancelScheduled (manual legacy handler)', () => {
  it('returns 400 when the id query parameter is missing', async () => {
    const res = mockRes();
    await handleCancelScheduled(
      mockReq({ method: 'POST', url: '/api/lines/alpha/scheduled' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'id query parameter is required' });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('returns 400 when the legacy id query parameter is not numeric', async () => {
    const res = mockRes();
    await handleCancelScheduled(
      mockReq({ method: 'POST', url: '/api/lines/alpha/scheduled?id=abc' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'id query parameter must be a positive integer' });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('dispatches to cancel_scheduled with numeric id on success', async () => {
    const res = mockRes();
    await handleCancelScheduled(
      mockReq({ method: 'POST', url: '/api/lines/alpha/scheduled?id=123' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ cancelled: true, id: 123 });
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'cancel_scheduled', { id: 123 });
  });

  it('returns 503 when socket missing', async () => {
    fs.unlinkSync(socketPath);
    const res = mockRes();
    await handleCancelScheduled(
      mockReq({ method: 'POST', url: '/api/lines/alpha/scheduled?id=123' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(res._status).toBe(503);
  });
});

describe('handleSearchContacts (manual handler)', () => {
  it('returns 400 when the q query parameter is missing', async () => {
    const res = mockRes();
    await handleSearchContacts(
      mockReq({ method: 'POST', url: '/api/lines/alpha/contacts/search' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'q query parameter is required' });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('normalizes search_contacts {results, total} to {contacts: results}', async () => {
    vi.mocked(mcpCall).mockResolvedValueOnce(
      happyMcpResult({ results: [{ jid: 'a@s.whatsapp.net' }], total: 1 }),
    );
    const res = mockRes();
    await handleSearchContacts(
      mockReq({ method: 'POST', url: '/api/lines/alpha/contacts/search?q=ana' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ contacts: [{ jid: 'a@s.whatsapp.net' }] });
  });

  it('falls back to contacts key when results is absent', async () => {
    vi.mocked(mcpCall).mockResolvedValueOnce(
      happyMcpResult({ contacts: [{ jid: 'b@s.whatsapp.net' }] }),
    );
    const res = mockRes();
    await handleSearchContacts(
      mockReq({ method: 'POST', url: '/api/lines/alpha/contacts/search?q=ana' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(JSON.parse(res._body)).toEqual({ contacts: [{ jid: 'b@s.whatsapp.net' }] });
  });

  it('returns 502 when search_contacts MCP call fails', async () => {
    vi.mocked(mcpCall).mockResolvedValueOnce({ success: false });
    const res = mockRes();
    await handleSearchContacts(
      mockReq({ method: 'POST', url: '/api/lines/alpha/contacts/search?q=ana' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(res._status).toBe(502);
    expect(JSON.parse(res._body)).toEqual({ error: 'MCP call failed' });
  });
});

describe('factory-generated scheduled handlers', () => {
  it('handleCreateScheduled returns 201 on success', async () => {
    const res = mockRes();
    await handleCreateScheduled(
      mockReq({ method: 'POST', body: '{"text":"hi","scheduled_at":1767225600,"chatJid":"a"}', url: '/api/lines/alpha/scheduled' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(res._status).toBe(201);
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'schedule_message',
      { text: 'hi', scheduled_at: 1767225600, chatJid: 'a' },
      undefined,
    );
  });

  it('handleGetScheduledById parses :id as number and dispatches to get_scheduled', async () => {
    const res = mockRes();
    await handleGetScheduledById(
      mockReq({ method: 'POST', url: '/api/lines/alpha/scheduled/42' }),
      res,
      makeDeps(),
      { name: 'alpha', id: '42' },
    );
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'get_scheduled', { id: 42 }, undefined);
  });

  it('handleUpdateScheduled merges body with :id', async () => {
    const res = mockRes();
    await handleUpdateScheduled(
      mockReq({ method: 'POST', body: '{"text":"updated","scheduled_at":1767229200}', url: '/api/lines/alpha/scheduled/77' }),
      res,
      makeDeps(),
      { name: 'alpha', id: '77' },
    );
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'update_scheduled',
      { text: 'updated', scheduled_at: 1767229200, id: 77 },
      undefined,
    );
  });

  it('handleCancelScheduledById dispatches to cancel_scheduled with numeric id', async () => {
    const res = mockRes();
    await handleCancelScheduledById(
      mockReq({ method: 'POST', url: '/api/lines/alpha/scheduled/5' }),
      res,
      makeDeps(),
      { name: 'alpha', id: '5' },
    );
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'cancel_scheduled', { id: 5 }, undefined);
  });
});

describe('factory-generated group handlers', () => {
  it('handleGetGroups dispatches to list_groups with 15s timeout', async () => {
    const res = mockRes();
    await handleGetGroups(mockReq({ method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'list_groups', {}, 15_000);
  });

  it('handleGetGroupDetail decodes URI-encoded jid and applies 15s timeout', async () => {
    const res = mockRes();
    const encoded = encodeURIComponent('111111100000000001@g.us');
    await handleGetGroupDetail(
      mockReq({ method: 'POST', url: `/api/lines/alpha/groups/${encoded}` }),
      res,
      makeDeps(),
      { name: 'alpha', jid: encoded },
    );
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'get_group_metadata',
      { jid: '111111100000000001@g.us' },
      15_000,
    );
  });

  it('handleLeaveGroup decodes jid into id arg', async () => {
    const res = mockRes();
    const encoded = encodeURIComponent('111111100000000001@g.us');
    await handleLeaveGroup(
      mockReq({ method: 'POST', url: `/api/lines/alpha/groups/${encoded}` }),
      res,
      makeDeps(),
      { name: 'alpha', jid: encoded },
    );
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'group_leave',
      { id: '111111100000000001@g.us' },
      undefined,
    );
  });

  it('handleUpdateGroupSubject merges body + decoded jid', async () => {
    const res = mockRes();
    const encoded = encodeURIComponent('111111100000000001@g.us');
    await handleUpdateGroupSubject(
      mockReq({ method: 'POST', body: '{"subject":"New Topic"}', url: `/api/lines/alpha/groups/${encoded}/subject` }),
      res,
      makeDeps(),
      { name: 'alpha', jid: encoded },
    );
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'group_update_subject',
      { subject: 'New Topic', jid: '111111100000000001@g.us' },
      undefined,
    );
  });

  it('handleGetGroupInvite dispatches to get_group_invite_link', async () => {
    const res = mockRes();
    const encoded = encodeURIComponent('111111100000000001@g.us');
    await handleGetGroupInvite(
      mockReq({ method: 'POST', url: `/api/lines/alpha/groups/${encoded}/invite` }),
      res,
      makeDeps(),
      { name: 'alpha', jid: encoded },
    );
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'get_group_invite_link',
      { jid: '111111100000000001@g.us' },
      undefined,
    );
  });

  it('handleRevokeGroupInvite dispatches to group_revoke_invite', async () => {
    const res = mockRes();
    const encoded = encodeURIComponent('111111100000000001@g.us');
    await handleRevokeGroupInvite(
      mockReq({ method: 'POST', url: `/api/lines/alpha/groups/${encoded}/invite/revoke` }),
      res,
      makeDeps(),
      { name: 'alpha', jid: encoded },
    );
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'group_revoke_invite',
      { jid: '111111100000000001@g.us' },
      undefined,
    );
  });
});

describe('shared error paths via factory handlers', () => {
  it('returns 503 when MCP socket is missing', async () => {
    fs.unlinkSync(socketPath);
    const res = mockRes();
    await handleGetGroups(mockReq({ method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });
    expect(res._status).toBe(503);
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('returns 502 when MCP call resolves with success=false', async () => {
    vi.mocked(mcpCall).mockResolvedValueOnce({ success: false, error: 'tool exception' });
    const res = mockRes();
    await handleGetGroups(mockReq({ method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });
    expect(res._status).toBe(502);
    expect(JSON.parse(res._body)).toEqual({ error: 'tool exception' });
  });

  it('returns 502 with generic message when MCP error is absent', async () => {
    vi.mocked(mcpCall).mockResolvedValueOnce({ success: false });
    const res = mockRes();
    await handleGetGroups(mockReq({ method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });
    expect(JSON.parse(res._body)).toEqual({ error: 'MCP call failed' });
  });

  it('unwraps tool-result envelope content[0].text to parsed JSON', async () => {
    vi.mocked(mcpCall).mockResolvedValueOnce(happyMcpResult([{ jid: 'g@g.us', name: 'Group A' }]));
    const res = mockRes();
    await handleGetGroups(mockReq({ method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });
    expect(JSON.parse(res._body)).toEqual([{ jid: 'g@g.us', name: 'Group A' }]);
  });

  it('passes through non-JSON tool-result text as a string', async () => {
    vi.mocked(mcpCall).mockResolvedValueOnce({
      success: true,
      result: { content: [{ type: 'text', text: 'plain text' }] },
    });
    const res = mockRes();
    await handleGetGroups(mockReq({ method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });
    expect(JSON.parse(res._body)).toBe('plain text');
  });
});

describe('mcpWithBody - JSON parse error path', () => {
  it('returns 400 on malformed JSON body', async () => {
    const res = mockRes();
    await handleCreateScheduled(
      mockReq({ method: 'POST', body: '{not json', url: '/api/lines/alpha/scheduled' }),
      res,
      makeDeps(),
      { name: 'alpha' },
    );
    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'Invalid JSON body' });
    expect(mcpCall).not.toHaveBeenCalled();
  });
});
