// src/fleet/ws-ticket.ts
//
// Backward-compatible adapter over `auth-ticket.ts` (issue #313).
//
// #313 generalised the WebSocket ticket pattern to three audiences
// (api, sse, ws). This module preserves the original `issue(signingKey)` /
// `redeem(ticket, validKeys)` API shape so the WS server call sites stay
// unchanged; under the hood every call binds to `audience='ws'` on the
// shared store.

import {
  createTicketStore as createScopedTicketStore,
  TICKET_TTL_MS as SHARED_TICKET_TTL_MS,
  type TicketStore as ScopedTicketStore,
  type TicketIssueResult as ScopedTicketIssueResult,
} from './auth-ticket.ts';

export const TICKET_TTL_MS = SHARED_TICKET_TTL_MS;

export type TicketIssueResult = ScopedTicketIssueResult;

export interface TicketStore {
  /** Issue a WebSocket-audience ticket signed with `signingKey`. */
  issue(signingKey: string, now?: number): TicketIssueResult;
  /** Redeem a WebSocket-audience ticket. */
  redeem(ticket: string, validKeys: readonly string[], now?: number): boolean;
  /** Stop the periodic eviction timer. */
  stop(): void;
  /** Number of nonces currently tracked (for tests). */
  readonly redeemedCount: number;
}

/**
 * Factory for an in-process WS ticket store. Internally an audience-scoped
 * store bound to `audience='ws'` -- callers can still use this module without
 * caring about audiences.
 */
export function createTicketStore(opts: {
  ttlMs?: number;
  evictionIntervalMs?: number;
  now?: () => number;
} = {}): TicketStore {
  const inner: ScopedTicketStore = createScopedTicketStore(opts);
  return {
    issue(signingKey, nowOverride): TicketIssueResult {
      return inner.issue(signingKey, 'ws', nowOverride);
    },
    redeem(ticket, validKeys, nowOverride): boolean {
      return inner.redeem(ticket, 'ws', validKeys, nowOverride);
    },
    stop(): void {
      inner.stop();
    },
    get redeemedCount(): number {
      return inner.redeemedCount;
    },
  };
}
