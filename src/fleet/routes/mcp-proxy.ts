/**
 * MCP proxy routes — expose MCP tool capabilities via fleet HTTP API.
 *
 * These routes proxy tool calls through the instance's MCP Unix socket,
 * making agent/chat capabilities accessible from the console UI.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import { jsonResponse, requireInstance, parseQueryString } from '../../lib/http.ts';
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
