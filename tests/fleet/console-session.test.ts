/**
 * B1 closure stage 1: server-side console sessions. The browser never holds
 * the root fleet token — the operator unlocks once, the server sets an
 * HttpOnly cookie whose opaque id maps to an in-memory session (restart
 * relocks the console by design).
 */
import { describe, it, expect, vi } from 'vitest';

import {
  createConsoleSessionStore,
  CONSOLE_SESSION_COOKIE,
  CONSOLE_SESSION_TTL_MS,
  buildSessionCookie,
  buildSessionClearCookie,
  parseSessionCookie,
  isSameOriginRequest,
  isSecureRequestTransport,
  isLoopbackRequest,
} from '../../src/fleet/console-session.ts';

describe('createConsoleSessionStore', () => {
  it('issues opaque ids that validate until TTL expiry', () => {
    let nowMs = 1_000_000;
    const store = createConsoleSessionStore({ now: () => nowMs });

    const { sessionId, expiresIn } = store.issue();
    expect(sessionId).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresIn).toBe(Math.floor(CONSOLE_SESSION_TTL_MS / 1000));
    expect(store.validate(sessionId)).toBe(true);

    nowMs += CONSOLE_SESSION_TTL_MS + 1;
    expect(store.validate(sessionId)).toBe(false);
  });

  it('rejects unknown and revoked ids', () => {
    const store = createConsoleSessionStore({ now: () => 0 });
    expect(store.validate('f'.repeat(64))).toBe(false);

    const { sessionId } = store.issue();
    store.revoke(sessionId);
    expect(store.validate(sessionId)).toBe(false);
  });

  it('bounds concurrent sessions by evicting the oldest', () => {
    const store = createConsoleSessionStore({ now: () => 0, maxSessions: 2 });
    const a = store.issue().sessionId;
    const b = store.issue().sessionId;
    const c = store.issue().sessionId;
    expect(store.validate(a)).toBe(false); // oldest evicted
    expect(store.validate(b)).toBe(true);
    expect(store.validate(c)).toBe(true);
  });
});

describe('session cookie helpers', () => {
  it('builds an HttpOnly SameSite=Strict cookie scoped to /', () => {
    const cookie = buildSessionCookie('a'.repeat(64));
    expect(cookie).toContain(`${CONSOLE_SESSION_COOKIE}=${'a'.repeat(64)}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${Math.floor(CONSOLE_SESSION_TTL_MS / 1000)}`);
  });

  it('omits Secure by default and on an explicit insecure transport', () => {
    expect(buildSessionCookie('a'.repeat(64))).not.toContain('Secure');
    expect(buildSessionCookie('a'.repeat(64), { secure: false })).not.toContain('Secure');
  });

  it('appends Secure only when the transport is confidential', () => {
    expect(buildSessionCookie('a'.repeat(64), { secure: true })).toContain('; Secure');
  });

  it('builds a clearing cookie with Max-Age=0', () => {
    const cookie = buildSessionClearCookie();
    expect(cookie).toContain(`${CONSOLE_SESSION_COOKIE}=`);
    expect(cookie).toContain('Max-Age=0');
  });

  it('parses the session id out of a Cookie header', () => {
    const id = 'b'.repeat(64);
    expect(parseSessionCookie(`${CONSOLE_SESSION_COOKIE}=${id}`)).toBe(id);
    expect(parseSessionCookie(`other=x; ${CONSOLE_SESSION_COOKIE}=${id}; more=y`)).toBe(id);
    expect(parseSessionCookie('other=x')).toBeNull();
    expect(parseSessionCookie(undefined)).toBeNull();
    // malformed values are rejected, not passed through
    expect(parseSessionCookie(`${CONSOLE_SESSION_COOKIE}=not-hex`)).toBeNull();
  });
});

describe('isSameOriginRequest', () => {
  function req(headers: Record<string, string | undefined>) {
    return { headers } as unknown as import('node:http').IncomingMessage;
  }

  it('accepts a matching Origin for the request host', () => {
    expect(isSameOriginRequest(req({ origin: 'http://127.0.0.1:9099', host: '127.0.0.1:9099' }))).toBe(true);
    expect(isSameOriginRequest(req({ origin: 'https://fleet.example:9099', host: 'fleet.example:9099' }))).toBe(true);
  });

  it('rejects a cross-site Origin', () => {
    expect(isSameOriginRequest(req({ origin: 'http://evil.example', host: '127.0.0.1:9099' }))).toBe(false);
  });

  it('rejects when Origin is missing (cookie-auth callers must prove origin)', () => {
    expect(isSameOriginRequest(req({ host: '127.0.0.1:9099' }))).toBe(false);
  });

  it('rejects malformed Origin values', () => {
    expect(isSameOriginRequest(req({ origin: 'not a url', host: '127.0.0.1:9099' }))).toBe(false);
  });
});

describe('isSecureRequestTransport', () => {
  function req(
    headers: Record<string, string | undefined>,
    socket: { encrypted?: boolean } = {},
  ) {
    return { headers, socket } as unknown as import('node:http').IncomingMessage;
  }

  it('treats X-Forwarded-Proto: https as confidential (TLS-terminating front)', () => {
    expect(isSecureRequestTransport(req({ 'x-forwarded-proto': 'https' }))).toBe(true);
  });

  it('reads only the first proto in a comma-joined forwarded chain', () => {
    expect(isSecureRequestTransport(req({ 'x-forwarded-proto': 'https, http' }))).toBe(true);
    expect(isSecureRequestTransport(req({ 'x-forwarded-proto': 'http, https' }))).toBe(false);
  });

  it('treats a direct encrypted socket as confidential', () => {
    expect(isSecureRequestTransport(req({}, { encrypted: true }))).toBe(true);
  });

  it('treats plain loopback HTTP (no signals) as not confidential', () => {
    expect(isSecureRequestTransport(req({}))).toBe(false);
    expect(isSecureRequestTransport(req({ 'x-forwarded-proto': 'http' }, { encrypted: false }))).toBe(false);
  });
});

describe('isLoopbackRequest', () => {
  function req(remoteAddress: string | undefined) {
    return { socket: { remoteAddress } } as unknown as import('node:http').IncomingMessage;
  }

  it('accepts IPv4 loopback (incl. the whole 127/8 block)', () => {
    expect(isLoopbackRequest(req('127.0.0.1'))).toBe(true);
    expect(isLoopbackRequest(req('127.1.2.3'))).toBe(true);
  });

  it('accepts IPv6 loopback and IPv4-mapped loopback (serve proxies to ::ffff:127.0.0.1)', () => {
    expect(isLoopbackRequest(req('::1'))).toBe(true);
    expect(isLoopbackRequest(req('::ffff:127.0.0.1'))).toBe(true);
  });

  it('rejects non-loopback sources (a direct remote peer after a bind regression)', () => {
    expect(isLoopbackRequest(req('203.0.113.7'))).toBe(false);
    expect(isLoopbackRequest(req('::ffff:203.0.113.7'))).toBe(false);
    expect(isLoopbackRequest(req('10.0.0.5'))).toBe(false);
    // not the loopback block despite the 127-ish prefix
    expect(isLoopbackRequest(req('128.0.0.1'))).toBe(false);
  });

  it('fails closed on a missing/empty source address', () => {
    expect(isLoopbackRequest(req(undefined))).toBe(false);
    expect(isLoopbackRequest(req(''))).toBe(false);
  });
});
