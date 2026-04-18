import { realpathSync } from 'node:fs';
import type { ZodType } from 'zod';
import type { WhatsAppSocket } from '../transport/connection.ts';

export type ToolScope = 'chat' | 'global';
export type TargetMode = 'injected' | 'caller-supplied';
export type SessionTier = 'global' | 'chat-scoped';

/**
 * MCP tool socket type — re-exports WhatsAppSocket for use by tool files.
 *
 * The upstream Baileys type definitions now include all methods used by
 * MCP tools (community, newsletter, business, profile, privacy, calls,
 * advanced/protocol). This alias provides a single import point for tool
 * files and serves as an extension seam if future Baileys versions drop
 * method declarations.
 *
 * Previously, tool files used 70+ `(sock as any)` casts because these
 * methods weren't in the type definitions. They are now fully typed
 * upstream, so the casts have been removed.
 */
export type ExtendedBaileysSocket = WhatsAppSocket;

export interface SessionContext {
  tier: SessionTier;
  /** Canonical conversation identity — for reads, queries, scope checks */
  conversationKey?: string;
  /** Current raw JID alias — for sends, replies, reactions */
  deliveryJid?: string;
  /** Filesystem boundary for file-access tools. Set to workspacePath for sandboxed sessions. */
  allowedRoot?: string;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  schema: ZodType;
  scope: ToolScope;
  targetMode: TargetMode;
  /** Controls how this tool call is replayed on recovery. Defaults to 'unsafe'. */
  replayPolicy?: 'safe' | 'unsafe' | 'read_only';
  handler: (params: Record<string, unknown>, session: SessionContext) => Promise<unknown>;
}

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function resolveConversationKey(session: SessionContext, callerKey: string): string {
  return session.tier === 'chat-scoped' ? session.conversationKey! : callerKey;
}

/**
 * Check whether a resolved filesystem path is within the session's allowedRoot.
 *
 * Both the resolved path and the allowedRoot are canonicalized via realpathSync
 * before comparison so this works correctly on macOS, where /var/folders is a
 * symlink to /private/var/folders (and the same for /tmp).
 *
 * Returns true if allowedRoot is undefined (no boundary enforced).
 */
export function isPathWithinAllowedRoot(
  resolvedPath: string,
  allowedRoot: string | undefined,
): boolean {
  if (!allowedRoot) return true;
  let canonicalAllowedRoot: string;
  try {
    canonicalAllowedRoot = realpathSync(allowedRoot);
  } catch {
    canonicalAllowedRoot = allowedRoot;
  }
  return (
    resolvedPath === canonicalAllowedRoot ||
    resolvedPath.startsWith(canonicalAllowedRoot + "/")
  );
}

