import { realpathSync } from 'node:fs';
import type { ZodType } from 'zod';
import type { WhatsAppSocket } from '../transport/connection.ts';
import { toConversationKey } from '../core/conversation-key.ts';

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
  /**
   * Caller identity (sender JID) for admin-gated tools. In groups, `deliveryJid`
   * is the group JID — NOT the person who sent the message — so admin checks
   * MUST gate on `actorJid`. Populated by the runtime when dispatching tools in
   * response to an inbound message. Absent in synthetic/global contexts.
   */
  actorJid?: string;
  /** Filesystem boundary for file-access tools. Set to workspacePath for sandboxed sessions. */
  allowedRoot?: string;
  /** Abort signal tied to the MCP client connection. Fires when the client disconnects. */
  abortSignal?: AbortSignal;
}

export interface ToolDeclaration {
  name: string;
  description: string;
  schema: ZodType;
  scope: ToolScope;
  targetMode: TargetMode;
  /** Controls how this tool call is replayed on recovery. Defaults to 'unsafe'. */
  replayPolicy?: 'safe' | 'unsafe' | 'read_only';
  /**
   * Whether this tool is required for a healthy boot. Default `true`.
   *
   * Modules whose registration is opt-in or vendor-gated (e.g. the Pinecone-backed
   * `knowledge_search`) should set `core: false` so that registration failures are
   * logged and skipped instead of aborting boot. Core tools (messaging, chat
   * management, search, etc.) must register successfully — a failure inside any
   * core module surfaces as a fatal error from `registerAllTools` so the host
   * never silently ships a partial toolset.
   */
  core?: boolean;
  /**
   * Marks a tool as sensitive (R1 declarative gate). Sensitive tools are
   * hidden from listTools and denied at call time unless the session
   * passes the registry's installed sensitive-tool authorizer (the
   * per-turn actorJid admin predicate). Fail-closed: no actorJid, no
   * authorizer, or an authorizer error all deny. The flag ADDS a central
   * gate; in-handler checks remain as defense in depth.
   */
  sensitive?: boolean;
  handler: (params: Record<string, unknown>, session: SessionContext) => Promise<unknown>;
}

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const TOOL_ERROR = Symbol('whatsoup.toolError');

export type ToolErrorPayload<T extends Record<string, unknown> = Record<string, unknown>> = T & {
  readonly [TOOL_ERROR]: true;
};

export function toolError<T extends Record<string, unknown>>(payload: T): ToolErrorPayload<T> {
  const result = { ...payload };
  Object.defineProperty(result, TOOL_ERROR, { value: true });
  return result as ToolErrorPayload<T>;
}

export function errorResult(error: string) {
  return toolError({ error });
}

export function isToolErrorPayload(value: unknown): value is ToolErrorPayload {
  return typeof value === 'object' && value !== null && (value as { [TOOL_ERROR]?: unknown })[TOOL_ERROR] === true;
}

/**
 * Normalize a caller-supplied key that may be a raw JID (`…@g.us`) into the
 * `_at_` encoded conversation_key used in the DB.  When the session is
 * chat-scoped the already-normalized session key wins.
 */
export function resolveConversationKey(session: SessionContext, callerKey: string): string {
  if (session.tier === 'chat-scoped') return session.conversationKey!;
  // Caller may pass a raw JID — normalize it to the DB encoding.
  try { return toConversationKey(callerKey); } catch { return callerKey; }
}

export function assertConversationAccess(
  conversationKey: string,
  session: SessionContext,
  label = 'Resource',
): void {
  if (!session.conversationKey) return;
  if (conversationKey !== session.conversationKey) {
    throw new Error(`${label} belongs to a different conversation`);
  }
}

/**
 * Check whether a resolved filesystem path is within the session's allowedRoot.
 *
 * Both the resolved path and the allowedRoot are canonicalized via realpathSync
 * before comparison so this works correctly on macOS, where /var/folders is a
 * symlink to /private/var/folders (and the same for /tmp).
 *
 * Fail-closed: returns false when allowedRoot is undefined. A session with no
 * configured root must not be able to read arbitrary host files (audit #1094);
 * every file-capable session is required to set an explicit allowedRoot.
 */
export function isPathWithinAllowedRoot(
  resolvedPath: string,
  allowedRoot: string | undefined,
): boolean {
  if (!allowedRoot) return false;
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
