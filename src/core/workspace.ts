// src/core/workspace.ts
// Pure functions for mapping chat JIDs to workspace paths.

import { mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { toConversationKey } from './conversation-key.ts';
import { JID_PERSONAL, JID_LID, JID_GROUP } from './jid-constants.ts';

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
  bash: { enabled: boolean; pathRestricted?: boolean };
}

export interface ProvisionOptions {
  workspacePath: string;
  instanceCwd: string;           // parent dir for CLAUDE.md symlink target
  sandbox: SandboxConfig;        // instance-level config to inherit non-path fields from
  hookPath: string;              // absolute path to agent-sandbox.sh
  mcpServerPath: string;         // absolute path to whatsoup-proxy.ts
  sendMediaServerPath?: string;  // absolute path to send-media-server.ts (optional — enables media bridge)
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

/**
 * Write sandbox-policy.json and settings.json into an existing .claude/ directory.
 * Both files are always overwritten (deterministic).
 *
 * @param claudeDir  Absolute path to the .claude/ directory (must already exist).
 * @param policy     The sandbox policy object to serialise as sandbox-policy.json.
 * @param hookPath   Absolute path to agent-sandbox.sh wired as the PreToolUse hook.
 */
export function writeSandboxArtifacts(
  claudeDir: string,
  policy: Record<string, unknown>,
  hookPath: string,
): void {
  writeFileSync(join(claudeDir, 'sandbox-policy.json'), JSON.stringify(policy, null, 2));

  const settings = {
    hooks: {
      PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: hookPath }] }],
    },
  };
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

/**
 * Provision (or re-provision) a workspace directory. Returns the WhatSoup socket path.
 * Deterministic — always overwrites existing files.
 */
export function provisionWorkspace(opts: ProvisionOptions): string {
  const { workspacePath, instanceCwd, sandbox, hookPath, mcpServerPath, sendMediaServerPath } = opts;

  // 1. Ensure .claude/ directory exists
  const claudeDir = join(workspacePath, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  // 2. Write sandbox-policy.json and settings.json via shared helper
  const mcpAllowlist = opts.chatScopedToolNames
    ? buildMcpAllowlist(opts.chatScopedToolNames, !!opts.sendMediaServerPath)
    : undefined;

  const sandboxPolicy = {
    allowedPaths: [workspacePath],
    allowedTools: sandbox.allowedTools,
    ...(sandbox.allowedMcpTools !== undefined ? { allowedMcpTools: sandbox.allowedMcpTools }
      : mcpAllowlist ? { allowedMcpTools: mcpAllowlist } : {}),
    bash: sandbox.bash,
  };
  writeSandboxArtifacts(claudeDir, sandboxPolicy, hookPath);

  // 3. Compute socket path (whatsoup.sock)
  const socketPath = join(claudeDir, 'whatsoup.sock');

  // 4. Write .mcp.json — whatsoup-proxy + optional send-media entry
  const mediaBridgeSocketPath = join(claudeDir, 'media-bridge.sock');
  const mcpServers: Record<string, unknown> = {
    'whatsoup': {
      command: 'node',
      args: ['--experimental-strip-types', mcpServerPath],
      env: { WHATSOUP_SOCKET: socketPath },
    },
  };
  if (sendMediaServerPath) {
    mcpServers['send-media'] = {
      command: 'node',
      args: ['--experimental-strip-types', sendMediaServerPath],
      env: { MEDIA_BRIDGE_SOCKET: mediaBridgeSocketPath },
    };
  }
  writeFileSync(
    join(workspacePath, '.mcp.json'),
    JSON.stringify({ mcpServers }, null, 2),
  );

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
}
