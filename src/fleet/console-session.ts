/**
 * Console session model (B1 closure).
 *
 * The browser console never holds the root fleet token. The operator unlocks
 * the console once by presenting the root token to POST /api/console-session;
 * the server answers with an HttpOnly SameSite=Strict cookie whose opaque id
 * maps to an in-memory session here. Ticket vending then accepts a valid
 * session cookie plus same-origin proof in place of the root Bearer.
 *
 * Sessions are deliberately in-memory: a fleet restart relocks the console.
 * The cookie carries `Secure` when the unlock request arrived over TLS — e.g.
 * fronted by `tailscale serve` or a reverse proxy that sets
 * X-Forwarded-Proto=https — and omits it for a direct loopback-HTTP unlock
 * (localhost is a secure context, so the cookie is still sent). Non-loopback
 * plain-HTTP binds are gated by bind-guard.ts.
 */
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const CONSOLE_SESSION_COOKIE = 'whatsoup_console_session';

/** Fixed session lifetime; no sliding renewal. */
export const CONSOLE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const SESSION_ID_RE = /^[0-9a-f]{64}$/;
const DEFAULT_MAX_SESSIONS = 32;

export interface ConsoleSessionStore {
  issue(): { sessionId: string; expiresIn: number };
  validate(sessionId: string): boolean;
  revoke(sessionId: string): void;
  /** Number of live (unexpired) sessions — for status surfaces, never ids. */
  size(): number;
}

export function createConsoleSessionStore(opts: {
  now?: () => number;
  ttlMs?: number;
  maxSessions?: number;
} = {}): ConsoleSessionStore {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? CONSOLE_SESSION_TTL_MS;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  // Map preserves insertion order → first key is the oldest session.
  const sessions = new Map<string, { expiresAt: number }>();

  function sweep(): void {
    const t = now();
    for (const [id, s] of sessions) {
      if (s.expiresAt <= t) sessions.delete(id);
    }
  }

  return {
    issue() {
      sweep();
      while (sessions.size >= maxSessions) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      const sessionId = randomBytes(32).toString('hex');
      sessions.set(sessionId, { expiresAt: now() + ttlMs });
      return { sessionId, expiresIn: Math.floor(ttlMs / 1000) };
    },
    validate(sessionId: string): boolean {
      if (!SESSION_ID_RE.test(sessionId)) return false;
      const s = sessions.get(sessionId);
      if (!s) return false;
      if (s.expiresAt <= now()) {
        sessions.delete(sessionId);
        return false;
      }
      return true;
    },
    revoke(sessionId: string): void {
      sessions.delete(sessionId);
    },
    size(): number {
      sweep();
      return sessions.size;
    },
  };
}

export function buildSessionCookie(sessionId: string, opts: { secure?: boolean } = {}): string {
  const secure = opts.secure ? '; Secure' : '';
  return `${CONSOLE_SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(CONSOLE_SESSION_TTL_MS / 1000)}${secure}`;
}

export function buildSessionClearCookie(): string {
  return `${CONSOLE_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** Extract a well-formed session id from a Cookie header, else null. */
export function parseSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== CONSOLE_SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return SESSION_ID_RE.test(value) ? value : null;
  }
  return null;
}

/**
 * Same-origin proof for cookie-authenticated browser calls. SameSite=Strict
 * already prevents cross-site cookie sending in modern browsers; this is
 * defense-in-depth, and it intentionally rejects requests with no Origin
 * header (cookie-auth callers are browsers, which send Origin on POST/DELETE;
 * external scripts use the root Bearer path instead).
 */
export function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string' || host.length === 0) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * True when the request reached us over a confidential transport, so the
 * session cookie can safely carry `Secure`. Two signals:
 *   - a TLS-terminating front (e.g. `tailscale serve` or a reverse proxy)
 *     sets `X-Forwarded-Proto: https`;
 *   - a direct TLS socket exposes `req.socket.encrypted === true`.
 * Spoofing `X-Forwarded-Proto` only makes the spoofer's own cookie MORE
 * restrictive (Secure), so it is not a downgrade vector. A plain loopback-HTTP
 * unlock yields neither signal → no `Secure` (and localhost is a secure
 * context regardless, so the cookie is still delivered).
 */
export function isSecureRequestTransport(req: IncomingMessage): boolean {
  const xfp = req.headers['x-forwarded-proto'];
  if (typeof xfp === 'string' && xfp.split(',')[0].trim().toLowerCase() === 'https') {
    return true;
  }
  const socket = req.socket as { encrypted?: boolean };
  return socket?.encrypted === true;
}
