import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import type { ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ADMIN_REQUIRED_DENIAL } from '../../../src/mcp/registry.ts';
import {
  handleCreateGroup,
  handleSearchContacts,
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
  handleUpdateGroupDescription,
  handleGroupParticipants,
  handleGroupSettings,
  handleGetGroupInvite,
  handleRevokeGroupInvite,
  handleGroupEphemeral,
  handleGetGroupRequests,
} from '../../../src/fleet/routes/mcp-proxy.ts';
import type { McpProxyDeps } from '../../../src/fleet/routes/mcp-proxy.ts';
import { mcpCall } from '../../../src/fleet/mcp-client.ts';
import type { DiscoveredInstance, FleetDiscovery } from '../../../src/fleet/discovery.ts';

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

import { mockReq, mockRes } from '../../helpers/http-mocks.ts';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsoup-mcp-proxy-'));
  socketPath = path.join(tmpDir, 'whatsoup.sock');
  fs.writeFileSync(socketPath, '');
  vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '{"ok":true}' }] } });
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mcp proxy body handlers', () => {
  it('rejects null JSON bodies before calling MCP tools', async () => {
    const res = mockRes();
    await handleCreateGroup(mockReq({ body: 'null', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'JSON body must be an object' });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('rejects array JSON bodies before calling MCP tools', async () => {
    const res = mockRes();
    await handleCreateGroup(mockReq({ body: '[]', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'JSON body must be an object' });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('forwards object JSON bodies to MCP tools', async () => {
    const res = mockRes();
    await handleCreateGroup(mockReq({ body: '{"subject":"Ops","participants":[]}', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(201);
    expect(JSON.parse(res._body)).toEqual({ ok: true });
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'group_create', { subject: 'Ops', participants: [] }, undefined);
  });

  it('treats null contact search tool payloads as an empty contact list', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: 'null' }] } });
    const res = mockRes();

    await handleSearchContacts(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/contacts/search?q=ana' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ contacts: [] });
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'search_contacts', { query: 'ana' });
  });
});

describe('mcp-proxy.ts uncovered-branch coverage', () => {
  // ---- respondMcp core branches (success false -> 502) ----

  it('responds 502 when mcpCall reports transport failure (success=false)', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: false, error: 'socket closed' });
    const res = mockRes();

    await handleGetGroups(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(502);
    expect(JSON.parse(res._body)).toEqual({ error: 'socket closed' });
  });

  it('responds 502 with default error text when mcpCall success=false has no error field', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: false });
    const res = mockRes();

    await handleGetGroups(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(502);
    expect(JSON.parse(res._body)).toEqual({ error: 'MCP call failed' });
  });

  // ---- toolError branches: validation-shaped (422) vs internal (500) ----

  it('maps a validation-shaped tool error to 422', async () => {
    vi.mocked(mcpCall).mockResolvedValue({
      success: true,
      toolError: true,
      result: { content: [{ type: 'text', text: 'invalid parameters: subject is required' }] },
    });
    const res = mockRes();

    await handleGetGroups(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(422);
    const body = JSON.parse(res._body);
    expect(body.isError).toBe(true);
    expect(body.error).toContain('invalid parameters');
  });

  it('maps an internal-shaped tool error to 500 when result is a plain string', async () => {
    vi.mocked(mcpCall).mockResolvedValue({
      success: true,
      toolError: true,
      result: { content: [{ type: 'text', text: 'boom internal failure' }] },
    });
    const res = mockRes();

    await handleGetGroups(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(500);
    const body = JSON.parse(res._body);
    expect(body.isError).toBe(true);
    expect(body.error).toBe('boom internal failure');
  });

  it('maps an admin_required tool error to 403 (#2974)', async () => {
    vi.mocked(mcpCall).mockResolvedValue({
      success: true,
      toolError: true,
      result: { content: [{ type: 'text', text: ADMIN_REQUIRED_DENIAL('create_agent_job') }] },
    });
    const res = mockRes();

    await handleGetGroups(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(403);
    const body = JSON.parse(res._body);
    expect(body.isError).toBe(true);
    expect(body.error).toContain('admin_required');
  });

  // ---- socketCheck branches ----

  it('returns 503 when the instance socket path does not exist (mcpProxy)', async () => {
    fs.rmSync(socketPath, { force: true });
    const res = mockRes();

    await handleGetGroups(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(503);
    expect(JSON.parse(res._body).error).toContain('MCP socket not available');
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('returns 503 when the instance socket path is null (mcpWithBody)', async () => {
    const deps = makeDeps();
    (deps.discovery.getInstance as ReturnType<typeof vi.fn>).mockReturnValue({ ...makeInstance(), socketPath: null });
    const res = mockRes();

    await handleCreateGroup(mockReq({ body: '{}', method: 'POST', url: '/api/lines/alpha/groups' }), res, deps, { name: 'alpha' });

    expect(res._status).toBe(503);
    expect(JSON.parse(res._body).error).toContain('MCP socket not available');
  });

  // ---- instance-not-found (requireInstance returns null) ----

  it('returns 404 when the instance is not discovered', async () => {
    const deps = makeDeps();
    (deps.discovery.getInstance as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    const res = mockRes();

    await handleGetGroups(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups' }), res, deps, { name: 'alpha' });

    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toContain('not found');
    expect(mcpCall).not.toHaveBeenCalled();
  });

  // ---- unwrapMcpResult branches ----

  it('returns raw value when MCP result has no content envelope', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { ok: true, id: 42 } });
    const res = mockRes();

    await handleGetGroups(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ ok: true, id: 42 });
  });

  it('returns raw value when content array is empty', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [] } });
    const res = mockRes();

    await handleGetGroups(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ content: [] });
  });

  it('returns first content text verbatim when it is not valid JSON', async () => {
    vi.mocked(mcpCall).mockResolvedValue({
      success: true,
      result: { content: [{ type: 'text', text: 'not-json-text' }] },
    });
    const res = mockRes();

    await handleGetGroups(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toBe('not-json-text');
  });

  it('returns raw when first content item is not type=text', async () => {
    vi.mocked(mcpCall).mockResolvedValue({
      success: true,
      result: { content: [{ type: 'image', text: 'ignored' }] },
    });
    const res = mockRes();

    await handleGetGroups(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ content: [{ type: 'image', text: 'ignored' }] });
  });

  // ---- mcpProxy with buildArgs + decodeParam + successCode ----

  it('decodes jid path param and forwards args for handleGetGroupDetail', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '{"id":"g"}' }] } });
    const res = mockRes();

    await handleGetGroupDetail(
      mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups/1555XXXXXXX%40s.whatsapp.net' }),
      res,
      makeDeps(),
      { name: 'alpha', jid: '1555XXXXXXX%40s.whatsapp.net' },
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ id: 'g' });
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'get_group_metadata', { jid: '1555XXXXXXX@s.whatsapp.net' }, 15_000);
  });

  it('returns 400 for malformed percent-encoding in jid param', async () => {
    const res = mockRes();

    await handleGetGroupDetail(
      mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups/%E0%A4%A' }),
      res,
      makeDeps(),
      { name: 'alpha', jid: '%E0%A4%A' },
    );

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toContain('malformed percent-encoding');
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('forwards empty args when mcpProxy has no buildArgs (handleRevokeGroupInvite builds args)', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '"revoked"' }] } });
    const res = mockRes();

    await handleRevokeGroupInvite(
      mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups/1555XXXXXXX%40s.whatsapp.net/invite/revoke' }),
      res,
      makeDeps(),
      { name: 'alpha', jid: '1555XXXXXXX%40s.whatsapp.net' },
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toBe('revoked');
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'group_revoke_invite', { jid: '1555XXXXXXX@s.whatsapp.net' }, undefined);
  });

  it('uses {id: jid} arg shape for handleLeaveGroup', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '"ok"' }] } });
    const res = mockRes();

    await handleLeaveGroup(
      mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups/1555XXXXXXX%40s.whatsapp.net' }),
      res,
      makeDeps(),
      { name: 'alpha', jid: '1555XXXXXXX%40s.whatsapp.net' },
    );

    expect(res._status).toBe(200);
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'group_leave', { id: '1555XXXXXXX@s.whatsapp.net' }, undefined);
  });

  it('parses integer id from path for handleGetScheduledById', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '{"id":7}' }] } });
    const res = mockRes();

    await handleGetScheduledById(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/scheduled/7' }), res, makeDeps(), {
      name: 'alpha',
      id: '7',
    });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ id: 7 });
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'get_scheduled', { id: 7 }, undefined);
  });

  it('parses integer id from path for handleCancelScheduledById', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '"gone"' }] } });
    const res = mockRes();

    await handleCancelScheduledById(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/scheduled/9' }), res, makeDeps(), {
      name: 'alpha',
      id: '9',
    });

    expect(res._status).toBe(200);
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'cancel_scheduled', { id: 9 }, undefined);
  });

  // ---- mcpWithBody branches: invalid JSON, successCode, buildArgs ----

  it('returns 400 for invalid JSON body (mcpWithBody)', async () => {
    const res = mockRes();

    await handleCreateScheduled(mockReq({ body: '{not-json', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'Invalid JSON body' });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('forwards body and returns 201 via successCode for handleCreateScheduled', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '{"id":3}' }] } });
    const res = mockRes();

    await handleCreateScheduled(mockReq({ body: '{"to":"1555XXXXXXX@s.whatsapp.net","text":"hi"}', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), {
      name: 'alpha',
    });

    expect(res._status).toBe(201);
    expect(JSON.parse(res._body)).toEqual({ id: 3 });
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'schedule_message',
      { to: '1555XXXXXXX@s.whatsapp.net', text: 'hi' },
      undefined,
    );
  });

  it('merges body with path id for handleUpdateScheduled', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '{"id":2}' }] } });
    const res = mockRes();

    await handleUpdateScheduled(mockReq({ body: '{"text":"updated"}', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha', id: '2' });

    expect(res._status).toBe(200);
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'update_scheduled', { text: 'updated', id: 2 }, undefined);
  });

  it('merges body with decoded jid for handleUpdateGroupSubject', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '"ok"' }] } });
    const res = mockRes();

    await handleUpdateGroupSubject(
      mockReq({ body: '{"subject":"New"}', method: 'POST', url: '/api/lines/alpha/groups' }),
      res,
      makeDeps(),
      { name: 'alpha', jid: '1555XXXXXXX%40s.whatsapp.net' },
    );

    expect(res._status).toBe(200);
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'group_update_subject',
      { subject: 'New', jid: '1555XXXXXXX@s.whatsapp.net' },
      undefined,
    );
  });

  it('merges body with decoded jid for handleGroupParticipants', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '"ok"' }] } });
    const res = mockRes();

    await handleGroupParticipants(
      mockReq({ body: '{"action":"add","participants":[]}', method: 'POST', url: '/api/lines/alpha/groups' }),
      res,
      makeDeps(),
      { name: 'alpha', jid: '1555XXXXXXX%40s.whatsapp.net' },
    );

    expect(res._status).toBe(200);
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'group_participants_update',
      { action: 'add', participants: [], jid: '1555XXXXXXX@s.whatsapp.net' },
      undefined,
    );
  });

  it('forwards to group_settings_update via handleGroupSettings', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '"ok"' }] } });
    const res = mockRes();

    await handleGroupSettings(mockReq({ body: '{"announcement":true}', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), {
      name: 'alpha',
      jid: '1555XXXXXXX%40s.whatsapp.net',
    });

    expect(res._status).toBe(200);
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'group_settings_update',
      { announcement: true, jid: '1555XXXXXXX@s.whatsapp.net' },
      undefined,
    );
  });

  it('forwards to group_update_description via handleUpdateGroupDescription', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '"ok"' }] } });
    const res = mockRes();

    await handleUpdateGroupDescription(mockReq({ body: '{"description":"d"}', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), {
      name: 'alpha',
      jid: '1555XXXXXXX%40s.whatsapp.net',
    });

    expect(res._status).toBe(200);
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'group_update_description',
      { description: 'd', jid: '1555XXXXXXX@s.whatsapp.net' },
      undefined,
    );
  });

  it('forwards to group_toggle_ephemeral via handleGroupEphemeral', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '"ok"' }] } });
    const res = mockRes();

    await handleGroupEphemeral(mockReq({ body: '{"enabled":true}', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), {
      name: 'alpha',
      jid: '1555XXXXXXX%40s.whatsapp.net',
    });

    expect(res._status).toBe(200);
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'group_toggle_ephemeral',
      { enabled: true, jid: '1555XXXXXXX@s.whatsapp.net' },
      undefined,
    );
  });

  it('forwards to group_request_participants_list via handleGetGroupRequests', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '[]' }] } });
    const res = mockRes();

    await handleGetGroupRequests(
      mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups/1555XXXXXXX%40s.whatsapp.net/requests' }),
      res,
      makeDeps(),
      { name: 'alpha', jid: '1555XXXXXXX%40s.whatsapp.net' },
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([]);
    expect(mcpCall).toHaveBeenCalledWith(
      socketPath,
      'group_request_participants_list',
      { jid: '1555XXXXXXX@s.whatsapp.net' },
      undefined,
    );
  });

  it('forwards to get_group_invite_link via handleGetGroupInvite', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '"https://inv"' }] } });
    const res = mockRes();

    await handleGetGroupInvite(
      mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups/1555XXXXXXX%40s.whatsapp.net/invite' }),
      res,
      makeDeps(),
      { name: 'alpha', jid: '1555XXXXXXX%40s.whatsapp.net' },
    );

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toBe('https://inv');
  });

  // ---- handleGetScheduled: query string + success path ----

  it('list_scheduled forwards optional status filter and unwraps result', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '[{"id":1}]' }] } });
    const res = mockRes();

    await handleGetScheduled(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/scheduled?status=sent' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual([{ id: 1 }]);
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'list_scheduled', { status: 'sent' });
  });

  it('list_scheduled forwards empty args when no status query', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '[]' }] } });
    const res = mockRes();

    await handleGetScheduled(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/scheduled' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'list_scheduled', {});
  });

  it('list_scheduled returns 503 when socket missing', async () => {
    fs.rmSync(socketPath, { force: true });
    const res = mockRes();

    await handleGetScheduled(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/scheduled' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(503);
    expect(mcpCall).not.toHaveBeenCalled();
  });

  // ---- handleCancelScheduled (legacy): query-param validation ----

  it('returns 400 when id query param is missing (legacy cancel route)', async () => {
    const res = mockRes();

    await handleCancelScheduled(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/scheduled' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'id query parameter is required' });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('returns 400 when id query param is not a positive integer (legacy cancel route)', async () => {
    const res = mockRes();

    await handleCancelScheduled(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/scheduled?id=abc' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'id query parameter must be a positive integer' });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('returns 400 when id query param is zero (legacy cancel route)', async () => {
    const res = mockRes();

    await handleCancelScheduled(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/scheduled?id=0' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'id query parameter must be a positive integer' });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('returns 503 when socket missing but id is valid (legacy cancel route)', async () => {
    fs.rmSync(socketPath, { force: true });
    const res = mockRes();

    await handleCancelScheduled(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/scheduled?id=5' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(503);
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('fabricates cancelled envelope on success (legacy cancel route)', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '"ok"' }] } });
    const res = mockRes();

    await handleCancelScheduled(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/scheduled?id=8' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ cancelled: true, id: 8 });
    expect(mcpCall).toHaveBeenCalledWith(socketPath, 'cancel_scheduled', { id: 8 });
  });

  // ---- handleSearchContacts branches ----

  it('returns 400 when q query param is missing', async () => {
    const res = mockRes();

    await handleSearchContacts(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/contacts/search' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ error: 'q query parameter is required' });
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('returns 503 when socket missing but q is present', async () => {
    fs.rmSync(socketPath, { force: true });
    const res = mockRes();

    await handleSearchContacts(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/contacts/search?q=a' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(503);
    expect(mcpCall).not.toHaveBeenCalled();
  });

  it('normalizes a results array into {contacts}', async () => {
    vi.mocked(mcpCall).mockResolvedValue({
      success: true,
      result: { content: [{ type: 'text', text: '{"results":[{"name":"Ana"}],"total":1}' }] },
    });
    const res = mockRes();

    await handleSearchContacts(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/contacts/search?q=ana' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ contacts: [{ name: 'Ana' }] });
  });

  it('falls back to unwrapped.contacts when no results key', async () => {
    vi.mocked(mcpCall).mockResolvedValue({
      success: true,
      result: { content: [{ type: 'text', text: '{"contacts":[{"name":"Bo"}]}' }] },
    });
    const res = mockRes();

    await handleSearchContacts(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/contacts/search?q=bo' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ contacts: [{ name: 'Bo' }] });
  });

  it('coerces non-array unwrapped to empty contacts list', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: '{"foo":"bar"}' }] } });
    const res = mockRes();

    await handleSearchContacts(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/contacts/search?q=z' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ contacts: [] });
  });

  it('coerces non-object unwrapped (raw string) to empty contacts list', async () => {
    vi.mocked(mcpCall).mockResolvedValue({ success: true, result: { content: [{ type: 'text', text: 'just-text' }] } });
    const res = mockRes();

    await handleSearchContacts(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/contacts/search?q=t' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ contacts: [] });
  });

  // ---- toolError branch with non-record result envelope ----

  it('handles toolError when result is a primitive string (non-record envelope)', async () => {
    vi.mocked(mcpCall).mockResolvedValue({
      success: true,
      toolError: true,
      result: 'unknown tool: foo',
    });
    const res = mockRes();

    await handleGetGroups(mockReq({ body: '', method: 'POST', url: '/api/lines/alpha/groups' }), res, makeDeps(), { name: 'alpha' });

    expect(res._status).toBe(422);
    const body = JSON.parse(res._body);
    expect(body.error).toBe('unknown tool: foo');
    expect(body.isError).toBe(true);
  });
});
