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
 * Populated from the connector mutation inventory approved for #411.
 * Existing on-disk custom settings are preserved, while the always-run
 * workspace reconciler restores this floor whenever it has drifted.
 */
export const REQUIRED_DENY: readonly string[] = Object.freeze([
  // Google auth-backed mutation tools.
  'mcp__claude_ai_Gmail__create_draft',
  'mcp__claude_ai_Gmail__create_label',
  'mcp__claude_ai_Gmail__delete_label',
  'mcp__claude_ai_Gmail__update_label',
  'mcp__claude_ai_Gmail__label_message',
  'mcp__claude_ai_Gmail__label_thread',
  'mcp__claude_ai_Gmail__unlabel_message',
  'mcp__claude_ai_Gmail__unlabel_thread',
  'mcp__claude_ai_Gmail__apply_sensitive_message_label',
  'mcp__claude_ai_Gmail__apply_sensitive_thread_label',
  'mcp__claude_ai_Google_Calendar__create_event',
  'mcp__claude_ai_Google_Calendar__update_event',
  'mcp__claude_ai_Google_Calendar__delete_event',
  'mcp__claude_ai_Google_Calendar__respond_to_event',
  // QR-029: Google Drive write tools — the connector is allowed (mcp__claude_ai_*),
  // so without an explicit deny these created/copied files in the user's Drive,
  // breaking the "Google Workspace read-only" floor (read tools stay allowed).
  'mcp__claude_ai_Google_Drive__create_file',
  'mcp__claude_ai_Google_Drive__copy_file',

  // Microsoft 365 mutation tools.
  'mcp__plugin_microsoft_365_microsoft_365__add-attachment',
  'mcp__plugin_microsoft_365_microsoft_365__add-chat-member',
  'mcp__plugin_microsoft_365_microsoft_365__add-group-member',
  'mcp__plugin_microsoft_365_microsoft_365__add-table-rows',
  'mcp__plugin_microsoft_365_microsoft_365__add-worksheet',
  'mcp__plugin_microsoft_365_microsoft_365__associate-dataverse-records',
  'mcp__plugin_microsoft_365_microsoft_365__batch-dataverse',
  'mcp__plugin_microsoft_365_microsoft_365__cancel-booking-appointment',
  'mcp__plugin_microsoft_365_microsoft_365__cancel-event',
  'mcp__plugin_microsoft_365_microsoft_365__close-workbook-session',
  'mcp__plugin_microsoft_365_microsoft_365__copy-drive-item',
  'mcp__plugin_microsoft_365_microsoft_365__copy-message',
  'mcp__plugin_microsoft_365_microsoft_365__create-booking-appointment',
  'mcp__plugin_microsoft_365_microsoft_365__create-calendar',
  'mcp__plugin_microsoft_365_microsoft_365__create-chat',
  'mcp__plugin_microsoft_365_microsoft_365__create-contact',
  'mcp__plugin_microsoft_365_microsoft_365__create-dataverse-record',
  'mcp__plugin_microsoft_365_microsoft_365__create-draft',
  'mcp__plugin_microsoft_365_microsoft_365__create-event',
  'mcp__plugin_microsoft_365_microsoft_365__create-folder',
  'mcp__plugin_microsoft_365_microsoft_365__create-group',
  'mcp__plugin_microsoft_365_microsoft_365__create-list-item',
  'mcp__plugin_microsoft_365_microsoft_365__create-mail-folder',
  'mcp__plugin_microsoft_365_microsoft_365__create-mail-rule',
  'mcp__plugin_microsoft_365_microsoft_365__create-notebook',
  'mcp__plugin_microsoft_365_microsoft_365__create-online-meeting',
  'mcp__plugin_microsoft_365_microsoft_365__create-page',
  'mcp__plugin_microsoft_365_microsoft_365__create-plan-task',
  'mcp__plugin_microsoft_365_microsoft_365__create-planner-bucket',
  'mcp__plugin_microsoft_365_microsoft_365__create-section',
  'mcp__plugin_microsoft_365_microsoft_365__create-section-group',
  'mcp__plugin_microsoft_365_microsoft_365__create-sharing-link',
  'mcp__plugin_microsoft_365_microsoft_365__create-site-list',
  'mcp__plugin_microsoft_365_microsoft_365__create-task',
  'mcp__plugin_microsoft_365_microsoft_365__create-task-checklist-item',
  'mcp__plugin_microsoft_365_microsoft_365__create-task-list',
  'mcp__plugin_microsoft_365_microsoft_365__create-upload-session',
  'mcp__plugin_microsoft_365_microsoft_365__create-workbook-session',
  'mcp__plugin_microsoft_365_microsoft_365__delete-calendar',
  'mcp__plugin_microsoft_365_microsoft_365__delete-channel-message',
  'mcp__plugin_microsoft_365_microsoft_365__delete-chat-message',
  'mcp__plugin_microsoft_365_microsoft_365__delete-contact',
  'mcp__plugin_microsoft_365_microsoft_365__delete-dataverse-record',
  'mcp__plugin_microsoft_365_microsoft_365__delete-drive-item',
  'mcp__plugin_microsoft_365_microsoft_365__delete-event',
  'mcp__plugin_microsoft_365_microsoft_365__delete-group',
  'mcp__plugin_microsoft_365_microsoft_365__delete-list-item',
  'mcp__plugin_microsoft_365_microsoft_365__delete-mail-rule',
  'mcp__plugin_microsoft_365_microsoft_365__delete-message',
  'mcp__plugin_microsoft_365_microsoft_365__delete-online-meeting',
  'mcp__plugin_microsoft_365_microsoft_365__delete-page',
  'mcp__plugin_microsoft_365_microsoft_365__delete-plan-task',
  'mcp__plugin_microsoft_365_microsoft_365__delete-planner-bucket',
  'mcp__plugin_microsoft_365_microsoft_365__delete-section',
  'mcp__plugin_microsoft_365_microsoft_365__delete-task',
  'mcp__plugin_microsoft_365_microsoft_365__delete-task-checklist-item',
  'mcp__plugin_microsoft_365_microsoft_365__delete-task-list',
  'mcp__plugin_microsoft_365_microsoft_365__delete-worksheet',
  'mcp__plugin_microsoft_365_microsoft_365__execute-dataverse-action',
  'mcp__plugin_microsoft_365_microsoft_365__execute-tool',
  'mcp__plugin_microsoft_365_microsoft_365__forward-event',
  'mcp__plugin_microsoft_365_microsoft_365__forward-message',
  'mcp__plugin_microsoft_365_microsoft_365__graph-batch',
  'mcp__plugin_microsoft_365_microsoft_365__hub-manage-subscription',
  'mcp__plugin_microsoft_365_microsoft_365__hub-recover-delta',
  'mcp__plugin_microsoft_365_microsoft_365__hub-refresh-account',
  'mcp__plugin_microsoft_365_microsoft_365__hub-trigger-enrich',
  'mcp__plugin_microsoft_365_microsoft_365__mark-message-read',
  'mcp__plugin_microsoft_365_microsoft_365__move-message',
  'mcp__plugin_microsoft_365_microsoft_365__remove-chat-member',
  'mcp__plugin_microsoft_365_microsoft_365__remove-group-member',
  'mcp__plugin_microsoft_365_microsoft_365__rename-drive-item',
  'mcp__plugin_microsoft_365_microsoft_365__reply-all-to-message',
  'mcp__plugin_microsoft_365_microsoft_365__reply-to-channel-message',
  'mcp__plugin_microsoft_365_microsoft_365__reply-to-chat-message',
  'mcp__plugin_microsoft_365_microsoft_365__reply-to-message',
  'mcp__plugin_microsoft_365_microsoft_365__respond-to-event',
  'mcp__plugin_microsoft_365_microsoft_365__restore-item-version',
  'mcp__plugin_microsoft_365_microsoft_365__send-channel-message',
  'mcp__plugin_microsoft_365_microsoft_365__send-chat-message',
  'mcp__plugin_microsoft_365_microsoft_365__send-draft',
  'mcp__plugin_microsoft_365_microsoft_365__send-mail',
  'mcp__plugin_microsoft_365_microsoft_365__undo-delete-channel-message',
  'mcp__plugin_microsoft_365_microsoft_365__undo-delete-chat-message',
  'mcp__plugin_microsoft_365_microsoft_365__update-booking-appointment',
  'mcp__plugin_microsoft_365_microsoft_365__update-calendar',
  'mcp__plugin_microsoft_365_microsoft_365__update-channel-message',
  'mcp__plugin_microsoft_365_microsoft_365__update-chat',
  'mcp__plugin_microsoft_365_microsoft_365__update-chat-message',
  'mcp__plugin_microsoft_365_microsoft_365__update-contact',
  'mcp__plugin_microsoft_365_microsoft_365__update-dataverse-record',
  'mcp__plugin_microsoft_365_microsoft_365__update-draft',
  'mcp__plugin_microsoft_365_microsoft_365__update-event',
  'mcp__plugin_microsoft_365_microsoft_365__update-group',
  'mcp__plugin_microsoft_365_microsoft_365__update-list-item',
  'mcp__plugin_microsoft_365_microsoft_365__update-mail-rule',
  'mcp__plugin_microsoft_365_microsoft_365__update-mailbox-settings',
  'mcp__plugin_microsoft_365_microsoft_365__update-online-meeting',
  'mcp__plugin_microsoft_365_microsoft_365__update-page-content',
  'mcp__plugin_microsoft_365_microsoft_365__update-plan-task',
  'mcp__plugin_microsoft_365_microsoft_365__update-plan-task-details',
  'mcp__plugin_microsoft_365_microsoft_365__update-planner-bucket',
  'mcp__plugin_microsoft_365_microsoft_365__update-range',
  'mcp__plugin_microsoft_365_microsoft_365__update-task',
  'mcp__plugin_microsoft_365_microsoft_365__update-task-checklist-item',
  'mcp__plugin_microsoft_365_microsoft_365__update-task-list',
  'mcp__plugin_microsoft_365_microsoft_365__upload-small-file',
  'mcp__plugin_microsoft_365_microsoft_365__upsert-dataverse-record',
]);

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
 * settings payload.
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
