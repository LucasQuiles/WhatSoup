import { afterEach, describe, expect, it, vi } from 'vitest';

import * as agent365Contract from '../../src/core/capabilities/agent365-v1-contract.ts';
import {
  agent365AccountDigest,
  createAgent365Client,
  getInternalAgent365AccountPermit,
  type Agent365ClientOptions,
  type Agent365ReadinessProbeResult,
} from '../../src/core/capabilities/agent365-client.ts';

const ENDPOINT = 'http://127.0.0.1:10000';
const READINESS_URL = `${ENDPOINT}/capabilities/microsoft-365/readiness`;
const API_KEY = 'test-key';
const OBSERVED_AT = '2026-07-11T16:00:00Z';
const NOW_MS = Date.parse(OBSERVED_AT);

function readyReadiness(accountId = 'acct-contract'): Record<string, unknown> {
  return {
    version: 1,
    status: 'ready',
    account_id: accountId,
    observed_at: OBSERVED_AT,
    expires_at: '2026-07-11T16:01:00Z',
    read: {
      ready: true,
      reason_codes: [],
      authenticated: true,
      token_broker_enabled: true,
      subscriptions_current: true,
      ingestion_fresh: true,
      public_ingress_ready: true,
    },
    mail_send: {
      ready: true,
      reason_codes: [],
      permission_ready: true,
      ledger_ready: true,
    },
  };
}

function notReadyReadiness(): Record<string, unknown> {
  return {
    version: 1,
    status: 'not_ready',
    account_id: null,
    observed_at: OBSERVED_AT,
    expires_at: '2026-07-11T16:01:00Z',
    read: {
      ready: false,
      reason_codes: ['no_authenticated_account'],
      authenticated: false,
      token_broker_enabled: true,
      subscriptions_current: false,
      ingestion_fresh: false,
      public_ingress_ready: false,
    },
    mail_send: {
      ready: false,
      reason_codes: ['no_authenticated_account'],
      permission_ready: false,
      ledger_ready: false,
    },
  };
}

function jsonResponse(
  value: unknown,
  init: {
    status?: number;
    url?: string;
    contentType?: string;
  } = {},
): Response {
  const response = new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'application/json' },
  });
  Object.defineProperty(response, 'url', {
    configurable: true,
    value: init.url ?? READINESS_URL,
  });
  return response;
}

function byteResponse(
  bytes: Uint8Array,
  init: {
    status?: number;
    url?: string;
    contentType?: string;
  } = {},
): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  const response = new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'application/json' },
  });
  Object.defineProperty(response, 'url', {
    configurable: true,
    value: init.url ?? READINESS_URL,
  });
  return response;
}

function options(fetchImpl: typeof fetch): Agent365ClientOptions {
  return {
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    fetch: fetchImpl,
    clock: () => NOW_MS,
    timeoutMs: 1_000,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Agent365 readiness HTTP client', () => {
  it('fails construction closed with a fixed error when the vendored oracle drifts', () => {
    const marker = 'private-oracle-error-marker';
    const fetchImpl = vi.fn<typeof fetch>();
    vi.spyOn(agent365Contract, 'assertVendoredAgent365V1Oracle').mockImplementationOnce(() => {
      throw new Error(marker);
    });

    expect(() => createAgent365Client(options(fetchImpl))).toThrowError(
      'agent365_client_configuration_invalid',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'https://127.0.0.1:10000',
    'http://192.0.2.10:10000',
    'http://127.0.0.1:10000/prefix',
    'http://127.0.0.1:10000/?next=http://outside.invalid',
    'http://user:password@127.0.0.1:10000',
  ])('rejects a non-exact loopback root without echoing it: %s', (endpoint) => {
    const marker = `${endpoint}/private-marker`;

    expect(() => createAgent365Client({
      ...options(vi.fn<typeof fetch>()),
      endpoint: marker,
    })).toThrowError('agent365_client_configuration_invalid');

    try {
      createAgent365Client({
        ...options(vi.fn<typeof fetch>()),
        endpoint: marker,
      });
    } catch (error) {
      expect(String(error)).not.toContain(marker);
      expect(String(error)).not.toContain('password');
    }
  });

  it('uses only the fixed readiness path, exact origin bearer, and redirect error mode', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(readyReadiness(), { contentType: 'application/json; charset=utf-8' }),
    );
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.probeReadiness();

    expect(result.kind).toBe('evidence');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      READINESS_URL,
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        signal: expect.any(AbortSignal),
      }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('acct-contract');
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(ENDPOINT);
    expect(serialized).not.toContain('account_id');
    expect(getInternalAgent365AccountPermit(result)).toEqual({
      accountDigest: agent365AccountDigest('acct-contract'),
    });
  });

  it('treats a coherent 503 v1 body as bounded non-ready evidence', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(notReadyReadiness(), { status: 503 }),
    );
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.probeReadiness();

    expect(result).toMatchObject({
      kind: 'evidence',
      evidence: {
        version: 1,
        status: 'not_ready',
        mailSend: { ready: false },
      },
    });
    expect(JSON.stringify(result)).not.toContain('accountId');
  });

  it('rejects redirects without retrying or forwarding the bearer', async () => {
    const marker = 'redirect-private-marker';
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new TypeError(`fetch redirected to https://outside.invalid/${marker}`),
    );
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.probeReadiness();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(READINESS_URL);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('error');
    expect(result).toEqual({ kind: 'unavailable', reason: 'transport_unavailable' });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('links an external lifecycle abort to the in-flight readiness request', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('synthetic lifecycle abort', 'AbortError'));
        }, { once: true });
      });
    });
    const client = createAgent365Client(options(fetchImpl));
    const controller = new AbortController();
    let outcome: Agent365ReadinessProbeResult | undefined;
    const probing = client.probeReadiness(controller.signal).then((result) => {
      outcome = result;
    });

    controller.abort();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    expect(requestSignal?.aborted).toBe(true);
    expect(outcome).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await probing;
  });

  it('does not start a fetch for a pre-aborted lifecycle signal', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(
      new DOMException('synthetic pre-abort rejection', 'AbortError'),
    );
    const client = createAgent365Client(options(fetchImpl));
    const controller = new AbortController();
    controller.abort();

    const result = await client.probeReadiness(controller.signal);

    expect(result).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an otherwise valid response whose final URL is not exact', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(readyReadiness('response-marker'), {
        url: 'http://localhost:10000/capabilities/microsoft-365/readiness',
      }),
    );
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.probeReadiness();

    expect(result).toEqual({ kind: 'unavailable', reason: 'response_url_mismatch' });
    expect(JSON.stringify(result)).not.toContain('response-marker');
  });

  it('requires application/json while allowing parameters', async () => {
    const badFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(readyReadiness(), { contentType: 'text/json' }),
    );
    const goodFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(readyReadiness(), { contentType: ' Application/JSON ; charset=utf-8' }),
    );

    await expect(createAgent365Client(options(badFetch)).probeReadiness()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'response_content_type_invalid',
    });
    await expect(createAgent365Client(options(goodFetch)).probeReadiness()).resolves.toMatchObject({
      kind: 'evidence',
      evidence: { status: 'ready' },
    });
  });

  it('hard-rejects a streamed body at 16 KiB plus one before decoding or parsing', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024));
        controller.enqueue(new Uint8Array([0x7b]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = {
      status: 200,
      url: READINESS_URL,
      headers: new Headers({ 'content-type': 'application/json' }),
      body,
      arrayBuffer: vi.fn<() => Promise<ArrayBuffer>>(),
    } as unknown as Response;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.probeReadiness();

    expect(result).toEqual({ kind: 'unavailable', reason: 'response_too_large' });
    expect(cancelled).toBe(true);
    expect(response.arrayBuffer).not.toHaveBeenCalled();
  });

  it('hard-rejects a non-stream fallback at 16 KiB plus one before UTF-8 decoding', async () => {
    const bytes = new Uint8Array((16 * 1024) + 1).fill(0x61);
    const arrayBuffer = vi.fn(async () => bytes.buffer);
    const response = {
      status: 200,
      url: READINESS_URL,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      arrayBuffer,
    } as unknown as Response;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.probeReadiness();

    expect(result).toEqual({ kind: 'unavailable', reason: 'response_too_large' });
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid UTF-8 instead of replacement-decoding it', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      byteResponse(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x28, 0x7d])),
    );
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.probeReadiness();

    expect(result).toEqual({ kind: 'unavailable', reason: 'response_invalid_utf8' });
  });

  it('uses one total timeout that still expires while the body is pending', async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
    });
    const response = {
      status: 200,
      url: READINESS_URL,
      headers: new Headers({ 'content-type': 'application/json' }),
      body,
      arrayBuffer: vi.fn<() => Promise<ArrayBuffer>>(),
    } as unknown as Response;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    const client = createAgent365Client({ ...options(fetchImpl), timeoutMs: 25 });

    const pending = client.probeReadiness();
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [200, notReadyReadiness()],
    [503, readyReadiness()],
  ])('rejects HTTP/body readiness status incoherence for HTTP %s', async (status, body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body, { status }));
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.probeReadiness();

    expect(result).toEqual({ kind: 'unavailable', reason: 'response_contract_invalid' });
  });

  it('never returns raw JSON, endpoint, account, key, or thrown exception markers', async () => {
    const marker = 'private-exception-marker';
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(marker));
    const client = createAgent365Client(options(fetchImpl));

    const result = await client.probeReadiness();
    const loggable = JSON.stringify(result);

    expect(loggable.length).toBeLessThan(256);
    expect(loggable).not.toContain(marker);
    expect(loggable).not.toContain(API_KEY);
    expect(loggable).not.toContain(ENDPOINT);
    expect(loggable).not.toContain('acct-contract');
  });
});
