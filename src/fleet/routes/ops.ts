import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readBody, jsonResponse, requireInstance } from '../../lib/http.ts';
import { escapeRegExp } from '../../lib/regex-utils.ts';
import { isNonEmptyString } from '../../lib/type-guards.ts';
import { createChildLogger } from '../../logger.ts';
const log = createChildLogger('fleet:ops');
import { mcpCall } from '../mcp-client.ts';
import { respondMcp } from './mcp-proxy.ts';
import { proxyToInstance } from '../http-proxy.ts';
import type { FleetDiscovery } from '../discovery.ts';
import { configRoot, dataRoot, stateRoot } from '../paths.ts';
import { writePermissionsSettings } from '../../core/workspace.ts';
import { mergeSettingsJson } from '../../core/settings-template.ts';
import type { PermissionsSettings } from '../../core/settings-template.ts';
import { VALID_TYPES, VALID_ACCESS_MODES, VALID_SESSION_SCOPES } from '../../instance-loader.ts';
import { validateInstanceConfig } from '../../core/agent-config-validator.ts';
import { isGroupConversationKey, conversationKeyToJid } from '../../core/conversation-key.ts';
import { toPersonalJid } from '../../core/jid-constants.ts';
import type { FleetRealtimePublisher } from '../realtime-publisher.ts';
import { publishInstanceStatus, publishMessageReceived, publishChatUpdated, publishAccessChanged, publishFeedEvent } from '../realtime-publisher.ts';
import { systemdUnitName, type ServiceManager } from '../platform.ts';
import { lookupCredential } from '../../lib/keyring.ts';
import { migrateLegacyMemoryConfig } from '../../config-memory-migration.ts';
import { stripPlaintextProviderKeys } from '../../lib/config-plaintext-keys.ts';
import { privateWriteError, writePrivateFileSync } from '../../lib/private-fs.ts';
import { errorMessage } from '../../lib/error-message.ts';
import { projectError, validationError, mutationError } from '../response-error-projection.ts';
import { NAME_MAX_LENGTH, NAME_RE, validateInstanceName } from './instance-name.ts';
import { writeInitialDatabaseCreateMarker } from '../../core/initial-database-marker.ts';
import {
  defaultAgentOptions,
  emitInventoryFailure,
  ensureHomeConfinedDirectory,
  normalizeAdminPhones,
  resolveAndValidateAgentCwd,
  scanHealthPortInventory,
  validatePluginDirs,
  validateServiceHomeConfinement,
} from './ops-config.ts';

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

/** Shared service action handler for restart/stop. */
async function handleServiceAction(
  verb: 'restart' | 'stop',
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  if (!validateInstanceName(params.name, res)) return;
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  try {
    if (verb === 'restart') {
      await deps.serviceManager.restart(params.name);
    } else {
      await deps.serviceManager.stop(params.name);
    }
    publishInstanceStatus(deps.realtime, params.name);
    publishFeedEvent(deps.realtime, params.name);
    jsonResponse(res, 202, { status: `${verb}_requested`, instance: params.name });
  } catch (err) {
    jsonResponse(res, 500, projectError(err, { operation: 'service_action', stage: 'execute' }));
  }
}

function serviceErrorMessage(err: unknown): string {
  return errorMessage(err);
}

function serviceErrorExitCode(err: unknown): number | string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? (err as { code?: number | string }).code
    : undefined;
}

function isBenignServiceTeardownError(err: unknown, name: string): boolean {
  const message = serviceErrorMessage(err);
  if (/\bcommand\s+not\s+found\b/iu.test(message)) return false;

  const systemdUnit = escapeRegExp(systemdUnitName(name));
  const systemdAbsent = new RegExp(
    String.raw`\b(?:unit|unit file|service)\s+${systemdUnit}\b[^\n]*(?:not\s+(?:found|loaded|running|active|installed)|could\s+not\s+be\s+found|does\s+not\s+exist|already\s+(?:stopped|disabled|inactive|removed))\b`,
    'iu',
  );
  if (systemdAbsent.test(message)) return true;

  const launchdLabel = escapeRegExp(`com.whatsoup.${name}`);
  const launchdStopCommand = new RegExp(
    String.raw`\blaunchctl\s+stop\s+${launchdLabel}\b`,
    'iu',
  );
  return serviceErrorExitCode(err) === 3 && launchdStopCommand.test(message);
}

/** POST /api/lines/:name/restart — restart the service. */
export async function handleRestart(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  return handleServiceAction('restart', res, deps, params);
}

/** POST /api/lines/:name/stop — stop the service. */
export async function handleStop(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  return handleServiceAction('stop', res, deps, params);
}

/** DELETE /api/lines/:name — tear down and remove an instance completely.
 *  Idempotent: returns 200 even if the instance was already deleted. */
export async function handleDeleteLine(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  if (!validateInstanceName(params.name, res)) return;

  // 1. Stop the service. Only service-absence errors are idempotent; other
  // failures may leave the instance running, so state must not be deleted.
  try {
    await deps.serviceManager.stop(params.name);
  } catch (err) {
    if (!isBenignServiceTeardownError(err, params.name)) {
      log.error({ err, instance: params.name }, 'delete line: service stop failed');
      jsonResponse(res, 500, {
        error: `stop failed: ${serviceErrorMessage(err)}`,
        instance: params.name,
      });
      return;
    }
    log.warn({ err, instance: params.name }, 'delete line: service already stopped or absent');
  }

  // 2. Disable the service. As above, unknown disable failures block deletion.
  try {
    await deps.serviceManager.disable(params.name);
  } catch (err) {
    if (!isBenignServiceTeardownError(err, params.name)) {
      log.error({ err, instance: params.name }, 'delete line: service disable failed');
      jsonResponse(res, 500, {
        error: `disable failed: ${serviceErrorMessage(err)}`,
        instance: params.name,
      });
      return;
    }
    log.warn({ err, instance: params.name }, 'delete line: service already disabled or absent');
  }

  // 3. Remove config, data, and state directories
  cleanupPartial(params.name);

  // 4. Re-scan discovery so the instance disappears from the UI
  deps.discovery.scan();

  publishInstanceStatus(deps.realtime, params.name);
  publishFeedEvent(deps.realtime, params.name);
  jsonResponse(res, 200, { deleted: params.name });
}

/**
 * Record of a file written during create that may need to be rolled back.
 * For files that pre-existed in user-supplied cwds (e.g. CLAUDE.md / settings.json
 * inside an existing project's `.claude/`), we capture the prior contents and
 * restore them on rollback rather than deleting user data. Files we created
 * fresh are removed.
 */
interface ExtraRecord {
  path: string;
  existed: boolean;
  priorContents?: Buffer;
  priorMode?: number;
}

function snapshotExtra(filePath: string): ExtraRecord {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      throw privateWriteError('refusing to snapshot private file through symlink', 'ELOOP');
    }
    if (!stat.isFile()) {
      throw privateWriteError('refusing to snapshot non-regular private file', 'EINVAL');
    }
    return {
      path: filePath,
      existed: true,
      priorContents: fs.readFileSync(filePath),
      priorMode: stat.mode & 0o7777,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return { path: filePath, existed: false };
  }
}

/** Remove directories/files created during a partial instance creation. */
function cleanupPartial(name: string, extras?: ExtraRecord[]): void {
  const dirs = [
    path.join(configRoot(), name),
    path.join(dataRoot(name)),
    path.join(stateRoot(name)),
  ];
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (extras) {
    for (const e of extras) {
      try {
        if (e.existed && e.priorContents !== undefined) {
          writePrivateFileSync(e.path, e.priorContents, { mode: e.priorMode ?? 0o600 });
        } else if (!e.existed) {
          // File did not exist before create — remove the one we wrote.
          // Never recursive: extras are files, not directories.
          fs.rmSync(e.path, { force: true });
        }
      } catch { /* swallow — cleanup must never throw */ }
    }
  }
}

// ---------------------------------------------------------------------------
// POST /api/lines — create a new instance
// ---------------------------------------------------------------------------

/** POST /api/lines — create a new WhatSoup instance. */
export async function handleCreateLine(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
): Promise<void> {
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('body must be a JSON object');
    }
  } catch (err) {
    jsonResponse(res, 400, validationError('invalid_json', 'instance_create'));
    return;
  }

  // --- Validate name ---
  const name = body.name;
  if (
    typeof name !== 'string'
    || !NAME_RE.test(name)
    || name.length < 2
    || name.length > NAME_MAX_LENGTH
  ) {
    jsonResponse(res, 400, { error: 'name must be 2-30 lowercase alphanumeric/hyphens, starting with a letter' });
    return;
  }

  // --- Uniqueness check ---
  const configDir = path.join(configRoot(), name);
  if (deps.discovery.getInstance(name) != null || fs.existsSync(configDir)) {
    jsonResponse(res, 409, { error: `instance '${name}' already exists` });
    return;
  }

  // --- Validate type ---
  const type = body.type as string;
  if (!VALID_TYPES.has(type)) {
    jsonResponse(res, 400, { error: `type must be one of: passive, chat, agent` });
    return;
  }

  // --- Validate & deduplicate adminPhones ---
  let adminPhones = body.adminPhones;
  if (!Array.isArray(adminPhones) || adminPhones.length === 0 ||
      adminPhones.some((p: unknown) => typeof p !== 'string' || p === '')) {
    jsonResponse(res, 400, { error: 'adminPhones must be a non-empty array of non-empty strings' });
    return;
  }
  adminPhones = normalizeAdminPhones(adminPhones as string[]);

  // --- Type-specific validation ---
  // systemPrompt and agentOptions are deferred — validated at instance start by instance-loader.
  // At create time they may not be set yet (wizard sends them via PATCH after QR link).
  // Only block passive instances from having a systemPrompt (hard constraint).
  if (type === 'passive' && body.systemPrompt) {
    jsonResponse(res, 400, { error: 'passive instances must not have a systemPrompt' });
    return;
  }

  // --- Auto-assign healthPort ---
  let healthPort = typeof body.healthPort === 'number' ? body.healthPort as number : null;
  if (healthPort != null && (healthPort < 1024 || healthPort > 65535)) {
    jsonResponse(res, 400, { error: 'healthPort must be between 1024 and 65535' });
    return;
  }
  const portInventory = scanHealthPortInventory();
  if (!portInventory.ok) {
    emitInventoryFailure(res, portInventory);
    return;
  }
  if (healthPort == null) {
    const used = [...portInventory.ports.values()];
    healthPort = used.length > 0 ? Math.max(...used) + 1 : 9095;
  } else {
    // Validate user-supplied port isn't already in use
    const used = [...portInventory.ports.values()];
    if (used.includes(healthPort)) {
      jsonResponse(res, 409, { error: `healthPort ${healthPort} is already in use` });
      return;
    }
  }

  // --- Validate accessMode ---
  const accessMode = type === 'passive' ? 'self_only' : (body.accessMode ?? 'self_only') as string;
  if (!VALID_ACCESS_MODES.has(accessMode)) {
    jsonResponse(res, 400, { error: 'accessMode must be one of: self_only, allowlist, open_dm, groups_only' });
    return;
  }

  // --- Validate agent-specific options (only if provided — may come via PATCH later) ---
  if (type === 'agent') {
    if (body.agentOptions == null) {
      body.agentOptions = defaultAgentOptions(name);
    }
    const ao = body.agentOptions as Record<string, unknown>;
    if (typeof ao !== 'object' || Array.isArray(ao)) {
      jsonResponse(res, 400, { error: 'agentOptions must be an object' });
      return;
    }
    if (ao.sessionScope && !VALID_SESSION_SCOPES.has(ao.sessionScope as string)) {
      jsonResponse(res, 400, { error: 'agentOptions.sessionScope must be single, shared, or per_chat' });
      return;
    }
    if (resolveAndValidateAgentCwd(name, ao, res) === null) return;
    // Confine pluginDirs to user home directory
    if (Array.isArray(ao.pluginDirs)) {
      if (!validatePluginDirs(ao.pluginDirs as unknown[], res)) return;
    }
  }

  // --- Build config — start with validated required fields, then merge optional fields ---
  let config: Record<string, unknown> = {
    name,
    type,
    adminPhones,
    healthPort,
    accessMode,
    introSent: false, // triggers introduction message on first boot
  };

  // Numeric bounds (rateLimitPerHour/maxTokens/tokenBudget) are enforced by the
  // shared validateInstanceConfig call below, which runs on both CREATE and PATCH.

  // Pass through all optional config fields (exclude internal/UI-only fields)
  const PASSTHROUGH_FIELDS = [
    'description', 'systemPrompt', 'maxTokens', 'tokenBudget', 'rateLimitPerHour',
    'models', 'model', 'pineconeIndex', 'pineconeSearchMode', 'pineconeRerank', 'pineconeTopK',
    'pineconeAllowedIndexes', 'memory', 'agentOptions', 'toolUpdateMode', 'controlPeers',
    'transcriptionOptions',
    // service: governed launchd render options (claudeConfigDir, pathPrepend) and
    // the ratified account digest. Passed through so the shared validator below
    // (validateLaunchdServiceConfig / validateServiceIdentityConfig) admits or
    // rejects the block on CREATE as it already does on PATCH/load (#3401 item 2).
    'service',
    'pineconeApiKeyEnv', 'pineconeProjectId', 'pineconeExpectedHostSuffix',
    'pineconeNamespaces', 'pineconeFactsNamespace', 'pineconeChunksNamespace',
    'pineconeSummariesNamespace', 'pineconeKnowledgeSearch', 'pineconeKnowledgeProfiles',
  ];
  for (const field of PASSTHROUGH_FIELDS) {
    if (body[field] != null) config[field] = body[field];
  }
  if (Object.prototype.hasOwnProperty.call(body, 'clientOutputPolicies')) {
    config['clientOutputPolicies'] = body['clientOutputPolicies'];
  }
  // chatOptions (openaiProviderConfig — QR-218 PR-2) is chat-only: gated to
  // type 'chat' so an agent/passive config can never carry an unvalidated
  // chat-shaped block (validateChatOptions below only checks type === 'chat').
  if (type === 'chat' && body.chatOptions != null) {
    config['chatOptions'] = body.chatOptions;
  }
  // Regression guard, not an active hole: PASSTHROUGH_FIELDS excludes the
  // wizard-era plaintext key fields today; this keeps future allowlist
  // growth from reopening the PATCH-path leak fixed alongside it.
  config = stripPlaintextProviderKeys(
    migrateLegacyMemoryConfig(config, { removeLegacy: true }).config,
  ).clean;

  // --- Shared validator: defense-in-depth before writing to disk ---
  // CREATE has already done inline shape checks above; this catches any field
  // that slips through (e.g. invalid instructionsPath in agentOptions, oversize
  // claudeMd, malformed providerConfig) and keeps CREATE/PATCH/loader aligned.
  {
    const validationError = validateInstanceConfig(
      { ...config, claudeMd: body.claudeMd },
      { name, mode: 'create', existingHealthPorts: portInventory.ports },
    );
    if (validationError) {
      jsonResponse(res, validationError.status ?? 400, { error: validationError.message });
      return;
    }
  }

  // service-block home-confinement (fs-aware, so not in the shared validator).
  // Placed outside the `type === 'agent'` block above that holds the pluginDirs
  // sibling: `service` is type-agnostic, so an out-of-home prepend on a chat or
  // passive instance must be refused too. Reads the assembled `config` rather
  // than `body` so it sees the post-passthrough, post-strip view that is about
  // to be written. Runs before the first mkdir, so a refusal leaves no
  // partially-created instance.
  if (!validateServiceHomeConfinement(config['service'], res)) return;

  // --- Create directories ---
  const createdExtras: ExtraRecord[] = [];
  let serviceEnabled = false;
  try {
    fs.mkdirSync(configRoot(), { recursive: true, mode: 0o700 });
    fs.mkdirSync(configDir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      jsonResponse(res, 409, { error: `instance '${name}' already exists` });
      return;
    }
    jsonResponse(res, 500, mutationError(err, { operation: 'instance_create', stage: 'commit', mutationState: 'not_started' }));
    return;
  }

  try {
    fs.mkdirSync(path.join(dataRoot(name), 'logs'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dataRoot(name), 'media', 'tmp'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(stateRoot(name), { recursive: true, mode: 0o700 });
    writeInitialDatabaseCreateMarker(dataRoot(name), name);

    // --- Write config.json ---
    writePrivateFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { exclusive: true });

    // Decision: instance creation ignores any per-instance provider key material for now.
    // The deploy wrapper still reads a shared provider key from the keyring, and we will only
    // persist instance-scoped keys after a dedicated secret-storage model is designed end-to-end.

    // --- Copy health token (per-instance canonical service only) ---
    try {
      const token = lookupCredential('whatsoup-health-token', { user: name, skipEnv: true, skipMigrationFallbacks: true });
      if (token) {
        writePrivateFileSync(path.join(configDir, 'tokens.env'), `WHATSOUP_HEALTH_TOKEN=${token}\n`, { exclusive: true });
      }
    } catch {
      log.warn({ instance: name }, 'keyring read failed — spawned instance will start without a health token');
    }

    // --- Write CLAUDE.md for agent instances ---
    if (body.claudeMd && type === 'agent' && body.agentOptions &&
        typeof (body.agentOptions as Record<string, unknown>).cwd === 'string') {
      const cwd = (body.agentOptions as Record<string, unknown>).cwd as string;
      let claudeDir = path.join(cwd, '.claude');
      claudeDir = ensureHomeConfinedDirectory(claudeDir);
      const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
      const claudeMdSnapshot = snapshotExtra(claudeMdPath);
      createdExtras.push(claudeMdSnapshot);
      writePrivateFileSync(claudeMdPath, body.claudeMd as string);
    }

    // --- Write settings.json for agent instances ---
    if (type === 'agent' && body.agentOptions &&
        typeof (body.agentOptions as Record<string, unknown>).cwd === 'string') {
      const cwd = (body.agentOptions as Record<string, unknown>).cwd as string;
      let claudeDir = path.join(cwd, '.claude');
      const settings = mergeSettingsJson('agent', body.settingsJson as PermissionsSettings | undefined);
      if (settings) {
        claudeDir = ensureHomeConfinedDirectory(claudeDir);
        // Include enabledPlugins from agentOptions if provided
        const ao = body.agentOptions as Record<string, unknown>;
        if (ao.enabledPlugins && typeof ao.enabledPlugins === 'object') {
          settings.enabledPlugins = ao.enabledPlugins as Record<string, boolean>;
        }
        const settingsPath = path.join(claudeDir, 'settings.json');
        const settingsSnapshot = snapshotExtra(settingsPath);
        createdExtras.push(settingsSnapshot);
        writePermissionsSettings(claudeDir, settings);
      }
    }

    // --- Enable service ---
    await deps.serviceManager.enable(name);
    serviceEnabled = true;

    // --- Re-scan discovery ---
    deps.discovery.scan();

    publishInstanceStatus(deps.realtime, name);
    publishFeedEvent(deps.realtime, name);
    jsonResponse(res, 201, { name, healthPort });
  } catch (err) {
    if (serviceEnabled) {
      try {
        await deps.serviceManager.disable(name);
      } catch (rollbackErr) {
        log.error(
          { err: rollbackErr, originalErr: err, instance: name },
          'failed to disable service after instance creation failure',
        );
        jsonResponse(res, 500, mutationError(err, { operation: 'instance_create', stage: 'rollback', mutationState: 'rollback_failed', rollbackState: 'failed' }));
        return;
      }
    }
    cleanupPartial(name, createdExtras);
    jsonResponse(res, 500, mutationError(err, { operation: 'instance_create', stage: 'commit', mutationState: 'not_started' }));
  }
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
