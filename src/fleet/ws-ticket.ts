// src/fleet/ws-ticket.ts
//
// Short-lived, single-use HMAC tickets for WebSocket auth.
//
// The browser `WebSocket` constructor cannot set custom headers, so we cannot
// reuse the Bearer scheme used for the HTTP API. Instead the console first
// calls `POST /api/ws-ticket` (Bearer-authenticated), receives a one-shot
// ticket, then opens the socket as `wss://host/ws?ticket=<token>`.
//
// Ticket wire format (base64url, dot-separated parts):
//   <nonce>.<expiryMs>.<hmac>
//
// where:
//   nonce     = 16 random bytes, base64url
//   expiryMs  = absolute Unix epoch milliseconds at which the ticket expires
//   hmac      = HMAC-SHA256(activeToken, `${nonce}.${expiryMs}`) base64url
//
// Replay defense: the server tracks redeemed nonces until well after expiry
// (expiryMs + 60s). Subsequent redemptions of the same nonce return false.
// Tickets bind to `active` (the signing token); rotation that keeps the old
// active in `accept[]` still validates the HMAC since the signing material
// matched at issue time.

import * as crypto from 'node:crypto';

/** Default ticket TTL — 60 seconds. */
export const TICKET_TTL_MS = 60_000;
/** Grace window after a ticket expires before we forget its nonce. */
const REDEMPTION_GRACE_MS = 60_000;
/** Default eviction interval for the redeemed-nonce set. */
const EVICTION_INTERVAL_MS = 60_000;

export interface TicketIssueResult {
  ticket: string;
  expiresIn: number;
}

export interface TicketStore {
  /** Issue a fresh ticket signed with `signingKey`. */
  issue(signingKey: string, now?: number): TicketIssueResult;
  /**
   * Redeem `ticket`. Validates HMAC against any of `validKeys`, checks expiry,
   * and ensures the nonce has not already been redeemed. On success the nonce
   * is marked as consumed.
   */
  redeem(ticket: string, validKeys: readonly string[], now?: number): boolean;
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
  expiryMs: number;
  hmac: string;
  /** The signed payload — `${nonce}.${expiryMs}`. */
  signedPayload: string;
}

function parseTicket(raw: string): ParsedTicket | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [nonce, expiryStr, hmac] = parts;
  if (!nonce || !expiryStr || !hmac) return null;
  // Defensive bounds — keep parser cheap for malformed input.
  if (nonce.length > 64 || expiryStr.length > 16 || hmac.length > 64) return null;
  const expiryMs = Number(expiryStr);
  if (!Number.isFinite(expiryMs) || Math.floor(expiryMs) !== expiryMs || expiryMs <= 0) return null;
  return { nonce, expiryMs, hmac, signedPayload: `${nonce}.${expiryStr}` };
}

/**
 * Factory for an in-process ticket store.
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

  const redeemed = new Map<string, number>(); // nonce → forgetAt

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
    issue(signingKey, nowOverride): TicketIssueResult {
      const t = nowOverride ?? now();
      const nonce = base64urlEncode(crypto.randomBytes(16));
      const expiryMs = t + ttlMs;
      const payload = `${nonce}.${expiryMs}`;
      const hmac = computeHmac(signingKey, payload);
      return { ticket: `${payload}.${hmac}`, expiresIn: Math.floor(ttlMs / 1000) };
    },

    redeem(ticket, validKeys, nowOverride): boolean {
      const parsed = parseTicket(ticket);
      if (!parsed) return false;
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
