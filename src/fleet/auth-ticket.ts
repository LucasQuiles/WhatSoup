// src/fleet/auth-ticket.ts
//
// Audience-scoped, short-lived, single-use HMAC tickets.
//
// Issue #313: the root fleet token used to land in the browser via the
// HTML meta-tag and was sent on every HTTP request and EventSource URL.
// This module generalises the WS ticket pattern (PR #310) to mint
// audience-scoped tickets the console threads on its place. The root
// token only ever leaves the server to mint a ticket via the dedicated
// Bearer-protected vending endpoint.
//
// Three audiences:
//   - 'api'  -- Bearer credential for /api/* HTTP routes
//   - 'sse'  -- query-string credential for SSE endpoints
//                (EventSource can't set headers)
//   - 'ws'   -- query-string credential for the WebSocket upgrade
//
// Ticket wire format (base64url, dot-separated parts):
//   <nonce>.<audience>.<expiryMs>.<hmac>
//
// where:
//   nonce     = 16 random bytes, base64url
//   audience  = one of 'api' | 'sse' | 'ws'
//   expiryMs  = absolute Unix epoch milliseconds at which the ticket expires
//   hmac      = HMAC-SHA256(activeToken, `${nonce}.${audience}.${expiryMs}`)
//
// Replay defense: the server tracks redeemed nonces until well after
// expiry (expiryMs + 60s). Cross-audience replay is rejected because the
// audience is part of the signed payload.

import * as crypto from 'node:crypto';

/** Default ticket TTL -- 60 seconds. */
export const TICKET_TTL_MS = 60_000;
/** Grace window after a ticket expires before we forget its nonce. */
const REDEMPTION_GRACE_MS = 60_000;
/** Default eviction interval for the redeemed-nonce set. */
const EVICTION_INTERVAL_MS = 60_000;

export type TicketAudience = 'api' | 'sse' | 'ws';

/** Valid audience values, exposed for runtime validation at the route layer. */
export const TICKET_AUDIENCES: readonly TicketAudience[] = ['api', 'sse', 'ws'];

export function isTicketAudience(value: unknown): value is TicketAudience {
  return typeof value === 'string' && (TICKET_AUDIENCES as readonly string[]).includes(value);
}

export interface TicketIssueResult {
  ticket: string;
  expiresIn: number;
}

export interface TicketStore {
  /** Issue a fresh ticket signed with `signingKey` bound to `audience`. */
  issue(signingKey: string, audience: TicketAudience, now?: number): TicketIssueResult;
  /**
   * Redeem `ticket` for `audience`. Validates HMAC against any of `validKeys`,
   * confirms the embedded audience matches, checks expiry, and ensures the
   * nonce has not already been redeemed. On success the nonce is marked
   * as consumed.
   */
  redeem(
    ticket: string,
    audience: TicketAudience,
    validKeys: readonly string[],
    now?: number,
  ): boolean;
  /** Stop the periodic eviction timer. Tests call this between cases. */
  stop(): void;
  /** Number of nonces currently tracked (for tests). */
  readonly redeemedCount: number;
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function computeHmac(key: string, payload: string): string {
  return base64urlEncode(crypto.createHmac('sha256', key).update(payload).digest());
}

interface ParsedTicket {
  nonce: string;
  audience: TicketAudience;
  expiryMs: number;
  hmac: string;
  /** The signed payload -- `${nonce}.${audience}.${expiryMs}`. */
  signedPayload: string;
}

function parseTicket(raw: string): ParsedTicket | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [nonce, audienceStr, expiryStr, hmac] = parts;
  if (!nonce || !audienceStr || !expiryStr || !hmac) return null;
  // Defensive bounds -- keep parser cheap for malformed input.
  if (nonce.length > 64 || audienceStr.length > 8 || expiryStr.length > 16 || hmac.length > 64) return null;
  if (!isTicketAudience(audienceStr)) return null;
  const expiryMs = Number(expiryStr);
  if (!Number.isFinite(expiryMs) || Math.floor(expiryMs) !== expiryMs || expiryMs <= 0) return null;
  return {
    nonce,
    audience: audienceStr,
    expiryMs,
    hmac,
    signedPayload: `${nonce}.${audienceStr}.${expiryStr}`,
  };
}

/**
 * Factory for an in-process audience-scoped ticket store.
 *
 * `evictionIntervalMs = 0` disables the periodic timer (tests opt out so they
 * don't keep vitest's event loop busy).
 */
export function createTicketStore(opts: {
  ttlMs?: number;
  evictionIntervalMs?: number;
  now?: () => number;
} = {}): TicketStore {
  const ttlMs = opts.ttlMs ?? TICKET_TTL_MS;
  const evictionIntervalMs = opts.evictionIntervalMs ?? EVICTION_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());

  const redeemed = new Map<string, number>(); // nonce -> forgetAt

  let timer: ReturnType<typeof setInterval> | null = null;
  function evictExpired(reference: number): void {
    for (const [nonce, forgetAt] of redeemed) {
      if (forgetAt <= reference) redeemed.delete(nonce);
    }
  }
  if (evictionIntervalMs > 0) {
    timer = setInterval(() => evictExpired(now()), evictionIntervalMs);
    // Don't keep the Node event loop alive just for eviction.
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    issue(signingKey, audience, nowOverride): TicketIssueResult {
      const t = nowOverride ?? now();
      const nonce = base64urlEncode(crypto.randomBytes(16));
      const expiryMs = t + ttlMs;
      const payload = `${nonce}.${audience}.${expiryMs}`;
      const hmac = computeHmac(signingKey, payload);
      return { ticket: `${payload}.${hmac}`, expiresIn: Math.floor(ttlMs / 1000) };
    },

    redeem(ticket, audience, validKeys, nowOverride): boolean {
      const parsed = parseTicket(ticket);
      if (!parsed) return false;
      if (parsed.audience !== audience) return false;
      const t = nowOverride ?? now();
      if (t >= parsed.expiryMs) return false;
      // Reject early if nonce was already redeemed.
      if (redeemed.has(parsed.nonce)) return false;

      // Walk all valid signing keys; constant-ish time per attempt.
      let signatureOk = false;
      for (const key of validKeys) {
        if (typeof key !== 'string' || key.length === 0) continue;
        const expected = computeHmac(key, parsed.signedPayload);
        if (safeEqual(expected, parsed.hmac)) signatureOk = true;
      }
      if (!signatureOk) return false;

      redeemed.set(parsed.nonce, parsed.expiryMs + REDEMPTION_GRACE_MS);
      // Opportunistic eviction so the map cannot grow unbounded between
      // scheduled sweeps under heavy load.
      if (redeemed.size > 1024) evictExpired(t);
      return true;
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    get redeemedCount(): number {
      return redeemed.size;
    },
  };
}
