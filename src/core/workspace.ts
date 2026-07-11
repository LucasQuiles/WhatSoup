// src/core/workspace.ts
// Pure functions for mapping chat JIDs to workspace paths.

import {
  existsSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  applyRequiredDeny,
  defaultSettingsJson,
  type PermissionsSettings,
} from './settings-template.ts';
import { toConversationKey } from './conversation-key.ts';
import { JID_PERSONAL, JID_LID, JID_GROUP } from './jid-constants.ts';
import {
  writeProviderMcpConfig,
  type AdditionalMcpServerConfig,
  type OpencodeProviderConfig,
} from './provider-mcp-config.ts';
import { createChildLogger } from '../logger.ts';
import {
  assertPrivateDirectorySync,
  ensurePrivateDirectorySync,
  writePrivateFileSync,
} from '../lib/private-fs.ts';

export { writePrivateFileSync } from '../lib/private-fs.ts';

const log = createChildLogger('workspace');

export interface WorkspaceInfo {
  kind: 'dm' | 'group';
  workspacePath: string;  // absolute path to the workspace directory
  workspaceKey: string;   // the directory name (phone or sanitized JID)
}

/**
 * Maps a chat JID to a WorkspaceInfo containing the kind, key, and absolute path.
 * Uses toConversationKey for consistent workspaceKey computation.
 */
export function chatJidToWorkspace(instanceCwd: string, chatJid: string): WorkspaceInfo {
  const key = toConversationKey(chatJid);

  if (chatJid.endsWith(JID_PERSONAL) || chatJid.endsWith(JID_LID)) {
    return {
      kind: 'dm',
      workspaceKey: key,
      workspacePath: join(instanceCwd, 'users', key),
    };
  }
  if (chatJid.endsWith(JID_GROUP)) {
    return {
      kind: 'group',
      workspaceKey: key,
      workspacePath: join(instanceCwd, 'groups', key),
    };
  }
  // Fallback: treat as DM with raw JID as key
  return {
    kind: 'dm',
    workspaceKey: key,
    workspacePath: join(instanceCwd, 'users', key),
  };
}

export interface SandboxConfig {
  allowedPaths: string[];
  allowedTools: string[];
  allowedMcpTools?: string[];
  allowedEgress?: string[];
  bash: { enabled: boolean; pathRestricted?: boolean };
}

export interface ProvisionOptions {
  workspacePath: string;
  instanceCwd: string;           // parent dir for CLAUDE.md symlink target
  provider?: string;             // agent provider whose CLI config shape should be written
  providerConfig?: OpencodeProviderConfig; // opencode custom endpoint/model config, when applicable
  sandbox: SandboxConfig;        // instance-level config to inherit non-path fields from
  hookPath: string;              // absolute path to agent-sandbox.sh
  mcpServerPath: string;         // absolute path to whatsoup-proxy.ts
  sendMediaServerPath?: string;  // absolute path to send-media-server.ts (optional — enables media bridge)
  pollLintHookPath?: string;     // absolute path to poll-interaction-lint.mjs (optional diagnostics hook)
  postToolUseLogHookPath?: string; // absolute path to post-tool-use-log hook (optional failure alert hook)
  chatScopedToolNames?: string[];  // chat-scoped tool names from registry (used to auto-generate allowedMcpTools)
}

/**
 * Build the allowedMcpTools array from chat-scoped tool names.
 * Each name is prefixed with `mcp__whatsoup__`.
 * If includeSendMedia is true, `mcp__send-media__send_media` is appended.
 */
export function buildMcpAllowlist(chatScopedToolNames: string[], includeSendMedia: boolean): string[] {
  const list = chatScopedToolNames.map(name => `mcp__whatsoup__${name}`);
  if (includeSendMedia) {
    list.push('mcp__send-media__send_media');
  }
  return list;
}

function writeWorkspaceMcpConfig(
  provider: string,
  workspacePath: string,
  socketPath: string,
  mcpServerPath: string,
  mediaBridgeSocketPath: string,
  sendMediaServerPath?: string,
  providerConfig?: OpencodeProviderConfig,
): void {
  const additionalServers: AdditionalMcpServerConfig[] = [];
  if (sendMediaServerPath) {
    additionalServers.push({
      name: 'send-media',
      proxyScriptPath: sendMediaServerPath,
      env: { MEDIA_BRIDGE_SOCKET: mediaBridgeSocketPath },
    });
  }
  writeProviderMcpConfig(provider, workspacePath, socketPath, mcpServerPath, providerConfig, additionalServers);
}

/**
 * Write sandbox-policy.json and settings.json into an existing .claude/ directory.
 * Both files are always overwritten (deterministic).
 *
 * @param claudeDir  Absolute path to the .claude/ directory (must already exist).
 * @param policy     The sandbox policy object to serialise as sandbox-policy.json.
 * @param hookPath   Absolute path to agent-sandbox.sh wired as the PreToolUse hook.
 * @param pollLintHookPath Absolute path to poll-interaction-lint.mjs wired as an optional PostToolUse hook.
 * @param postToolUseLogHookPath Absolute path to post-tool-use-log.sh wired as an optional tool failure hook.
 */
export function writeSandboxArtifacts(
  claudeDir: string,
  policy: Record<string, unknown>,
  hookPath: string,
  pollLintHookPath?: string,
  postToolUseLogHookPath?: string,
): void {
  try {
    writePrivateFileSync(join(claudeDir, 'sandbox-policy.json'), JSON.stringify(policy, null, 2));

    const hooks: Record<string, unknown> = {
      PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: hookPath }] }],
    };
    const postToolUseHooks: Array<{ type: 'command'; command: string }> = [];
    if (pollLintHookPath) {
      postToolUseHooks.push({ type: 'command', command: pollLintHookPath });
    }
    if (postToolUseLogHookPath) {
      postToolUseHooks.push({ type: 'command', command: postToolUseLogHookPath });
      hooks.PostToolUseFailure = [{ matcher: '', hooks: [{ type: 'command', command: postToolUseLogHookPath }] }];
    }
    if (postToolUseHooks.length > 0) hooks.PostToolUse = [{ matcher: '', hooks: postToolUseHooks }];
    const settings = { hooks };
    writePrivateFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));
  } catch (err) {
    log.error({ err, claudeDir }, 'failed to write sandbox artifacts');
    throw err;
  }
}

/**
 * Write or update the permissions block in settings.json, preserving existing
 * keys (hooks, env, etc.). Creates the .claude/ directory if needed.
 *
 * @param claudeDir  Absolute path to the .claude/ directory.
 * @param settings   The permissions settings object to merge in.
 */
export function writePermissionsSettings(
  claudeDir: string,
  settings: PermissionsSettings,
): void {
  try {
    ensurePrivateDirectorySync(claudeDir);
    const settingsPath = join(claudeDir, 'settings.json');

    let existing: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        existing = JSON.parse(readFileSync(settingsPath, 'utf8'));
      } catch (err) {
        // Corrupt file — overwrite entirely (destructive: customizations are lost)
        log.warn({ err, settingsPath }, 'settings.json unreadable; overwriting with generated settings');
      }
    }

    const mergedPermissions = {
      ...settings.permissions,
      deny: applyRequiredDeny(settings.permissions.deny),
    };
    const merged: Record<string, unknown> = { ...existing, permissions: mergedPermissions };
    if (settings.enabledPlugins !== undefined) {
      // null or {} = reset to global inheritance; non-empty object = override
      merged.enabledPlugins = settings.enabledPlugins ?? {};
    }
    writePrivateFileSync(settingsPath, JSON.stringify(merged, null, 2));
  } catch (err) {
    log.error({ err, claudeDir }, 'failed to write permissions settings');
    throw err;
  }
}

/**
 * Remove an orphaned agent-sandbox PreToolUse hook from a parsed settings object.
 * Mutates `settings.hooks.PreToolUse` in place; returns true if anything was removed.
 *
 * Only the WhatSoup-managed `agent-sandbox.sh` hook is targeted — unrelated PreToolUse
 * hooks are preserved. If PreToolUse becomes empty, the key is deleted so the shape
 * matches a fresh non-sandbox agent.
 */
function stripOrphanSandboxHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as
    | { PreToolUse?: Array<{ hooks?: Array<{ command?: unknown }> }> }
    | undefined;
  if (!hooks || !Array.isArray(hooks.PreToolUse)) return false;
  const before = hooks.PreToolUse.length;
  const filtered = hooks.PreToolUse.filter(
    entry =>
      !(
        Array.isArray(entry.hooks) &&
        entry.hooks.some(h => typeof h.command === 'string' && h.command.includes('agent-sandbox.sh'))
      ),
  );
  if (filtered.length === before) return false;
  if (filtered.length === 0) {
    delete hooks.PreToolUse;
  } else {
    hooks.PreToolUse = filtered;
  }
  return true;
}

/**
 * Ensure a settings.json with a permissions block exists in claudeDir.
 * - If settings.json doesn't exist, writes the default for the instance type.
 * - If settings.json exists but has no permissions block, adds the default.
 * - If settings.json already has a permissions block, preserves custom entries and
 *   restores the repo-owned deny floor when it has drifted.
 * - For non-agent types, does nothing.
 *
 * This is the safety-net called from AgentRuntime.start() to prevent
 * Claude Code's "sensitive file" blocks on instances without sandbox config.
 */
export function ensurePermissionsSettings(
  claudeDir: string,
  type: string,
  enabledPlugins?: Record<string, boolean>,
  opts?: { hasSandbox?: boolean },
): void {
  try {
    if (type !== 'agent') return;

    const defaults = defaultSettingsJson(type);
    if (!defaults) return;

    ensurePrivateDirectorySync(claudeDir);
    const settingsPath = join(claudeDir, 'settings.json');

    if (existsSync(settingsPath)) {
      try {
        const existing = JSON.parse(readFileSync(settingsPath, 'utf8'));
        // Reconcile an orphaned fail-closed agent-sandbox PreToolUse hook: when the
        // instance has no sandbox config, writeSandboxArtifacts never runs, so a hook
        // left over from a prior sandboxed config is unmanaged and bricks every tool
        // if its policy file goes missing. Strip it here (the always-run reconciler).
        let settingsChanged = false;
        if (opts?.hasSandbox === false) {
          settingsChanged = stripOrphanSandboxHook(existing);
        }
        // Apply enabledPlugins from config — always overwrite to stay in sync
        if (enabledPlugins) {
          existing.enabledPlugins = enabledPlugins;
          settingsChanged = true;
        }

        if (existing.permissions && typeof existing.permissions === 'object') {
          const permissions = existing.permissions as Record<string, unknown>;
          const validPermissions = Array.isArray(permissions.allow)
            && permissions.allow.every((entry) => typeof entry === 'string')
            && Array.isArray(permissions.deny)
            && permissions.deny.every((entry) => typeof entry === 'string')
            && permissions.defaultMode === 'bypassPermissions';
          if (validPermissions) {
            const currentDeny = permissions.deny as string[];
            const repairedDeny = applyRequiredDeny(currentDeny);
            if (repairedDeny.length !== currentDeny.length) {
              existing.permissions = {
                ...permissions,
                deny: repairedDeny,
              };
              settingsChanged = true;
            }
          } else {
            existing.permissions = {
              ...defaults.permissions,
            };
            settingsChanged = true;
          }
          if (settingsChanged) {
            writePrivateFileSync(settingsPath, JSON.stringify(existing, null, 2));
          }
          return;
        }

        // Has settings (e.g. hooks) but no permissions — add them
        const merged = { ...existing, permissions: defaults.permissions };
        writePrivateFileSync(settingsPath, JSON.stringify(merged, null, 2));
      } catch (err) {
        // Corrupt file — overwrite with defaults (destructive: customizations are lost)
        log.warn({ err, settingsPath }, 'settings.json unreadable; overwriting with default permissions');
        const out: Record<string, unknown> = { ...defaults };
        if (enabledPlugins) out.enabledPlugins = enabledPlugins;
        writePrivateFileSync(settingsPath, JSON.stringify(out, null, 2));
      }
      return;
    }

    // No settings.json at all — write defaults + enabledPlugins if provided
    const out: Record<string, unknown> = { ...defaults };
    if (enabledPlugins) out.enabledPlugins = enabledPlugins;
    writePrivateFileSync(settingsPath, JSON.stringify(out, null, 2));
  } catch (err) {
    log.error({ err, claudeDir, type }, 'failed to ensure permissions settings');
    throw err;
  }
}

/**
 * Provision (or re-provision) a workspace directory. Returns the WhatSoup socket path.
 * Deterministic — always overwrites existing files.
 */
export function provisionWorkspace(opts: ProvisionOptions): string {
  const { workspacePath, instanceCwd, provider = 'claude-cli', providerConfig, sandbox, hookPath, pollLintHookPath, postToolUseLogHookPath, mcpServerPath, sendMediaServerPath } = opts;

  try {
    // 1. Ensure .claude/ directory exists without following directory symlinks.
    ensurePrivateDirectorySync(workspacePath);
    const claudeDir = join(workspacePath, '.claude');
    ensurePrivateDirectorySync(claudeDir);

    // 2. Write sandbox-policy.json and settings.json via shared helper
    const mcpAllowlist = opts.chatScopedToolNames
      ? buildMcpAllowlist(opts.chatScopedToolNames, !!opts.sendMediaServerPath)
      : undefined;

    const sandboxPolicy = {
      allowedPaths: [workspacePath],
      allowedTools: sandbox.allowedTools,
      ...(sandbox.allowedMcpTools !== undefined ? { allowedMcpTools: sandbox.allowedMcpTools }
        : mcpAllowlist ? { allowedMcpTools: mcpAllowlist } : {}),
      ...(sandbox.allowedEgress !== undefined ? { allowedEgress: sandbox.allowedEgress } : {}),
      bash: sandbox.bash,
    };
    writeSandboxArtifacts(claudeDir, sandboxPolicy, hookPath, pollLintHookPath, postToolUseLogHookPath);

    // 3. Compute socket path (whatsoup.sock)
    const socketPath = join(claudeDir, 'whatsoup.sock');

    // 4. Write provider-specific MCP config — whatsoup-proxy + optional send-media entry
    const mediaBridgeSocketPath = join(claudeDir, 'media-bridge.sock');
    writeWorkspaceMcpConfig(provider, workspacePath, socketPath, mcpServerPath, mediaBridgeSocketPath, sendMediaServerPath, providerConfig);

    // 5. Symlink CLAUDE.md -> instanceCwd/CLAUDE.md (recreate if already exists)
    const symlinkPath = join(workspacePath, 'CLAUDE.md');
    const symlinkTarget = join(instanceCwd, 'CLAUDE.md');
    try {
      unlinkSync(symlinkPath);
    } catch {
      // Ignore error if symlink does not exist yet
    }
    symlinkSync(symlinkTarget, symlinkPath);

    // 6. Return socket path
    return socketPath;
  } catch (err) {
    log.error({ err, workspacePath }, 'workspace provisioning failed');
    throw err;
  }
}
