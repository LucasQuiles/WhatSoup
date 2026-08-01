import { afterEach, describe, it, expect, vi } from 'vitest';
import { api } from '../../console/src/lib/api.ts';

/**
 * Structural tests for console API client write operations.
 * These verify that the api object exposes the correct methods with the expected
 * function signatures — guarding against accidental removal or signature changes.
 * They don't make real HTTP calls.
 */

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubProductionConsole(enabled: boolean): void {
  vi.stubGlobal('document', {
    querySelector: (selector: string) => {
      if (selector !== 'meta[name="fleet-auth-mode"]' || !enabled) return null;
      return { content: 'session' };
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

function fetchInit(fetchMock: ReturnType<typeof vi.fn>, index: number): RequestInit {
  const init = fetchMock.mock.calls[index]?.[1];
  expect(init).toBeDefined();
  return init as RequestInit;
}

function headersFor(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

function parsedBody(init: RequestInit): unknown {
  if (typeof init.body !== 'string') return undefined;
  return JSON.parse(init.body);
}

function errorResponse(status: number, text: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => text,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('api write operations', () => {
  it('restart is a function accepting (name)', () => {
    expect(typeof api.restart).toBe('function');
    expect(api.restart.length).toBe(1);
  });

  it('stopInstance is a function accepting (name)', () => {
    expect(typeof api.stopInstance).toBe('function');
    expect(api.stopInstance.length).toBe(1);
  });

  it('updateConfig is a function accepting (name, patch)', () => {
    expect(typeof api.updateConfig).toBe('function');
    expect(api.updateConfig.length).toBe(2);
  });

  it('sendMessage is a function accepting (name, chatJid, text)', () => {
    expect(typeof api.sendMessage).toBe('function');
    expect(api.sendMessage.length).toBe(3);
  });

  it('accessDecision is a function accepting (name, subjectType, subjectId, action)', () => {
    expect(typeof api.accessDecision).toBe('function');
    expect(api.accessDecision.length).toBe(4);
  });

  it('searchMessages is a function accepting (name, query, conversationKey?)', () => {
    expect(typeof api.searchMessages).toBe('function');
    expect(api.searchMessages.length).toBeGreaterThanOrEqual(2);
  });

  it('deleteLine is a function accepting (name)', () => {
    expect(typeof api.deleteLine).toBe('function');
    expect(api.deleteLine.length).toBe(1);
  });
});

describe('console session endpoints', () => {
  it('unlockConsole posts the operator token through Authorization and returns expiry', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ expiresIn: 900 }));
    vi.stubGlobal('fetch', fetch);

    const { unlockConsole } = await import('../../console/src/lib/api.ts');

    await expect(unlockConsole('root-token')).resolves.toEqual({ expiresIn: 900 });
    expect(fetch).toHaveBeenCalledWith('/api/console-session', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer root-token' },
      credentials: 'same-origin',
    }));
  });

  it('unlockConsole reports invalid token for 401 and status-specific errors otherwise', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(errorResponse(401, 'unauthorized'))
      .mockResolvedValueOnce(errorResponse(503, 'down'));
    vi.stubGlobal('fetch', fetch);

    const { unlockConsole } = await import('../../console/src/lib/api.ts');

    await expect(unlockConsole('bad-token')).rejects.toThrow('invalid token');
    await expect(unlockConsole('root-token')).rejects.toThrow('unlock failed (503)');
  });

  it('lockConsole revokes the session cookie with a DELETE request', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    const { lockConsole } = await import('../../console/src/lib/api.ts');

    await expect(lockConsole()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith('/api/console-session', expect.objectContaining({
      method: 'DELETE',
      credentials: 'same-origin',
    }));
  });
});

describe('api console-session helpers', () => {
  it('unlocks with the root token only on the session exchange and locks with DELETE', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ expiresIn: 900 }))
      .mockResolvedValueOnce(jsonResponse({ revoked: true }));
    vi.stubGlobal('fetch', fetch);

    const { unlockConsole, lockConsole } = await import('../../console/src/lib/api.ts');

    await expect(unlockConsole('root-token')).resolves.toEqual({ expiresIn: 900 });
    await expect(lockConsole()).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/console-session');
    expect(fetchInit(fetch, 0).method).toBe('POST');
    expect(headersFor(fetchInit(fetch, 0))).toEqual({ Authorization: 'Bearer root-token' });
    expect(fetchInit(fetch, 0).credentials).toBe('same-origin');
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/console-session');
    expect(fetchInit(fetch, 1).method).toBe('DELETE');
    expect(fetchInit(fetch, 1).credentials).toBe('same-origin');
  });

  it('classifies invalid-token and non-auth unlock failures distinctly', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(errorResponse(401, 'unauthorized'))
      .mockResolvedValueOnce(errorResponse(503, 'down'));
    vi.stubGlobal('fetch', fetch);

    const { unlockConsole } = await import('../../console/src/lib/api.ts');

    await expect(unlockConsole('bad-token')).rejects.toThrow('invalid token');
    await expect(unlockConsole('root-token')).rejects.toThrow('unlock failed (503)');
  });
});

describe('api ticket failure handling', () => {
  it('surfaces non-401 ticket mint failures with audience and status', async () => {
    stubProductionConsole(true);
    const fetch = vi.fn().mockResolvedValue(errorResponse(503, 'issuer down'));
    vi.stubGlobal('fetch', fetch);

    const { getApiTicket } = await import('../../console/src/lib/api.ts');

    await expect(getApiTicket('sse')).rejects.toThrow('auth-ticket sse 503: issuer down');
  });

  it('rejects malformed ticket mint responses before any API request is attempted', async () => {
    stubProductionConsole(true);
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ ticket: '', expiresIn: 60 }));
    vi.stubGlobal('fetch', fetch);

    const { getApiTicket } = await import('../../console/src/lib/api.ts');

    await expect(getApiTicket('api')).rejects.toThrow('auth-ticket api: malformed server response');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/auth-ticket');
  });

  it('surfaces WebSocket ticket auth and server failures', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(errorResponse(401, 'locked'))
      .mockResolvedValueOnce(errorResponse(503, 'issuer down'));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getWsTicket()).rejects.toThrow('console locked');
    await expect(freshApi.getWsTicket()).rejects.toThrow('API 503: issuer down');
  });
});

describe('api auth headers', () => {
  it('mints an api-audience ticket and threads it on availability probes and fallback-backed reads (#313)', async () => {
    stubProductionConsole(true);
    // Sequence: mint -> probe -> mint -> read. Tickets are single-use, so the
    // fallback-backed read cannot reuse the availability probe credential.
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ticket: 'api-ticket-abc', audience: 'api', expiresIn: 60 }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ ticket: 'api-ticket-def', audience: 'api', expiresIn: 60 }))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getLines()).resolves.toEqual([]);

    // 4 calls total: mint + probe + mint + read.
    expect(fetch).toHaveBeenCalledTimes(4);

    expect(fetch.mock.calls[0]?.[0]).toBe('/api/auth-ticket');
    expect(headersFor(fetchInit(fetch, 0))).toEqual({
      'Content-Type': 'application/json',
    });
    expect(fetchInit(fetch, 0)?.credentials).toBe('same-origin');

    expect(fetch.mock.calls[1]?.[0]).toBe('/api/lines');
    expect(headersFor(fetchInit(fetch, 1))).toEqual({
      Authorization: 'Bearer api-ticket-abc',
    });

    expect(fetch.mock.calls[2]?.[0]).toBe('/api/auth-ticket');
    expect(headersFor(fetchInit(fetch, 2))).toEqual({
      'Content-Type': 'application/json',
    });
    expect(fetchInit(fetch, 2)?.credentials).toBe('same-origin');

    expect(fetch.mock.calls[3]?.[0]).toBe('/api/lines');
    expect(headersFor(fetchInit(fetch, 3))).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer api-ticket-def',
    });
  });

  it('omits Authorization on availability probes and reads when no meta token exists', async () => {
    stubProductionConsole(false);
    const fetch = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getLines()).resolves.toEqual([]);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/lines');
    expect(headersFor(fetchInit(fetch, 0))).toEqual({});
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/lines');
    expect(headersFor(fetchInit(fetch, 1))).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('clears the availability probe timeout when fetch rejects (dev/mock-mode fallback path)', async () => {
    stubProductionConsole(false);
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    // In dev (vitest default), withFallback degrades to mock data when
    // the availability probe rejects — verifying the legacy convenience
    // path still works for design iteration.
    await expect(freshApi.getLines()).resolves.toEqual(expect.any(Array));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('threads the api-audience ticket (not the root token) on write requests (#313)', async () => {
    stubProductionConsole(true);
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ticket: 'api-ticket-xyz', audience: 'api', expiresIn: 60 }))
      .mockResolvedValueOnce(jsonResponse({ status: 'ok', instance: 'line-a' }));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.restart('line-a')).resolves.toEqual({ status: 'ok', instance: 'line-a' });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/auth-ticket');
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/lines/line-a/restart');
    expect(fetchInit(fetch, 1).method).toBe('POST');
    expect(headersFor(fetchInit(fetch, 1))).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer api-ticket-xyz',
    });
  });

  it('omits Authorization on write requests when no meta token exists', async () => {
    stubProductionConsole(false);
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok', instance: 'line-a' }));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.restart('line-a')).resolves.toEqual({ status: 'ok', instance: 'line-a' });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/lines/line-a/restart');
    expect(fetchInit(fetch, 0).method).toBe('POST');
    expect(headersFor(fetchInit(fetch, 0))).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('falls back to unauthenticated dev requests when ticket minting fails outside PROD', async () => {
    stubProductionConsole(true);
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('ticket issuer offline'))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockRejectedValueOnce(new Error('ticket issuer offline'))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getLines()).resolves.toEqual([]);

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/auth-ticket');
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/lines');
    expect(headersFor(fetchInit(fetch, 1))).toEqual({});
    expect(fetch.mock.calls[2]?.[0]).toBe('/api/auth-ticket');
    expect(fetch.mock.calls[3]?.[0]).toBe('/api/lines');
    expect(headersFor(fetchInit(fetch, 3))).toEqual({ 'Content-Type': 'application/json' });
  });

  it('shares in-flight availability probes and expires the cached fleet status', async () => {
    stubProductionConsole(false);
    vi.useFakeTimers();
    try {
      const availability = deferred<Response>();
      const fetch = vi.fn()
        .mockReturnValueOnce(availability.promise)
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse({ range: '24h' }))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse([]));
      vi.stubGlobal('fetch', fetch);

      const { api: freshApi } = await import('../../console/src/lib/api.ts');

      const first = freshApi.getLines();
      const second = freshApi.getFleetMetrics('24h');
      await Promise.resolve();

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[0]).toBe('/api/lines');

      availability.resolve(jsonResponse([]));
      await expect(Promise.all([first, second])).resolves.toEqual([[], { range: '24h' }]);
      expect(fetch.mock.calls.map((call) => call[0])).toEqual([
        '/api/lines',
        '/api/lines',
        '/api/metrics?range=24h',
      ]);

      await vi.advanceTimersByTimeAsync(60_000);
      await expect(freshApi.getLines()).resolves.toEqual([]);
      expect(fetch.mock.calls.map((call) => call[0])).toEqual([
        '/api/lines',
        '/api/lines',
        '/api/metrics?range=24h',
        '/api/lines',
        '/api/lines',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to mock data when the availability probe times out and aborts', async () => {
    stubProductionConsole(false);
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }));
      vi.stubGlobal('fetch', fetch);

      const { api: freshApi } = await import('../../console/src/lib/api.ts');

      const request = freshApi.getLines();
      await vi.advanceTimersByTimeAsync(1500);

      await expect(request).resolves.toEqual(expect.any(Array));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[0]).toBe('/api/lines');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('api production mock-fallback gating (#420)', () => {
  it('does NOT fall back to mock data when checkFleetAvailable rejects in PROD without opt-in', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_MOCK_MODE', '');
    stubProductionConsole(false);
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    // Production without explicit opt-in: errors propagate so the UI
    // surfaces a real error state instead of mock data.
    await expect(freshApi.getLines()).rejects.toThrow(/offline/);
  });

  it('does NOT fall back to mock data when apiFn throws in PROD without opt-in', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_MOCK_MODE', '');
    stubProductionConsole(false);
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'service unavailable',
    } as Response);
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getLines()).rejects.toThrow(/API 503/);
  });

  it('authHeaders surfaces ticket-mint failures in PROD without opt-in', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_MOCK_MODE', '');
    stubProductionConsole(true);
    // Auth-ticket mint returns 401 — in PROD this must throw instead
    // of falling through to a bare-token (unauthenticated) request.
    const fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'unauthorized',
    } as Response);
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getLines()).rejects.toThrow(/console locked/);
    // Critical: we must NOT have proceeded to /api/lines with a bare
    // token — the mint failure short-circuits the request.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/auth-ticket');
  });

  it('getTyping surfaces production API failures instead of returning an empty list', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_MOCK_MODE', '');
    stubProductionConsole(false);
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => 'service unavailable',
    } as Response);
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getTyping()).rejects.toThrow(/API 503/);
  });

  it('honors VITE_MOCK_MODE=1 opt-in to restore mock fallback in PROD', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_MOCK_MODE', '1');
    stubProductionConsole(false);
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    // With explicit opt-in, the legacy mock fallback re-engages.
    await expect(freshApi.getLines()).resolves.toEqual(expect.any(Array));
  });
});

describe('api read operations', () => {
  it('getLines is a function', () => {
    expect(typeof api.getLines).toBe('function');
  });

  it('getChats is a function accepting (name)', () => {
    expect(typeof api.getChats).toBe('function');
    expect(api.getChats.length).toBe(1);
  });

  it('getMessages is a function accepting (name, conversationKey, beforePk?)', () => {
    expect(typeof api.getMessages).toBe('function');
    expect(api.getMessages.length).toBeGreaterThanOrEqual(2);
  });

  it('getMetrics is a function accepting (name, range)', () => {
    expect(typeof api.getMetrics).toBe('function');
    expect(api.getMetrics.length).toBe(2);
  });

  it('getAccess is a function accepting (name)', () => {
    expect(typeof api.getAccess).toBe('function');
    expect(api.getAccess.length).toBe(1);
  });

  it('normalizes nullable chat history rows before returning chats to the console', async () => {
    stubProductionConsole(false);
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([
        {
          conversationKey: '15551234567',
          name: null,
          lastMessagePreview: null,
          lastMessageAt: null,
          unreadCount: null,
          isGroup: null,
        },
      ]));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getChats('line-a')).resolves.toEqual([
      {
        conversationKey: '15551234567',
        name: '15551234567',
        lastMessagePreview: '',
        lastMessageAt: '',
        unreadCount: 0,
        isGroup: false,
      },
    ]);
  });

  it('normalizes nullable message history rows before returning messages to the console', async () => {
    stubProductionConsole(false);
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([
        {
          pk: 42,
          conversationKey: '15551234567',
          senderName: null,
          senderJid: null,
          content: null,
          timestamp: null,
          fromMe: null,
          type: null,
          rawMessage: null,
        },
      ]));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getMessages('line-a', '15551234567')).resolves.toEqual([
      {
        pk: 42,
        conversationKey: '15551234567',
        senderName: '',
        senderJid: '',
        content: null,
        timestamp: '',
        fromMe: false,
        type: 'unknown',
        rawMessage: undefined,
      },
    ]);
  });

  it('normalizes nullable message rows returned by history search', async () => {
    stubProductionConsole(false);
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({
      results: [
        {
          pk: 43,
          conversationKey: '15551234567',
          senderName: null,
          senderJid: null,
          content: null,
          timestamp: null,
          fromMe: null,
          type: null,
          rawMessage: null,
        },
      ],
      total: null,
      query: null,
    }));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.searchMessages('line-a', 'receipt', '15551234567')).resolves.toEqual({
      results: [
        {
          pk: 43,
          conversationKey: '15551234567',
          senderName: '',
          senderJid: '',
          content: null,
          timestamp: '',
          fromMe: false,
          type: 'unknown',
          rawMessage: undefined,
        },
      ],
      total: 1,
      query: '',
    });
  });

  it('normalizes a history search response that omits the results array', async () => {
    stubProductionConsole(false);
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ query: 'receipt' }));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.searchMessages('line-a', 'receipt')).resolves.toEqual({
      results: [],
      total: 0,
      query: 'receipt',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/lines/line-a/messages/search?q=receipt');
  });

  it('threads encoded URLs, methods, and bodies through direct API wrappers', async () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_MOCK_MODE', '');
    stubProductionConsole(false);
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/messages?')) return jsonResponse([]);
      if (url.endsWith('/providers')) return jsonResponse([]);
      if (url.endsWith('/access')) return jsonResponse([]);
      if (url.endsWith('/logs')) return jsonResponse([]);
      if (url.endsWith('/feed')) return jsonResponse([]);
      if (url.endsWith('/typing')) return jsonResponse([]);
      return jsonResponse({ results: [], messages: [], groups: [], contacts: [] });
    });
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    const cases: Array<{
      invoke: () => Promise<unknown>;
      path: string;
      method?: string;
      body?: unknown;
    }> = [
      { invoke: () => freshApi.getLine('line a'), path: '/api/lines/line%20a' },
      { invoke: () => freshApi.getMessages('line a', 'chat jid', 99), path: '/api/lines/line%20a/messages?conversation_key=chat%20jid&before_pk=99' },
      { invoke: () => freshApi.getMetrics('line a', '24h'), path: '/api/lines/line%20a/metrics?range=24h' },
      { invoke: () => freshApi.getFleetMetrics('7d'), path: '/api/metrics?range=7d' },
      { invoke: () => freshApi.getAccess('line a'), path: '/api/lines/line%20a/access' },
      { invoke: () => freshApi.getLogs('line a'), path: '/api/lines/line%20a/logs' },
      { invoke: () => freshApi.getFeed(), path: '/api/feed' },
      { invoke: () => freshApi.getTyping(), path: '/api/typing' },
      { invoke: () => freshApi.stopInstance('line a'), path: '/api/lines/line%20a/stop', method: 'POST' },
      { invoke: () => freshApi.deleteLine('line a'), path: '/api/lines/line%20a', method: 'DELETE' },
      { invoke: () => freshApi.sendMessage('line a', 'chat jid', 'hello'), path: '/api/lines/line%20a/send', method: 'POST', body: { chatJid: 'chat jid', text: 'hello' } },
      { invoke: () => freshApi.accessDecision('line a', 'phone', '1555000001', 'allow'), path: '/api/lines/line%20a/access', method: 'POST', body: { subjectType: 'phone', subjectId: '1555000001', action: 'allow' } },
      { invoke: () => freshApi.markRead('line a', 'chat jid'), path: '/api/lines/line%20a/mark-read', method: 'POST', body: { conversation_key: 'chat jid' } },
      { invoke: () => freshApi.updateConfig('line a', { enabled: true }), path: '/api/lines/line%20a/config', method: 'PATCH', body: { enabled: true } },
      { invoke: () => freshApi.createLine({ name: 'line a' }), path: '/api/lines', method: 'POST', body: { name: 'line a' } },
      { invoke: () => freshApi.checkExists('line a'), path: '/api/lines/line%20a/exists' },
      { invoke: () => freshApi.checkDirectory('/tmp/line a'), path: '/api/directories/check?path=%2Ftmp%2Fline%20a' },
      { invoke: () => freshApi.getVersion(), path: '/api/version' },
      { invoke: () => freshApi.getProviders(), path: '/api/providers' },
      { invoke: () => freshApi.getProviderStatus('line a'), path: '/api/lines/line%20a/provider-status' },
      { invoke: () => freshApi.getScheduled('line a', 'pending'), path: '/api/lines/line%20a/scheduled?status=pending' },
      { invoke: () => freshApi.getScheduled('line a'), path: '/api/lines/line%20a/scheduled' },
      { invoke: () => freshApi.cancelScheduled('line a', 42), path: '/api/lines/line%20a/scheduled/42', method: 'DELETE' },
      { invoke: () => freshApi.getGroups('line a'), path: '/api/lines/line%20a/groups' },
      { invoke: () => freshApi.searchContacts('line a', 'Ada Lovelace'), path: '/api/lines/line%20a/contacts/search?q=Ada%20Lovelace' },
      { invoke: () => freshApi.createScheduled('line a', { text: 'hello' }), path: '/api/lines/line%20a/scheduled', method: 'POST', body: { text: 'hello' } },
      { invoke: () => freshApi.updateScheduled('line a', 42, { text: 'hello' }), path: '/api/lines/line%20a/scheduled/42', method: 'PUT', body: { text: 'hello' } },
      { invoke: () => freshApi.getScheduledById('line a', 42), path: '/api/lines/line%20a/scheduled/42' },
      { invoke: () => freshApi.getGroupDetail('line a', '1555100001@g.us'), path: '/api/lines/line%20a/groups/1555100001%40g.us' },
      { invoke: () => freshApi.createGroup('line a', 'Team A', ['1555000001@s.whatsapp.net']), path: '/api/lines/line%20a/groups', method: 'POST', body: { subject: 'Team A', participants: ['1555000001@s.whatsapp.net'] } },
      { invoke: () => freshApi.leaveGroup('line a', '1555100001@g.us'), path: '/api/lines/line%20a/groups/1555100001%40g.us', method: 'DELETE' },
      { invoke: () => freshApi.updateGroupSubject('line a', '1555100001@g.us', 'Team A'), path: '/api/lines/line%20a/groups/1555100001%40g.us/subject', method: 'PUT', body: { subject: 'Team A' } },
      { invoke: () => freshApi.updateGroupDescription('line a', '1555100001@g.us', undefined), path: '/api/lines/line%20a/groups/1555100001%40g.us/description', method: 'PUT', body: {} },
      { invoke: () => freshApi.updateGroupParticipants('line a', '1555100001@g.us', ['1555000001@s.whatsapp.net'], 'promote'), path: '/api/lines/line%20a/groups/1555100001%40g.us/participants', method: 'POST', body: { participants: ['1555000001@s.whatsapp.net'], action: 'promote' } },
      { invoke: () => freshApi.updateGroupSettings('line a', '1555100001@g.us', 'announcement'), path: '/api/lines/line%20a/groups/1555100001%40g.us/settings', method: 'PUT', body: { setting: 'announcement' } },
      { invoke: () => freshApi.getGroupInviteLink('line a', '1555100001@g.us'), path: '/api/lines/line%20a/groups/1555100001%40g.us/invite' },
      { invoke: () => freshApi.revokeGroupInvite('line a', '1555100001@g.us'), path: '/api/lines/line%20a/groups/1555100001%40g.us/invite/revoke', method: 'POST' },
      { invoke: () => freshApi.updateGroupEphemeral('line a', '1555100001@g.us', 86400), path: '/api/lines/line%20a/groups/1555100001%40g.us/ephemeral', method: 'PUT', body: { expiration: 86400 } },
      { invoke: () => freshApi.updateGroupMemberAddMode('line a', '1555100001@g.us', 'admin_add'), path: '/api/lines/line%20a/groups/1555100001%40g.us/member-add-mode', method: 'PUT', body: { mode: 'admin_add' } },
      { invoke: () => freshApi.updateGroupJoinApproval('line a', '1555100001@g.us', 'on'), path: '/api/lines/line%20a/groups/1555100001%40g.us/join-approval', method: 'PUT', body: { mode: 'on' } },
    ];

    for (const [index, entry] of cases.entries()) {
      await entry.invoke();
      const call = fetch.mock.calls[index] as unknown as [string, RequestInit?];
      expect(call).toBeDefined();
      const path = call[0];
      const init = call[1] ?? {};
      expect(path).toBe(entry.path);
      expect(init.method ?? 'GET').toBe(entry.method ?? 'GET');
      if (entry.body !== undefined) {
        expect(JSON.parse(init.body as string)).toEqual(entry.body);
      } else {
        expect(init.body).toBeUndefined();
      }
    }
  });

  it('reuses a successful availability probe across fallback-backed reads and builds query strings', async () => {
    stubProductionConsole(false);
    const fetch = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getLine('line main')).resolves.toEqual([]);
    await expect(freshApi.getMessages('line main', 'chat/key', 123)).resolves.toEqual([]);
    await expect(freshApi.getMetrics('line main', '24h')).resolves.toEqual([]);
    await expect(freshApi.getFleetMetrics('7d')).resolves.toEqual([]);
    await expect(freshApi.getAccess('line main')).resolves.toEqual([]);
    await expect(freshApi.getLogs('line main')).resolves.toEqual([]);
    await expect(freshApi.getFeed()).resolves.toEqual([]);
    await expect(freshApi.getTyping()).resolves.toEqual([]);
    await expect(freshApi.getScheduled('line main', 'pending')).resolves.toEqual([]);
    await expect(freshApi.getGroups('line main')).resolves.toEqual([]);
    await expect(freshApi.searchContacts('line main', 'Ada Lovelace')).resolves.toEqual([]);
    await expect(freshApi.getGroupDetail('line main', 'group/jid')).resolves.toEqual([]);

    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/lines',
      '/api/lines/line%20main',
      '/api/lines/line%20main/messages?conversation_key=chat%2Fkey&before_pk=123',
      '/api/lines/line%20main/metrics?range=24h',
      '/api/metrics?range=7d',
      '/api/lines/line%20main/access',
      '/api/lines/line%20main/logs',
      '/api/feed',
      '/api/typing',
      '/api/lines/line%20main/scheduled?status=pending',
      '/api/lines/line%20main/groups',
      '/api/lines/line%20main/contacts/search?q=Ada%20Lovelace',
      '/api/lines/line%20main/groups/group%2Fjid',
    ]);
  });

  it('falls back to mock line data after an available fleet API read fails', async () => {
    stubProductionConsole(false);
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(errorResponse(503, 'service unavailable'));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getLine('personal')).resolves.toMatchObject({ name: 'personal' });
  });

  it('reports missing mock fallback records for line and group detail reads', async () => {
    stubProductionConsole(false);
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getLine('not-a-line')).rejects.toThrow('Not found');
    await expect(freshApi.getGroupDetail('personal', 'missing-group')).rejects.toThrow('Not found');
  });

  it('uses deterministic mock data for fallback-backed reads when the fleet is offline', async () => {
    stubProductionConsole(false);
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getChats('personal')).resolves.toEqual(expect.any(Array));
    await expect(freshApi.getMessages('personal', '120363001@g.us')).resolves.toEqual(expect.any(Array));
    await expect(freshApi.getMetrics('personal', '24h')).resolves.toMatchObject({ range: '24h' });
    await expect(freshApi.getFleetMetrics('7d')).resolves.toMatchObject({ range: '7d' });
    await expect(freshApi.getAccess('personal')).resolves.toEqual(expect.any(Array));
    await expect(freshApi.getLogs('personal')).resolves.toEqual(expect.any(Array));
    await expect(freshApi.getFeed()).resolves.toEqual(expect.any(Array));
    await expect(freshApi.getTyping()).resolves.toEqual(expect.any(Array));
    await expect(freshApi.getScheduled('support')).resolves.toMatchObject({ count: expect.any(Number) });
    await expect(freshApi.getGroups('personal')).resolves.toMatchObject({ groups: expect.any(Array) });
    await expect(freshApi.searchContacts('personal', '555')).resolves.toMatchObject({ contacts: expect.any(Array) });
    await expect(freshApi.getGroupDetail('personal', '120363001@g.us')).resolves.toMatchObject({
      id: '120363001@g.us',
      inviteLink: expect.stringContaining('mock120363001'),
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/lines');
  });
});

describe('api operation request construction', () => {
  it('builds direct operation routes, methods, and JSON bodies', async () => {
    stubProductionConsole(false);
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');
    const cases = [
      {
        run: () => freshApi.stopInstance('line main'),
        url: '/api/lines/line%20main/stop',
        method: 'POST',
      },
      {
        run: () => freshApi.deleteLine('line/main'),
        url: '/api/lines/line%2Fmain',
        method: 'DELETE',
      },
      {
        run: () => freshApi.sendMessage('line main', 'chat/jid', 'hello'),
        url: '/api/lines/line%20main/send',
        method: 'POST',
        body: { chatJid: 'chat/jid', text: 'hello' },
      },
      {
        run: () => freshApi.accessDecision('line main', 'user', 'chat/jid', 'allow'),
        url: '/api/lines/line%20main/access',
        method: 'POST',
        body: { subjectType: 'user', subjectId: 'chat/jid', action: 'allow' },
      },
      {
        run: () => freshApi.markRead('line main', 'chat/jid'),
        url: '/api/lines/line%20main/mark-read',
        method: 'POST',
        body: { conversation_key: 'chat/jid' },
      },
      {
        run: () => freshApi.updateConfig('line main', { mode: 'agent' }),
        url: '/api/lines/line%20main/config',
        method: 'PATCH',
        body: { mode: 'agent' },
      },
      {
        run: () => freshApi.createLine({ name: 'line main', mode: 'agent' }),
        url: '/api/lines',
        method: 'POST',
        body: { name: 'line main', mode: 'agent' },
      },
      {
        run: () => freshApi.checkExists('line main'),
        url: '/api/lines/line%20main/exists',
      },
      {
        run: () => freshApi.checkDirectory('/tmp/line main'),
        url: '/api/directories/check?path=%2Ftmp%2Fline%20main',
      },
      {
        run: () => freshApi.getVersion(),
        url: '/api/version',
      },
      {
        run: () => freshApi.getProviders(),
        url: '/api/providers',
      },
      {
        run: () => freshApi.getProviderStatus('line main'),
        url: '/api/lines/line%20main/provider-status',
      },
      {
        run: () => freshApi.cancelScheduled('line main', 7),
        url: '/api/lines/line%20main/scheduled/7',
        method: 'DELETE',
      },
      {
        run: () => freshApi.createScheduled('line main', { text: 'later' }),
        url: '/api/lines/line%20main/scheduled',
        method: 'POST',
        body: { text: 'later' },
      },
      {
        run: () => freshApi.updateScheduled('line main', 7, { text: 'soon' }),
        url: '/api/lines/line%20main/scheduled/7',
        method: 'PUT',
        body: { text: 'soon' },
      },
      {
        run: () => freshApi.getScheduledById('line main', 7),
        url: '/api/lines/line%20main/scheduled/7',
      },
      {
        run: () => freshApi.createGroup('line main', 'Ops Chat', ['one', 'two']),
        url: '/api/lines/line%20main/groups',
        method: 'POST',
        body: { subject: 'Ops Chat', participants: ['one', 'two'] },
      },
      {
        run: () => freshApi.leaveGroup('line main', 'group/jid'),
        url: '/api/lines/line%20main/groups/group%2Fjid',
        method: 'DELETE',
      },
      {
        run: () => freshApi.updateGroupSubject('line main', 'group/jid', 'New Subject'),
        url: '/api/lines/line%20main/groups/group%2Fjid/subject',
        method: 'PUT',
        body: { subject: 'New Subject' },
      },
      {
        run: () => freshApi.updateGroupDescription('line main', 'group/jid', 'New description'),
        url: '/api/lines/line%20main/groups/group%2Fjid/description',
        method: 'PUT',
        body: { description: 'New description' },
      },
      {
        run: () => freshApi.updateGroupParticipants('line main', 'group/jid', ['one'], 'promote'),
        url: '/api/lines/line%20main/groups/group%2Fjid/participants',
        method: 'POST',
        body: { participants: ['one'], action: 'promote' },
      },
      {
        run: () => freshApi.updateGroupSettings('line main', 'group/jid', 'announcement'),
        url: '/api/lines/line%20main/groups/group%2Fjid/settings',
        method: 'PUT',
        body: { setting: 'announcement' },
      },
      {
        run: () => freshApi.getGroupInviteLink('line main', 'group/jid'),
        url: '/api/lines/line%20main/groups/group%2Fjid/invite',
      },
      {
        run: () => freshApi.revokeGroupInvite('line main', 'group/jid'),
        url: '/api/lines/line%20main/groups/group%2Fjid/invite/revoke',
        method: 'POST',
      },
      {
        run: () => freshApi.updateGroupEphemeral('line main', 'group/jid', 86400),
        url: '/api/lines/line%20main/groups/group%2Fjid/ephemeral',
        method: 'PUT',
        body: { expiration: 86400 },
      },
      {
        run: () => freshApi.updateGroupMemberAddMode('line main', 'group/jid', 'admin_add'),
        url: '/api/lines/line%20main/groups/group%2Fjid/member-add-mode',
        method: 'PUT',
        body: { mode: 'admin_add' },
      },
      {
        run: () => freshApi.updateGroupJoinApproval('line main', 'group/jid', 'on'),
        url: '/api/lines/line%20main/groups/group%2Fjid/join-approval',
        method: 'PUT',
        body: { mode: 'on' },
      },
    ];

    for (const testCase of cases) {
      await expect(testCase.run()).resolves.toEqual({ ok: true });
    }

    expect(fetch).toHaveBeenCalledTimes(cases.length);
    cases.forEach((testCase, index) => {
      expect(fetch.mock.calls[index]?.[0]).toBe(testCase.url);
      const init = fetchInit(fetch, index);
      expect(init.method).toBe(testCase.method);
      expect(headersFor(init)).toEqual({ 'Content-Type': 'application/json' });
      expect(parsedBody(init)).toEqual(testCase.body);
    });
  });
});
