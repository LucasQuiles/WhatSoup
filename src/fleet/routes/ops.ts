import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import { readBody, jsonResponse, requireInstance } from '../../lib/http.ts';
import { isNonEmptyString } from '../../lib/type-guards.ts';
import { mcpCall } from '../mcp-client.ts';
import { respondMcp } from './mcp-proxy.ts';
import { proxyToInstance } from '../http-proxy.ts';
import type { FleetDiscovery } from '../discovery.ts';
import { isGroupConversationKey, conversationKeyToJid } from '../../core/conversation-key.ts';
import { toPersonalJid } from '../../core/jid-constants.ts';
import type { FleetRealtimePublisher } from '../realtime-publisher.ts';
import { publishMessageReceived, publishChatUpdated, publishAccessChanged, publishFeedEvent } from '../realtime-publisher.ts';
import type { ServiceManager } from '../platform.ts';
import { validateInstanceName } from './instance-name.ts';

export interface OpsDeps {
  discovery: FleetDiscovery;
  realtime: FleetRealtimePublisher;
  serviceManager: ServiceManager;
}

/** POST /api/lines/:name/send — route a message to the instance. */
export async function handleSend(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  if (!validateInstanceName(params.name, res)) return;
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const body = await readBody(req);

  // Validate target shape + normalize JID in request body.
  // chatJid xor to: callers must commit to exactly one. Both -> 400; neither -> 400.
  //
  // Architectural note (docs/tools.md#send_message and src/core/send-pipeline.ts):
  // We do NOT add a `chatResolver` field to OpsDeps. Aliases live in per-instance
  // DBs and the fleet has no per-instance DB connection. Fleet-side alias
  // resolution would require Map<line, ChatResolver> + new infrastructure for
  // fleet-side instance DB connections. Instead, the fleet validates xor and
  // forwards the body verbatim; the per-instance MCP `send_message` tool
  // resolves the alias against its own DB. Defense in depth: fleet xor protects
  // HTTP callers; MCP xor protects direct-MCP callers. Instance returns its own
  // error (propagated as 502) when an alias is unknown.
  let fixedBody = body;
  try {
    const parsed = JSON.parse(body);

    // Reject non-object payloads explicitly. Without this guard, a body of `null`
    // throws TypeError on property access; the catch below would report it as
    // "invalid JSON body", masking the real problem (valid JSON that parses to
    // `null`, not malformed JSON) behind the wrong error message. Arrays and
    // primitives currently land at the "neither" branch by accident; explicit
    // type-shape rejection makes the boundary deliberate.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      jsonResponse(res, 400, {
        error: 'request body must be a JSON object with chatJid (raw JID) or to (alias)',
      });
      return;
    }

    // Trim before length check: whitespace-only values count as not-provided
    // (matches resolver semantics in src/core/chats-resolver.ts and prevents
    // forwarding `'   '` to the instance via JID normalization).
    const hasChatJid = isNonEmptyString(parsed.chatJid);
    const hasTo = isNonEmptyString(parsed.to);

    if (hasChatJid && hasTo) {
      jsonResponse(res, 400, {
        error: 'chatJid and to are mutually exclusive; provide exactly one',
      });
      return;
    }
    if (!hasChatJid && !hasTo) {
      jsonResponse(res, 400, {
        error: 'request body must contain chatJid (raw JID) or to (alias)',
      });
      return;
    }

    if (parsed.profile !== undefined && !isNonEmptyString(parsed.profile)) {
      jsonResponse(res, 400, { error: 'profile must be a non-empty string' });
      return;
    }

    if (hasChatJid && !parsed.chatJid.includes('@')) {
      parsed.chatJid = isGroupConversationKey(parsed.chatJid)
        ? conversationKeyToJid(parsed.chatJid)
        : toPersonalJid(parsed.chatJid);
      fixedBody = JSON.stringify(parsed);
    }
  } catch {
    jsonResponse(res, 400, { error: 'invalid JSON body' });
    return;
  }

  // Route 1: Try MCP socket (passive instances with verified socket)
  if (instance.type === 'passive' && instance.socketPath) {
    try {
      const socketStat = fs.existsSync(instance.socketPath!);
      if (socketStat) {
        const parsed = JSON.parse(fixedBody);
        const result = await mcpCall(instance.socketPath, 'send_message', parsed);
        // Publish realtime events only on a fully clean tool envelope —
        // transport failure (`success: false`) and tool-level error
        // (`toolError: true`) must NOT fan out a "message received" signal.
        if (result.success && !result.toolError) {
          publishMessageReceived(deps.realtime, params.name);
          publishChatUpdated(deps.realtime, params.name);
          publishFeedEvent(deps.realtime, params.name);
        }
        // Route through `respondMcp` so `isError: true` envelopes map to
        // 4xx/5xx like the dedicated MCP proxy routes (issue #257 parity).
        respondMcp(res, result, 200);
        return;
      }
    } catch { /* fall through to HTTP */ }
  }

  // Route 2: HTTP health server /send (works for ALL instance types)
  // This is the universal fallback — every instance has a health port
  if (instance.healthPort) {
    const result = await proxyToInstance(
      instance.healthPort, '/send', 'POST', fixedBody, instance.healthToken,
    );
    if (result.status >= 200 && result.status < 300) {
      publishMessageReceived(deps.realtime, params.name);
      publishChatUpdated(deps.realtime, params.name);
      publishFeedEvent(deps.realtime, params.name);
    }
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    res.end(result.body);
    return;
  }

  jsonResponse(res, 422, {
    error: `no send route available for instance '${params.name}' (type=${instance.type})`,
  });
}

/** POST /api/lines/:name/access — proxy access update to instance. */
export async function handleAccessUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  if (!validateInstanceName(params.name, res)) return;
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const body = await readBody(req);

  // Validate body shape before proxying to instance
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    jsonResponse(res, 400, { error: 'invalid JSON body' });
    return;
  }
  const { subjectType, subjectId, action } = parsed;
  if ((subjectType !== 'phone' && subjectType !== 'group') ||
      typeof subjectId !== 'string' || !subjectId ||
      (action !== 'allow' && action !== 'block')) {
    jsonResponse(res, 400, { error: 'body must include subjectType (phone|group), subjectId (string), action (allow|block)' });
    return;
  }

  const result = await proxyToInstance(
    instance.healthPort, '/access', 'POST', body, instance.healthToken,
  );
  if (result.status >= 200 && result.status < 300) {
    publishAccessChanged(deps.realtime, params.name);
    publishFeedEvent(deps.realtime, params.name);
  }
  res.writeHead(result.status, { 'Content-Type': 'application/json' });
  res.end(result.body);
}

/** POST /api/lines/:name/mark-read — proxy mark-read to instance health server. */
export async function handleMarkRead(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  if (!validateInstanceName(params.name, res)) return;
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const body = await readBody(req);

  const result = await proxyToInstance(instance.healthPort, '/mark-read', 'POST', body, instance.healthToken);

  if (result.status >= 200 && result.status < 300) {
    publishChatUpdated(deps.realtime, params.name);
    publishFeedEvent(deps.realtime, params.name);
  }

  res.writeHead(result.status, { 'Content-Type': 'application/json' });
  res.end(result.body);
}

/** POST /api/lines/:name/contacts — save a contact via MCP add_or_edit_contact tool. */
export async function handleSaveContact(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  if (!validateInstanceName(params.name, res)) return;
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    jsonResponse(res, 400, { error: 'invalid JSON body' });
    return;
  }

  const { jid, firstName, lastName, company, phone } = parsed;
  if (typeof jid !== 'string' || !jid) {
    jsonResponse(res, 400, { error: 'jid is required' });
    return;
  }

  const contactParams: Record<string, string> = { jid };
  if (typeof firstName === 'string') contactParams.firstName = firstName;
  if (typeof lastName === 'string') contactParams.lastName = lastName;
  if (typeof company === 'string') contactParams.company = company;
  if (typeof phone === 'string') contactParams.phone = phone;

  // Try MCP socket first (passive instances with verified socket)
  if (instance.socketPath && fs.existsSync(instance.socketPath)) {
    try {
      const result = await mcpCall(instance.socketPath, 'add_or_edit_contact', contactParams);
      // Route through `respondMcp` so `isError: true` envelopes map to
      // 4xx/5xx like the dedicated MCP proxy routes (issue #257 parity).
      respondMcp(res, result, 200);
      return;
    } catch { /* fall through to HTTP proxy */ }
  }

  // Fallback: proxy to instance health port /send endpoint isn't right for contacts.
  // Contact management requires MCP — if socket unavailable, report error.
  jsonResponse(res, 503, { error: 'MCP socket not available — contact management requires a running instance with MCP' });
}

// handleAuth + its module-level auth-session state (activeAuthProcesses,
// authInFlight) extracted to ./ops-auth.ts (#2239). Re-exported here as a
// migration shim so existing callers and tests are unchanged; follow-up
// slices update imports to point at ops-auth.ts directly.
export { handleAuth } from './ops-auth.ts';

// handleConfigUpdate (PATCH /api/lines/:name/config, including the
// enabledPlugins write to both config.json and the agent's settings.json) and
// its validation helpers extracted to ./ops-config.ts (#2239). Re-exported here
// as a migration shim so existing callers and tests are unchanged.
export { handleConfigUpdate } from './ops-config.ts';

// Service-lifecycle handlers (restart, stop, delete, create) extracted to
// ./ops-lifecycle.ts (#2239). Re-exported here as a migration shim so existing
// callers and tests are unchanged.
export { handleRestart, handleStop, handleDeleteLine, handleCreateLine } from './ops-lifecycle.ts';
