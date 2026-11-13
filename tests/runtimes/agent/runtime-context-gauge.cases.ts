import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from '../../../src/core/types.ts';
import { AgentRuntime } from '../../../src/runtimes/agent/runtime.ts';
import { parseEvents, type AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import { makeDb, makeMessenger, makeMsg, type AutoCompactView } from './lib/runtime-mock-scaffold.ts';

/**
 * #3717 / #3717c context-gauge cases. They run inside runtime.test.ts's
 * describe('AgentRuntime'), whose hoisted session and database mocks they need;
 * runtime.test.ts passes those mocks and the helpers bound to them. The cases
 * live here because runtime.test.ts sits at its arch.file-size ceiling.
 */
export interface RuntimeContextGaugeHarness {
  capturedOnEventRef: { current: ((event: AgentEvent) => void) | null };
  mockSession: { sendTurn: ReturnType<typeof vi.fn> };
  mockAccumulateTokensWithEvent: ReturnType<typeof vi.fn>;
  mockActiveAgentSession(rowId?: number): void;
  mockTokenSnapshot(totalInputTokens: number, lastCompactInputTokens: number): void;
  sendAndAwaitProviderDispatch(runtime: AgentRuntime, msg: IncomingMessage, scopeKey?: string): Promise<void>;
  emitAgentResult(inputTokens: number, text?: string | null): Promise<void>;
  emitRequestUsage(contextTokens: number): Promise<void>;
  emitSuccessfulCompactResult(inputTokens?: number): Promise<void>;
}

export function registerRuntimeContextGaugeTests(harness: RuntimeContextGaugeHarness): void {
  const {
    capturedOnEventRef, mockSession, mockAccumulateTokensWithEvent, mockActiveAgentSession, mockTokenSnapshot,
    sendAndAwaitProviderDispatch, emitAgentResult, emitRequestUsage, emitSuccessfulCompactResult,
  } = harness;

  // #3717 shape from production (threshold 150,000): a request context of 352,562 was
  // compacted; the first requests after the compact had contexts of 84,216 and 93,900.
  // That turn's summed usage (1,070,745) and the cumulative input since the compact were
  // both over the threshold, so the cumulative measure judged the successful compact
  // non-convergent, counted a rapid re-arm and backed the scope off.
  describe('#3717 convergence is judged on the current request context', () => {
    const threshold = 150_000;
    const globalKey = '__global__';
    const baseline = 2_000_000;
    const preCompactCumulative = 38_160_286;
    const compactBaseline = baseline + preCompactCumulative;
    const overContext = 352_562;
    const postCompactContexts = [84_216, 93_900] as const;
    const postCompactSummedInput = 1_070_745;

    type ConvergenceView = AutoCompactView & { consecutiveNonConvergentCompactions: Map<string, number> };

    /** A real over-threshold context compacts, then the first post-compact turn is under it. */
    async function compactThenUnderThresholdTurn(runtime: AgentRuntime, label: string): Promise<number> {
      mockActiveAgentSession();
      await runtime.start();

      mockTokenSnapshot(compactBaseline, baseline);
      await sendAndAwaitProviderDispatch(runtime, makeMsg({ messageId: `msg-${label}-over`, content: 'over' }));
      await emitRequestUsage(overContext);
      await emitAgentResult(overContext);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
      await emitSuccessfulCompactResult();

      // Inside the 5-minute rapid-rearm window, with cumulative input past the threshold.
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(compactBaseline + postCompactSummedInput, compactBaseline);
      await sendAndAwaitProviderDispatch(runtime, makeMsg({ messageId: `msg-${label}-after`, content: 'after compact' }));
      for (const context of postCompactContexts) await emitRequestUsage(context);
      await emitAgentResult(postCompactSummedInput);
      expect(mockSession.sendTurn).not.toHaveBeenCalledWith('/compact');
      return compactBaseline + postCompactSummedInput;
    }

    it('judges a compact converged and sets no backoff when the first post-compact context is under the threshold', async () => {
      vi.useFakeTimers();
      try {
        const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', { autoCompactInputTokens: threshold });
        const { autoCompact } = runtime as unknown as { autoCompact: ConvergenceView };

        await compactThenUnderThresholdTurn(runtime, '3717-b1');

        // The verdict: this compact converged.
        expect(autoCompact.consecutiveNonConvergentCompactions.get(globalKey) ?? 0).toBe(0);
        // No rapid re-arm, and no cooldown beyond the 5-minute one the successful compact set.
        expect(autoCompact.consecutiveRapidRearms.get(globalKey) ?? 0).toBe(0);
        const compactedAt = autoCompact.lastSuccessAt.get(globalKey);
        expect(compactedAt).toBeDefined();
        expect(autoCompact.cooldownUntil.get(globalKey)).toBe(compactedAt! + 5 * 60 * 1000);
        const health = runtime.getHealthSnapshot().details as {
          degradedReasons: string[];
          autoCompactIneffective: number;
          autoCompactNextTurnOverThreshold: number;
          autoCompactState: string;
        };
        expect(health.autoCompactIneffective).toBe(0);
        expect(health.autoCompactNextTurnOverThreshold).toBe(0);
        expect(health.autoCompactState).toBe('idle');
        expect(health.degradedReasons).not.toContain('auto_compact_backoff');
      } finally {
        vi.useRealTimers();
      }
    });

    it('compacts a real over-threshold context inside the backoff an earlier false verdict would have set', async () => {
      vi.useFakeTimers();
      try {
        const runtime = new AgentRuntime(makeDb(), makeMessenger().messenger, 'test', { autoCompactInputTokens: threshold });
        const totalAfterFirstTurn = await compactThenUnderThresholdTurn(runtime, '3717-b2');

        // Past the 5-minute success cooldown, inside the 15-minute tier-1 backoff a false
        // verdict on the previous turn would have set. The context is now really over.
        await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
        mockSession.sendTurn.mockClear();
        mockTokenSnapshot(totalAfterFirstTurn + 2_500_000, compactBaseline);
        await sendAndAwaitProviderDispatch(runtime, makeMsg({ messageId: 'msg-3717-b2-real-over', content: 'real over' }));
        await emitRequestUsage(151_798);
        await emitAgentResult(151_798);

        expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ─── #3717-C context gauge (design v2, RECEIPT 2026-11-01T13:05:53Z) ─────────
  // Revision 2. Raw Claude stream-json lines go through the REAL parseEvents()
  // into the captured SessionManager onEvent. No new API: every assertion reads an
  // existing observable — health counters (ineffective, consecutiveRapidRearmsMax,
  // nextTurnOverThreshold, autoCompactState), the existing streak map /
  // isCompactionNonConvergent, sendTurn('/compact') calls and the billing call.
  // The gauge is read indirectly: within the 5-minute window after a compact, P4
  // counts a known context over 400,000 (and P1 records the verdict); after the
  // window, P3 compacts on a known context over 400,000, or falls back to the
  // cumulative trigger when the context is unknown (G6). Cumulative traffic is kept
  // over threshold throughout, so base 5165ed90b (summed traffic) goes red.
  describe('#3717c context gauge', () => {
    const THRESHOLD = 400_000;
    const GLOBAL = '__global__';
    const WINDOW_PASSED_MS = 6 * 60 * 1000; // past success cooldown and rapid-rearm window (5 min each)
    type GaugeView = {
      autoCompact: {
        consecutiveNonConvergentCompactions: Map<string, number>;
        isCompactionNonConvergent(scopeKey: string): boolean;
      };
      cleanupPerChatState(mapKey: string): void;
      cleanupGlobalAutoCompactState(): void;
    };
    // One API request whose context (input + cache_creation + cache_read, G1) is ctx.
    const usageFor = (ctx: number) => ({
      input_tokens: 4,
      cache_creation_input_tokens: 1_000,
      cache_read_input_tokens: ctx - 1_004,
      output_tokens: 100,
    });
    const assistantLine = (sid: string, id: string, usage: unknown, text = `step ${id}`): string => {
      const message: Record<string, unknown> = {
        id, type: 'message', role: 'assistant', model: 'claude-test',
        content: [{ type: 'text', text }],
      };
      if (usage !== undefined) message['usage'] = usage;
      return JSON.stringify({ type: 'assistant', message, session_id: sid });
    };
    // CLI result usage = the SUM over the turn's distinct requests (billing figure).
    const resultLine = (sid: string, contexts: readonly number[]): string => JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid,
      usage: {
        input_tokens: 4 * contexts.length,
        cache_creation_input_tokens: 1_000 * contexts.length,
        cache_read_input_tokens: contexts.reduce((sum, ctx) => sum + ctx - 1_004, 0),
        output_tokens: 100 * contexts.length,
      },
    });
    const boundaryLine = (sid: string, preTokens: number): string => JSON.stringify({
      type: 'system', subtype: 'compact_boundary', session_id: sid,
      compact_metadata: { trigger: 'manual', pre_tokens: preTokens },
    });
    const initLine = (sid: string): string => JSON.stringify({ type: 'system', subtype: 'init', session_id: sid });
    async function feedRaw(...lines: string[]): Promise<void> {
      for (const line of lines) {
        for (const event of parseEvents(line)) capturedOnEventRef.current?.(event);
      }
      await Promise.resolve();
    }
    // A turn of distinct requests in one generation: one assistant line each, then the result.
    async function feedTurn(sid: string, prefix: string, contexts: readonly number[]): Promise<void> {
      await feedRaw(
        ...contexts.map((ctx, i) => assistantLine(sid, `${prefix}-${i}`, usageFor(ctx))),
        resultLine(sid, contexts),
      );
    }
    // Row 1193 (13:59Z): compact 107,741 -> 19,375; then seven requests summing
    // 475,858, max = last = 76,628, threshold 400,000 (controller figures).
    const S1 = 'session-1';
    const S2 = 'session-2';
    const ROW_1193_PRE_COMPACT = 107_741;
    const ROW_1193_TURN = [60_649, 63_361, 64_521, 66_427, 68_459, 75_813, 76_628] as const;
    const ROW_1193_SUM = 475_858;
    const OVER = 450_000;
    const UNDER = 150_000;
    // Cumulative traffic since the compact = one row-1193 turn (over threshold).
    const overSinceCompact = (rounds = 1) =>
      mockTokenSnapshot(1_000_000 + rounds * ROW_1193_SUM, 1_000_000 + (rounds - 1) * ROW_1193_SUM);

    let userTurn = 0;
    async function userMessage(runtime: AgentRuntime, mapKey = GLOBAL): Promise<void> {
      userTurn += 1;
      const chat = mapKey === GLOBAL ? {} : { chatJid: mapKey, senderJid: mapKey };
      await sendAndAwaitProviderDispatch(
        runtime,
        makeMsg({ messageId: `msg-3717c-${userTurn}`, content: `3717c turn ${userTurn}`, ...chat }),
        mapKey,
      );
    }
    // Arm and complete one /compact (session-1). The arming turn is the legacy
    // emitAgentResult (no assistant usage): the context is unknown and the cumulative
    // trigger fires on base and after the fix alike. `side` places the summarize
    // request's usage before or after compact_boundary; neither may become the
    // post-compact context (G5).
    async function compactOnce(
      runtime: AgentRuntime,
      { side = 'before', summarize = ROW_1193_PRE_COMPACT, mapKey = GLOBAL }:
        { side?: 'before' | 'after'; summarize?: number; mapKey?: string } = {},
    ): Promise<void> {
      await userMessage(runtime, mapKey);
      mockSession.sendTurn.mockClear();
      mockTokenSnapshot(1_000_000, 500_000);
      await emitAgentResult(150);
      expect(mockSession.sendTurn).toHaveBeenCalledWith('/compact');
      const summary = assistantLine(S1, `compact-${userTurn}`, usageFor(summarize), 'summary');
      const boundary = boundaryLine(S1, summarize);
      await feedRaw(...(side === 'before' ? [summary, boundary] : [boundary, summary]), resultLine(S1, [summarize]));
      overSinceCompact();
      mockSession.sendTurn.mockClear();
    }
    function makeRuntime(extra: Record<string, unknown> = {}): AgentRuntime {
      const { messenger } = makeMessenger();
      return new AgentRuntime(makeDb(), messenger, 'test', { autoCompactInputTokens: THRESHOLD, ...extra });
    }
    const view = (runtime: AgentRuntime) => runtime as unknown as GaugeView;
    const details = (runtime: AgentRuntime) => runtime.getHealthSnapshot().details;
    const streak = (runtime: AgentRuntime, key = GLOBAL) =>
      view(runtime).autoCompact.consecutiveNonConvergentCompactions.get(key) ?? 0;
    const compactCalls = () => (mockSession.sendTurn.mock.calls as unknown as Array<[string]>)
      .filter(([text]) => text === '/compact').length;

    beforeEach(() => {
      userTurn = 0;
      vi.useFakeTimers();
      mockActiveAgentSession();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('R1 row 1193 replay inside the window: last request 76,628 is converged (P1/P2/P4)', async () => {
      const runtime = makeRuntime();
      await runtime.start();
      await compactOnce(runtime);

      await userMessage(runtime);
      await feedTurn(S1, 'r1', ROW_1193_TURN);

      expect(details(runtime).autoCompactNextTurnOverThreshold).toBe(0); // P4 (base: summed 475,858 -> 1)
      expect(details(runtime).autoCompactIneffective).toBe(0); // P2
      expect(details(runtime).autoCompactConsecutiveRapidRearmsMax).toBe(0); // P2
      expect(details(runtime).autoCompactState).toBe('idle');
      expect(streak(runtime)).toBe(0); // P1
      expect(compactCalls()).toBe(0);
    });

    it('R1 billing is unchanged: the summed result usage is accumulated once, in full (G7)', async () => {
      const runtime = makeRuntime();
      await runtime.start();
      await compactOnce(runtime);

      mockAccumulateTokensWithEvent.mockClear();
      await userMessage(runtime);
      await feedTurn(S1, 'bill', ROW_1193_TURN);

      const cacheRead = ROW_1193_SUM - (4 + 1_000) * ROW_1193_TURN.length;
      expect(mockAccumulateTokensWithEvent).toHaveBeenCalledWith(
        expect.anything(), 42, ROW_1193_SUM - cacheRead, 100 * ROW_1193_TURN.length, cacheRead,
      );
      expect(mockAccumulateTokensWithEvent).toHaveBeenCalledTimes(1); // assistant usage is never billed
    });

    it('R2 P3 after the window: cumulative over threshold, known last request under -> no /compact', async () => {
      const runtime = makeRuntime();
      await runtime.start();
      await compactOnce(runtime);

      await vi.advanceTimersByTimeAsync(WINDOW_PASSED_MS);
      await userMessage(runtime);
      await feedTurn(S1, 'r2', ROW_1193_TURN);

      expect(compactCalls()).toBe(0);
      expect(streak(runtime)).toBe(0);
    });

    it.each([
      ['before', 'summarize usage precedes compact_boundary'],
      ['after', 'summarize usage follows compact_boundary'],
    ] as const)('R6 boundary (%s): the /compact turn never feeds the post-compact context — %s', async (side, _why) => {
      const runtime = makeRuntime();
      await runtime.start();
      // The summarize request is itself over threshold; adding it, taking a max over
      // the session, or keeping it as a stale value all count the next turn as over.
      await compactOnce(runtime, { side, summarize: OVER });

      await userMessage(runtime);
      await feedTurn(S1, `post-${side}`, [19_375]);

      expect(details(runtime).autoCompactNextTurnOverThreshold).toBe(0);
      expect(details(runtime).autoCompactIneffective).toBe(0);
      expect(streak(runtime)).toBe(0);
    });

    // Each case: [label, assistant lines (one message.id may repeat), expected over].
    // add = sum of every chunk; max = largest chunk; stale = first value per id or per turn.
    it.each([
      ['repeated id, equal usage x3 (add trips)', [['d', UNDER], ['d', UNDER], ['d', UNDER]], false],
      ['repeated id, falling usage (add and max trip)', [['d', OVER], ['d', UNDER]], false],
      ['repeated id, rising usage (stale-first misses)', [['d', UNDER], ['d', OVER]], true],
      ['distinct ids, last lower (max and add trip)', [['a', OVER], ['b', UNDER]], false],
      ['distinct ids, last higher (stale-first misses)', [['a', UNDER], ['b', OVER]], true],
    ] as const)('R4/R3 %s', async (_label, chunks, over) => {
      const runtime = makeRuntime();
      await runtime.start();
      await compactOnce(runtime);

      await userMessage(runtime);
      const distinct = new Map<string, number>();
      for (const [id, ctx] of chunks) distinct.set(id, ctx); // CLI result counts each request once, final usage
      await feedRaw(
        ...chunks.map(([id, ctx], i) => assistantLine(S1, `dup-${id}`, usageFor(ctx), `block ${i}`)),
        resultLine(S1, [...distinct.values()]),
      );

      expect(details(runtime).autoCompactNextTurnOverThreshold).toBe(over ? 1 : 0); // P4
      expect(streak(runtime)).toBe(over ? 1 : 0); // P1 verdict
    });

    it('R5 missing last usage inside the window: unknown, so no P4 count, no verdict, no backoff', async () => {
      const runtime = makeRuntime();
      await runtime.start();
      await compactOnce(runtime);

      await userMessage(runtime);
      await feedRaw(
        assistantLine(S1, 'm-0', usageFor(60_000)),
        assistantLine(S1, 'm-1', undefined),
        resultLine(S1, [60_000, 400_000]),
      );

      expect(details(runtime).autoCompactNextTurnOverThreshold).toBe(0);
      expect(details(runtime).autoCompactIneffective).toBe(0);
      expect(details(runtime).autoCompactState).toBe('idle');
      expect(streak(runtime)).toBe(0);
    });

    it('R5 missing last usage after the window: unknown, so the cumulative fallback compacts (G6)', async () => {
      const runtime = makeRuntime();
      await runtime.start();
      await compactOnce(runtime);

      await vi.advanceTimersByTimeAsync(WINDOW_PASSED_MS);
      await userMessage(runtime);
      // A stale value (60,000) would suppress the fallback; unknown must not.
      await feedRaw(
        assistantLine(S1, 'f-0', usageFor(60_000)),
        assistantLine(S1, 'f-1', undefined),
        resultLine(S1, [60_000, 70_000]),
      );

      expect(compactCalls()).toBe(1);
      expect(streak(runtime)).toBe(0); // no verdict from an unknown context
      expect(details(runtime).autoCompactIneffective).toBe(0);
    });

    it.each([
      ['negative', { ...usageFor(50_000), cache_read_input_tokens: -10 }],
      ['string', { ...usageFor(50_000), input_tokens: '4' }],
      ['non-finite', '__INF__'],
      ['non-object', 5],
      ['null', null],
    ])('invalid last usage (%s) is unknown — never 0, never added, never the prior value', async (_label, badUsage) => {
      const runtime = makeRuntime();
      await runtime.start();
      await compactOnce(runtime);

      await vi.advanceTimersByTimeAsync(WINDOW_PASSED_MS);
      await userMessage(runtime);
      const bad = badUsage === '__INF__'
        // JSON.parse('1e400') === Infinity: the only way to carry a non-finite number in JSON.
        ? assistantLine(S1, 'bad', usageFor(50_000)).replace(/"cache_read_input_tokens":\d+/, '"cache_read_input_tokens":1e400')
        : assistantLine(S1, 'bad', badUsage);
      await feedRaw(assistantLine(S1, 'ok', usageFor(60_000)), bad, resultLine(S1, [60_000, 50_000]));

      expect(compactCalls()).toBe(1); // unknown -> cumulative fallback; 0 or 60,000 would suppress it
    });

    it('turn reset: a turn with no assistant usage does not inherit the previous turn context', async () => {
      const runtime = makeRuntime();
      await runtime.start();
      await compactOnce(runtime);
      await vi.advanceTimersByTimeAsync(WINDOW_PASSED_MS);

      await userMessage(runtime);
      await feedTurn(S1, 't1', [50_000]);
      expect(compactCalls()).toBe(0); // known 50,000 under threshold (base: cumulative compacts)

      await userMessage(runtime);
      await feedRaw(resultLine(S1, [30_000]));
      expect(compactCalls()).toBe(1); // unknown -> fallback; a carried 50,000 would suppress it
    });

    it('R7 generation: a new session id mid-turn drops the old generation context', async () => {
      const runtime = makeRuntime();
      await runtime.start();
      await compactOnce(runtime);

      await userMessage(runtime);
      // session-1 request over threshold, then the provider re-inits as session-2,
      // whose result carries no assistant usage of its own. Every line after the
      // init carries session-2.
      await feedRaw(
        assistantLine(S1, 'g1-0', usageFor(OVER)),
        initLine(S2),
        resultLine(S2, [OVER]),
      );

      expect(details(runtime).autoCompactNextTurnOverThreshold).toBe(0); // unknown, not the session-1 value
      expect(streak(runtime)).toBe(0);
    });

    it('re-key: an alias change mid-turn carries the context to the canonical scope (real route)', async () => {
      const lidKey = '15550100444@lid';
      const canonical = '15550100444@s.whatsapp.net';
      const runtime = makeRuntime({ sessionScope: 'per_chat' });
      await runtime.start();
      overSinceCompact();
      mockSession.sendTurn.mockClear();

      await userMessage(runtime, lidKey);
      await feedRaw(...ROW_1193_TURN.map((ctx, i) => assistantLine(S1, `k-${i}`, usageFor(ctx))));
      runtime.handleJidAliasChanged('15550100444', canonical);
      await feedRaw(resultLine(S1, ROW_1193_TURN));

      // Known 76,628 moved with the scope -> no /compact. Lost on re-key -> unknown ->
      // cumulative fallback compacts. Base: cumulative 475,858 compacts.
      expect(compactCalls()).toBe(0);
    });

    it('cleanup routes: per-chat and global cleanup leave the next turn unknown', async () => {
      const chat = 'chat-3717c@s.whatsapp.net';
      const perChat = makeRuntime({ sessionScope: 'per_chat' });
      await perChat.start();
      overSinceCompact();
      mockSession.sendTurn.mockClear();
      await userMessage(perChat, chat);
      await feedTurn(S1, 'c1', [50_000]);
      expect(compactCalls()).toBe(0);
      view(perChat).cleanupPerChatState(chat);
      await userMessage(perChat, chat);
      await feedRaw(resultLine(S1, [30_000]));
      expect(compactCalls()).toBe(1);

      const single = makeRuntime();
      await single.start();
      overSinceCompact();
      mockSession.sendTurn.mockClear();
      await userMessage(single);
      await feedTurn(S1, 'c2', [50_000]);
      expect(compactCalls()).toBe(0);
      view(single).cleanupGlobalAutoCompactState();
      await userMessage(single);
      await feedRaw(resultLine(S1, [30_000]));
      expect(compactCalls()).toBe(1);
    });

    it('R8 genuine over threshold still escalates: last request over after each compact reaches the limit', async () => {
      const runtime = makeRuntime();
      await runtime.start();
      await compactOnce(runtime);

      for (let round = 1; round <= 3; round += 1) {
        await vi.advanceTimersByTimeAsync(WINDOW_PASSED_MS);
        mockSession.sendTurn.mockClear();
        overSinceCompact(round);
        await userMessage(runtime);
        await feedTurn(S1, `over-${round}`, [120_000, OVER]);
        expect(streak(runtime)).toBe(round);
        if (round < 3) {
          expect(compactCalls()).toBe(1);
          await feedRaw(
            assistantLine(S1, `sum-${round}`, usageFor(OVER), 'summary'),
            boundaryLine(S1, OVER),
            resultLine(S1, [OVER]),
          );
        }
      }
      expect(view(runtime).autoCompact.isCompactionNonConvergent(GLOBAL)).toBe(true);
    });

    it.each([
      ['string field', { input_tokens: '4', cache_creation_input_tokens: 1_000, cache_read_input_tokens: 448_996 }],
      ['negative field', { input_tokens: -4, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 448_996 }],
      ['empty object', {}],
      ['null', null],
    ])('usage gap: invalid last usage (%s) is unknown inside the window, never 0 or stale', async (_label, usage) => {
      const runtime = makeRuntime();
      await runtime.start();
      await compactOnce(runtime);

      await userMessage(runtime);
      await feedRaw(
        assistantLine(S1, 'iv-0', usageFor(60_000)),
        assistantLine(S1, 'iv-1', usage),
        resultLine(S1, [60_000, OVER]),
      );

      expect(details(runtime).autoCompactNextTurnOverThreshold).toBe(0);
      expect(details(runtime).autoCompactIneffective).toBe(0);
      expect(streak(runtime)).toBe(0);
    });

    // P4 non-result sites (the per-chat and global token_usage handlers). The event is the
    // exact shape codex-parser emits for thread/tokenUsage/updated, delivered to the
    // real onEvent handler. Its inputTokens is a turn/thread sum, not one request's
    // context, so it must not count as P4 over threshold (G1/G6); base counts it.
    it.each([
      ['global', GLOBAL, {}],
      ['per-chat', 'chat-3717c-p4@s.whatsapp.net', { sessionScope: 'per_chat' }],
    ])('usage gap: P4 token_usage (%s) summed over threshold is not the context gauge', async (_label, mapKey, extra) => {
      const runtime = makeRuntime(extra);
      await runtime.start();
      await compactOnce(runtime, { mapKey });

      await userMessage(runtime, mapKey);
      capturedOnEventRef.current?.({ type: 'token_usage', inputTokens: ROW_1193_SUM, outputTokens: 700 });
      await feedTurn(S1, 'tu', ROW_1193_TURN);

      expect(details(runtime).autoCompactNextTurnOverThreshold).toBe(0);
      expect(details(runtime).autoCompactConsecutiveRapidRearmsMax).toBe(0);
      expect(streak(runtime, mapKey)).toBe(0);
    });

    it('billing gap: duplicate chunks and a missing last usage still bill the result usage once', async () => {
      const runtime = makeRuntime();
      await runtime.start();
      await compactOnce(runtime);

      mockAccumulateTokensWithEvent.mockClear();
      await userMessage(runtime);
      const billed = [UNDER, 70_000] as const;
      await feedRaw(
        assistantLine(S1, 'dup', usageFor(UNDER)),
        assistantLine(S1, 'dup', usageFor(UNDER)),
        assistantLine(S1, 'dup', usageFor(UNDER)),
        assistantLine(S1, 'tail', undefined),
        resultLine(S1, billed),
      );

      const cacheRead = billed.reduce((sum, ctx) => sum + ctx - 1_004, 0);
      expect(mockAccumulateTokensWithEvent).toHaveBeenCalledTimes(1);
      expect(mockAccumulateTokensWithEvent).toHaveBeenCalledWith(
        expect.anything(), 42, 1_004 * billed.length, 100 * billed.length, cacheRead,
      );
    });
  });
}
