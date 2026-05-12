import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIApiProvider } from '../../../../src/runtimes/agent/providers/openai-api.ts';
import { AnthropicApiProvider } from '../../../../src/runtimes/agent/providers/anthropic-api.ts';
import { lookupCredential } from '../../../../src/lib/keyring.ts';

vi.mock('../../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(),
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockedLookupCredential = vi.mocked(lookupCredential);

function makeSseResponse(events: Array<Record<string, unknown> | string>): Response {
  const body = events
    .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('HTTP provider API key service config', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mockedLookupCredential.mockReset();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('openai-api uses providerConfig.apiKeyService for the authorization header', async () => {
    mockedLookupCredential.mockReturnValue('custom-openai-key');
    fetchMock.mockResolvedValueOnce(makeSseResponse(['[DONE]']));
    const provider = new OpenAIApiProvider({ apiKeyService: 'openai-custom' });

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: vi.fn(),
      onCrash: vi.fn(),
    });
    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'hello' }],
    });

    expect(mockedLookupCredential).toHaveBeenCalledWith('openai-custom');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer custom-openai-key',
    });
  });

  it('openai-api defaults to the openai credential service', async () => {
    mockedLookupCredential.mockReturnValue('default-openai-key');
    fetchMock.mockResolvedValueOnce(makeSseResponse(['[DONE]']));
    const provider = new OpenAIApiProvider();

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: vi.fn(),
      onCrash: vi.fn(),
    });
    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'hello' }],
    });

    expect(mockedLookupCredential).toHaveBeenCalledWith('openai');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer default-openai-key',
    });
  });

  it('anthropic-api uses providerConfig.apiKeyService for the x-api-key header', async () => {
    mockedLookupCredential.mockReturnValue('custom-anthropic-key');
    fetchMock.mockResolvedValueOnce(makeSseResponse([{ type: 'message_stop' }]));
    const provider = new AnthropicApiProvider({ apiKeyService: 'anthropic-custom' });

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: vi.fn(),
      onCrash: vi.fn(),
    });
    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'hello' }],
    });

    expect(mockedLookupCredential).toHaveBeenCalledWith('anthropic-custom');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-api-key': 'custom-anthropic-key',
    });
  });

  it('anthropic-api defaults to the anthropic credential service', async () => {
    mockedLookupCredential.mockReturnValue('default-anthropic-key');
    fetchMock.mockResolvedValueOnce(makeSseResponse([{ type: 'message_stop' }]));
    const provider = new AnthropicApiProvider();

    await provider.initialize({
      cwd: '/tmp',
      systemPrompt: 'System prompt',
      instanceName: 'test-instance',
      onEvent: vi.fn(),
      onCrash: vi.fn(),
    });
    await provider.sendTurn({
      role: 'user',
      conversationKey: 'chat-key',
      parts: [{ kind: 'text', text: 'hello' }],
    });

    expect(mockedLookupCredential).toHaveBeenCalledWith('anthropic');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-api-key': 'default-anthropic-key',
    });
  });
});
