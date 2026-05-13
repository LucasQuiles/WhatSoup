// src/core/settings-template.ts
// Default settings.json templates per instance type.
// Agent instances need a permissions block to prevent Claude Code's
// built-in "sensitive file" protection from blocking tool calls.

export interface PermissionsSettings {
  permissions: {
    allow: string[];
    deny: string[];
    defaultMode: 'bypassPermissions';
  };
  enabledPlugins?: Record<string, boolean>;
}

/**
 * Default tool allow list for agent instances.
 * Includes core tools + wildcard MCP patterns for common integrations.
 */
export const AGENT_DEFAULT_ALLOW: readonly string[] = Object.freeze([
  'Bash',
  'Read',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'Task',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'mcp__whatsoup__*',
  'mcp__pinecone__*',
  'mcp__playwright__*',
  'mcp__render__*',
  'mcp__plugin_*',
  'mcp__claude_ai_*',
  'mcp__google-workspace__*',
]);

/**
 * Repo-owned deny floor — patterns that must always appear in
 * `permissions.deny` for an agent instance, regardless of caller input.
 *
 * `mergeSettingsJson` unions this list into the merged deny array, and
 * `isValidPermissionsSettings` asserts that every entry survives.
 *
 * TODO(#411): populate with mutation-capable patterns (send mail, drive
 * create/update/delete, calendar mutations, M365 write tools, …) when
 * fleets opt in to fail-closed default. Shipping empty keeps the merge a
 * no-op so existing fleets (notably `mw-bot` with `ALLOW_M365_MUTATIONS=1`)
 * are observably unchanged.
 */
export const REQUIRED_DENY: readonly string[] = Object.freeze([]);

/**
 * Union the caller-provided deny list with `REQUIRED_DENY`, preserving
 * caller order first and appending any floor entries that the caller did
 * not already include. Stable, idempotent, and order-preserving for
 * existing fleets.
 */
export function applyRequiredDeny(deny: readonly string[]): string[] {
  const seen = new Set<string>(deny);
  const out: string[] = [...deny];
  for (const entry of REQUIRED_DENY) {
    if (!seen.has(entry)) {
      out.push(entry);
      seen.add(entry);
    }
  }
  return out;
}

/**
 * Returns the default settings.json content for a given instance type.
 * Only agent instances need settings (they run Claude Code subprocesses).
 * Returns null for chat/passive types.
 */
export function defaultSettingsJson(type: string): PermissionsSettings | null {
  if (type !== 'agent') return null;
  return {
    permissions: {
      allow: [...AGENT_DEFAULT_ALLOW],
      deny: applyRequiredDeny([]),
      defaultMode: 'bypassPermissions',
    },
  };
}

/**
 * Validate that a value has the shape of PermissionsSettings.
 * Guards against arbitrary JSON being written to settings.json.
 *
 * Also asserts that the `REQUIRED_DENY` floor is a subset of the deny
 * list — callers cannot strip mandatory deny entries through a custom
 * settings payload. With an empty `REQUIRED_DENY` (current default) the
 * subset check is trivially satisfied and existing callers are unaffected.
 */
export function isValidPermissionsSettings(v: unknown): v is PermissionsSettings {
  if (typeof v !== 'object' || v === null) return false;
  const p = (v as Record<string, unknown>).permissions;
  if (typeof p !== 'object' || p === null) return false;
  const perms = p as Record<string, unknown>;
  const shapeOk = Array.isArray(perms.allow)
    && (perms.allow as unknown[]).every((x: unknown) => typeof x === 'string')
    && Array.isArray(perms.deny)
    && (perms.deny as unknown[]).every((x: unknown) => typeof x === 'string')
    && perms.defaultMode === 'bypassPermissions';
  if (!shapeOk) return false;
  // Deny-floor subset check: every REQUIRED_DENY entry must already
  // be present in the supplied deny list. mergeSettingsJson will union
  // them anyway, but rejecting here lets the loader surface drift early
  // (e.g. an operator hand-editing settings.json to drop a floor entry).
  const denyList = perms.deny as string[];
  const denySet = new Set(denyList);
  for (const required of REQUIRED_DENY) {
    if (!denySet.has(required)) return false;
  }
  return true;
}

/**
 * Merge custom settings with defaults for a given instance type.
 * Custom settings fully replace the permissions block (not merged field-by-field),
 * but the `REQUIRED_DENY` floor is always unioned into the resulting deny list.
 * Returns null for non-agent types or invalid input.
 */
export function mergeSettingsJson(
  type: string,
  custom: PermissionsSettings | undefined,
): PermissionsSettings | null {
  if (type !== 'agent') return null;
  if (!custom) return defaultSettingsJson(type);
  // Validate shape only — the validator's deny-floor subset check is
  // intentionally skipped here so custom payloads that omit floor entries
  // still get a merge with the floor unioned in (rather than a fallback
  // to defaults). This keeps the floor enforceable without making every
  // legacy caller round-trip through the validator.
  if (!isValidPermissionsShape(custom)) return defaultSettingsJson(type);
  return {
    ...custom,
    permissions: {
      ...custom.permissions,
      deny: applyRequiredDeny(custom.permissions.deny),
    },
  };
}

/**
 * Shape-only check, factored out of `isValidPermissionsSettings` so
 * `mergeSettingsJson` can union the floor into otherwise-valid payloads
 * without rejecting them outright.
 */
function isValidPermissionsShape(v: unknown): v is PermissionsSettings {
  if (typeof v !== 'object' || v === null) return false;
  const p = (v as Record<string, unknown>).permissions;
  if (typeof p !== 'object' || p === null) return false;
  const perms = p as Record<string, unknown>;
  return Array.isArray(perms.allow)
    && (perms.allow as unknown[]).every((x: unknown) => typeof x === 'string')
    && Array.isArray(perms.deny)
    && (perms.deny as unknown[]).every((x: unknown) => typeof x === 'string')
    && perms.defaultMode === 'bypassPermissions';
}
