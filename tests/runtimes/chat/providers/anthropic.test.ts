import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhatSoupError as AppError } from '../../../../src/errors.ts';

// Mock the Anthropic SDK before importing the provider
vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn();
  return { default: MockAnthropic };
});

// Mock config to have a predictable timeout
vi.mock('../../../../src/config.ts', () => ({
  config: {
    apiTimeoutMs: 30_000,
  },
}));

// Suppress logger output in tests
vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicProvider } from '../../../../src/runtimes/chat/providers/anthropic.ts';

function makeSuccessResponse(overrides: Partial<{
  content: Anthropic.ContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}> = {}) {
  return {
    content: [{ type: 'text', text: 'Hello from Anthropic' }],
    usage: { input_tokens: 50, output_tokens: 25 },
    model: 'claude-opus-4-6',
    ...overrides,
  };
}

function makeRequest(overrides = {}) {
  return {
    model: 'claude-opus-4-6',
    maxTokens: 500,
    systemPrompt: 'You are a helpful assistant.',
    messages: [{ role: 'user' as const, content: 'Hello' }],
    ...overrides,
  };
}

describe('Anthropic Provider', () => {
  let mockCreate: ReturnType<typeof vi.fn>;
  let provider: ReturnType<typeof createAnthropicProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    const MockAnthropic = vi.mocked(Anthropic);
    mockCreate = vi.fn();
    MockAnthropic.mockImplementation(function (this: Anthropic) {
      (this as unknown as { messages: unknown }).messages = { create: mockCreate };
    });
    provider = createAnthropicProvider();
  });

  // ── Positive tests ────────────────────────────────────────────────────────

  it('returns content from successful response', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());
    const result = await provider.generate(makeRequest());
    expect(result.content).toBe('Hello from Anthropic');
  });

  it('extracts inputTokens from response.usage.input_tokens', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse({ usage: { input_tokens: 123, output_tokens: 45 } }));
    const result = await provider.generate(makeRequest());
    expect(result.inputTokens).toBe(123);
  });

  it('extracts outputTokens from response.usage.output_tokens', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse({ usage: { input_tokens: 10, output_tokens: 99 } }));
    const result = await provider.generate(makeRequest());
    expect(result.outputTokens).toBe(99);
  });

  it('returns durationMs as a positive number', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());
    const result = await provider.generate(makeRequest());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe('number');
  });

  it('returns the model name from the response', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse({ model: 'claude-opus-4-6' }));
    const result = await provider.generate(makeRequest());
    expect(result.model).toBe('claude-opus-4-6');
  });

  it('passes systemPrompt as separate "system" parameter, not in messages', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());
    await provider.generate(makeRequest({ systemPrompt: 'System instruction here' }));
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toBe('System instruction here');
    // system prompt must not appear in messages array
    const systemInMessages = (callArgs.messages as Array<{ role: string; content: unknown }>)
      .some((m) => m.role === 'system');
    expect(systemInMessages).toBe(false);
  });

  it('multi-modal request: image blocks have type "image" in content array', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());
    const request = makeRequest({
      messages: [{
        role: 'user' as const,
        content: 'Look at this image',
        images: [{ mimeType: 'image/jpeg', base64: 'abc123' }],
      }],
    });
    await provider.generate(request);
    const callArgs = mockCreate.mock.calls[0][0];
    const userMsg = callArgs.messages[0];
    expect(Array.isArray(userMsg.content)).toBe(true);
    const imageBlock = (userMsg.content as Array<{ type: string }>).find((b) => b.type === 'image');
    expect(imageBlock).toBeDefined();
    expect(imageBlock?.type).toBe('image');
  });

  it('multi-modal request: text content is included alongside image blocks', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse());
    const request = makeRequest({
      messages: [{
        role: 'user' as const,
        content: 'Describe this',
        images: [{ mimeType: 'image/png', base64: 'xyz789' }],
      }],
    });
    await provider.generate(request);
    const callArgs = mockCreate.mock.calls[0][0];
    const userMsg = callArgs.messages[0];
    const textBlock = (userMsg.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text');
    expect(textBlock?.text).toBe('Describe this');
  });

  it('does not return empty string as valid content', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse({ content: [{ type: 'text', text: 'non-empty' }] }));
    const result = await provider.generate(makeRequest());
    expect(result.content).not.toBe('');
    expect(result.content.length).toBeGreaterThan(0);
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
    const apiErr = Object.assign(new Error('Internal Server Error'), { status: 500 });
    mockCreate.mockRejectedValueOnce(apiErr);
    await expect(provider.generate(makeRequest())).rejects.toMatchObject({
      code: 'LLM_UNAVAILABLE',
    });
  });

  it('preserves original error as cause in AppError on API failure', async () => {
    const originalErr = new Error('upstream boom');
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

  it('throws AppError when response has no content blocks', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse({ content: [] }));
    await expect(provider.generate(makeRequest())).rejects.toBeInstanceOf(AppError);
  });

  it('throws AppError when first block is not a text block', async () => {
    mockCreate.mockResolvedValueOnce(makeSuccessResponse({
      content: [{ type: 'tool_use', id: 'tool_1', name: 'test', input: {} } as unknown as Anthropic.ContentBlock],
    }));
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
});
