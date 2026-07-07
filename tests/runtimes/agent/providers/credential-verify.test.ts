import { describe, it, expect, vi } from 'vitest';

import {
  verifyFallbackCredential,
} from '../../../../src/runtimes/agent/providers/credential-verify.ts';
import type { CredentialVerifyResult } from '../../../../src/runtimes/agent/providers/credential-verify.ts';

// ---------------------------------------------------------------------------
// Fake fetch builder — never touches the network.
// ---------------------------------------------------------------------------
function makeFetch(status: number): typeof fetch {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
  })) as unknown as typeof fetch;
}

describe('verifyFallbackCredential', () => {
  // 1. 200 → 'valid'
  it('returns valid on HTTP 200', async () => {
    const fakeFetch = makeFetch(200);
    const result = await verifyFallbackCredential('openai', 'any-key', fakeFetch);
    expect(result).toBe<CredentialVerifyResult>('valid');
  });

  // 2. 401 → 'invalid'; 403 → 'invalid'
  it.each([401, 403])('returns invalid on HTTP %i', async (status) => {
    const fakeFetch = makeFetch(status);
    const result = await verifyFallbackCredential('openai', 'bad-key', fakeFetch);
    expect(result).toBe<CredentialVerifyResult>('invalid');
  });

  // 3. 500 → 'unknown' (fail-open)
  it('returns unknown on HTTP 500 (fail-open)', async () => {
    const fakeFetch = makeFetch(500);
    const result = await verifyFallbackCredential('openai', 'any-key', fakeFetch);
    expect(result).toBe<CredentialVerifyResult>('unknown');
  });

  // 4. fetch rejects (network error) → 'unknown' (fail-open)
  it('returns unknown when fetch rejects (fail-open)', async () => {
    const failFetch = vi.fn(async () => {
      throw new Error('network failure');
    }) as unknown as typeof fetch;
    const result = await verifyFallbackCredential('openai', 'any-key', failFetch);
    expect(result).toBe<CredentialVerifyResult>('unknown');
  });

  // 5. unmapped service → 'unknown' AND fetch never called
  it('returns unknown for an unmapped service without calling fetch', async () => {
    const fakeFetch = makeFetch(200);
    const result = await verifyFallbackCredential('unknown-provider', 'any-key', fakeFetch);
    expect(result).toBe<CredentialVerifyResult>('unknown');
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  // 5b. Mapped-but-unprobed services (SERVICE_ENV_MAP entries with no
  //     CREDENTIAL_PROBE_DESCRIPTORS entry) degrade to presence-only checks: 'unknown',
  //     fetch never called, so fallback_credential_invalid can never fire for
  //     them. Locked per service so adding a probe entry flips a named test.
  //     If it flips: prove the endpoint returns 401/403 on a bad key first —
  //     openrouter serves GET /models publicly (HTTP 200 with an invalid key,
  //     observed 2026-07-03), so a /models-shaped probe there would be mute
  //     and fail open forever. See the qualification comment in
  //     credential-verify.ts.
  it.each(['glm', 'xai', 'groq', 'mistral', 'openrouter', 'google', 'fireworks-ai', 'togetherai'])(
    'returns unknown for mapped-but-unprobed service %s without calling fetch',
    async (service) => {
      const fakeFetch = makeFetch(200);
      const result = await verifyFallbackCredential(service, 'any-key', fakeFetch);
      expect(result).toBe<CredentialVerifyResult>('unknown');
      expect(fakeFetch).not.toHaveBeenCalled();
    },
  );

  // 6. Key handling: Authorization header is exactly `Bearer <key>`, URL does
  //    not contain the key, and init.signal is an AbortSignal.
  it('sends Authorization: Bearer <key>, URL does not leak key, signal is AbortSignal', async () => {
    const secret = 'secret-key';
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    const spyFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url as string;
      capturedInit = init;
      return { status: 200, ok: true };
    }) as unknown as typeof fetch;

    await verifyFallbackCredential('openai', secret, spyFetch);

    expect(capturedInit?.headers).toBeDefined();
    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${secret}`);
    expect(capturedUrl).not.toContain(secret);
    expect(capturedInit!.signal).toBeInstanceOf(AbortSignal);
  });

  // 6b. anthropic uses x-api-key auth (not Bearer) plus the anthropic-version
  //     header; the key never appears in the URL or an Authorization header.
  it('sends x-api-key (not Authorization) + anthropic-version for anthropic', async () => {
    const secret = 'secret-anthropic-key';
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;

    const spyFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url as string;
      capturedInit = init;
      return { status: 200, ok: true };
    }) as unknown as typeof fetch;

    await verifyFallbackCredential('anthropic', secret, spyFetch);

    const headers = capturedInit!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(secret);
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(capturedUrl).not.toContain(secret);
  });

  // Regression guard for #1056: a 3xx must abort rather than forward the bearer
  // header to the redirect target.
  it("sets redirect: 'error' so a 3xx never forwards the bearer key", async () => {
    let capturedInit: RequestInit | undefined;
    const spyFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return { status: 200, ok: true };
    }) as unknown as typeof fetch;

    await verifyFallbackCredential('openai', 'any-key', spyFetch);

    expect(capturedInit?.redirect).toBe('error');
  });

  // 7. Each mapped service probes its exact documented URL.
  it.each([
    ['anthropic', 'https://api.anthropic.com/v1/models'],
    ['deepseek', 'https://api.deepseek.com/models'],
    ['minimax', 'https://api.minimax.io/v1/models'],
    ['openai', 'https://api.openai.com/v1/models'],
  ])('probes the correct URL for service %s', async (service, expectedUrl) => {
    let capturedUrl: string | undefined;
    const spyFetch = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = url as string;
      return { status: 200, ok: true };
    }) as unknown as typeof fetch;

    await verifyFallbackCredential(service, 'any-key', spyFetch);

    expect(capturedUrl).toBe(expectedUrl);
  });
});
