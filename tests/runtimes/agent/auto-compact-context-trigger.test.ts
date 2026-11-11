// #3717c regression: the auto-compact trigger must measure the context of the
// current request, not the cumulative usage since the last compact.
//
// Shape seen in production (2026-11-06, threshold 500,000): after one compact a
// per-chat session made 163 API requests. Each request's context (input +
// cache_creation + cache_read) stayed between about 45,000 and 204,000 tokens,
// but their sum was 19.6M. The cumulative trigger read that sum as "over
// threshold", re-armed /compact four times inside the rapid-rearm window and
// put the scope into a one-hour backoff although no request came near the limit.
//
// Raw Claude stream-json lines go through the real parseEvents() into the
// runtime's per-chat event handler; the token totals come from a real
// agent_sessions row, so maybeStartAutoCompact reads the same cumulative figure
// it reads in production.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/logger.ts', async () => {
  const { singletonLoggerMock } = await import('../../helpers/logger-mock.ts');
  const runtimeLogger = singletonLoggerMock();
  return {
    default: { ...runtimeLogger, child: () => runtimeLogger },
    createChildLogger: () => runtimeLogger,
    flushLogger: () => Promise.resolve(),
  };
});

vi.mock('../../../src/lib/emit-alert.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/lib/emit-alert.ts')>(),
  emitAlert: vi.fn(() => ({ ok: true, channel: 'outbox', status: 'durably_queued' })),
  emitAlertChecked: vi.fn(() => true),
  clearAlertSourceChecked: vi.fn(() => true),
}));

import { Database } from '../../../src/core/database.ts';
import { createChildLogger } from '../../../src/logger.ts';
import type { IOutboundQueue } from '../../../src/runtimes/agent/outbound-queue.ts';
import { ensureAgentSchema } from '../../../src/runtimes/agent/session-db.ts';
import { parseEvents, type AgentEvent } from '../../../src/runtimes/agent/stream-parser.ts';
import {
  makeRuntimeState,
  perChatToolScopeKey,
  queueStub,
  registerSessionToolScope,
  sessionStub,
} from './lib/runtime-terminal-coordinator-harness.ts';

const THRESHOLD = 500_000;
const ROW_ID = 467;
const SCOPE = 'group-3717c@g.us';
const SESSION_ID = 'session-3717c';
// Per-request usage split, as the CLI reports it: a few new input tokens, a
// small cache write and the rest of the context read back from the cache.
const INPUT = 2;
const CACHE_CREATION = 884;

type Session = ReturnType<typeof sessionStub> & { bindGenerationOwnership: ReturnType<typeof vi.fn> };

// The private runtime members this suite drives (standalone, not the harness
// RuntimeState, whose stubs type these methods for other suites).
type TriggerState = {
  chatQueues: Map<string, IOutboundQueue>;
  sessionEventToolScopes: WeakMap<object, string>;
  autoCompact: {
    waiters: Map<string, unknown>;
    lastSuccessAt: Map<string, number>;
    consecutiveRapidRearms: Map<string, number>;
    consecutiveNonConvergentCompactions: Map<string, number>;
    cooldownUntil: Map<string, number>;
    ineffective: number;
    nextTurnOverThreshold: number;
    recordAutoCompactSuccess(scopeKey: string): void;
  };
  setOwnedPerChatSession(mapKey: string, session: Session): void;
  handleEventWithContext(
    event: AgentEvent,
    queue: IOutboundQueue,
    session: Session,
    conversationKey?: string,
    inboundSeq?: number,
    mapKey?: string,
    toolScopeKey?: string,
  ): void;
  maybeStartAutoCompact(session: Session, mapKey?: string): boolean;
  recordAutoCompactNextTurnIfNeeded(
    scopeKey: string,
    summedInputTokens: number | undefined,
    consumeWhenNotOverThreshold?: boolean,
    generation?: string,
  ): void;
};

/** `count` distinct request contexts rising evenly from `first` to `last`. */
function risingContexts(count: number, first: number, last: number): number[] {
  return Array.from({ length: count }, (_, i) => Math.round(first + ((last - first) * i) / (count - 1)));
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

function assistantLine(id: string, context: number): string {
  return JSON.stringify({
    type: 'assistant',
    session_id: SESSION_ID,
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'thinking', thinking: '', signature: '' }],
      usage: {
        input_tokens: INPUT,
        cache_creation_input_tokens: CACHE_CREATION,
        cache_read_input_tokens: context - INPUT - CACHE_CREATION,
        output_tokens: 150,
      },
    },
  });
}

const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION_ID });

describe('#3717c auto-compact trigger measures the current request context', () => {
  let db: Database;
  let state: TriggerState;
  let session: Session;
  let queue: IOutboundQueue;
  const log = createChildLogger('agent-runtime');

  /** Store the session's totals: `sinceCompact` tokens of traffic after the last compact. */
  function setTotals(sinceCompact: readonly number[]): void {
    const lastCompactInput = 2_000_000;
    const lastCompactCacheRead = 80_000_000;
    const input = sinceCompact.length * (INPUT + CACHE_CREATION);
    const cacheRead = sum(sinceCompact) - input;
    db.raw.prepare(
      `INSERT OR REPLACE INTO agent_sessions
         (id, session_id, chat_jid, started_at, status, provider,
          total_input_tokens, total_cache_read_tokens,
          last_compact_at, last_compact_input_tokens, last_compact_cache_read_tokens)
       VALUES (?, ?, ?, datetime('now'), 'active', 'claude-cli', ?, ?, datetime('now'), ?, ?)`,
    ).run(
      ROW_ID, SESSION_ID, SCOPE,
      lastCompactInput + input, lastCompactCacheRead + cacheRead,
      lastCompactInput, lastCompactCacheRead,
    );
  }

  function feed(...lines: string[]): void {
    for (const line of lines) {
      for (const event of parseEvents(line)) {
        state.handleEventWithContext(event, queue, session, undefined, undefined, SCOPE, perChatToolScopeKey(SCOPE));
      }
    }
  }

  function feedRequests(prefix: string, contexts: readonly number[]): void {
    feed(...contexts.map((context, i) => assistantLine(`${prefix}-${i}`, context)));
  }

  const triggerLogged = () =>
    (vi.mocked(log.info).mock.calls as unknown as unknown[][]).some((call) => call[1] === 'auto compact triggered');
  const compactSent = () => session.sendTurn.mock.calls.some(([text]) => text === '/compact');

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-06T16:25:24.000Z') });
    vi.mocked(log.info).mockClear();
    db = new Database(':memory:');
    db.open();
    ensureAgentSchema(db);
    const { runtime } = makeRuntimeState(db, {
      sessionScope: 'per_chat',
      autoCompactInputTokens: THRESHOLD,
    });
    state = runtime as unknown as TriggerState;
    session = Object.assign(sessionStub(), { bindGenerationOwnership: vi.fn() });
    session.getProviderId.mockReturnValue('claude-cli');
    session.getDbRowId.mockReturnValue(ROW_ID);
    session.getStatus.mockReturnValue({ active: true, sessionId: SESSION_ID, pid: 4100, turnInFlight: false });
    queue = queueStub(SCOPE);
    state.chatQueues.set(SCOPE, queue);
    state.setOwnedPerChatSession(SCOPE, session);
    registerSessionToolScope(state, session, perChatToolScopeKey(SCOPE));
    feed(initLine);
  });

  afterEach(() => {
    db.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not compact when many requests are each under the limit but their sum is far over it', () => {
    const contexts = risingContexts(163, 45_249, 204_244);
    expect(Math.max(...contexts)).toBeLessThan(THRESHOLD);
    expect(sum(contexts)).toBeGreaterThan(30 * THRESHOLD);
    setTotals(contexts);

    feedRequests('long-run', contexts);
    const armed = state.maybeStartAutoCompact(session, SCOPE);

    expect(armed).toBe(false);
    expect(compactSent()).toBe(false);
    expect(triggerLogged()).toBe(false);
    expect(state.autoCompact.waiters.has(SCOPE)).toBe(false);
  });

  it('does not count a rapid re-arm or a failed compact when the first requests after a compact are under the limit', () => {
    state.autoCompact.recordAutoCompactSuccess(SCOPE);
    vi.advanceTimersByTime(3 * 60_000); // inside the 5-minute rapid-rearm window
    const contexts = risingContexts(35, 44_695, 79_953);
    expect(sum(contexts)).toBeGreaterThan(4 * THRESHOLD);
    setTotals(contexts);

    feedRequests('after-compact', contexts);
    // The turn-result handler passes the turn's summed usage; the decision must not use it.
    state.recordAutoCompactNextTurnIfNeeded(SCOPE, sum(contexts), false, `row:${ROW_ID}`);
    const armed = state.maybeStartAutoCompact(session, SCOPE);

    expect(armed).toBe(false);
    expect(state.autoCompact.nextTurnOverThreshold).toBe(0);
    expect(state.autoCompact.ineffective).toBe(0);
    expect(state.autoCompact.consecutiveRapidRearms.get(SCOPE) ?? 0).toBe(0);
    expect(state.autoCompact.consecutiveNonConvergentCompactions.get(SCOPE) ?? 0).toBe(0);
    expect(compactSent()).toBe(false);
  });

  it('still compacts when the current request context is at or over the limit', () => {
    const contexts = [180_000, 320_000, THRESHOLD + 20_000];
    setTotals(contexts);

    feedRequests('over', contexts);
    const armed = state.maybeStartAutoCompact(session, SCOPE);

    expect(armed).toBe(true);
    expect(compactSent()).toBe(true);
    expect(triggerLogged()).toBe(true);
    expect(state.autoCompact.waiters.has(SCOPE)).toBe(true);
  });
});
