/**
 * PATCH /api/lines/:name/config handler for the fleet ops API.
 *
 * Extracted from `src/fleet/routes/ops.ts` (#2239, slice 2/5). Owns config-file
 * persistence (read-merge-write under the private-config lock) plus the
 * validation helpers it shares with CREATE: home-confined path admission,
 * agentOptions cwd defaulting, pluginDirs and service-block confinement,
 * per-transport admin-ID normalization, and the healthPort inventory scan.
 *
 * `handleConfigUpdate` is re-exported from `ops.ts` as a migration shim so
 * existing callers and tests are unchanged. The shared helpers are exported
 * for `handleCreateLine`; they are not part of the route surface.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readBody, jsonResponse, requireInstance } from '../../lib/http.ts';
import {
  admitHomeConfinedPath,
  ensureHomeConfinedDirectory as provisionHomeConfinedDirectory,
  isCanonicalAbsolutePath,
  pathIsInsideDirectory,
  plannedPrefixIsConfined,
  rawAbsolutePath,
} from '../../lib/home-confinement.ts';
import { isNonEmptyString, isRecord } from '../../lib/type-guards.ts';
import { normalizePhoneE164, normalizePhoneE164Wire } from '../../lib/phone.ts';
import { SIGNAL_UUID_RE } from '../../transport/signal/types.ts';
import { canonicalizeImessageDirectIdentity } from '../../core/transport-refs.ts';
import { createChildLogger } from '../../logger.ts';
import { configRoot } from '../paths.ts';
import { writePermissionsSettings } from '../../core/workspace.ts';
import { applyRequiredDeny, defaultSettingsJson, mergeSettingsJson } from '../../core/settings-template.ts';
import type { PermissionsSettings } from '../../core/settings-template.ts';
import { validateInstanceConfig } from '../../core/agent-config-validator.ts';
import type { ValidationError as ConfigValidationError } from '../../core/agent-config-validator.ts';
import {
  readPrivateConfigFileSync,
  withPrivateConfigLockSync,
  writePrivateConfigFileSync,
} from '../../core/private-config-file.ts';
import { publishInstanceStatus, publishFeedEvent } from '../realtime-publisher.ts';
import {
  expandHomePath,
  hasUnsupportedTildePrefix,
  isSamePhysicalDirectory,
} from '../../lib/home-path.ts';
import { migrateLegacyMemoryConfig } from '../../config-memory-migration.ts';
import { stripPlaintextProviderKeys } from '../../lib/config-plaintext-keys.ts';
import { DEFAULT_INSTANCE_HEALTH_PORT } from '../constants.ts';
import { writePrivateFileSync } from '../../lib/private-fs.ts';
import { projectError, validationError, configValidationError } from '../response-error-projection.ts';
import { validateInstanceName } from './instance-name.ts';
import { projectClientOutputPolicyConfig } from '../../core/client-output-policy-config.ts';
import type { OpsDeps } from './ops.ts';

// Same component name as ops.ts: log lines from the moved code are unchanged.
const log = createChildLogger('fleet:ops');

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
          !patch.adminPhones.every((p: unknown) => isNonEmptyString(p))
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
      // service-block home-confinement is fs-aware for the same reason, and runs
      // on the MERGED view: a patch that leaves an out-of-home entry standing is
      // refused even when the entry came from the existing config, matching the
      // pluginDirs sibling. An instance already carrying one is therefore
      // un-patchable until the entry is corrected.
      if (!validateServiceHomeConfinement(merged.service, res)) haltConfigUpdateAfterResponse();
      if (patch.claudeMd && merged.type === 'agent') {
        // Invariant: resolveAndValidateAgentCwd() (called above whenever
        // merged.type === 'agent') always leaves agentOptions.cwd a validated
        // non-empty string, or halts the request first.
        const ao = merged.agentOptions as Record<string, unknown>;
        const cwd = ao.cwd as string;
        try {
          let claudeDir = path.join(cwd, '.claude');
          claudeDir = ensureHomeConfinedDirectory(claudeDir);
          writePrivateFileSync(path.join(claudeDir, 'CLAUDE.md'), patch.claudeMd as string);
        } catch (err) {
          jsonResponse(res, 500, projectError(err, { operation: 'config_write', stage: 'commit' }));
          haltConfigUpdateAfterResponse();
        }
      }

      // Write settings.json when settingsJson is in the patch (agent instances only)
      if (patch.settingsJson && merged.type === 'agent') {
        const ao = merged.agentOptions as Record<string, unknown>;
        const cwd = ao.cwd as string;
        try {
          let claudeDir = path.join(cwd, '.claude');
          const settings = mergeSettingsJson('agent', patch.settingsJson as PermissionsSettings);
          if (settings) {
            claudeDir = ensureHomeConfinedDirectory(claudeDir);
            writePermissionsSettings(claudeDir, settings);
          }
        } catch (err) {
          jsonResponse(res, 500, projectError(err, { operation: 'config_write', stage: 'commit' }));
          haltConfigUpdateAfterResponse();
        }
      }

      // Write enabledPlugins to .claude/settings.json when agentOptions.enabledPlugins changes
      if (patch.agentOptions && merged.type === 'agent') {
        const patchAo = patch.agentOptions as Record<string, unknown>;
        if (patchAo.enabledPlugins !== undefined && (patchAo.enabledPlugins === null || typeof patchAo.enabledPlugins === 'object')) {
          const ao = merged.agentOptions as Record<string, unknown>;
          const cwd = ao.cwd as string;
          try {
            let claudeDir = path.join(cwd, '.claude');
            claudeDir = ensureHomeConfinedDirectory(claudeDir);
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
            } catch { /* intentional: use defaults when settings.json is missing or unreadable */ }
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
  jsonResponse(res, 200, projectClientOutputPolicyConfig(mergedClean));
}

function resolveHomeConfinedPath(
  inputPath: string,
  res: ServerResponse,
  error: string,
  spellingError: string = error,
): string | null {
  if (hasUnsupportedTildePrefix(inputPath)) {
    jsonResponse(res, 400, { error });
    return null;
  }
  // Two forms, deliberately kept apart:
  //  - `expanded` is the RAW spelling with `..` INTACT. It is what the physical
  //    check must judge, because it is what gets persisted and rendered.
  //  - `resolved` is the lexically collapsed form, used only as a cheap first
  //    gate and as the return value.
  const expanded = expandHomePath(inputPath);
  // Refuse `.`/`..` components outright, on the tilde-expanded spelling.
  //
  // Chosen over resolving left-to-right because this route PERSISTS the
  // lexically collapsed form: validating one string and storing another is the
  // shape that produced the traversal bypass in the first place. Refusing the
  // spelling makes the validated value and the stored value identical, and it
  // is the same reject-not-canonicalise rule the service block already applies.
  // A canonical form always exists, and no caller in this repo passes `..`.
  if (!isCanonicalAbsolutePath(expanded)) {
    // A distinct message: the path may well BE inside home, so telling the
    // operator it "must be within the home directory" points at the wrong fix.
    jsonResponse(res, 400, { error: spellingError });
    return null;
  }
  const resolved = path.resolve(expanded);
  const homePath = path.resolve(os.homedir());
  if (!pathIsInsideDirectory(resolved, homePath)) {
    jsonResponse(res, 400, { error });
    return null;
  }

  // Make the raw spelling absolute WITHOUT normalising it: `path.resolve` would
  // collapse the `..` this check exists to catch.
  const rawAbsolute = rawAbsolutePath(expanded);

  try {
    const homeReal = fs.realpathSync.native(homePath);
    if (!plannedPrefixIsConfined(rawAbsolute, homeReal)) {
      jsonResponse(res, 400, { error });
      return null;
    }
  } catch {
    jsonResponse(res, 400, { error });
    return null;
  }

  try {
    return admitHomeConfinedPath(resolved, homePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        if (plannedPrefixIsConfined(rawAbsolute, fs.realpathSync.native(homePath))) {
          return resolved; // Planned path; creation and final consumption revalidate it.
        }
      } catch {
        jsonResponse(res, 400, { error });
        return null;
      }
    }
    jsonResponse(res, 400, { error });
    return null;
  }
}

export function ensureHomeConfinedDirectory(dirPath: string): string {
  return provisionHomeConfinedDirectory(dirPath, os.homedir());
}

/**
 * Resolve agentOptions.cwd and verify it is within the home directory.
 * Mutates agentOptions.cwd in-place to the resolved absolute path.
 * Returns the resolved path on success, null and writes a 400 on failure.
 */
function resolveAndValidateCwd(agentOptions: Record<string, unknown>, res: ServerResponse): string | null {
  const cwd = agentOptions.cwd as string;
  if (!cwd.trim()) return cwd; // empty — caller decides whether it's valid
  const safeCwd = resolveHomeConfinedPath(
    cwd,
    res,
    'agentOptions.cwd must be within the home directory',
    'agentOptions.cwd must be a normalized absolute path within the home directory',
  );
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

export function defaultAgentOptions(name: string): Record<string, unknown> {
  return { cwd: defaultAgentCwd(name), sessionScope: 'per_chat' };
}

export function resolveAndValidateAgentCwd(
  name: string,
  agentOptions: Record<string, unknown>,
  res: ServerResponse,
): string | null {
  const cwd = agentOptions.cwd;
  // The typeof guard is load-bearing, not redundant: it keeps a non-string,
  // non-null cwd (e.g. a number) falling through to the `else if` 400 branch
  // below instead of being silently defaulted here.
  if (cwd == null || (typeof cwd === 'string' && !isNonEmptyString(cwd))) {
    agentOptions.cwd = defaultAgentCwd(name);
  } else if (typeof cwd !== 'string') {
    jsonResponse(res, 400, { error: 'agentOptions.cwd must be a string within the home directory' });
    return null;
  }
  if (agentOptions.sessionScope == null || (typeof agentOptions.sessionScope === 'string' && !isNonEmptyString(agentOptions.sessionScope))) {
    agentOptions.sessionScope = 'per_chat';
  }

  return resolveAndValidateCwd(agentOptions, res);
}

/**
 * Validate a list of filesystem paths as home-confined, returning the accepted
 * physical paths for existing entries and canonical spellings for planned paths.
 *
 * One helper for both callers: `agentOptions.pluginDirs` and the launchd
 * `service` block ran near-identical loops over the same predicate, so a fix to
 * one silently missed the other.
 *
 * `fieldFor(index)` names the offending field; the two messages are derived
 * from it so a caller cannot drift them apart. Writes a 400 and returns null on
 * the first violation.
 */
function validateHomeConfinedPathList(
  values: readonly unknown[],
  res: ServerResponse,
  fieldFor: (index: number) => string,
): string[] | null {
  const accepted: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const field = fieldFor(i);
    const containmentError = `${field} must be within the home directory`;
    const spellingError = `${field} must be a normalized absolute path within the home directory`;
    const value = values[i];
    if (typeof value !== 'string') {
      jsonResponse(res, 400, { error: containmentError });
      return null;
    }
    const safe = resolveHomeConfinedPath(value, res, containmentError, spellingError);
    if (safe === null) return null;
    accepted.push(safe);
  }
  return accepted;
}

/**
 * Validate that every entry in pluginDirs is a string within the home directory.
 * Writes a 400 response and returns false on the first violation; returns true when valid.
 */
export function validatePluginDirs(dirs: unknown[], res: ServerResponse): boolean {
  const accepted = validateHomeConfinedPathList(dirs, res, () => 'each pluginDirs entry');
  if (accepted === null) return false;
  dirs.splice(0, dirs.length, ...accepted);
  return true;
}

/**
 * Confine the launchd `service` block's filesystem fields — `claudeConfigDir`
 * and every `pathPrepend` entry — to the instance user's home directory.
 *
 * Deliberately a ROUTE guard rather than a rule in
 * `validateLaunchdServiceConfig` (src/lib/launchd-service-config.ts): that
 * validator is the shared shape contract and also runs on config *load*, so
 * rejecting an out-of-home value there would stop an instance that already
 * persisted one from loading at all.
 *
 * This is no longer the only confinement check.
 * `assertHomeConfinedRenderOptions` (src/fleet/platform.ts) applies the same
 * rule again at plist RENDER admission, on the reconcile and first-install
 * paths, so an already-persisted out-of-home value still LOADS but no longer
 * RENDERS. This guard is the early feedback half: it refuses the write with a
 * 400 naming the field, while the operator is still at the keyboard, rather
 * than at the next reconcile.
 *
 * The two are not redundant. Admission cannot bind a value whose meaning can
 * still change: a path admitted while an intermediate segment was absent
 * resolves to wherever a symlink later created at that segment points, and
 * admission has already happened by then.
 *
 * Runs after the shared validator, so shape (absolute, bounded, no control
 * characters, no ':') is already guaranteed; the typeof guards are
 * defense-in-depth for callers that reorder the checks. Existing paths are
 * replaced with their accepted physical form before persistence.
 *
 * Writes a 400 and returns false on the first violation; returns true when the
 * block is absent or entirely home-confined. Mirrors validatePluginDirs above.
 */
export function validateServiceHomeConfinement(service: unknown, res: ServerResponse): boolean {
  if (service === undefined || service === null) return true;
  if (typeof service !== 'object' || Array.isArray(service)) return true; // shape validator owns this
  const block = service as Record<string, unknown>;

  const claudeConfigDir = block['claudeConfigDir'];
  if (claudeConfigDir !== undefined) {
    const accepted = validateHomeConfinedPathList(
      [claudeConfigDir], res, () => 'service.claudeConfigDir',
    );
    if (accepted === null) return false;
    block['claudeConfigDir'] = accepted[0];
  }

  const pathPrepend = block['pathPrepend'];
  if (Array.isArray(pathPrepend)) {
    const accepted = validateHomeConfinedPathList(
      pathPrepend, res, (i) => `service.pathPrepend[${i}]`,
    );
    if (accepted === null) return false;
    block['pathPrepend'] = accepted;
  }

  return true;
}

/**
 * Deduplicate and normalize an array of phone strings using E.164 format.
 */
export function normalizeAdminPhones(phones: string[]): string[] {
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
// Helpers shared with handleCreateLine
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

export function emitInventoryFailure(res: ServerResponse, result: HealthPortInventory): boolean {
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
export function scanHealthPortInventory(excludeName?: string): HealthPortInventory {
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
