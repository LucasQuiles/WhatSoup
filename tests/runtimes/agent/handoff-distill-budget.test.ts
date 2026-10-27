import { describe, expect, it, vi } from 'vitest';
import { runHandoffDistill } from '../../../src/runtimes/agent/handoff-distiller.ts';
import { initialDistillState, type DistillState } from '../../../src/runtimes/agent/handoff-distill-gate.ts';
import { buildHandoffDistill } from '../../../src/runtimes/agent/handoff-summarizer.ts';
import { HandoffDistillRunner } from '../../../src/runtimes/agent/handoff-distill-runner.ts';

const now = 100_000;
const config = { maxTokensPerWindow: 1_000, maxCallsPerWindow: 6, windowMs: 60_000,
  failureThreshold: 3, breakerCooldownMs: 30_000, globalConcurrency: 2 };

function harness(fetchImpl: typeof fetch, content: string, maxTokensPerWindow = 1_000) {
  const persist = vi.fn();
  const distill = buildHandoffDistill({ model: 'deepseek-chat', apiKey: 'test-key',
    endpoint: 'https://provider.example.test/chat/completions', conversationKey: 'budget-test',
    loadMessages: () => [{ senderName: 'User', isFromMe: false, content }],
    redact: (text) => text, verbatimN: 1, fetchImpl });
  return { persist, run: (state: DistillState = initialDistillState(now)) => runHandoffDistill({
    state, config: { ...config, maxTokensPerWindow }, now, globalInFlight: 0,
    conversationKey: 'budget-test', sourceProvider: 'deepseek', sourceModel: 'deepseek-chat',
    tokenBaseline: 4_000, distill, persist,
  }) };
}

const response = (tokens = 42) => Response.json({
  choices: [{ message: { content: 'A short summary.' } }], usage: { total_tokens: tokens },
});

describe('handoff pre-egress token reservation', () => {
  it.each([0, 999])('refuses one oversized request before fetch with %i tokens already spent', async (spent) => {
    const fetchImpl = vi.fn(async () => response(5_000));
    const { run, persist } = harness(fetchImpl, 'large conversation '.repeat(600));
    const result = await run({ ...initialDistillState(now), tokensThisWindow: spent });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ran: false, failed: false, denied: 'budget-tokens' });
    expect(result.nextState.tokensThisWindow).toBe(spent);
    expect(result.nextState.callsThisWindow).toBe(0);
  });

  it.each(['http', 'transport', 'invalid-json', 'invalid-usage', 'oversized-response'] as const)(
    'retains the reservation when %s fails after egress', async (failure) => {
      const fetchImpl = vi.fn(async () => {
        if (failure === 'transport') throw new Error('connection lost after send');
        if (failure === 'http') return new Response(null, { status: 503 });
        if (failure === 'invalid-json') return new Response('not json');
        if (failure === 'oversized-response') return new Response('x'.repeat(65_537));
        return response(-1);
      });
      const { run, persist } = harness(fetchImpl, 'A brief message.', 20_000);
      const result = await run();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.failed).toBe(true);
      expect(result.nextState.tokensThisWindow).toBeGreaterThan(512);
      expect(result.nextState.tokensThisWindow).toBeLessThanOrEqual(20_000);
      expect(result.nextState.callsThisWindow).toBe(1);
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it('reconciles a successful reservation to validated actual usage', async () => {
    const fetchImpl = vi.fn(async () => response());
    const { run, persist } = harness(fetchImpl, 'A brief message.', 20_000);
    const result = await run();
    expect(result.ran).toBe(true);
    expect(result.nextState.tokensThisWindow).toBe(42);
    expect(result.nextState.callsThisWindow).toBe(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('keeps validated spend when artifact persistence fails', async () => {
    const { run, persist } = harness(vi.fn(async () => response()), 'A brief message.', 20_000);
    persist.mockImplementation(() => { throw new Error('store unavailable'); });
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.nextState.tokensThisWindow).toBe(42);
    expect(result.nextState.callsThisWindow).toBe(1);
  });

  it('admits exact reservation equality and refuses one token less', async () => {
    const failedFetch = vi.fn(async () => { throw new Error('response lost'); });
    const measured = await harness(failedFetch, 'Boundary message.', 20_000).run();
    const reservation = measured.nextState.tokensThisWindow;
    const fetchImpl = vi.fn(async () => response());
    expect((await harness(fetchImpl, 'Boundary message.', reservation).run()).ran).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await harness(fetchImpl, 'Boundary message.', reservation - 1).run()).denied).toBe('budget-tokens');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('records a provider overrun and blocks further egress without persisting it', async () => {
    const fetchImpl = vi.fn(async () => response(30_000));
    const { run, persist } = harness(fetchImpl, 'Brief message.', 20_000);
    const overrun = await run();
    expect(overrun.failed).toBe(true);
    expect(overrun.nextState.tokensThisWindow).toBe(30_000);
    expect((await run(overrun.nextState)).denied).toBe('budget-tokens');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });

  it('charges validated usage even when the returned summary is rejected', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      choices: [{ message: { content: '' } }], usage: { total_tokens: 30_000 },
    }));
    const { run, persist } = harness(fetchImpl, 'Brief message.', 20_000);
    const result = await run();
    expect(result.failed).toBe(true);
    expect(result.nextState.tokensThisWindow).toBe(30_000);
    expect((await run(result.nextState)).denied).toBe('budget-tokens');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });

  it('preserves uncertain spend when an in-flight artifact is invalidated', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { finish = resolve; });
    const fetchImpl = vi.fn(() => pending);
    const persist = vi.fn();
    const onDegraded = vi.fn();
    const distill = buildHandoffDistill({ model: 'deepseek-chat', apiKey: 'test-key',
      endpoint: 'https://provider.example.test/chat/completions', conversationKey: 'same-key',
      loadMessages: () => [{ senderName: 'User', isFromMe: false, content: 'Brief message.' }],
      redact: (text) => text, verbatimN: 1, fetchImpl });
    const runner = new HandoffDistillRunner({ config: { ...config, maxTokensPerWindow: 2_000 },
      now: () => now, growthThreshold: 1, tokenGrowth: () => 10,
      distillFor: (_key, reserve) => distill(reserve), persist, onDegraded,
      sourceFor: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) });
    const first = runner.tickConversation('same-key');
    runner.invalidateConversation('same-key');
    await runner.tickConversation('same-key');
    finish(new Response(null, { status: 503 }));
    await first;
    await runner.tickConversation('same-key');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
    expect(onDegraded).not.toHaveBeenCalled();
  });
});
