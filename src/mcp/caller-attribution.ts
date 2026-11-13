// src/mcp/caller-attribution.ts
//
// #3421 step 1: record who made each tool call, with no change to what any
// caller may do. The socket server learns about a connection (its id, the
// client's declared name, whether it presented the executing session's
// token); the registry combines that with the resolved turn context and writes
// it onto the tool_calls row. The Microsoft workflow broker also requires this
// attribution alongside its current employee request and account binding.

import { randomBytes } from 'node:crypto';
import type { ToolCallCallerEvidence } from '../core/durability-evidence-contract.ts';
import { createChildLogger } from '../logger.ts';
import { safeStringEqual } from '../lib/safe-compare.ts';
import { isNonEmptyString, isRecord } from '../lib/type-guards.ts';
import type { CallerAttribution, ResolvedSessionContext } from './types.ts';

/**
 * The line a session's own MCP helper (the stdio proxy or a session hook) writes
 * first. It is a JSON-RPC notification, so a server that does not know it drops
 * it, and it never gets a reply.
 */
export const SESSION_TOKEN_NOTIFICATION = 'notifications/whatsoup/session';

const log = createChildLogger('caller-attribution');

/**
 * What a token stands for. A session token is bound to the socket its child is
 * given. A request token is also bound to the one turn (conversation and request
 * reference) that the adapter call was made for.
 */
export interface SessionTokenBinding {
  kind: 'session' | 'request';
  socketPath: string;
  conversationKey?: string;
  requestRef?: string;
  /** Opaque runtime session identity for turn-reply routing; honoured on session tokens only. */
  turnReplySessionId?: string;
}

/** A minted token and the only handle that retires it. */
export interface SessionTokenLease {
  readonly token: string;
  revoke(): void;
}

/**
 * Why a token the registry minted is refused on a socket: it is live but bound
 * to another socket, or its lease was revoked.
 */
export type SessionTokenRefusal = 'wrong_socket' | 'revoked';

/** Anything that can say which live binding, if any, a token presented on a socket has. */
export interface SessionTokenVerifier {
  verify(presented: unknown, socketPath: string): Readonly<SessionTokenBinding> | undefined;
  /**
   * Why a token this verifier minted is refused on `socketPath`. Undefined when the
   * token verifies there, was never minted, or has been forgotten past the capacity.
   */
  refusal?(presented: unknown, socketPath: string): SessionTokenRefusal | undefined;
}

/**
 * How many live tokens, and separately how many revoked tokens, of each kind are
 * kept before the oldest of that kind is forgotten (a backstop; leases revoke).
 */
export const SESSION_TOKEN_CAPACITY = 4096;

type SessionTokenKind = SessionTokenBinding['kind'];
const SESSION_TOKEN_KINDS: readonly SessionTokenKind[] = ['session', 'request'];

/** Drops the oldest entries until `size` is within `capacity`; returns how many it dropped. */
function trimOldest(entries: Map<string, unknown> | Set<string>, capacity: number): number {
  let dropped = 0;
  while (entries.size > capacity) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
    dropped += 1;
  }
  return dropped;
}

/**
 * Tokens minted for the runtime's own sessions and adapter calls. Each is handed
 * to its child only through the environment and never written to disk or the
 * database.
 *
 * A token is a scoped capability with a lifetime: it verifies only on the socket
 * it is bound to, and only until its lease is revoked. A session token lives as
 * long as its session manager (child respawns keep it); a request token lives
 * for one adapter call. Past the capacity the oldest token of the same kind is
 * forgotten and its holder is recorded as an outside caller, which only makes
 * evidence stricter.
 *
 * A revoked token is remembered, up to the same capacity per kind, so a caller
 * still presenting it can be refused rather than treated as one that presented
 * none. Each kind has its own bounds, so request-token churn (one per adapter
 * call) can never displace a session token, live or revoked; only newer session
 * tokens can.
 *
 * A same-user process can read another process's environment, so a match is
 * still attribution evidence, not authentication against such a process.
 */
export class SessionTokenRegistry implements SessionTokenVerifier {
  private readonly live: Record<SessionTokenKind, Map<string, Readonly<SessionTokenBinding>>> = {
    session: new Map(),
    request: new Map(),
  };
  private readonly revoked: Record<SessionTokenKind, Set<string>> = { session: new Set(), request: new Set() };
  private readonly capacity: number;

  constructor(capacity: number = SESSION_TOKEN_CAPACITY) {
    this.capacity = capacity;
  }

  /** Number of live tokens; a settled adapter call returns it to its baseline. */
  get liveCount(): number {
    return this.live.session.size + this.live.request.size;
  }

  mint(binding: SessionTokenBinding): string {
    const token = randomBytes(32).toString('hex');
    const live = this.live[binding.kind];
    live.set(token, Object.freeze({ ...binding }));
    if (trimOldest(live, this.capacity) > 0) {
      log.warn({ capacity: this.capacity, kind: binding.kind }, 'session token capacity reached: the oldest live token was forgotten');
    }
    return token;
  }

  mintLease(binding: SessionTokenBinding): SessionTokenLease {
    const token = this.mint(binding);
    return { token, revoke: () => this.revoke(token) };
  }

  revoke(token: string): void {
    for (const kind of SESSION_TOKEN_KINDS) {
      if (!this.live[kind].delete(token)) continue;
      this.revoked[kind].add(token);
      trimOldest(this.revoked[kind], this.capacity);
      return;
    }
  }

  verify(presented: unknown, socketPath: string): Readonly<SessionTokenBinding> | undefined {
    if (!isNonEmptyString(presented) || !isNonEmptyString(socketPath)) return undefined;
    const matched = this.findLive(presented);
    return matched?.socketPath === socketPath ? matched : undefined;
  }

  refusal(presented: unknown, socketPath: string): SessionTokenRefusal | undefined {
    if (!isNonEmptyString(presented)) return undefined;
    const live = this.findLive(presented);
    let revoked = false;
    // Visit every revoked token so the comparison time does not depend on which one matches.
    for (const kind of SESSION_TOKEN_KINDS) {
      for (const token of this.revoked[kind]) {
        if (safeStringEqual(token, presented)) revoked = true;
      }
    }
    if (live !== undefined) {
      return isNonEmptyString(socketPath) && live.socketPath === socketPath ? undefined : 'wrong_socket';
    }
    return revoked ? 'revoked' : undefined;
  }

  private findLive(presented: string): Readonly<SessionTokenBinding> | undefined {
    let matched: Readonly<SessionTokenBinding> | undefined;
    // Visit every live token so the comparison time does not depend on which one matches.
    for (const kind of SESSION_TOKEN_KINDS) {
      for (const [token, binding] of this.live[kind]) {
        if (safeStringEqual(token, presented)) matched = binding;
      }
    }
    return matched;
  }
}

/** The token a session notification presents, if it carries a non-empty one. */
export function presentedSessionToken(notificationParams: unknown): string | undefined {
  const presented = isRecord(notificationParams) ? notificationParams['token'] : undefined;
  return isNonEmptyString(presented) ? presented : undefined;
}

/**
 * A session token matched on `socketPath` identifies its runtime session, never
 * a bare token value. A request token never carries turn-reply authority.
 */
export function turnReplySessionIdFromPresentedToken(
  notificationParams: unknown,
  verifier: SessionTokenVerifier | undefined,
  socketPath: string,
): string | undefined {
  const binding = verifier?.verify(presentedSessionToken(notificationParams), socketPath);
  return binding?.kind === 'session' ? binding.turnReplySessionId : undefined;
}

/** Fold a token presented on `socketPath` into a connection's attribution. */
export function withPresentedToken(
  current: Readonly<CallerAttribution>,
  notificationParams: unknown,
  verifier: SessionTokenVerifier | undefined,
  socketPath: string,
): Readonly<CallerAttribution> {
  const presented = presentedSessionToken(notificationParams);
  const matched = verifier !== undefined && verifier.verify(presented, socketPath) !== undefined;
  return Object.freeze({ ...current, tokenResult: matched ? 'match' : 'mismatch' });
}

/** Client-declared strings are bounded before they reach the database. */
export const CLIENT_INFO_MAX_LENGTH = 64;

/** Calls made through the in-process provider bridge: the turn's own by construction. */
export const IN_PROCESS_CALLER: Readonly<CallerAttribution> = Object.freeze({
  transport: 'in_process',
  connectionId: null,
  clientName: null,
  clientVersion: null,
  tokenResult: 'not_applicable',
});

/** A socket connection before it has declared anything. */
export function initialSocketAttribution(connectionId: string): Readonly<CallerAttribution> {
  return Object.freeze({
    transport: 'socket',
    connectionId,
    clientName: null,
    clientVersion: null,
    tokenResult: 'absent',
  });
}

/**
 * Keep printable ASCII only and cap the length. The value is whatever the
 * client chose to say, so it is stored as a label and never trusted.
 */
export function boundClientField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let printable = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e) printable += char;
  }
  const bounded = printable.trim().slice(0, CLIENT_INFO_MAX_LENGTH);
  return bounded.length > 0 ? bounded : null;
}

/** Fold an `initialize` request's `params.clientInfo` into a connection's attribution. */
export function withDeclaredClient(
  current: Readonly<CallerAttribution>,
  initializeParams: unknown,
): Readonly<CallerAttribution> {
  const clientInfo = isRecord(initializeParams) ? initializeParams['clientInfo'] : undefined;
  if (!isRecord(clientInfo)) return current;
  return Object.freeze({
    ...current,
    clientName: boundClientField(clientInfo['name']),
    clientVersion: boundClientField(clientInfo['version']),
  });
}

export function isTurnOwned(attribution: Readonly<CallerAttribution>): boolean {
  return attribution.transport === 'in_process' || attribution.tokenResult === 'match';
}

/**
 * The per-call record for the tool_calls row, or null when the session carries
 * no attribution (a caller outside the socket server and the provider bridge),
 * in which case the columns stay NULL.
 */
export function getToolCallCallerEvidence(
  session: ResolvedSessionContext,
  toolSensitive: boolean,
): ToolCallCallerEvidence | null {
  const attribution = session.callerAttribution;
  if (!attribution) return null;
  return {
    transport: attribution.transport,
    connectionId: attribution.connectionId,
    clientName: attribution.clientName,
    clientVersion: attribution.clientVersion,
    tokenResult: attribution.tokenResult,
    turnOwned: isTurnOwned(attribution),
    actorSource: session.executingResolution === 'resolved' && isNonEmptyString(session.actorJid)
      ? 'executing_turn'
      : 'none',
    toolSensitive,
  };
}
