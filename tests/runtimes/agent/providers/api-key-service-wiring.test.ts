/**
 * Integration coverage for #363: HTTP agent providers must honor
 * `providerConfig.apiKeyService` for keyring-based credential resolution
 * before falling back to the conventional env var.
 *
 * Strategy: mock `lookupCredential` and `fetch`, construct each provider with
 * an `apiKeyService`, drive a single callApi turn, and assert the captured
 * Authorization / x-api-key header reflects the keyring value when present.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(),
}));

import { OpenAIApiProvider } from '../../../../src/runtimes/agent/providers/openai-api.ts';
import { AnthropicApiProvider } from '../../../../src/runtimes/agent/providers/anthropic-api.ts';
import { lookupCredential } from '../../../../src/lib/keyring.ts';

const mockedLookup = vi.mocked(lookupCredential);

type FetchInit = { headers?: Record<string, string>; body?: string; signal?: AbortSignal };

interface CapturedRequest {
  url: string;
  init: FetchInit;
}

function installFetchMock(): { captured: CapturedRequest[]; restore: () => void } {
  const captured: CapturedRequest[] = [];
  const realFetch = globalThis.fetch;

  // Minimal SSE body that terminates immediately so callApi() returns cleanly.
  const sseBody = (): ReadableStream<Uint8Array> => {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
  };

  globalThis.fetch = (async (input: unknown, init?: FetchInit): Promise<Response> => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(sseBody(), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;

  return {
    captured,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

async function driveTurn(provider: OpenAIApiProvider | AnthropicApiProvider): Promise<void> {
  const events: Array<Record<string, unknown>> = [];
  await provider.initialize({
    sessionId: 'test-session',
    systemPrompt: 'sys',
    workingDirectory: process.cwd(),
    onEvent: (e: Record<string, unknown>) => { events.push(e); },
    onError: () => {},
    onIdle: () => {},
    mcpBridge: { listTools: () => [], callTool: async () => ({ result: '' }) } as never,
  } as never);

  await provider.sendTurn({
    parts: [{ kind: 'text', text: 'hello' }],
  } as never);
}

describe('HTTP providers honor apiKeyService (issue #363)', () => {
  const originalEnv = { ...process.env };
  let fetchMock: ReturnType<typeof installFetchMock>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedLookup.mockReset();
    mockedLookup.mockReturnValue(null);
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    fetchMock = installFetchMock();
  });

  afterEach(() => {
    fetchMock.restore();
    process.env = { ...originalEnv };
  });

  describe('OpenAIApiProvider', () => {
    it('uses keyring value from apiKeyService for Authorization header', async () => {
      process.env.OPENAI_API_KEY = 'env-key-should-be-overridden';
      mockedLookup.mockReturnValue('keyring-key');

      const provider = new OpenAIApiProvider({ apiKeyService: 'prod-openai' });
      await driveTurn(provider);

      expect(mockedLookup).toHaveBeenCalledWith('prod-openai');
      const req = fetchMock.captured[0];
      expect(req).toBeDefined();
      expect(req.init.headers).toMatchObject({ Authorization: 'Bearer keyring-key' });
    });

    it('falls back to OPENAI_API_KEY env when apiKeyService is unset', async () => {
      process.env.OPENAI_API_KEY = 'env-key';

      const provider = new OpenAIApiProvider({});
      await driveTurn(provider);

      const req = fetchMock.captured[0];
      expect(req.init.headers).toMatchObject({ Authorization: 'Bearer env-key' });
      expect(mockedLookup).toHaveBeenCalledWith('openai', { skipEnv: true });
    });

    it('falls back to env when apiKeyService is set but keyring lookup misses', async () => {
      process.env.OPENAI_API_KEY = 'env-key';
      mockedLookup.mockReturnValue(null);

      const provider = new OpenAIApiProvider({ apiKeyService: 'missing-service' });
      await driveTurn(provider);

      expect(mockedLookup).toHaveBeenCalledWith('missing-service');
      const req = fetchMock.captured[0];
      expect(req.init.headers).toMatchObject({ Authorization: 'Bearer env-key' });
    });
  });

  describe('AnthropicApiProvider', () => {
    it('uses keyring value from apiKeyService for x-api-key header', async () => {
      process.env.ANTHROPIC_API_KEY = 'env-key-should-be-overridden';
      mockedLookup.mockReturnValue('keyring-key');

      const provider = new AnthropicApiProvider({ apiKeyService: 'prod-anthropic' });
      await driveTurn(provider);

      expect(mockedLookup).toHaveBeenCalledWith('prod-anthropic');
      const req = fetchMock.captured[0];
      expect(req).toBeDefined();
      expect(req.init.headers).toMatchObject({ 'x-api-key': 'keyring-key' });
    });

    it('falls back to ANTHROPIC_API_KEY env when apiKeyService is unset', async () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';

      const provider = new AnthropicApiProvider({});
      await driveTurn(provider);

      const req = fetchMock.captured[0];
      expect(req.init.headers).toMatchObject({ 'x-api-key': 'env-key' });
      expect(mockedLookup).toHaveBeenCalledWith('anthropic', { skipEnv: true });
    });

    it('falls back to env when apiKeyService is set but keyring lookup misses', async () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      mockedLookup.mockReturnValue(null);

      const provider = new AnthropicApiProvider({ apiKeyService: 'missing-service' });
      await driveTurn(provider);

      expect(mockedLookup).toHaveBeenCalledWith('missing-service');
      const req = fetchMock.captured[0];
      expect(req.init.headers).toMatchObject({ 'x-api-key': 'env-key' });
    });
  });
});
