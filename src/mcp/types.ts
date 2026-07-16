import type { ZodType } from 'zod';
import type { WhatsAppSocket } from '../transport/connection.ts';
import { toConversationKey } from '../core/conversation-key.ts';
import type { TurnReplySink } from '../core/turn-reply.ts';
export { isPathWithinAllowedRoot } from '../lib/path-boundary.ts';

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

/**
 * Explicit conversation-binding discriminator for sessions that serve exactly
 * ONE conversation for their entire lifetime (the per-chat actor socket,
 * F-STICKY-ACTOR). Deliberately distinct from a top-level `conversationKey`
 * on a global session, which shared/operator sockets re-pin per TURN
 * (bindActiveGlobalMcpConversation) while legitimately reading other
 * conversations mid-turn. Hard confinement — read-tool key resolution,
 * global-tool eligibility, handler access checks — keys on this binding only.
 *
 * Binding objects are IMMUTABLE (frozen at construction). Rekeying replaces
 * the object (see WhatSoupSocketServer.updateConversationBinding), so an
 * in-flight request's session snapshot keeps the pair it was admitted under.
 */
export interface ConversationBinding {
  readonly kind: 'conversation-bound';
  /** Canonical conversation identity the session is confined to. */
  readonly conversationKey: string;
  /** Current raw JID alias for sends — the injected-target fill source. */
  readonly deliveryJid: string;
}

export interface SessionContext {
  tier: SessionTier;
  /** Canonical conversation identity — for reads, queries, scope checks */
  conversationKey?: string;
  /** Current raw JID alias — for sends, replies, reactions */
  deliveryJid?: string;
  /**
   * Lifetime conversation confinement. When present, `conversationKey` and
   * `deliveryJid` above are mirrors of the binding (kept coherent by the
   * socket-server mutators); the binding is the source of truth.
   */
  binding?: ConversationBinding;
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
  /** Routes an admitted agent-turn reply through the durable outbound queue. */
  turnReplySink?: TurnReplySink;
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
   * Marks a tool as sensitive (R1 declarative gate). The gate is
   * call-time-authoritative: sensitive tools REMAIN visible in listTools
   * (listing is not a security boundary), and every invocation is denied
   * unless the session passes the registry's installed sensitive-tool
   * authorizer (the per-turn actorJid admin predicate). Fail-closed: no
   * actorJid, no authorizer, or an authorizer error all deny. The flag ADDS
   * a central gate; in-handler checks remain as defense in depth. (See
   * docs/tools.md for the authoritative model.)
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
 * Construct a frozen ConversationBinding — the single enforcement point for
 * the freeze + discriminator contract every construction site must honor.
 */
export function makeConversationBinding(conversationKey: string, deliveryJid: string): ConversationBinding {
  return Object.freeze({ kind: 'conversation-bound', conversationKey, deliveryJid });
}

/**
 * Return the binding's conversation key for a conversation-bound session,
 * undefined otherwise. The single predicate every confinement site keys on.
 */
export function conversationBoundKey(session: SessionContext): string | undefined {
  return session.tier === 'global' && session.binding?.kind === 'conversation-bound'
    ? session.binding.conversationKey
    : undefined;
}

/**
 * Normalize a caller-supplied key that may be a raw JID (`…@g.us`) into the
 * `_at_` encoded conversation_key used in the DB.  When the session is
 * chat-scoped the already-normalized session key wins. A conversation-bound
 * session may address its OWN conversation in either form; any other key is
 * rejected (fail-closed — never silently redirected).
 */
export function resolveConversationKey(session: SessionContext, callerKey: string): string {
  if (session.tier === 'chat-scoped') return session.conversationKey!;
  // Caller may pass a raw JID — normalize it to the DB encoding.
  let resolved: string;
  try { resolved = toConversationKey(callerKey); } catch { resolved = callerKey; }
  const boundKey = conversationBoundKey(session);
  if (boundKey !== undefined && resolved !== boundKey) {
    throw new Error(`conversation_key "${callerKey}" is not available to this conversation-bound session`);
  }
  return resolved;
}

export function assertConversationAccess(
  conversationKey: string,
  session: SessionContext,
  label = 'Resource',
): void {
  // The binding is the source of truth for a conversation-bound session —
  // enforce from it even if the top-level mirror is absent or diverged.
  const enforcedKey = conversationBoundKey(session) ?? session.conversationKey;
  if (!enforcedKey) return;
  if (conversationKey !== enforcedKey) {
    throw new Error(`${label} belongs to a different conversation`);
  }
}
