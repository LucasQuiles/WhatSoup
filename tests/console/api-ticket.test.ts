// tests/console/api-ticket.test.ts
//
// #313 — Console-side coverage for the audience-scoped ticket flow:
//  - `apiFetch` calls mint an api-audience ticket via POST /api/auth-ticket
//    and thread it as `Authorization: Bearer <ticket>` instead of the root
//    fleet token.
//  - `getApiTicket` caches the minted ticket so back-to-back calls only mint
//    once, and concurrent callers share one in-flight mint.
//  - `getApiTicket('sse')` mints an sse-audience ticket (LinkStep path).
//  - When no meta-tag token is present (dev / mock-only), `apiFetch` omits
//    Authorization and never hits /api/auth-ticket.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.resetModules();
});

function stubFleetToken(token: string | null): void {
  vi.stubGlobal('document', {
    querySelector: (selector: string) => {
      if (selector !== 'meta[name="fleet-token"]' || token === null) return null;
      return { content: token };
    },
  });
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => '',
  } as Response;
}

function mintResponse(ticket: string, audience: 'api' | 'sse', expiresIn = 60): Response {
  return jsonResponse({ ticket, audience, expiresIn });
}

describe('console api-ticket -- apiFetch threads api-audience ticket', () => {
  it('mints an api ticket before the first API call and Bearers it', async () => {
    stubFleetToken('root-token-xyz');
    const fetchMock = vi.fn()
      // 1) availability probe — mint + probe call
      .mockResolvedValueOnce(mintResponse('api-ticket-A', 'api'))
      .mockResolvedValueOnce(jsonResponse([]))
      // 2) actual read — reuses cached ticket (no mint)
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');
    await expect(freshApi.getLines()).resolves.toEqual([]);

    // Call sequence:
    //   call 0: POST /api/auth-ticket  (mint for availability probe)
    //   call 1: GET  /api/lines        (probe, with cached api-ticket-A)
    //   call 2: GET  /api/lines        (actual fetch, same ticket)
    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth-ticket');
    const mintInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(mintInit.method).toBe('POST');
    const mintHeaders = mintInit.headers as Record<string, string>;
    expect(mintHeaders.Authorization).toBe('Bearer root-token-xyz');
    expect(JSON.parse(mintInit.body as string)).toEqual({ audience: 'api' });

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/lines');
    const probeHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(probeHeaders.Authorization).toBe('Bearer api-ticket-A');

    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/lines');
    const readHeaders = (fetchMock.mock.calls[2]?.[1] as RequestInit).headers as Record<string, string>;
    expect(readHeaders.Authorization).toBe('Bearer api-ticket-A');
  });

  it('does NOT send the root token on /api/* routes', async () => {
    stubFleetToken('root-token-xyz');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mintResponse('api-ticket-B', 'api'))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');
    await freshApi.getLines();

    // Only the mint endpoint ever sees the root token.
    for (let i = 0; i < fetchMock.mock.calls.length; i++) {
      const path = fetchMock.mock.calls[i]?.[0] as string;
      const headers = (fetchMock.mock.calls[i]?.[1] as RequestInit).headers as Record<string, string>;
      if (path === '/api/auth-ticket') continue;
      expect(headers.Authorization, `call ${i} (${path})`).not.toBe('Bearer root-token-xyz');
    }
  });

  it('omits Authorization (and never mints) when no meta-tag token exists', async () => {
    stubFleetToken(null);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');
    await expect(freshApi.getLines()).resolves.toEqual([]);

    // Two calls: availability probe + actual read. No mint, no Authorization.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).not.toBe('/api/auth-ticket');
      const headers = ((call[1] as RequestInit).headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    }
  });
});

describe('console api-ticket -- getApiTicket caching', () => {
  it('reuses a cached api ticket across concurrent callers', async () => {
    stubFleetToken('root-token-xyz');
    const fetchMock = vi.fn().mockResolvedValue(mintResponse('shared-api-ticket', 'api'));
    vi.stubGlobal('fetch', fetchMock);

    const { getApiTicket, clearTicketCache } = await import('../../console/src/lib/api.ts');
    clearTicketCache();
    const [a, b, c] = await Promise.all([getApiTicket('api'), getApiTicket('api'), getApiTicket('api')]);
    expect(a).toBe('shared-api-ticket');
    expect(b).toBe('shared-api-ticket');
    expect(c).toBe('shared-api-ticket');
    // All three concurrent callers should have shared one mint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('mints separate tickets for api and sse audiences', async () => {
    stubFleetToken('root-token-xyz');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mintResponse('ticket-for-api', 'api'))
      .mockResolvedValueOnce(mintResponse('ticket-for-sse', 'sse'));
    vi.stubGlobal('fetch', fetchMock);

    const { getApiTicket, clearTicketCache } = await import('../../console/src/lib/api.ts');
    clearTicketCache();
    const a = await getApiTicket('api');
    const s = await getApiTicket('sse');
    expect(a).toBe('ticket-for-api');
    expect(s).toBe('ticket-for-sse');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(firstBody.audience).toBe('api');
    const secondBody = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(secondBody.audience).toBe('sse');
  });

  it('refreshes the cached ticket once the cached entry has aged past its safe-reuse window', async () => {
    stubFleetToken('root-token-xyz');
    // First mint expires in 1s; safe-reuse window is max(1s, 1s - 10s margin) = 1s.
    // Advance time past that window so the next call must re-mint.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mintResponse('expiring-ticket', 'api', 1))
      .mockResolvedValueOnce(mintResponse('fresh-ticket', 'api', 60));
    vi.stubGlobal('fetch', fetchMock);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-12T00:00:00Z'));
      const { getApiTicket, clearTicketCache } = await import('../../console/src/lib/api.ts');
      clearTicketCache();
      const first = await getApiTicket('api');
      expect(first).toBe('expiring-ticket');

      // Advance well past the cached entry's refreshAt.
      vi.setSystemTime(new Date('2026-05-12T00:00:05Z'));
      const second = await getApiTicket('api');
      expect(second).toBe('fresh-ticket');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
