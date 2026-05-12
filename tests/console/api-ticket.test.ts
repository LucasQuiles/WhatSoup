// tests/console/api-ticket.test.ts
//
// #313 — Console-side coverage for the audience-scoped ticket flow:
//  - `apiFetch` calls mint an api-audience ticket via POST /api/auth-ticket
//    and thread it as `Authorization: Bearer <ticket>` instead of the root
//    fleet token.
//  - `getApiTicket` treats tickets as single-use credentials, so back-to-back
//    callers receive separate tickets.
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
      // 2) actual read — mint + read call; tickets are single-use.
      .mockResolvedValueOnce(mintResponse('api-ticket-B', 'api'))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');
    await expect(freshApi.getLines()).resolves.toEqual([]);

    // Call sequence:
    //   call 0: POST /api/auth-ticket  (mint for availability probe)
    //   call 1: GET  /api/lines        (probe, with api-ticket-A)
    //   call 2: POST /api/auth-ticket  (mint for actual read)
    //   call 3: GET  /api/lines        (actual fetch, with api-ticket-B)
    expect(fetchMock).toHaveBeenCalledTimes(4);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth-ticket');
    const mintInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(mintInit.method).toBe('POST');
    const mintHeaders = mintInit.headers as Record<string, string>;
    expect(mintHeaders.Authorization).toBe('Bearer root-token-xyz');
    expect(JSON.parse(mintInit.body as string)).toEqual({ audience: 'api' });

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/lines');
    const probeHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>;
    expect(probeHeaders.Authorization).toBe('Bearer api-ticket-A');

    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/auth-ticket');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/lines');
    const readHeaders = (fetchMock.mock.calls[3]?.[1] as RequestInit).headers as Record<string, string>;
    expect(readHeaders.Authorization).toBe('Bearer api-ticket-B');
  });

  it('does NOT send the root token on /api/* routes', async () => {
    stubFleetToken('root-token-xyz');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mintResponse('api-ticket-B', 'api'))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(mintResponse('api-ticket-C', 'api'))
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

  it('mints WebSocket tickets with the root bootstrap token, not an api-audience ticket', async () => {
    stubFleetToken('root-token-xyz');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ticket: 'ws-ticket', expiresIn: 60 }));
    vi.stubGlobal('fetch', fetchMock);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');
    await expect(freshApi.getWsTicket()).resolves.toEqual({ ticket: 'ws-ticket', expiresIn: 60 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/ws-ticket');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer root-token-xyz' });
  });
});

describe('console api-ticket -- single-use ticket minting', () => {
  it('mints a fresh api ticket for each caller', async () => {
    stubFleetToken('root-token-xyz');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mintResponse('api-ticket-1', 'api'))
      .mockResolvedValueOnce(mintResponse('api-ticket-2', 'api'))
      .mockResolvedValueOnce(mintResponse('api-ticket-3', 'api'));
    vi.stubGlobal('fetch', fetchMock);

    const { getApiTicket, clearTicketCache } = await import('../../console/src/lib/api.ts');
    clearTicketCache();
    const a = await getApiTicket('api');
    const b = await getApiTicket('api');
    const c = await getApiTicket('api');
    expect(a).toBe('api-ticket-1');
    expect(b).toBe('api-ticket-2');
    expect(c).toBe('api-ticket-3');
    expect(fetchMock).toHaveBeenCalledTimes(3);
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

  it('does not reuse an unexpired ticket because server redemption is single-use', async () => {
    stubFleetToken('root-token-xyz');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mintResponse('first-ticket', 'api', 60))
      .mockResolvedValueOnce(mintResponse('second-ticket', 'api', 60));
    vi.stubGlobal('fetch', fetchMock);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-05-12T00:00:00Z'));
      const { getApiTicket, clearTicketCache } = await import('../../console/src/lib/api.ts');
      clearTicketCache();
      const first = await getApiTicket('api');
      expect(first).toBe('first-ticket');

      vi.setSystemTime(new Date('2026-05-12T00:00:01Z'));
      const second = await getApiTicket('api');
      expect(second).toBe('second-ticket');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
