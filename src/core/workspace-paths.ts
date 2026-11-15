import { join } from 'node:path';

/**
 * The WhatSoup socket a sandboxed chat workspace serves. `provisionWorkspace`
 * writes it into the workspace MCP config and the runtime binds the workspace
 * session's token to it, so both must read it from here.
 */
export function workspaceSocketPath(workspacePath: string): string {
  return join(workspacePath, '.claude', 'whatsoup.sock');
}
