import { describe, expect, it, vi } from 'vitest';
import { buildHandoffDistill, HandoffSummarizerInertError } from '../../../src/runtimes/agent/handoff-summarizer.ts';

const baseDeps = () => ({
  model: 'deepseek-chat',
  apiKey: 'tok-FAKE',
  endpoint: 'https://api.example.test/chat/completions',
  conversationKey: 'c1',
  loadMessages: () => [{ senderName: 'Lucas', isFromMe: false, content: 'my secret is SENSITIVE' }],
  redact: (t: string) => t.replace(/SENSITIVE/g, '[REDACTED]'),
  verbatimN: 10,
});

describe('buildHandoffDistill', () => {
  it('redacts every line before the request leaves the process', async () => {
    let sentBody = '';
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'summary' } }], usage: { total_tokens: 42 } }) } as Response;
    });
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await distill();
    expect(sentBody).not.toContain('SENSITIVE');
    expect(sentBody).toContain('[REDACTED]');
    expect(out).toEqual({ summary: 'summary', seededArtifacts: null, tokensUsed: 42 });
  });

  it('redacts the sender name too (WhatsApp names/phones are PII crossing to the model)', async () => {
    let sentBody = '';
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'summary' } }], usage: { total_tokens: 1 } }) } as Response;
    });
    const distill = buildHandoffDistill({
      ...baseDeps(),
      // Sender name carries a sensitive token that must be redacted before egress.
      loadMessages: () => [{ senderName: 'SENSITIVE Caller', isFromMe: false, content: 'hello' }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await distill();
    expect(sentBody).not.toContain('SENSITIVE');
    expect(sentBody).toContain('[REDACTED]');
  });

  it('labels assistant lines, defaults missing sender names to User, and drops empty content', async () => {
    let sentBody = '';
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'summary' } }] }) } as Response;
    });
    const distill = buildHandoffDistill({
      ...baseDeps(),
      timeoutMs: 1234,
      loadMessages: () => [
        { senderName: 'Bot Name', isFromMe: true, content: ' assistant reply ' },
        { senderName: '  ', isFromMe: false, content: ' user asks ' },
        { senderName: 'Nobody', isFromMe: false, content: undefined as unknown as string },
      ],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const out = await distill();
    const body = JSON.parse(sentBody) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: 'Assistant: assistant reply\nUser: user asks',
    });
    expect(body.messages[1].content).not.toContain('Nobody');
    expect(out.tokensUsed).toBe(0);
  });

  it('uses reasoning_content when content is empty', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: null, reasoning_content: 'reasoned summary' } }] }),
    }) as Response);
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(distill()).resolves.toEqual({
      summary: 'reasoned summary',
      seededArtifacts: null,
      tokensUsed: 0,
    });
  });

  it('uses the global fetch implementation when no fetch override is supplied', async () => {
    const originalFetch = globalThis.fetch;
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'default fetch summary' } }] }),
    }) as Response);
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const distill = buildHandoffDistill(baseDeps());
      await expect(distill()).resolves.toMatchObject({ summary: 'default fetch summary' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('aborts the outbound request when the timeout expires', async () => {
    vi.useFakeTimers();
    let outboundSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: { signal?: AbortSignal }) => {
      outboundSignal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        outboundSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    try {
      const distill = buildHandoffDistill({
        ...baseDeps(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 5,
      });
      const pending = distill().catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(5);

      const err = await pending;
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).message).toMatch(/aborted/i);
      expect(outboundSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects when the model returns no summary content', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: null, reasoning_content: null } }] }),
    }) as Response);
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(distill()).rejects.toThrow('handoff summarizer returned empty summary');
  });

  it('rejects on a non-ok HTTP response (folded as a distill failure)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }) as Response);
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).rejects.toThrow(/429/);
  });

  it('uses an empty HTTP body when reading an error response fails', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => {
        throw new Error('body unavailable');
      },
    }) as unknown as Response);
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(distill()).rejects.toThrow('handoff summarizer HTTP 503: ');
  });

  it('is inert when no api key is configured', () => {
    expect(() => buildHandoffDistill({ ...baseDeps(), apiKey: '' })).toThrow(HandoffSummarizerInertError);
  });
});
