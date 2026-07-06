import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The `openai` module is deliberately NOT mocked here (unlike openai.test.ts):
// this file locks the real SDK's env-default behavior for the NO-CONFIG path
// — a process-wide OPENAI_BASE_URL repoints every bare `new OpenAI()` in the
// process, including Whisper transcription (same construction, still
// env-only). PR-2/QR-218 added an opt-in override: an instance that sets
// `chatOptions.openaiProviderConfig.baseUrl` gets its own endpoint regardless
// of OPENAI_BASE_URL (third test below) — an instance that configures nothing
// must keep behaving exactly as before (first two tests, unchanged). If any
// of these locks flip, reconcile the Traps section of
// docs/architecture/provider-credential-services.md and the custom-endpoint
// section of docs/configuration.md in the same PR.

vi.mock('../../../../src/config.ts', () => ({
  config: {
    apiTimeoutMs: 30_000,
  },
}));

vi.mock('../../../../src/logger.ts', () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import OpenAI from 'openai';
import { createOpenAIProvider } from '../../../../src/runtimes/chat/providers/openai.ts';

interface CapturedRequest {
  url: string | undefined;
  authorization: string | undefined;
}

describe('chat provider OPENAI_BASE_URL env sensitivity', () => {
  let server: http.Server;
  let baseUrl: string;
  const captured: CapturedRequest[] = [];
  const savedEnv: Record<string, string | undefined> = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        captured.push({ url: req.url, authorization: req.headers.authorization });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { content: 'routed-through-local-endpoint', role: 'assistant' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            model: 'local-test-model',
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('control: without OPENAI_BASE_URL a bare client targets api.openai.com', () => {
    delete process.env.OPENAI_BASE_URL;
    const client = new OpenAI({ apiKey: 'control-key' });
    expect(client.baseURL).toBe('https://api.openai.com/v1');
  });

  it('OPENAI_BASE_URL set at construction repoints the chat provider (real SDK, real socket)', async () => {
    process.env.OPENAI_BASE_URL = baseUrl;
    process.env.OPENAI_API_KEY = 'env-test-key';
    captured.length = 0;

    const provider = createOpenAIProvider();
    const result = await provider.generate({
      model: 'local-test-model',
      maxTokens: 16,
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('/v1/chat/completions');
    expect(captured[0].authorization).toBe('Bearer env-test-key');
    expect(result.content).toBe('routed-through-local-endpoint');
    expect(result.model).toBe('local-test-model');
  });

  it('openaiProviderConfig.baseUrl wins over a deliberately-unreachable OPENAI_BASE_URL (real SDK, real socket)', async () => {
    // An arbitrary closed port on loopback — nothing listens there, so a
    // connection attempt fails fast (ECONNREFUSED) instead of hanging, so a
    // regression (config NOT winning) fails this test quickly rather than
    // timing out.
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:18471/v1';
    process.env.OPENAI_API_KEY = 'env-test-key';
    captured.length = 0;

    const provider = createOpenAIProvider({ baseUrl: baseUrl });
    const result = await provider.generate({
      model: 'local-test-model',
      maxTokens: 16,
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('/v1/chat/completions');
    expect(captured[0].authorization).toBe('Bearer env-test-key');
    expect(result.content).toBe('routed-through-local-endpoint');
  });
});
