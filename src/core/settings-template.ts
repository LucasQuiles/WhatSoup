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
 * Returns the default settings.json content for a given instance type.
 * Only agent instances need settings (they run Claude Code subprocesses).
 * Returns null for chat/passive types.
 */
export function defaultSettingsJson(type: string): PermissionsSettings | null {
  if (type !== 'agent') return null;
  return {
    permissions: {
      allow: [...AGENT_DEFAULT_ALLOW],
      deny: [],
      defaultMode: 'bypassPermissions',
    },
  };
}

/**
 * Validate that a value has the shape of PermissionsSettings.
 * Guards against arbitrary JSON being written to settings.json.
 */
export function isValidPermissionsSettings(v: unknown): v is PermissionsSettings {
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

/**
 * Merge custom settings with defaults for a given instance type.
 * Custom settings fully replace the permissions block (not merged field-by-field).
 * Returns null for non-agent types or invalid input.
 */
export function mergeSettingsJson(
  type: string,
  custom: PermissionsSettings | undefined,
): PermissionsSettings | null {
  if (type !== 'agent') return null;
  if (!custom) return defaultSettingsJson(type);
  if (!isValidPermissionsSettings(custom)) return defaultSettingsJson(type);
  return custom;
}
