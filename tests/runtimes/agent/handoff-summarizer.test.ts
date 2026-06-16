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

  it('rejects on a non-ok HTTP response (folded as a distill failure)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }) as Response);
    const distill = buildHandoffDistill({ ...baseDeps(), fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(distill()).rejects.toThrow(/429/);
  });

  it('is inert when no api key is configured', () => {
    expect(() => buildHandoffDistill({ ...baseDeps(), apiKey: '' })).toThrow(HandoffSummarizerInertError);
  });
});
