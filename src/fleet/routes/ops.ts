import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { readBody, jsonResponse, requireInstance } from '../../lib/http.ts';
import { escapeRegExp } from '../../lib/regex-utils.ts';
import { isRecord } from '../../lib/type-guards.ts';
import { createSSEWriter } from '../sse-helpers.ts';
import { normalizePhoneE164, normalizePhoneE164Wire } from '../../lib/phone.ts';
import { SIGNAL_UUID_RE } from '../../transport/signal/types.ts';
import { canonicalizeImessageDirectIdentity } from '../../core/transport-refs.ts';
import { createChildLogger } from '../../logger.ts';
const log = createChildLogger('fleet:ops');
import { mcpCall } from '../mcp-client.ts';
import { respondMcp } from './mcp-proxy.ts';
import { proxyToInstance } from '../http-proxy.ts';
import type { FleetDiscovery } from '../discovery.ts';
import { configRoot, dataRoot, stateRoot, repoRoot } from '../paths.ts';
import { writePermissionsSettings } from '../../core/workspace.ts';
import { applyRequiredDeny, defaultSettingsJson, mergeSettingsJson } from '../../core/settings-template.ts';
import type { PermissionsSettings } from '../../core/settings-template.ts';
import { VALID_TYPES, VALID_ACCESS_MODES, VALID_SESSION_SCOPES } from '../../instance-loader.ts';
import { validateInstanceConfig } from '../../core/agent-config-validator.ts';
import type { ValidationError as ConfigValidationError } from '../../core/agent-config-validator.ts';
import { isGroupConversationKey, conversationKeyToJid } from '../../core/conversation-key.ts';
import { toPersonalJid } from '../../core/jid-constants.ts';
import { persistIntroSentFlag } from '../../core/intro-sent-config.ts';
import {
  readPrivateConfigFileSync,
  withPrivateConfigLockSync,
  writePrivateConfigFileSync,
} from '../../core/private-config-file.ts';
import type { FleetRealtimePublisher } from '../realtime-publisher.ts';
import { publishInstanceStatus, publishMessageReceived, publishChatUpdated, publishAccessChanged, publishFeedEvent } from '../realtime-publisher.ts';
import { systemdUnitName, type ServiceManager } from '../platform.ts';
import { lookupCredential } from '../../lib/keyring.ts';
import {
  expandHomePath,
  hasUnsupportedTildePrefix,
  isSamePhysicalDirectory,
} from '../../lib/home-path.ts';
import { migrateLegacyMemoryConfig } from '../../config-memory-migration.ts';
import { stripPlaintextProviderKeys } from '../../lib/config-plaintext-keys.ts';
import { DEFAULT_INSTANCE_HEALTH_PORT } from '../constants.ts';
import { privateWriteError, writePrivateFileSync } from '../../lib/private-fs.ts';
import { errorMessage } from '../../lib/error-message.ts';
import { projectError, validationError, mutationError, serviceActionError, configValidationError } from '../response-error-projection.ts';
import { NAME_MAX_LENGTH, NAME_RE, validateInstanceName } from './instance-name.ts';

function deepMergeRecords(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  path: string[] = [],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    const childPath = [...path, key];
    const dottedPath = childPath.join('.');
    result[key] = isRecord(current) && isRecord(value) && dottedPath !== 'chatOptions.openaiProviderConfig'
      ? deepMergeRecords(current, value, childPath)
      : value;
  }
  return result;
}

class ConfigUpdateResponseSent extends Error {
  constructor() {
    super('config update response already sent');
    this.name = 'ConfigUpdateResponseSent';
  }
}

function haltConfigUpdateAfterResponse(): never {
  throw new ConfigUpdateResponseSent();
}

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
    // throws TypeError on property access, the catch swallows it as "invalid
    // JSON", and the request falls through to mcpCall with a `null` payload —
    // bypassing xor validation. Arrays and primitives currently land at the
    // "neither" branch by accident; explicit type-shape rejection makes the
    // boundary deliberate.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      jsonResponse(res, 400, {
        error: 'request body must be a JSON object with chatJid (raw JID) or to (alias)',
      });
      return;
    }

    // Trim before length check: whitespace-only values count as not-provided
    // (matches resolver semantics in src/core/chats-resolver.ts and prevents
    // forwarding `'   '` to the instance via JID normalization).
    const hasChatJid = typeof parsed.chatJid === 'string' && parsed.chatJid.trim().length > 0;
    const hasTo = typeof parsed.to === 'string' && parsed.to.trim().length > 0;

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

    if (parsed.profile !== undefined && (typeof parsed.profile !== 'string' || parsed.profile.trim().length === 0)) {
      jsonResponse(res, 400, { error: 'profile must be a non-empty string' });
      return;
    }

    if (hasChatJid && !parsed.chatJid.includes('@')) {
      parsed.chatJid = isGroupConversationKey(parsed.chatJid)
        ? conversationKeyToJid(parsed.chatJid)
        : toPersonalJid(parsed.chatJid);
      fixedBody = JSON.stringify(parsed);
    }
  } catch { /* invalid JSON: existing fall-through; downstream returns 400 */ }

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

/** PATCH /api/lines/:name/config — merge fields into instance config. */
export async function handleConfigUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  if (!validateInstanceName(params.name, res)) return;
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  const body = await readBody(req);
  let patch: Record<string, unknown>;
  try {
    patch = JSON.parse(body);
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new Error('body must be a JSON object');
    }
  } catch (err) {
    jsonResponse(res, 400, validationError('invalid_json', 'unknown'));
    return;
  }

  let mergedClean: Record<string, unknown>;
  try {
    mergedClean = withPrivateConfigLockSync(instance.configPath, () => {
      // Read existing config under the same advisory lock used by the instance
      // process, so read-merge-write cannot clobber introSent updates.
      let existing: Record<string, unknown>;
      try {
        existing = JSON.parse(readPrivateConfigFileSync(instance.configPath));
      } catch (err) {
        jsonResponse(res, 500, projectError(err, { operation: 'config_read', stage: 'execute' }));
        haltConfigUpdateAfterResponse();
      }

      // 0. Transport is IMMUTABLE after line creation — a patch that changes
      //    the transport kind is rejected with 409 (switching transports means
      //    re-linking; create a new line instead). Checked against the
      //    pre-merge existing config so the merged view can't smuggle it.
      if (
        patch.transport !== undefined &&
        patch.transport !== existing.transport
      ) {
        jsonResponse(res, 409, {
          error: 'transport is immutable; create a new line to change transports',
        });
        haltConfigUpdateAfterResponse();
      }

      // Deep merge nested config so partial memory.pinecone patches do not destroy
      // sibling namespaces, BYOK key-env settings, or project guards.
      const merged = deepMergeRecords(existing, patch);

      // --- Shape/normalization that must run BEFORE the shared validator ---
      // 1. agentOptions defaulting + cwd traversal check (paths are inherently
      //    filesystem-aware; the shared validator only does type/range/enum).
      if (merged.type === 'agent') {
        if (merged.agentOptions == null) {
          merged.agentOptions = defaultAgentOptions(params.name);
        }
        if (typeof merged.agentOptions !== 'object' || Array.isArray(merged.agentOptions)) {
          jsonResponse(res, 400, { error: 'agentOptions must be an object' });
          haltConfigUpdateAfterResponse();
        }
        if (resolveAndValidateAgentCwd(params.name, merged.agentOptions as Record<string, unknown>, res) === null) {
          haltConfigUpdateAfterResponse();
        }
      }

      // 2. Normalize adminPhones if patched, per the (merged) transport —
      //    signal accepts E.164 or UUID; imessage accepts E.164 or AppleID
      //    email; other transports E.164-only.
      if (patch.adminPhones !== undefined) {
        if (
          !Array.isArray(patch.adminPhones) ||
          patch.adminPhones.length === 0 ||
          !patch.adminPhones.every((p: unknown) => typeof p === 'string' && (p as string).trim())
        ) {
          jsonResponse(res, 400, { error: 'adminPhones must be a non-empty array of strings' });
          haltConfigUpdateAfterResponse();
        }
        const mergedTransport = typeof merged.transport === 'string' ? merged.transport : 'baileys';
        merged.adminPhones = normalizeAdminIdsForTransport(mergedTransport, patch.adminPhones as string[]);
      }

      // --- Shared validator: closes #244 + #249 PATCH validation gaps ---
      // Runs on the post-merge view so partial patches are checked against the
      // assembled config, not the bare patch. Mirrors loader + CREATE.
      {
        const portInventory = patch.healthPort === undefined ? null : scanHealthPortInventory(params.name);
        if (portInventory && !portInventory.ok) {
          emitInventoryFailure(res, portInventory);
          haltConfigUpdateAfterResponse();
        }
        const validationError = validateInstanceConfig(merged, {
          name: params.name,
          mode: 'patch',
          ...(portInventory ? { existingHealthPorts: portInventory.ports } : {}),
          originalType: existing.type,
        });
        if (validationError) {
          emitValidationError(validationError, res);
          haltConfigUpdateAfterResponse();
        }
      }

      // pluginDirs home-confinement is fs-aware (not in the shared validator).
      const mergedAo = merged.agentOptions as Record<string, unknown> | undefined;
      if (Array.isArray(mergedAo?.pluginDirs)) {
        if (!validatePluginDirs(mergedAo!.pluginDirs as unknown[], res)) haltConfigUpdateAfterResponse();
      }
      if (patch.claudeMd && merged.type === 'agent') {
        const ao = merged.agentOptions as Record<string, unknown> | undefined;
        if (ao && typeof ao.cwd === 'string' && ao.cwd.trim()) {
          try {
            const claudeDir = path.join(ao.cwd, '.claude');
            ensureHomeConfinedDirectory(claudeDir);
            writePrivateFileSync(path.join(claudeDir, 'CLAUDE.md'), patch.claudeMd as string);
          } catch (err) {
            jsonResponse(res, 500, projectError(err, { operation: 'config_write', stage: 'commit' }));
            haltConfigUpdateAfterResponse();
          }
        }
      }

      // Write settings.json when settingsJson is in the patch (agent instances only)
      if (patch.settingsJson && merged.type === 'agent') {
        const ao = merged.agentOptions as Record<string, unknown> | undefined;
        if (ao && typeof ao.cwd === 'string' && ao.cwd.trim()) {
          try {
            const claudeDir = path.join(ao.cwd, '.claude');
            const settings = mergeSettingsJson('agent', patch.settingsJson as PermissionsSettings);
            if (settings) {
              ensureHomeConfinedDirectory(claudeDir);
              writePermissionsSettings(claudeDir, settings);
            }
          } catch (err) {
            jsonResponse(res, 500, projectError(err, { operation: 'config_write', stage: 'commit' }));
            haltConfigUpdateAfterResponse();
          }
        }
      }

      // Write enabledPlugins to .claude/settings.json when agentOptions.enabledPlugins changes
      if (patch.agentOptions && merged.type === 'agent') {
        const patchAo = patch.agentOptions as Record<string, unknown>;
        if (patchAo.enabledPlugins !== undefined && (patchAo.enabledPlugins === null || typeof patchAo.enabledPlugins === 'object')) {
          const ao = merged.agentOptions as Record<string, unknown> | undefined;
          if (ao && typeof ao.cwd === 'string' && ao.cwd.trim()) {
            try {
              const claudeDir = path.join(ao.cwd, '.claude');
              ensureHomeConfinedDirectory(claudeDir);
              // Build a full PermissionsSettings so writePermissionsSettings handles the merge
              const settingsPath = path.join(claudeDir, 'settings.json');
              let existingPerms = defaultSettingsJson('agent')!.permissions;
              try {
                const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
                if (existing.permissions) {
                  const permissions = existing.permissions as PermissionsSettings['permissions'];
                  existingPerms = {
                    ...permissions,
                    deny: applyRequiredDeny(Array.isArray(permissions.deny) ? permissions.deny : []),
                  };
                }
              } catch { /* use defaults */ }
              writePermissionsSettings(claudeDir, {
                permissions: existingPerms,
                // null or {} = reset to global inheritance
                enabledPlugins: (patchAo.enabledPlugins ?? {}) as Record<string, boolean>,
              });
            } catch (err) {
              jsonResponse(res, 500, projectError(err, { operation: 'config_write', stage: 'commit' }));
              haltConfigUpdateAfterResponse();
            }
          }
        }
      }

      // chatOptions is chat-only (mirrors handleCreateLine's `type === 'chat' &&
      // body.chatOptions != null` gate). deepMergeRecords above has no type
      // awareness, so a patch carrying chatOptions onto an agent/passive
      // instance would otherwise merge straight through — and validateChatOptions
      // only runs for type === 'chat', so it would reach disk unvalidated. Drop,
      // don't reject, matching CREATE's drop-not-reject behavior.
      if (merged.type !== 'chat' && 'chatOptions' in merged) {
        delete merged.chatOptions;
      }

      // Strip settingsJson from persisted config (it lives in .claude/settings.json, not config.json)
      // and inert plaintext provider keys (wizard-era apiKey/openaiKey — nothing reads them;
      // stripping here also scrubs legacy on-disk victims on their next config write).
      const { settingsJson: _stripped, ...mergedCleanRaw } = merged;
      const scrubbed = stripPlaintextProviderKeys(mergedCleanRaw).clean;
      const clean = migrateLegacyMemoryConfig(scrubbed, { removeLegacy: true }).config;
      try {
        writePrivateConfigFileSync(instance.configPath, JSON.stringify(clean, null, 2) + '\n');
      } catch (err) {
        jsonResponse(res, 500, projectError(err, { operation: 'config_write', stage: 'execute' }));
        haltConfigUpdateAfterResponse();
      }
      return clean;
    });
  } catch (err) {
    if (err instanceof ConfigUpdateResponseSent) {
      return;
    }
    jsonResponse(res, 500, projectError(err, { operation: 'config_write', stage: 'execute' }));
    return;
  }

  publishInstanceStatus(deps.realtime, params.name);
  publishFeedEvent(deps.realtime, params.name);
  jsonResponse(res, 200, mergedClean);
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

function pathIsInsideDirectory(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function pathIsAtOrInsideDirectory(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realpathExistingPrefix(targetPath: string): string {
  let current = targetPath;
  while (true) {
    try {
      return fs.realpathSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}

function resolveHomeConfinedPath(inputPath: string, res: ServerResponse, error: string): string | null {
  if (hasUnsupportedTildePrefix(inputPath)) {
    jsonResponse(res, 400, { error });
    return null;
  }
  const resolved = path.resolve(expandHomePath(inputPath));
  const homePath = path.resolve(os.homedir());
  if (!pathIsInsideDirectory(resolved, homePath)) {
    jsonResponse(res, 400, { error });
    return null;
  }

  try {
    const homeReal = fs.realpathSync(homePath);
    const existingReal = realpathExistingPrefix(resolved);
    if (!pathIsAtOrInsideDirectory(existingReal, homeReal)) {
      jsonResponse(res, 400, { error });
      return null;
    }
  } catch {
    jsonResponse(res, 400, { error });
    return null;
  }

  return resolved;
}

function ensureHomeConfinedDirectory(dirPath: string): void {
  const resolved = path.resolve(dirPath);
  const homePath = path.resolve(os.homedir());
  const homeReal = fs.realpathSync(homePath);
  const existingReal = realpathExistingPrefix(resolved);
  if (!pathIsInsideDirectory(resolved, homePath) || !pathIsAtOrInsideDirectory(existingReal, homeReal)) {
    throw privateWriteError('directory must be within the home directory', 'EACCES');
  }

  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const dirReal = fs.realpathSync(resolved);
  if (!pathIsInsideDirectory(resolved, homePath) || !pathIsAtOrInsideDirectory(dirReal, homeReal)) {
    throw privateWriteError('directory must be within the home directory', 'EACCES');
  }
}

/**
 * Resolve agentOptions.cwd and verify it is within the home directory.
 * Mutates agentOptions.cwd in-place to the resolved absolute path.
 * Returns the resolved path on success, null and writes a 400 on failure.
 */
function resolveAndValidateCwd(agentOptions: Record<string, unknown>, res: ServerResponse): string | null {
  const cwd = agentOptions.cwd as string;
  if (!cwd.trim()) return cwd; // empty — caller decides whether it's valid
  const safeCwd = resolveHomeConfinedPath(cwd, res, 'agentOptions.cwd must be within the home directory');
  if (safeCwd === null) return null;
  try {
    if (isSamePhysicalDirectory(safeCwd, os.homedir())) {
      jsonResponse(res, 400, { error: 'agentOptions.cwd must be within the home directory' });
      return null;
    }
  } catch {
    jsonResponse(res, 400, { error: 'agentOptions.cwd must be within the home directory' });
    return null;
  }
  agentOptions.cwd = safeCwd;
  return safeCwd;
}

function defaultAgentCwd(name: string): string {
  return path.join(os.homedir(), '.local', 'share', 'whatsoup', 'instances', name, 'workspace');
}

function defaultAgentOptions(name: string): Record<string, unknown> {
  return { cwd: defaultAgentCwd(name), sessionScope: 'per_chat' };
}

function resolveAndValidateAgentCwd(
  name: string,
  agentOptions: Record<string, unknown>,
  res: ServerResponse,
): string | null {
  const cwd = agentOptions.cwd;
  if (cwd == null || (typeof cwd === 'string' && !cwd.trim())) {
    agentOptions.cwd = defaultAgentCwd(name);
  } else if (typeof cwd !== 'string') {
    jsonResponse(res, 400, { error: 'agentOptions.cwd must be a string within the home directory' });
    return null;
  }
  if (agentOptions.sessionScope == null || (typeof agentOptions.sessionScope === 'string' && !agentOptions.sessionScope.trim())) {
    agentOptions.sessionScope = 'per_chat';
  }

  return resolveAndValidateCwd(agentOptions, res);
}

/**
 * Validate that every entry in pluginDirs is a string within the home directory.
 * Writes a 400 response and returns false on the first violation; returns true when valid.
 */
function validatePluginDirs(dirs: unknown[], res: ServerResponse): boolean {
  for (const dir of dirs) {
    if (typeof dir !== 'string') {
      jsonResponse(res, 400, { error: 'pluginDirs entries must be within the home directory' });
      return false;
    }
    if (resolveHomeConfinedPath(dir, res, 'pluginDirs entries must be within the home directory') === null) return false;
  }
  return true;
}

/**
 * Deduplicate and normalize an array of phone strings using E.164 format.
 */
function normalizeAdminPhones(phones: string[]): string[] {
  return [...new Set(phones.map((p) => normalizePhoneE164(p)))];
}

/**
 * Per-transport admin-ID normalization. Admin IDs are matched against the
 * sender's protocol-verified identity, so the acceptable shape depends on
 * the line's transport:
 * - signal:   E.164 phone OR Signal UUID (passed through verbatim)
 * - imessage: E.164 phone OR AppleID email (passed through verbatim)
 * - others:   E.164 phone (existing behavior)
 */
function normalizeAdminIdsForTransport(transport: string, phones: string[]): string[] {
  if (transport === 'signal') {
    return [...new Set(phones.map((p) => {
      const trimmed = p.trim();
      return SIGNAL_UUID_RE.test(trimmed) ? trimmed : normalizePhoneE164(trimmed);
    }))];
  }
  if (transport === 'imessage') {
    return [...new Set(phones.map((p) => {
      const trimmed = p.trim();
      const directIdentity = canonicalizeImessageDirectIdentity(trimmed);
      if (directIdentity !== null) return directIdentity;
      const wireIdentity = normalizePhoneE164Wire(trimmed);
      return wireIdentity === null
        ? normalizePhoneE164(trimmed)
        : canonicalizeImessageDirectIdentity(wireIdentity) ?? wireIdentity;
    }))];
  }
  return normalizeAdminPhones(phones);
}

// ---------------------------------------------------------------------------
// Helpers for handleCreateLine
// ---------------------------------------------------------------------------

type HealthPortInventory =
  | { ok: true; ports: ReadonlyMap<string, number> }
  | {
      ok: false;
      status: number;
      body: { error: string; code?: string; instance?: string };
    };

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && typeof (err as NodeJS.ErrnoException).code === 'string'
    ? (err as NodeJS.ErrnoException).code
    : undefined;
}

function inventoryFailure(
  error: string,
  err?: unknown,
  instance?: string,
): HealthPortInventory {
  const code = errnoCode(err);
  return {
    ok: false,
    status: 500,
    body: {
      error,
      ...(code ? { code } : {}),
      ...(instance ? { instance } : {}),
    },
  };
}

function emitInventoryFailure(res: ServerResponse, result: HealthPortInventory): boolean {
  if (result.ok) return false;
  jsonResponse(res, result.status, result.body);
  return true;
}

/**
 * Build a name -> healthPort map by scanning the config root.
 *
 * Missing config root means no instances exist yet. Existing unreadable or
 * malformed instance configs are different: CREATE/PATCH cannot safely prove a
 * requested port is free, so fail closed rather than authorizing a collision.
 */
function scanHealthPortInventory(excludeName?: string): HealthPortInventory {
  const map = new Map<string, number>();
  const root = configRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { ok: true, ports: map };
    log.warn({ err, configRoot: root }, 'healthPort inventory scan failed');
    return inventoryFailure('healthPort inventory unavailable: failed to read config root', err);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === excludeName) continue;

    const configPath = path.join(root, name, 'config.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') continue;
      log.warn({ err, instance: name, configPath }, 'healthPort inventory config read failed');
      return inventoryFailure('healthPort inventory unavailable: failed to read instance config', err, name);
    }

    if (!isRecord(parsed)) {
      log.warn({ instance: name, configPath }, 'healthPort inventory config is not an object');
      return inventoryFailure('healthPort inventory unavailable: instance config is not a JSON object', undefined, name);
    }
    if (parsed.enabled === false) continue;

    const rawPort = parsed.healthPort ?? DEFAULT_INSTANCE_HEALTH_PORT;
    if (
      typeof rawPort !== 'number' ||
      !Number.isFinite(rawPort) ||
      !Number.isInteger(rawPort) ||
      rawPort < 1024 ||
      rawPort > 65535
    ) {
      log.warn({ instance: name, configPath }, 'healthPort inventory config has invalid healthPort');
      return inventoryFailure('healthPort inventory unavailable: instance config has invalid healthPort', undefined, name);
    }
    map.set(name, rawPort);
  }

  return { ok: true, ports: map };
}

/** Map a ValidationError to the HTTP response and return false to halt the handler. */
function emitValidationError(err: ConfigValidationError, res: ServerResponse): boolean {
  jsonResponse(res, err.status ?? 400, configValidationError(err, 'unknown'));
  return false;
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
    'pineconeApiKeyEnv', 'pineconeProjectId', 'pineconeExpectedHostSuffix',
    'pineconeNamespaces', 'pineconeFactsNamespace', 'pineconeChunksNamespace',
    'pineconeSummariesNamespace', 'pineconeKnowledgeSearch', 'pineconeKnowledgeProfiles',
  ];
  for (const field of PASSTHROUGH_FIELDS) {
    if (body[field] != null) config[field] = body[field];
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
      const claudeDir = path.join(cwd, '.claude');
      ensureHomeConfinedDirectory(claudeDir);
      const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
      const claudeMdSnapshot = snapshotExtra(claudeMdPath);
      createdExtras.push(claudeMdSnapshot);
      writePrivateFileSync(claudeMdPath, body.claudeMd as string);
    }

    // --- Write settings.json for agent instances ---
    if (type === 'agent' && body.agentOptions &&
        typeof (body.agentOptions as Record<string, unknown>).cwd === 'string') {
      const cwd = (body.agentOptions as Record<string, unknown>).cwd as string;
      const claudeDir = path.join(cwd, '.claude');
      const settings = mergeSettingsJson('agent', body.settingsJson as PermissionsSettings | undefined);
      if (settings) {
        ensureHomeConfinedDirectory(claudeDir);
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

// Active auth processes per instance — prevents duplicate concurrent auth sessions
const activeAuthProcesses = new Map<string, ReturnType<typeof spawn>>();
// In-flight auth operations — prevents concurrent auth requests from racing
const authInFlight = new Set<string>();

// Auth session wall-clock timeout (5 minutes — QR codes expire in ~60s, allows 5 scan attempts)
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
// The helper normally exits about two seconds after it persists credentials.
// Keep a short, bounded window so that a hung helper cannot strand its service.
const AUTH_COMPLETION_TIMEOUT_MS = 15 * 1000;
const ALLOWED_SSE_EVENTS = new Set(['qr', 'connected', 'error']);

/** GET /api/lines/:name/auth — SSE stream of QR codes from the auth process. */
export async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OpsDeps,
  params: { name: string },
): Promise<void> {
  if (!validateInstanceName(params.name, res)) return;
  const instance = requireInstance(deps.discovery, params.name, res);
  if (!instance) return;

  // Prevent concurrent auth requests for the same instance from racing
  if (authInFlight.has(params.name)) {
    jsonResponse(res, 409, { error: 'auth already in progress for this instance' });
    return;
  }
  authInFlight.add(params.name);

  // Kill any existing auth process for this instance before starting a new one
  const existing = activeAuthProcesses.get(params.name);
  if (existing) {
    try { existing.kill('SIGTERM'); } catch { /* already exited */ }
    activeAuthProcesses.delete(params.name);
  }

  // SSE headers — write BEFORE stopping the instance to avoid browser timeout
  // during a slow systemd stop (up to TimeoutStopSec=15s)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Attach the SSE error listener before the asynchronous stop preflight. A
  // client can disconnect while that stop is in flight.
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  let stoppedForAuth = false;
  let startupRequested = false;
  let restoreRequested = false;
  let preflightClosed = false;
  const { writeSSE, endOnce } = createSSEWriter(res, () => {
    activeAuthProcesses.delete(params.name);
    authInFlight.delete(params.name);
    if (authTimer) clearTimeout(authTimer);
  });
  const restoreStoppedInstance = (reason: string) => {
    if (!stoppedForAuth || startupRequested || restoreRequested) return;
    restoreRequested = true;
    const onError = (err: Error | null) => {
      if (err) log.error({ err, instance: params.name, reason }, 'post-auth failure restart failed');
    };
    if (deps.serviceManager.startAfterAuthFire) {
      deps.serviceManager.startAfterAuthFire(params.name, onError);
    } else {
      deps.serviceManager.startFire(params.name, onError);
    }
  };
  const onPreflightClose = () => {
    // Keep the in-flight claim until the stop settles, then either restore the
    // prior service or report the failure without writing to the closed stream.
    preflightClosed = true;
  };
  req.once('close', onPreflightClose);

  // Stop the running instance so the lock file is released for auth.
  if (deps.serviceManager.stopForAuth) {
    try {
      stoppedForAuth = (await deps.serviceManager.stopForAuth(params.name)) !== false;
    } catch (err) {
      req.removeListener('close', onPreflightClose);
      log.error({ err, instance: params.name }, 'auth preflight failed to stop existing service');
      if (!preflightClosed) {
        writeSSE('error', { message: 'Unable to stop the existing instance before authentication. Resolve its service state and retry.' });
      }
      endOnce();
      return;
    }
  } else {
    try {
      await deps.serviceManager.stop(params.name);
      stoppedForAuth = true;
    } catch { /* may not be running */ }
  }

  req.removeListener('close', onPreflightClose);
  if (preflightClosed) {
    restoreStoppedInstance('client-close-before-auth-spawn');
    endOnce();
    return;
  }

  // Auth bootstrap is an admin-only operation that needs full environment access
  // for WhatsApp pairing (QR code flow). This is not a user-facing agent session
  // and does not process untrusted input, so full env inheritance is acceptable.
  // Resolve bootstrap-auth against the repo root, not `process.cwd()`.
  // Under systemd the fleet unit ships with no `WorkingDirectory=`, so cwd
  // is the service user's `$HOME` and a relative script path ENOENTs (#419).
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    path.join(repoRoot, 'src', 'bootstrap-auth.ts'),
    params.name,
  ], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeAuthProcesses.set(params.name, child);

  // Guard against double res.end() — declared before any event handlers
  let connected = false;
  let terminalFailure = false;

  const startAfterSuccessfulAuth = () => {
    if (startupRequested) return;
    startupRequested = true;
    let activationCompleted = false;
    const onComplete = (err: Error | null) => {
      if (activationCompleted) return;
      activationCompleted = true;
      if (err) {
        terminalFailure = true;
        log.error({ err, instance: params.name }, 'post-auth start failed');
        // The pairing helper has already persisted credentials, but the
        // instance was not activated. Do not expose launchctl details in SSE.
        writeSSE('error', { message: 'Authentication completed but the instance could not start. Please retry or inspect fleet logs.' });
      } else {
        deps.discovery.scan();
        // The helper's internal `connected` signal proves persisted
        // credentials, not a live managed instance. Only report connected to
        // the browser after the helper exits and service activation succeeds.
        writeSSE('connected', {});
      }
      endOnce();
    };
    try {
      if (deps.serviceManager.startAfterAuthFire) {
        deps.serviceManager.startAfterAuthFire(params.name, onComplete);
      } else {
        deps.serviceManager.startFire(params.name, onComplete);
      }
    } catch (error) {
      onComplete(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const armAuthTimeout = (delayMs: number, message: string, reason: string) => {
    if (authTimer) clearTimeout(authTimer);
    authTimer = setTimeout(() => {
      terminalFailure = true;
      writeSSE('error', { message });
      child.kill('SIGTERM');
      restoreStoppedInstance(reason);
      endOnce();
    }, delayMs);
  };

  // Wall-clock timeout — prevents auth process from hanging forever.
  armAuthTimeout(
    AUTH_TIMEOUT_MS,
    'Authentication timed out. QR codes expire after ~60 seconds. Please retry.',
    'timeout',
  );

  // Parse stdout for JSON events
  let buffer = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (!ALLOWED_SSE_EVENTS.has(evt.event)) continue;
        if (evt.event === 'connected') {
          if (!connected) {
            connected = true;
            armAuthTimeout(
              AUTH_COMPLETION_TIMEOUT_MS,
              'Authentication completed but did not finish. Please retry.',
              'completion-timeout',
            );
            // Reset introSent so the instance sends an introduction on next boot
            try {
              persistIntroSentFlag(instance.configPath, false);
            } catch (err) {
              // Not fatal to the auth flow, but without this warn the operator
              // has no clue why the instance never re-introduced itself.
              log.warn({ err, instance: params.name }, 'introSent reset failed after re-auth; intro will not re-fire on next boot');
            }
          }
          continue;
        }
        writeSSE(evt.event, evt.data ?? {});
      } catch {
        // Intentional: the helper may emit human-readable non-JSON output;
        // only structured SSE events are safe to forward to the browser.
      }
    }
  });

  // Log stderr from auth process for debugging
  child.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log.info({ instance: params.name, stderr: text.slice(0, 200) }, 'auth process stderr');
  });

  // Forward errors
  child.on('error', (err) => {
    terminalFailure = true;
    writeSSE('error', projectError(err, { operation: 'auth', stage: 'execute' }));
    restoreStoppedInstance('child-error');
    endOnce();
  });
  // `exit` can arrive before the final stdout bytes. Wait for `close`, which
  // follows closure of the child's stdio streams, before deciding whether the
  // helper persisted credentials.
  child.on('close', (code) => {
    if (code === 0 && connected && !terminalFailure) {
      if (authTimer) {
        clearTimeout(authTimer);
        authTimer = null;
      }
      startAfterSuccessfulAuth();
      return;
    } else if (code !== 0) {
      terminalFailure = true;
      writeSSE('error', serviceActionError(new Error(`auth exited with code ${code}`), 'auth', 'auth_failed'));
      restoreStoppedInstance('child-exit');
    }
    endOnce();
  });

  // Cleanup on client disconnect
  req.on('close', () => {
    // Once the helper has emitted the persisted-credential signal, let its
    // short successful completion activate the instance even if the browser
    // closes the SSE stream. Killing it here would strand the booted-out job.
    if (connected && !terminalFailure) return;
    terminalFailure = true;
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } }, 5000);
    endOnce();
  });
}
