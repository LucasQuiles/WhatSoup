import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
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

function response(content: unknown = 'summary', extra: Record<string, unknown> = {}): Response {
  return Response.json({ choices: [{ message: { content } }], usage: { total_tokens: 42 }, ...extra });
}

describe('buildHandoffDistill', () => {
  it('redacts every line before the request leaves the process', async () => {
    let sentBody = '';
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return response();
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
      return response('summary', { usage: { total_tokens: 1 } });
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
      return response('summary', { usage: { total_tokens: 0 } });
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

  it('rejects reasoning-only output instead of persisting the reasoning channel', async () => {
    const fetchImpl = vi.fn(async () => response(null, {
      choices: [{ message: { content: null, reasoning_content: 'private reasoning' } }],
    }));
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).rejects.toThrow(/empty summary/);
  });

  it('persists only assistant content when reasoning accompanies it', async () => {
    const fetchImpl = vi.fn(async () => response('summary', {
      choices: [{ message: { content: 'summary', reasoning_content: 'private reasoning' } }],
    }));
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).resolves.toEqual({ summary: 'summary', seededArtifacts: null, tokensUsed: 42 });
  });

  it('uses the global fetch implementation when no fetch override is supplied', async () => {
    const originalFetch = globalThis.fetch;
    const fetchImpl = vi.fn(async () => response('default fetch summary'));
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
    const fetchImpl = vi.fn(async () => response(null));
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(distill()).rejects.toThrow('handoff summarizer returned empty summary');
  });

  it('rejects on a non-ok HTTP response (folded as a distill failure)', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 }));
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).rejects.toThrow(/429/);
  });

  it('cancels error bodies without reading or including provider data', async () => {
    const cancel = vi.fn();
    const providerResponse = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('private provider error')); },
      cancel,
    }), { status: 503 });
    const fetchImpl = vi.fn(async () => providerResponse);
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    // The old eager text reader would otherwise wait forever on this unfinished body.
    const text = vi.spyOn(providerResponse, 'text').mockResolvedValue('private provider error');
    await expect(distill()).rejects.toThrow(/^handoff summarizer HTTP 503$/);
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(['content', 'senderName'] as const)('rejects oversized raw %s before redaction or network egress', async (field) => {
    const fetchImpl = vi.fn(async () => response());
    const redact = vi.fn((value: string) => value);
    const distill = buildHandoffDistill({ ...baseDeps(), redact,
      loadMessages: () => [{ content: 'hello', senderName: 'User', isFromMe: false, [field]: '界'.repeat(22_000) }],
      fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).rejects.toThrow(/request.*limit/);
    expect(redact).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds the aggregate corpus, not just each message', async () => {
    const fetchImpl = vi.fn(async () => response());
    const distill = buildHandoffDistill({ ...baseDeps(),
      loadMessages: () => Array.from({ length: 10 }, () => ({ content: 'x'.repeat(7000), senderName: 'User', isFromMe: false })),
      fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).rejects.toThrow(/request.*limit/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds the encoded request after redaction and JSON escaping', async () => {
    const fetchImpl = vi.fn(async () => response());
    const distill = buildHandoffDistill({ ...baseDeps(), redact: () => '\u0001'.repeat(12_000),
      fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).rejects.toThrow(/request.*limit/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancels an oversized streaming success response before consuming its tail', async () => {
    let chunksRead = 0;
    const cancel = vi.fn();
    const providerResponse = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead++;
        controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
        if (chunksRead === 80) controller.close();
      }, cancel,
    }));
    const fetchImpl = vi.fn(async () => providerResponse);
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).rejects.toThrow(/response.*limit/);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(chunksRead).toBeLessThan(80);
  });

  it.each([
    ['UTF-8 bytes', '界'.repeat(1366)],
    ['word count', Array.from({ length: 121 }, () => 'word').join(' ')],
  ])('rejects summary over the %s limit before returning an artifact', async (_label, content) => {
    const fetchImpl = vi.fn(async () => response(content));
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).rejects.toThrow(/summary.*limit/);
  });

  it('accepts a 120-word summary at the exact 4096-byte boundary', async () => {
    const prefix = Array.from({ length: 119 }, () => 'word').join(' ') + ' ';
    const content = prefix + 'x'.repeat(4096 - Buffer.byteLength(prefix));
    const fetchImpl = vi.fn(async () => response(content));
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).resolves.toMatchObject({ summary: content, tokensUsed: 42 });
  });

  it.each(['invalid', '1', -1, 0.5, null, undefined, {}, Number.MAX_SAFE_INTEGER + 1])('rejects invalid token usage %j', async (tokens) => {
    const fetchImpl = vi.fn(async () => response('summary', { usage: { total_tokens: tokens } }));
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).rejects.toThrow(/token usage/);
  });

  it('does not forward the conversation or credentials to a redirect target', async () => {
    const target = vi.fn();
    const server = createServer((req, res) => {
      if (req.url === '/target') { target(); res.end(JSON.stringify({ choices: [{ message: { content: 'summary' } }], usage: { total_tokens: 42 } })); }
      else { res.writeHead(307, { location: '/target' }); res.end(); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing local server address');
    try {
      const distill = buildHandoffDistill({ ...baseDeps(), endpoint: `http://127.0.0.1:${address.port}/redirect` });
      await expect(distill()).rejects.toThrow();
      expect(target).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('is inert when no api key is configured', () => {
    expect(() => buildHandoffDistill({ ...baseDeps(), apiKey: '' })).toThrow(HandoffSummarizerInertError);
  });

  it('aborts a native response stream after headers when the body never completes', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":[');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing local server address');
    let headersReceived = false;
    try {
      const fetchImpl: typeof fetch = async (input, init) => {
        const result = await fetch(input, init);
        headersReceived = true;
        return result;
      };
      const distill = buildHandoffDistill({ ...baseDeps(), timeoutMs: 1000, fetchImpl,
        endpoint: `http://127.0.0.1:${address.port}/incomplete` });
      await expect(distill()).rejects.toThrow(/abort/i);
      expect(headersReceived).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('does not include malformed provider response data in the failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('private provider reasoning is not JSON'));
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).rejects.toThrow(/^handoff summarizer returned invalid JSON$/);
  });

});
