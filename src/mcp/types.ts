import type { ZodType } from 'zod';
import type { WhatsAppSocket } from '../transport/connection.ts';
import { toConversationKey } from '../core/conversation-key.ts';
import {
  TOOL_FAILURE_CODES,
  TOOL_FAILURE_STAGES,
  type ToolFailureCode,
  type ToolFailureStage,
} from '../core/durability-evidence-contract.ts';
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
  /** Narrow runtime purpose used for fail-closed tool restrictions. */
  purpose?: 'scheduled-agent-job';
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
}

/** Mutable authorization and confinement fields resolved from the turn currently executing. */
export interface ExecutingSessionContext {
  actorJid: SessionContext['actorJid'];
  purpose: SessionContext['purpose'];
  conversationKey: SessionContext['conversationKey'];
  /**
   * Explicit assertion that a REAL executing-turn resolution produced this
   * context (#3435, L1). Optional: a real resolution is normally recognized
   * because it carries at least one defined authorization/confinement field. The
   * all-undefined context is the UNRESOLVED state (`noExecutingSession()`, or a
   * read-time resolver that found no executing-turn entry).
   *
   * WHAT SUPPLIES THAT DEFINED FIELD IS PER-SURFACE, AND IT IS NOT ALWAYS THE
   * TURN. The per-chat actor socket is the standing exception: its resolver
   * substitutes the SOCKET IDENTITY's conversation key whenever the executing turn
   * left one undefined (src/runtimes/agent/per-chat-mcp-socket-manager.ts
   * `conversationKey: executing.conversationKey ?? toConversationKey(identity.value)`),
   * so every context leaving that surface carries a defined `conversationKey` and
   * classifies `'resolved'` whether or not a turn actually resolved — the
   * fail-closed UNRESOLVED branch is unreachable there by construction. That is
   * intentional, not an oversight: the socket is created per bound conversation and
   * its identity IS the confinement, so no ambiguous empty context can reach the
   * gate through it. Do NOT read the branch's presence at that call site as runtime
   * protection.
   *
   * The branch stays load-bearing for the surfaces that CAN emit an all-undefined
   * context: the passive operator socket (`noExecutingSession()`,
   * src/runtimes/passive/runtime.ts) and any read-time resolver that finds no
   * executing-turn entry.
   *
   * Set `resolved: true` ONLY to assert resolution for a legitimately
   * all-undefined resolved turn — in practice just the direct-registry test
   * adapter, which snapshots a caller-built session rather than reading a live
   * register entry. Never set it to paper over an empty resolution: that reopens
   * the fail-open this brand closes. The permitted sites are inventoried and
   * count-pinned by `npm run guard:resolved-override`
   * (scripts/resolved-override-inventory-guard.ts): a production caller setting it
   * fails the push gate.
   */
  resolved?: boolean;
}

declare const resolvedSessionContextBrand: unique symbol;

/**
 * A request-local session whose mutable authorization fields were resolved
 * read-time. The brand additionally carries `executingResolution`, the explicit
 * three-state discriminator the registry gate reads (#3435, L1):
 *
 *   - `'resolved'`   — a real executing-turn resolution produced this snapshot.
 *                      Split further by `purpose`: resolved-normal (undefined
 *                      purpose = an ordinary, non-scheduled turn) vs
 *                      resolved-scheduled (`purpose === 'scheduled-agent-job'`).
 *   - `'unresolved'` — an empty (all-undefined) context reached the gate; no real
 *                      resolution happened. The scheduled-agent-job forbidden-tool
 *                      set is denied fail-closed in this state.
 *
 * An undefined `purpose` is NOT by itself the unresolved state — on a
 * resolved-normal turn it is the load-bearing representation of "this is a normal
 * (non-scheduled) turn," and the history-mutation tools MUST stay reachable there.
 */
export type ResolvedSessionContext = SessionContext & {
  readonly [resolvedSessionContextBrand]: true;
  readonly executingResolution: 'resolved' | 'unresolved';
};

/** The sole production constructor for registry-authorized session snapshots. */
export function resolveSessionContext(
  session: SessionContext,
  executing: ExecutingSessionContext,
): ResolvedSessionContext {
  const { resolved: assertedResolved, ...executingFields } = executing;
  // A resolution is REAL when it is explicitly asserted OR carries at least one
  // defined authorization/confinement field. The all-undefined context — the
  // issue's own definition of the empty context — is the UNRESOLVED state
  // (`noExecutingSession()`, or a read-time resolver that found no executing-turn
  // entry). A caller that structurally cannot produce an all-undefined context
  // needs no explicit assertion: the per-chat actor socket, for one, pins a
  // `conversationKey` from the SOCKET IDENTITY before calling in, so its contexts
  // are always classified resolved (see the `resolved` field's docstring above —
  // that is a property of the socket, not of the turn). The callers that CAN emit
  // one — the passive operator socket, and a read-time resolver that finds no
  // entry — land in the fail-closed branch, which is the point.
  const executingResolution: ResolvedSessionContext['executingResolution'] =
    assertedResolved === true
    || executingFields.actorJid !== undefined
    || executingFields.purpose !== undefined
    || (typeof executingFields.conversationKey === 'string' && executingFields.conversationKey.length > 0)
      ? 'resolved'
      : 'unresolved';
  return { ...session, ...executingFields, executingResolution } as ResolvedSessionContext;
}

/**
 * The UNCONFINED-OPERATOR resolver (#3435, L2): the read-time context for a
 * surface that never executes an agent turn. It produces the all-undefined
 * (UNRESOLVED) executing context, which is fail-closed for `actorJid`
 * (`sensitiveAllowed` denies) AND — since #3435 — for the scheduled-agent-job
 * forbidden-tool set (an unresolved context denies it).
 *
 * It is NOT a general "confine" helper. It does NOT confine conversation scope:
 * an unresolved context leaves the cross-conversation guard unchanged (the
 * passive operator socket is intentionally unconfined). Do NOT wire this to a
 * surface that runs scheduled turns expecting it to gate `purpose`/`conversationKey`
 * by scope — it only asserts "no executing turn." Its sole production consumer is
 * the passive operator socket (src/runtimes/passive/runtime.ts), which processes
 * no messages and therefore legitimately needs none of the history-mutation tools.
 */
export function noExecutingSession(): ExecutingSessionContext {
  return { actorJid: undefined, purpose: undefined, conversationKey: undefined };
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
  /**
   * S1 (bond-revocation programme, 2026-08-17). Marks a tool that intentionally
   * asks WhatsApp to remove this companion device. The registry writes an actor
   * receipt to the bond-actor ledger through the handler's dispatch callback at
   * the closest practical seam before the socket request, so the resulting
   * terminal bond event can name what asked for it without misclassifying a
   * pre-dispatch validation or socket-acquisition failure.
   *
   * Exactly one tool carries this today (`logout`). It is deliberately NOT a
   * general "dangerous" flag: `sensitive` already gates authorization. This says
   * something narrower and factual — the call requests device removal.
   */
  bondEffect?: 'requests_device_removal';
  /**
   * Functional group tag (QR-017 / #1976 — progressive-disclosure taxonomy).
   * OPTIONAL and backward-compatible: untagged tools remain valid. Populated
   * at the registration seam (ToolRegistry.withModule, driven by
   * register-all.ts's per-module runModule) so a whole module's tools share
   * one group with no per-tool edits; the ~2 inline runtime tools are tagged
   * explicitly at their registration site.
   *
   * This is PURE metadata: it is carried on the declaration but NOT acted on.
   * It does not affect listTools() advertisement or call() authorization —
   * later disclosure work (#1976 §3.1+) may use it to filter what is
   * *advertised*, never what is *authorized* (advertise != authorize; see §0
   * of the design).
   */
  group?: string;
  /**
   * D2 (capability-obligation replay) — explicit closed external-effect
   * declaration: does an ACCEPTED invocation of this tool observably mutate
   * anything outside the process (WhatsApp, DB/memory stores, third parties)?
   * `kind: 'none'` = pure read; `kind: 'external'` = may mutate (fail-closed
   * default when authoring). This is independent of `replayPolicy` (recovery
   * semantics) and MUST NOT be derived from it. Coverage is CI-enforced with no
   * grandfather list (tests/mcp/external-effect-coverage.test.ts); an
   * unclassified tool folds to `unknown`, which blocks automatic obligation
   * creation. See src/mcp/external-effect.ts.
   */
  externalEffect?: import('./external-effect.ts').ExternalEffectDeclaration;
  handler: (
    params: Record<string, unknown>,
    session: SessionContext,
    recordBondEffectDispatch?: () => void,
  ) => Promise<unknown>;
}

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const TOOL_ERROR = Symbol('whatsoup.toolError');
const TOOL_ERROR_EVIDENCE = Symbol('whatsoup.toolErrorEvidence');

export interface ToolErrorEvidence {
  failureCode: ToolFailureCode;
  failureStage: ToolFailureStage;
}

export type ToolErrorPayload<T extends Record<string, unknown> = Record<string, unknown>> = T & {
  readonly [TOOL_ERROR]: true;
  readonly [TOOL_ERROR_EVIDENCE]?: ToolErrorEvidence;
};

function isToolErrorEvidence(value: unknown): value is ToolErrorEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ToolErrorEvidence>;
  return TOOL_FAILURE_CODES.includes(candidate.failureCode as ToolFailureCode)
    && TOOL_FAILURE_STAGES.includes(candidate.failureStage as ToolFailureStage);
}

export function toolError<T extends Record<string, unknown>>(
  payload: T,
  evidence?: ToolErrorEvidence,
): ToolErrorPayload<T> {
  if (evidence !== undefined && !isToolErrorEvidence(evidence)) {
    throw new TypeError('Invalid tool error evidence');
  }
  const result = { ...payload };
  Object.defineProperty(result, TOOL_ERROR, { value: true });
  if (evidence !== undefined) {
    Object.defineProperty(result, TOOL_ERROR_EVIDENCE, {
      value: Object.freeze({ ...evidence }),
    });
  }
  return result as ToolErrorPayload<T>;
}

export function errorResult(error: string) {
  return toolError({ error });
}

export function isToolErrorPayload(value: unknown): value is ToolErrorPayload {
  return typeof value === 'object' && value !== null && (value as { [TOOL_ERROR]?: unknown })[TOOL_ERROR] === true;
}

export function getToolErrorEvidence(value: unknown): ToolErrorEvidence | undefined {
  if (!isToolErrorPayload(value)) return undefined;
  const evidence = value[TOOL_ERROR_EVIDENCE];
  return isToolErrorEvidence(evidence) ? evidence : undefined;
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
