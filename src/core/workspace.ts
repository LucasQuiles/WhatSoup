// src/core/workspace.ts
// Pure functions for mapping chat JIDs to workspace paths.

import { mkdirSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { toConversationKey } from './conversation-key.ts';

export interface WorkspaceInfo {
  kind: 'dm' | 'group';
  workspacePath: string;  // absolute path to the workspace directory
  workspaceKey: string;   // the directory name (phone or sanitized JID)
}

/**
 * Returns the canonical chat key for a given JID.
 * - DM (@s.whatsapp.net): the phone number
 * - LID (@lid): the numeric ID, stripping any :device qualifier
 * - Group (@g.us): the full JID with '@' replaced by '_at_'
 *
 * Delegates to toConversationKey for consistent canonicalization.
 */
export function canonicalChatKey(chatJid: string): string {
  try {
    return toConversationKey(chatJid);
  } catch {
    // Fallback for malformed JIDs
    return chatJid;
  }
}

/**
 * Maps a chat JID to a WorkspaceInfo containing the kind, key, and absolute path.
 * Uses toConversationKey for consistent workspaceKey computation.
 */
export function chatJidToWorkspace(instanceCwd: string, chatJid: string): WorkspaceInfo {
  const key = toConversationKey(chatJid);

  if (chatJid.endsWith('@s.whatsapp.net') || chatJid.endsWith('@lid')) {
    return {
      kind: 'dm',
      workspaceKey: key,
      workspacePath: join(instanceCwd, 'users', key),
    };
  }
  if (chatJid.endsWith('@g.us')) {
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
}

/**
 * Provision (or re-provision) a workspace directory. Returns the WhatSoup socket path.
 * Deterministic — always overwrites existing files.
 */
export function provisionWorkspace(opts: ProvisionOptions): string {
  const { workspacePath, instanceCwd, sandbox, hookPath, mcpServerPath } = opts;

  // 1. Ensure .claude/ directory exists
  mkdirSync(join(workspacePath, '.claude'), { recursive: true });

  // 2. Write sandbox-policy.json with workspacePath as the sole allowedPath
  const sandboxPolicy = {
    allowedPaths: [workspacePath],
    allowedTools: sandbox.allowedTools,
    ...(sandbox.allowedMcpTools !== undefined ? { allowedMcpTools: sandbox.allowedMcpTools } : {}),
    bash: sandbox.bash,
  };
  writeFileSync(
    join(workspacePath, '.claude', 'sandbox-policy.json'),
    JSON.stringify(sandboxPolicy, null, 2),
  );

  // 3. Write settings.json with the PreToolUse hook
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: hookPath }],
        },
      ],
    },
  };
  writeFileSync(
    join(workspacePath, '.claude', 'settings.json'),
    JSON.stringify(settings, null, 2),
  );

  // 4. Compute socket path (whatsoup.sock)
  const socketPath = join(workspacePath, '.claude', 'whatsoup.sock');

  // 5. Write .mcp.json — whatsoup-proxy entry with WHATSOUP_SOCKET env var
  const mcpConfig = {
    mcpServers: {
      'whatsoup': {
        command: 'node',
        args: ['--experimental-strip-types', mcpServerPath],
        env: { WHATSOUP_SOCKET: socketPath },
      },
    },
  };
  writeFileSync(
    join(workspacePath, '.mcp.json'),
    JSON.stringify(mcpConfig, null, 2),
  );

  // 6. Symlink CLAUDE.md -> instanceCwd/CLAUDE.md (recreate if already exists)
  const symlinkPath = join(workspacePath, 'CLAUDE.md');
  const symlinkTarget = join(instanceCwd, 'CLAUDE.md');
  try {
    unlinkSync(symlinkPath);
  } catch {
    // Ignore error if symlink does not exist yet
  }
  symlinkSync(symlinkTarget, symlinkPath);

  // 7. Return socket path
  return socketPath;
}
