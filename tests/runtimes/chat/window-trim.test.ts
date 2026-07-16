/**
 * Unit tests for summarizeWindowBeforeTrim (#1445 QR-010).
 *
 * Replaces the silent FIFO `window.shift()` token-budget trim in
 * src/runtimes/chat/runtime.ts with summarize-before-trim: collect the
 * contiguous oldest turns that must be dropped, summarize them in ONE cheap
 * LLM call, and prepend the bounded summary as a synthetic turn. Config-gated
 * with a deterministic-marker fallback so there is never silent loss.
 */
import { describe, it, expect, vi } from 'vitest';
import { summarizeWindowBeforeTrim } from '../../../src/runtimes/chat/window-trim.ts';
import type { ChatMessage, GenerateResponse, LLMProvider } from '../../../src/runtimes/chat/providers/types.ts';

function makeProvider(impl?: (request: unknown) => Promise<GenerateResponse>): LLMProvider {
  return {
    name: 'test-provider',
    generate: vi.fn(impl ?? (() => Promise.resolve(canned('default summary')))),
  };
}

function canned(content: string): GenerateResponse {
  return { content, inputTokens: 10, outputTokens: 5, model: 'test-model', durationMs: 1 };
}

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content };
}

// estimateTokens = (systemPromptLength + sum(content.length)) / 4 + mediaTokenEstimate.
// Keep systemPromptLength/mediaTokenEstimate at 0 in most cases so token math is
// just contentLength / 4 — easy to reason about from the test data.
const baseOptions = {
  tokenBudget: 100,
  systemPromptLength: 0,
  mediaTokenEstimate: 0,
  traceId: 'trace-1',
};

describe('summarizeWindowBeforeTrim', () => {
  // ---- (d) under budget → no summarization call, window untouched ----
  it('under budget: returns the window untouched, no LLM call, no model resolution', async () => {
    const provider = makeProvider();
    const resolveSummarizationModel = vi.fn(() => Promise.resolve('claude-haiku-4-5'));
    const window = [msg('user', 'hi'), msg('assistant', 'hello there')];

    const result = await summarizeWindowBeforeTrim(window, {
      ...baseOptions,
      tokenBudget: 100_000,
      summarizationEnabled: true,
      provider,
      resolveSummarizationModel,
    });

    expect(result.window).toBe(window); // same reference — genuinely untouched
    expect(result.trimmedMessages).toBe(0);
    expect(result.summarized).toBe(false);
    expect(provider.generate).not.toHaveBeenCalled();
    expect(resolveSummarizationModel).not.toHaveBeenCalled();
  });

  // ---- (a) over-budget → summary prepended, window under budget ----
  it('over budget: summarizes the overflow in one call and prepends a bounded summary turn', async () => {
    const overflowA = msg('user', 'x'.repeat(200));
    const overflowB = msg('assistant', 'y'.repeat(200));
    const overflowC = msg('user', 'z'.repeat(200));
    const recent1 = msg('user', 'recent question');
    const recent2 = msg('assistant', 'recent answer');
    const window = [overflowA, overflowB, overflowC, recent1, recent2];

    const provider = makeProvider(() => Promise.resolve(canned('CANNED SUMMARY TEXT')));
    const resolveSummarizationModel = vi.fn(() => Promise.resolve('claude-haiku-4-5'));

    const result = await summarizeWindowBeforeTrim(window, {
      ...baseOptions,
      tokenBudget: 50,
      summarizationEnabled: true,
      provider,
      resolveSummarizationModel,
    });

    // Exactly one LLM call for the whole overflow batch (not one per turn).
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(resolveSummarizationModel).toHaveBeenCalledTimes(1);

    expect(result.summarized).toBe(true);
    expect(result.trimmedMessages).toBe(3);

    // Summary is prepended as a synthetic, labeled turn.
    const summaryTurn = result.window[0];
    expect(summaryTurn.role).toBe('assistant');
    expect(summaryTurn.content).toContain('[earlier conversation summary]');
    expect(summaryTurn.content).toContain('CANNED SUMMARY TEXT');

    // Recent turns preserved verbatim (not re-summarized, not mutated).
    expect(result.window.slice(1)).toEqual([recent1, recent2]);

    // Window must actually be under budget after prepending the summary.
    expect(result.estimatedTokens).toBeLessThanOrEqual(50);

    // The single summarization call carries the overflow content, not the whole window.
    const request = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].content).toContain('x'.repeat(200));
    expect(request.messages[0].content).toContain('z'.repeat(200));
    expect(request.messages[0].content).not.toContain('recent question');
  });

  // ---- (b) summarization failure → deterministic marker fallback ----
  it('LLM failure: falls back to a deterministic marker turn, never throws', async () => {
    const window = [
      msg('user', 'x'.repeat(200)),
      msg('assistant', 'y'.repeat(200)),
      msg('user', 'z'.repeat(200)),
      msg('user', 'recent question'),
    ];
    const provider = makeProvider(() => Promise.reject(new Error('provider unavailable')));

    const result = await summarizeWindowBeforeTrim(window, {
      ...baseOptions,
      tokenBudget: 50,
      summarizationEnabled: true,
      provider,
      resolveSummarizationModel: () => Promise.resolve('claude-haiku-4-5'),
    });

    expect(result.summarized).toBe(false);
    expect(result.trimmedMessages).toBe(3);
    expect(result.window[0]).toEqual({ role: 'assistant', content: '[3 earlier turns omitted]' });
    // Recent turn(s) still present, verbatim.
    expect(result.window[result.window.length - 1].content).toBe('recent question');
  });

  // ---- (c) disabled config → marker/no LLM call ----
  it('disabled: uses the marker fallback and never calls the provider or resolves a model', async () => {
    const window = [
      msg('user', 'x'.repeat(200)),
      msg('assistant', 'y'.repeat(200)),
      msg('user', 'recent question'),
    ];
    const provider = makeProvider();
    const resolveSummarizationModel = vi.fn(() => Promise.resolve('claude-haiku-4-5'));

    const result = await summarizeWindowBeforeTrim(window, {
      ...baseOptions,
      tokenBudget: 50,
      summarizationEnabled: false,
      provider,
      resolveSummarizationModel,
    });

    expect(provider.generate).not.toHaveBeenCalled();
    expect(resolveSummarizationModel).not.toHaveBeenCalled();
    expect(result.summarized).toBe(false);
    expect(result.trimmedMessages).toBe(2);
    expect(result.window[0]).toEqual({ role: 'assistant', content: '[2 earlier turns omitted]' });
  });

  // ---- Bounded output: a summary that would itself re-blow the budget falls back ----
  it('summary still over budget after prepending: falls back to marker instead of looping', async () => {
    const window = [
      msg('user', 'x'.repeat(200)),
      msg('assistant', 'y'.repeat(200)),
      msg('user', 'recent question'),
    ];
    // Provider misbehaves and returns a huge "summary" that alone blows the budget.
    const provider = makeProvider(() => Promise.resolve(canned('S'.repeat(2000))));

    const result = await summarizeWindowBeforeTrim(window, {
      ...baseOptions,
      tokenBudget: 50,
      summarizationEnabled: true,
      provider,
      resolveSummarizationModel: () => Promise.resolve('claude-haiku-4-5'),
    });

    expect(provider.generate).toHaveBeenCalledTimes(1); // single attempt, no retry loop
    expect(result.summarized).toBe(false);
    expect(result.window[0]).toEqual({ role: 'assistant', content: '[2 earlier turns omitted]' });
  });

  // ---- Cannot trim below a single turn ----
  it('single oversized turn: left unchanged (nothing left to drop or summarize)', async () => {
    const window = [msg('user', 'x'.repeat(10_000))];
    const provider = makeProvider();

    const result = await summarizeWindowBeforeTrim(window, {
      ...baseOptions,
      tokenBudget: 10,
      summarizationEnabled: true,
      provider,
      resolveSummarizationModel: () => Promise.resolve('claude-haiku-4-5'),
    });

    expect(result.window).toEqual(window);
    expect(result.trimmedMessages).toBe(0);
    expect(result.summarized).toBe(false);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it('empty summary content from the provider is treated as a failure and falls back to marker', async () => {
    const window = [
      msg('user', 'x'.repeat(200)),
      msg('assistant', 'y'.repeat(200)),
      msg('user', 'recent question'),
    ];
    const provider = makeProvider(() => Promise.resolve(canned('   ')));

    const result = await summarizeWindowBeforeTrim(window, {
      ...baseOptions,
      tokenBudget: 50,
      summarizationEnabled: true,
      provider,
      resolveSummarizationModel: () => Promise.resolve('claude-haiku-4-5'),
    });

    expect(result.summarized).toBe(false);
    expect(result.window[0]).toEqual({ role: 'assistant', content: '[2 earlier turns omitted]' });
  });
});
