import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WhatSoupError as AppError } from '../../../../src/errors.ts';

// Mock the OpenAI SDK before importing the provider
vi.mock('openai', () => {
  const MockOpenAI = vi.fn();
  return { default: MockOpenAI };
});

// Mock the keyring so openaiProviderConfig.apiKeyService tests control the
// keyring hit/miss outcome deterministically (mirrors tests/lib/api-key-resolver.test.ts).
vi.mock('../../../../src/lib/keyring.ts', () => ({
  lookupCredential: vi.fn(),
}));

vi.mock('../../../../src/config.ts', () => ({
  config: {
    apiTimeoutMs: 30_000,
  },
}));

// Hoisted + shared so the resolver's own logger (src/lib/api-key-resolver.ts)
// and this provider's logger both write to the SAME mock object — needed to
// assert the QR-104 keyring-miss warning below (mirrors
// tests/lib/api-key-resolver.test.ts).
const { mockLog } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => mockLog,
}));

import OpenAI from 'openai';
import { createOpenAIProvider } from '../../../../src/runtimes/chat/providers/openai.ts';
import { lookupCredential } from '../../../../src/lib/keyring.ts';

const mockedLookupCredential = vi.mocked(lookupCredential);
const MockOpenAI = vi.mocked(OpenAI);

function makeSuccessResponse(overrides: {
  content?: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  model?: string;
} = {}) {
  const {
    content = 'Hello from OpenAI',
    promptTokens = 60,
    completionTokens = 30,
    model = 'gpt-5.4',
  } = overrides;
  return {
    choices: [{ message: { content, role: 'assistant' } }],
    usage: promptTokens !== null || completionTokens !== null
      ? { prompt_tokens: promptTokens ?? 0, completion_tokens: completionTokens ?? 0 }
      : undefined,
    model,
  };
}

function makeRequest(overrides = {}) {
  return {
    model: 'gpt-5.4',
    maxTokens: 500,
    systemPrompt: 'You are a helpful assistant.',
    messages: [{ role: 'user' as const, content: 'Hello' }],
    ...overrides,
  };
}

describe('OpenAI Provider', () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  let provider: ReturnType<typeof createOpenAIProvider>;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    mockCreate = vi.fn();
    MockOpenAI.mockImplementation(function (this: Record<string, unknown>) {
      this.chat = { completions: { create: mockCreate } };
    } as unknown as () => OpenAI);
    provider = createOpenAIProvider();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── Positive tests ────────────────────────────────────────────────────────

  it('returns content from successful response', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse({ content: 'Hi there!' }));
    const result = await provider.generate(makeRequest());
    expect(result.content).toBe('Hi there!');
  });

  it('extracts inputTokens from response.usage.prompt_tokens', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse({ promptTokens: 75, completionTokens: 20 }));
    const result = await provider.generate(makeRequest());
    expect(result.inputTokens).toBe(75);
  });

  it('extracts outputTokens from response.usage.completion_tokens', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse({ promptTokens: 10, completionTokens: 88 }));
    const result = await provider.generate(makeRequest());
    expect(result.outputTokens).toBe(88);
  });

  it('defaults token counts to 0 when usage is null/undefined', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse({ promptTokens: null, completionTokens: null }));
    const result = await provider.generate(makeRequest());
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('returns durationMs as a non-negative number', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());
    const result = await provider.generate(makeRequest());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe('number');
  });

  it('returns the model name from the response', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse({ model: 'gpt-5.4' }));
    const result = await provider.generate(makeRequest());
    expect(result.model).toBe('gpt-5.4');
  });

  it('places systemPrompt as first message with role "system"', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());
    await provider.generate(makeRequest({ systemPrompt: 'Be concise.' }));
    const callArgs = mockCreate.mock.calls[0][0];
    const firstMsg = callArgs.messages[0];
    expect(firstMsg.role).toBe('system');
    expect(firstMsg.content).toBe('Be concise.');
  });

  it('system message appears before user messages in array', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());
    await provider.generate(makeRequest());
    const callArgs = mockCreate.mock.calls[0][0];
    const roles = (callArgs.messages as Array<{ role: string }>).map((m) => m.role);
    expect(roles[0]).toBe('system');
    expect(roles.slice(1)).not.toContain('system');
  });

  it('multi-modal request: image parts use image_url type', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());
    const request = makeRequest({
      messages: [{
        role: 'user' as const,
        content: 'What is this?',
        images: [{ mimeType: 'image/jpeg', base64: 'abc123' }],
      }],
    });
    await provider.generate(request);
    const callArgs = mockCreate.mock.calls[0][0];
    // First message is system; second is the user message with images
    const userMsg = (callArgs.messages as Array<{ role: string; content: unknown }>)
      .find((m) => m.role === 'user');
    expect(Array.isArray(userMsg?.content)).toBe(true);
    expect(userMsg?.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc123' } },
    ]);
  });

  it('multi-modal request: image_url contains data: URI', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());
    const request = makeRequest({
      messages: [{
        role: 'user' as const,
        content: 'Describe',
        images: [{ mimeType: 'image/png', base64: 'base64data' }],
      }],
    });
    await provider.generate(request);
    const callArgs = mockCreate.mock.calls[0][0];
    const userMsg = (callArgs.messages as Array<{ role: string; content: unknown }>)
      .find((m) => m.role === 'user');
    const imgPart = (userMsg?.content as Array<{ type: string; image_url?: { url: string } }>)
      .find((p) => p.type === 'image_url');
    expect(imgPart?.image_url?.url).toMatch(/^data:image\/png;base64,/);
    expect(imgPart?.image_url?.url).toContain('base64data');
  });

  it('returns empty content for a valid empty completion (finish_reason: stop) (#1064)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '', role: 'assistant' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
      model: 'gpt-5.4',
    });
    const result = await provider.generate(makeRequest());
    expect(result.content).toBe('');
  });

  it('throws on empty content with a non-stop finish_reason (#1064)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '', role: 'assistant' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
      model: 'gpt-5.4',
    });
    await expect(provider.generate(makeRequest())).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
    });
  });

  // ── Negative tests ────────────────────────────────────────────────────────

  it('throws AppError with code LLM_TIMEOUT when request is aborted', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    mockCreate.mockRejectedValueOnce(abortErr);
    await expect(provider.generate(makeRequest())).rejects.toMatchObject({
      code: 'LLM_TIMEOUT',
    });
  });

  it('throws AppError (not generic Error) on timeout', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    mockCreate.mockRejectedValueOnce(abortErr);
    await expect(provider.generate(makeRequest())).rejects.toBeInstanceOf(AppError);
  });

  it('throws AppError with code LLM_UNAVAILABLE on API error', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('Bad Gateway'), { status: 502 }));
    await expect(provider.generate(makeRequest())).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
    });
  });

  it('preserves original error as cause in AppError on API failure', async () => {
    const originalErr = new Error('network failure');
    mockCreate.mockRejectedValueOnce(originalErr);
    let thrown: AppError | null = null;
    try {
      await provider.generate(makeRequest());
    } catch (e) {
      thrown = e as AppError;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown?.cause).toBe(originalErr);
  });

  it('throws AppError when choices array is empty', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [], model: 'gpt-5.4' });
    await expect(provider.generate(makeRequest())).rejects.toBeInstanceOf(AppError);
  });

  it('throws AppError when message content is null', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: null, role: 'assistant' } }],
      model: 'gpt-5.4',
    });
    await expect(provider.generate(makeRequest())).rejects.toBeInstanceOf(AppError);
  });

  it('timeout error has LLM_TIMEOUT code, not LLM_UNAVAILABLE', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    mockCreate.mockRejectedValueOnce(abortErr);
    let thrown: AppError | null = null;
    try {
      await provider.generate(makeRequest());
    } catch (e) {
      thrown = e as AppError;
    }
    expect(thrown?.code).toBe('LLM_TIMEOUT');
    expect(thrown?.code).not.toBe('LLM_UNAVAILABLE');
  });

  // ── openaiProviderConfig (PR-2/QR-218) ──────────────────────────────────────
  // Per-instance OpenAI endpoint/key override. The no-config path resolves the
  // canonical `openai` keyring service instead of depending on parent env.

  it('no config: resolves the canonical keyring service into the SDK client', () => {
    mockedLookupCredential.mockReturnValue('canonical-openai-key');
    MockOpenAI.mockClear();
    createOpenAIProvider();
    expect(mockedLookupCredential).toHaveBeenCalledWith('openai', { skipEnv: true });
    expect(MockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'canonical-openai-key' }),
    );
  });

  it('openaiProviderConfig.baseUrl maps to the SDK baseURL option', () => {
    MockOpenAI.mockClear();
    createOpenAIProvider({ baseUrl: 'https://custom.example.com/v1' });
    expect(MockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://custom.example.com/v1' }),
    );
  });

  it('openaiProviderConfig.apiKeyService resolves apiKey from the keyring', () => {
    mockedLookupCredential.mockReturnValue('keyring-secret');
    MockOpenAI.mockClear();
    createOpenAIProvider({ apiKeyService: 'my-openai-service' });
    expect(mockedLookupCredential).toHaveBeenCalledWith('my-openai-service');
    expect(MockOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'keyring-secret' }));
  });

  it('openaiProviderConfig.apiKeyService keyring miss falls back to OPENAI_API_KEY env and warns (QR-104)', () => {
    process.env.OPENAI_API_KEY = 'env-fallback-key';
    mockedLookupCredential.mockReturnValue(null);
    MockOpenAI.mockClear();
    createOpenAIProvider({ apiKeyService: 'missing-service' });
    expect(MockOpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'env-fallback-key' }));
    expect(mockLog.warn).toHaveBeenCalledWith(
      { service: 'missing-service', envVar: 'OPENAI_API_KEY' },
      expect.stringContaining('keyring lookup missed'),
    );
  });

  it('openaiProviderConfig.apiKeyService double-miss (keyring null AND env unset) constructs with apiKey: undefined, not empty string', () => {
    // OPENAI_API_KEY is already deleted in beforeEach. This is the exact
    // double-miss the `|| undefined` in openai.ts guards against: resolveApiKey
    // returns '' here (a visible missing-key condition, no warning per QR-104 —
    // see tests/lib/api-key-resolver.test.ts), and '' must not reach the SDK as
    // apiKey: '' (a silent empty Bearer header). It must become undefined so the
    // SDK re-reads env/throws loudly instead.
    mockedLookupCredential.mockReturnValue(null);
    MockOpenAI.mockClear();
    createOpenAIProvider({ baseUrl: 'https://custom.example.com/v1', apiKeyService: 'custom-openai' });
    const callArgs = MockOpenAI.mock.calls[0][0] as { baseURL?: string; apiKey?: string };
    expect(callArgs.baseURL).toBe('https://custom.example.com/v1');
    expect(callArgs.apiKey).toBeUndefined();
    expect(mockLog.warn).not.toHaveBeenCalled();
  });
});
