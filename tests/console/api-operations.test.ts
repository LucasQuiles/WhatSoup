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

  it('saveContact is a function accepting (name, contact)', () => {
    expect(typeof api.saveContact).toBe('function');
    expect(api.saveContact.length).toBe(2);
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

describe('api auth headers', () => {
  it('mints an api-audience ticket and threads it on availability probes and fallback-backed reads (#313)', async () => {
    stubFleetToken('fleet-token-123');
    // Sequence: mint -> probe -> read. Mint consumes the root token; every
    // subsequent call sees only the api-audience ticket.
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ticket: 'api-ticket-abc', audience: 'api', expiresIn: 60 }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getLines()).resolves.toEqual([]);

    // 3 calls total: 1 mint + 1 probe + 1 read.
    expect(fetch).toHaveBeenCalledTimes(3);

    expect(fetch.mock.calls[0]?.[0]).toBe('/api/auth-ticket');
    expect(headersFor(fetchInit(fetch, 0))).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer fleet-token-123',
    });

    expect(fetch.mock.calls[1]?.[0]).toBe('/api/lines');
    expect(headersFor(fetchInit(fetch, 1))).toEqual({
      Authorization: 'Bearer api-ticket-abc',
    });

    expect(fetch.mock.calls[2]?.[0]).toBe('/api/lines');
    expect(headersFor(fetchInit(fetch, 2))).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer api-ticket-abc',
    });
  });

  it('omits Authorization on availability probes and reads when no meta token exists', async () => {
    stubFleetToken(null);
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

  it('clears the availability probe timeout when fetch rejects', async () => {
    stubFleetToken(null);
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    vi.stubGlobal('fetch', fetch);

    const { api: freshApi } = await import('../../console/src/lib/api.ts');

    await expect(freshApi.getLines()).resolves.toEqual(expect.any(Array));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('threads the api-audience ticket (not the root token) on write requests (#313)', async () => {
    stubFleetToken('fleet-token-123');
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
    stubFleetToken(null);
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
    stubFleetToken(null);
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
    stubFleetToken(null);
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
    stubFleetToken(null);
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
});
