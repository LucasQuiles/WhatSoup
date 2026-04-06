/**
 * MCP proxy routes — expose MCP tool capabilities via fleet HTTP API.
 *
 * These routes proxy tool calls through the instance's MCP Unix socket,
 * making agent/chat capabilities accessible from the console UI.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import { jsonResponse, requireInstance, parseQueryString, readBody } from '../../lib/http.ts';
import { mcpCall } from '../mcp-client.ts';
import type { FleetDiscovery } from '../discovery.ts';

export interface McpProxyDeps {
  discovery: FleetDiscovery;
}

// ---------------------------------------------------------------------------
// Scheduled messages
// ---------------------------------------------------------------------------

/** GET /api/lines/:name/scheduled — list scheduled messages for an instance. */
export async function handleGetScheduled(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const result = await mcpCall(instance.socketPath, 'list_scheduled', {});
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** POST /api/lines/:name/scheduled — create a new scheduled message. */
export async function handleCreateScheduled(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }

  const result = await mcpCall(instance.socketPath, 'schedule_message', parsed);
  if (result.success) {
    jsonResponse(res, 201, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** GET /api/lines/:name/scheduled/:id — get a single scheduled message by ID. */
export async function handleGetScheduledById(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; id: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const result = await mcpCall(instance.socketPath, 'get_scheduled', { id: parseInt(params.id, 10) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** PUT /api/lines/:name/scheduled/:id — update a scheduled message. */
export async function handleUpdateScheduled(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; id: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }

  const result = await mcpCall(instance.socketPath, 'update_scheduled', { ...parsed, id: parseInt(params.id, 10) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** DELETE /api/lines/:name/scheduled/:id — cancel a scheduled message by path ID. */
export async function handleCancelScheduledById(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; id: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const result = await mcpCall(instance.socketPath, 'cancel_scheduled', { id: parseInt(params.id, 10) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** DELETE /api/lines/:name/scheduled/:id — cancel a scheduled message. */
export async function handleCancelScheduled(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const qs = parseQueryString(req.url);
  const messageId = qs.id;
  if (!messageId) {
    jsonResponse(res, 400, { error: 'id query parameter is required' });
    return;
  }

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const result = await mcpCall(instance.socketPath, 'cancel_scheduled', { messageId });
  if (result.success) {
    jsonResponse(res, 200, { cancelled: true, messageId });
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/** GET /api/lines/:name/groups — list WhatsApp groups for an instance. */
export async function handleGetGroups(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const result = await mcpCall(instance.socketPath, 'list_groups', {}, 15_000);
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

// ---------------------------------------------------------------------------
// Group management
// ---------------------------------------------------------------------------

/** GET /api/lines/:name/groups/:jid — get group metadata. */
export async function handleGetGroupDetail(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const result = await mcpCall(instance.socketPath, 'get_group_metadata', { jid: decodeURIComponent(params.jid) }, 15_000);
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** POST /api/lines/:name/groups — create a new group. */
export async function handleCreateGroup(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }

  const result = await mcpCall(instance.socketPath, 'group_create', parsed);
  if (result.success) {
    jsonResponse(res, 201, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** DELETE /api/lines/:name/groups/:jid — leave a group. */
export async function handleLeaveGroup(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const result = await mcpCall(instance.socketPath, 'group_leave', { id: decodeURIComponent(params.jid) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** PUT /api/lines/:name/groups/:jid/subject — update group subject. */
export async function handleUpdateGroupSubject(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }

  const result = await mcpCall(instance.socketPath, 'group_update_subject', { ...parsed, jid: decodeURIComponent(params.jid) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** PUT /api/lines/:name/groups/:jid/description — update group description. */
export async function handleUpdateGroupDescription(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }

  const result = await mcpCall(instance.socketPath, 'group_update_description', { ...parsed, jid: decodeURIComponent(params.jid) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** POST /api/lines/:name/groups/:jid/participants — add/remove/promote/demote participants. */
export async function handleGroupParticipants(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }

  const result = await mcpCall(instance.socketPath, 'group_participants_update', { ...parsed, jid: decodeURIComponent(params.jid) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** PUT /api/lines/:name/groups/:jid/settings — update group settings (announcement/locked). */
export async function handleGroupSettings(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }

  const result = await mcpCall(instance.socketPath, 'group_settings_update', { ...parsed, jid: decodeURIComponent(params.jid) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** GET /api/lines/:name/groups/:jid/invite — get group invite link. */
export async function handleGetGroupInvite(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const result = await mcpCall(instance.socketPath, 'get_group_invite_link', { jid: decodeURIComponent(params.jid) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** POST /api/lines/:name/groups/:jid/invite/revoke — revoke group invite link. */
export async function handleRevokeGroupInvite(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const result = await mcpCall(instance.socketPath, 'group_revoke_invite', { jid: decodeURIComponent(params.jid) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** PUT /api/lines/:name/groups/:jid/ephemeral — toggle ephemeral messages. */
export async function handleGroupEphemeral(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }

  const result = await mcpCall(instance.socketPath, 'group_toggle_ephemeral', { ...parsed, jid: decodeURIComponent(params.jid) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** PUT /api/lines/:name/groups/:jid/member-add-mode — set who can add members. */
export async function handleGroupMemberAddMode(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }

  const result = await mcpCall(instance.socketPath, 'group_member_add_mode', { ...parsed, jid: decodeURIComponent(params.jid) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** PUT /api/lines/:name/groups/:jid/join-approval — set join approval mode. */
export async function handleGroupJoinApproval(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }

  const result = await mcpCall(instance.socketPath, 'group_join_approval_mode', { ...parsed, jid: decodeURIComponent(params.jid) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** GET /api/lines/:name/groups/:jid/requests — list pending join requests. */
export async function handleGetGroupRequests(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const result = await mcpCall(instance.socketPath, 'group_request_participants_list', { jid: decodeURIComponent(params.jid) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

/** POST /api/lines/:name/groups/:jid/requests — approve/reject join requests. */
export async function handleGroupRequestsUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string; jid: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(body); } catch { jsonResponse(res, 400, { error: 'Invalid JSON body' }); return; }

  const result = await mcpCall(instance.socketPath, 'group_request_participants_update', { ...parsed, jid: decodeURIComponent(params.jid) });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}

// ---------------------------------------------------------------------------
// Contact search
// ---------------------------------------------------------------------------

/** POST /api/lines/:name/contacts/search — search contacts via MCP. */
export async function handleSearchContacts(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpProxyDeps,
  params: { name: string },
): Promise<void> {
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const qs = parseQueryString(req.url);
  const query = qs.q;
  if (!query) {
    jsonResponse(res, 400, { error: 'q query parameter is required' });
    return;
  }

  if (!instance.socketPath || !fs.existsSync(instance.socketPath)) {
    jsonResponse(res, 503, { error: 'MCP socket not available — instance must be running' });
    return;
  }

  const result = await mcpCall(instance.socketPath, 'search_contacts', { query });
  if (result.success) {
    jsonResponse(res, 200, result.result);
  } else {
    jsonResponse(res, 502, { error: result.error ?? 'MCP call failed' });
  }
}
