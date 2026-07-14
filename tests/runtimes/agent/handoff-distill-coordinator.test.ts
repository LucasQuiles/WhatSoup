/**
 * Branch coverage for `src/runtimes/agent/handoff-distill-coordinator.ts`.
 *
 * The coordinator owns three observable surfaces:
 *   1. `start()` arm lifecycle — flag off / already armed / inert (no model+key)
 *      / happy-arm / idempotent / re-arm.
 *   2. `shutdown()` lifecycle — clears the timer, drops the runner, idempotent.
 *   3. The per-tick wiring inside `buildRunner()` — `tokenGrowth` (null rowId,
 *      null snapshot, compaction-baseline-ahead clamp), `distillFor` (closure
 *      builds + invokes the LLM and normalises `seededArtifacts ?? null`),
 *      `onDegraded` (sanitises + slices, emits alert, swallows emit failure).
 *
 * The sweep is exercised through bracket access to the private `sweep()`
 * method so we hit the enumeration/iteration/dedup/prune branches without
 * waiting on the production cadence. All test branch observations are made on
 * the coordinator's `runner` field (a real `HandoffDistillRunner` instance) and
 * on the injected `listActiveSessionRows` / `getSessionTokenSnapshot` mocks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockListActiveSessionRows,
  mockGetSessionTokenSnapshot,
  mockGetRecentMessages,
  mockUpsertHandoffArtifact,
  mockEmitAlertChecked,
  mockLogger,
  mockBuildHandoffDistill,
} = vi.hoisted(() => ({
  mockListActiveSessionRows: vi.fn<
    (db: unknown) => Array<{ conversationKey: string; rowId: number }>
  >(() => []),
  mockGetSessionTokenSnapshot: vi.fn<
    (db: unknown, rowId: number) => {
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      lastCompactInputTokens: number;
      lastCompactOutputTokens: number;
      lastCompactCacheReadTokens: number;
    } | null
  >(() => null),
  mockGetRecentMessages: vi.fn(() => []),
  mockUpsertHandoffArtifact: vi.fn(),
  mockEmitAlertChecked: vi.fn(() => true),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockBuildHandoffDistill: vi.fn(),
}));

// ─── Module mocks (declared before importing the coordinator) ───────────────

vi.mock('../../../src/logger.ts', () => ({
  createChildLogger: () => mockLogger,
}));

vi.mock('../../../src/core/messages.ts', () => ({
  getRecentMessages: mockGetRecentMessages,
}));

vi.mock('../../../src/lib/emit-alert.ts', () => ({
  emitAlertChecked: mockEmitAlertChecked,
  clearAlertSourceChecked: vi.fn(() => true),
}));

vi.mock('../../../src/runtimes/agent/handoff-artifact.ts', () => ({
  upsertHandoffArtifact: mockUpsertHandoffArtifact,
}));

vi.mock('../../../src/runtimes/agent/handoff-summarizer.ts', () => ({
  buildHandoffDistill: mockBuildHandoffDistill,
}));

vi.mock('../../../src/runtimes/agent/session-db.ts', () => ({
  getSessionTokenSnapshot: mockGetSessionTokenSnapshot,
  listActiveSessionRows: mockListActiveSessionRows,
}));

// ─── Imports under test ─────────────────────────────────────────────────────

import { HandoffDistillCoordinator } from '../../../src/runtimes/agent/handoff-distill-coordinator.ts';
import type { Database } from '../../../src/core/database.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeDb(): Database {
  return {
    raw: {
      prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn() })),
      exec: vi.fn(),
    },
  } as unknown as Database;
}

const DISTILLER_FLAG = 'WHATSOUP_HANDOFF_DISTILLER';
const MODEL_FLAG = 'WHATSOUP_HANDOFF_DISTILL_MODEL';
const DEEPSEEK_KEY = 'DEEPSEEK_API_KEY';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) prev[k] = process.env[k];
  for (const [k, val] of Object.entries(env)) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

/** Bracket view of the private sweep + runner. */
type CoordinatorInternals = {
  sweep(): Promise<void>;
  rowIdFor(conversationKey: string): number | null;
  onDegraded(conversationKey: string, reason: string): void;
  runner: {
    tickConversation(conversationKey: string): Promise<void>;
    prune(activeKeys: Set<string>): void;
  } | null;
};

function view(coord: HandoffDistillCoordinator): CoordinatorInternals {
  return coord as unknown as CoordinatorInternals;
}

function armWithMockRunner(): HandoffDistillCoordinator {
  // Arm with a flag, model, and key that resolveDistillModel accepts, so the
  // coordinator builds a real runner for wiring assertions. The env must be
  // set BEFORE start() so resolveDistillModel(this.getModel(), process.env)
  // sees the key. The env is restored when this function returns.
  return withEnv(
    {
      [DEEPSEEK_KEY]: 'sk-test-key',
    },
    () => {
      const coord = new HandoffDistillCoordinator({
        db: makeDb(),
        instanceName: 'test',
        isEnabled: () => true,
        getModel: () => 'deepseek-chat',
      });
      coord.start();
      return coord;
    },
  );
}

// ─── Setup ──────────────────────────────────────────────────────────────────

describe('handoff-distill-coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListActiveSessionRows.mockReturnValue([]);
    mockGetSessionTokenSnapshot.mockReturnValue(null);
    mockGetRecentMessages.mockReturnValue([]);
    mockUpsertHandoffArtifact.mockReset();
    mockEmitAlertChecked.mockReset();
    mockEmitAlertChecked.mockReturnValue(true);
    mockBuildHandoffDistill.mockReset();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── start() arm lifecycle ──────────────────────────────────────────────

  describe('start()', () => {
    it('flag OFF → no timer, no runner (early return)', () => {
      const coord = new HandoffDistillCoordinator({
        db: makeDb(),
        instanceName: 'test',
        isEnabled: () => false,
        getModel: () => 'deepseek-chat',
      });
      coord.start();
      // A flag-off start is observably identical to a never-started
      // coordinator — both fields are exactly the initial state.
      expect({ timer: coord.timer, runner: coord.runner }).toEqual({ timer: null, runner: null });
    });

    it('flag ON but unknown model → enabled-but-inert (warn, no timer, no runner)', () => {
      const coord = new HandoffDistillCoordinator({
        db: makeDb(),
        instanceName: 'test',
        isEnabled: () => true,
        getModel: () => 'some-unknown-model',
      });
      coord.start();
      expect(coord.timer).toBeNull();
      expect(coord.runner).toBeNull();
      // The "enabled but inert" log fires exactly once, with the configured model.
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ instance: 'test', model: 'some-unknown-model' }),
        expect.stringContaining('enabled but inert'),
      );
    });

    it('flag ON + unknown model + getModel() returning null → enabled-but-inert with null model', () => {
      const coord = new HandoffDistillCoordinator({
        db: makeDb(),
        instanceName: 'test',
        isEnabled: () => true,
        getModel: () => null,
      });
      coord.start();
      expect(coord.timer).toBeNull();
      expect(coord.runner).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ instance: 'test', model: null }),
        expect.stringContaining('enabled but inert'),
      );
    });

    it('flag ON + resolved model → arms the timer and a runner (info log)', () => {
      vi.useFakeTimers();
      const coord = new HandoffDistillCoordinator({
        db: makeDb(),
        instanceName: 'test',
        isEnabled: () => true,
        getModel: () => 'deepseek-chat',
      });
      withEnv({ [DEEPSEEK_KEY]: 'sk-test-key' }, () => {
        coord.start();
        expect(coord.timer).not.toBeNull();
        expect(coord.runner).not.toBeNull();
        expect(mockLogger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            instance: 'test',
            provider: 'deepseek',
            model: 'deepseek-chat',
          }),
          expect.stringContaining('armed'),
        );
        coord.shutdown();
      });
    });

    it('second start() while armed is a no-op (idempotent — same timer reference)', () => {
      vi.useFakeTimers();
      const coord = new HandoffDistillCoordinator({
        db: makeDb(),
        instanceName: 'test',
        isEnabled: () => true,
        getModel: () => 'deepseek-chat',
      });
      withEnv({ [DEEPSEEK_KEY]: 'sk-test-key' }, () => {
        coord.start();
        const firstTimer = coord.timer;
        const firstRunner = coord.runner;
        coord.start();
        expect(coord.timer).toBe(firstTimer);
        expect(coord.runner).toBe(firstRunner);
        coord.shutdown();
      });
    });

    it('the setInterval callback invokes sweep() on the production cadence', async () => {
      vi.useFakeTimers();
      const coord = new HandoffDistillCoordinator({
        db: makeDb(),
        instanceName: 'test',
        isEnabled: () => true,
        getModel: () => 'deepseek-chat',
      });
      await withEnv({ [DEEPSEEK_KEY]: 'sk-test-key' }, async () => {
        coord.start();
        // Replace the runner's tickConversation with a spy so the timer-driven
        // sweep is observable without re-implementing the runner.
        const runner = view(coord).runner;
        expect(runner).not.toBeNull();
        const tickSpy = vi.spyOn(runner!, 'tickConversation').mockResolvedValue();
        mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }]);

        // Advance the fake clock past the sweep interval (60_000ms default).
        // Two cycles is enough to confirm the interval callback fires.
        await vi.advanceTimersByTimeAsync(120_000);
        // The setInterval callback returns void; sweep() is an async function
        // but `void this.sweep()` discards the promise. The async timer
        // advance flushes the microtask queue, so the runner's spy was
        // observed before the assertion runs.
        expect(tickSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        coord.shutdown();
      });
    });
  });

  // ─── shutdown() lifecycle ───────────────────────────────────────────────

  describe('shutdown()', () => {
    it('clears an armed timer and drops the runner', () => {
      vi.useFakeTimers();
      const coord = new HandoffDistillCoordinator({
        db: makeDb(),
        instanceName: 'test',
        isEnabled: () => true,
        getModel: () => 'deepseek-chat',
      });
      withEnv({ [DEEPSEEK_KEY]: 'sk-test-key' }, () => {
        coord.start();
        expect(coord.timer).not.toBeNull();
        expect(coord.runner).not.toBeNull();
        coord.shutdown();
        expect(coord.timer).toBeNull();
        expect(coord.runner).toBeNull();
      });
    });

    it('shutdown() before start() is a no-op (no throw)', () => {
      const coord = new HandoffDistillCoordinator({
        db: makeDb(),
        instanceName: 'test',
        isEnabled: () => true,
        getModel: () => 'deepseek-chat',
      });
      // shutdown() must not throw, AND must not corrupt the initial state.
      coord.shutdown();
      expect({ timer: coord.timer, runner: coord.runner }).toEqual({ timer: null, runner: null });
    });
  });

  // ─── buildRunner() tokenGrowth closure ──────────────────────────────────

  describe('buildRunner() tokenGrowth closure', () => {
    it('rowIdFor returns null when conversation key is not in active rows', () => {
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'other-chat', rowId: 99 }]);
      expect(view(coord).rowIdFor('missing-chat')).toBeNull();
      coord.shutdown();
    });

    it('rowIdFor returns the rowId when conversation key matches', () => {
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'present', rowId: 7 }]);
      expect(view(coord).rowIdFor('present')).toBe(7);
      coord.shutdown();
    });

    it('tokenGrowth returns 0 when no active session row matches the conversation key', async () => {
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'other', rowId: 1 }]);
      // Snapshot mock returns a non-zero value but the closure should return 0
      // BEFORE consulting it (rowId lookup short-circuits).
      mockGetSessionTokenSnapshot.mockReturnValue({
        totalInputTokens: 9_999,
        totalOutputTokens: 9_999,
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 0,
        lastCompactOutputTokens: 0,
        lastCompactCacheReadTokens: 0,
      });
      const runner = view(coord).runner;
      expect(runner).not.toBeNull();
      // Persist mock must be untouched — growth=0 means the gate denies the distill.
      await runner!.tickConversation('absent-chat');
      expect(mockUpsertHandoffArtifact).not.toHaveBeenCalled();
      coord.shutdown();
    });

    it('tokenGrowth returns 0 when the snapshot is null (row gone between list+lookup)', async () => {
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'present', rowId: 1 }]);
      mockGetSessionTokenSnapshot.mockReturnValue(null);
      const runner = view(coord).runner;
      await runner!.tickConversation('present');
      expect(mockUpsertHandoffArtifact).not.toHaveBeenCalled();
      coord.shutdown();
    });

    it('tokenGrowth returns the positive since-compact delta (input + output)', async () => {
      // Drive a real distill so the artifact write is observable — growth must
      // exceed the threshold for the gate to admit the call. The threshold is
      // resolved at module load (default 4000), so use a sinceCompact value
      // comfortably above that floor: (10_000 - 0) + (10_000 - 0) = 20_000.
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }]);
      mockGetSessionTokenSnapshot.mockReturnValue({
        totalInputTokens: 10_000,
        totalOutputTokens: 10_000,
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 0,
        lastCompactOutputTokens: 0,
        lastCompactCacheReadTokens: 0,
      });
      const distillRun = vi.fn(async () => ({ summary: 's', seededArtifacts: null, tokensUsed: 1 }));
      mockBuildHandoffDistill.mockReturnValue(distillRun);

      const runner = view(coord).runner;
      await runner!.tickConversation('c1');
      expect(mockBuildHandoffDistill).toHaveBeenCalledTimes(1);
      expect(mockUpsertHandoffArtifact).toHaveBeenCalledTimes(1);
      // The conversation-key passed into the closure must match.
      const args = mockBuildHandoffDistill.mock.calls[0]?.[0] as { conversationKey: string; verbatimN: number; redact: (t: string) => string };
      expect(args.conversationKey).toBe('c1');
      // verbatimN is forwarded from the resolved config (default 40).
      expect(args.verbatimN).toBe(40);
      expect(typeof args.redact).toBe('function');
      coord.shutdown();
    });

    it('tokenGrowth clamps a negative since-compact delta to 0 (compaction baseline ahead)', async () => {
      // total < lastCompact would normally produce a negative number; Math.max
      // guards the gate from a spurious distill after a recompute. With a 0
      // growth, the gate denies the call and the LLM is not invoked.
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }]);
      mockGetSessionTokenSnapshot.mockReturnValue({
        totalInputTokens: 50,
        totalOutputTokens: 50,
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 100,
        lastCompactOutputTokens: 100,
        lastCompactCacheReadTokens: 0,
      });
      const runner = view(coord).runner;
      await runner!.tickConversation('c1');
      expect(mockBuildHandoffDistill).not.toHaveBeenCalled();
      expect(mockUpsertHandoffArtifact).not.toHaveBeenCalled();
      coord.shutdown();
    });

    it('#1774: tokenGrowth eligibility ignores total_cache_read_tokens — a huge cache re-read does not falsely admit a distill', async () => {
      // Deliberately NOT compensated (contrast with maybeStartAutoCompact in
      // runtime.ts, which does combine total_input_tokens with
      // total_cache_read_tokens): genuinely-new input is the better
      // handoff-distill eligibility signal than repeated re-reads of the same
      // prior context. If tokenGrowth ever regressed to reading
      // total_cache_read_tokens too, this session's growth would balloon past
      // the (default 4000) threshold and wrongly trigger a distill.
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }]);
      mockGetSessionTokenSnapshot.mockReturnValue({
        totalInputTokens: 100,
        totalOutputTokens: 100,
        totalCacheReadTokens: 1_000_000,
        lastCompactInputTokens: 0,
        lastCompactOutputTokens: 0,
        lastCompactCacheReadTokens: 0,
      });
      const runner = view(coord).runner;
      await runner!.tickConversation('c1');
      // sinceCompact = (100 - 0) + (100 - 0) = 200, well under the threshold —
      // the 1,000,000 cache-read figure must play no part in this decision.
      expect(mockBuildHandoffDistill).not.toHaveBeenCalled();
      expect(mockUpsertHandoffArtifact).not.toHaveBeenCalled();
      coord.shutdown();
    });
  });

  // ─── buildRunner() distillFor closure ───────────────────────────────────

  describe('buildRunner() distillFor closure', () => {
    it('forwards a non-null seededArtifacts value verbatim', async () => {
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }]);
      mockGetSessionTokenSnapshot.mockReturnValue({
        totalInputTokens: 10_000,
        totalOutputTokens: 10_000,
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 0,
        lastCompactOutputTokens: 0,
        lastCompactCacheReadTokens: 0,
      });
      const distillRun = vi.fn(async () => ({
        summary: 's',
        seededArtifacts: 'open PRs: #42',
        tokensUsed: 5,
      }));
      mockBuildHandoffDistill.mockReturnValue(distillRun);

      const runner = view(coord).runner;
      await runner!.tickConversation('c1');

      const persisted = mockUpsertHandoffArtifact.mock.calls[0]?.[1] as { seededArtifacts: string | null };
      expect(persisted.seededArtifacts).toBe('open PRs: #42');
      coord.shutdown();
    });

    it('normalises a missing seededArtifacts (undefined) to null on the persisted artifact', async () => {
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }]);
      mockGetSessionTokenSnapshot.mockReturnValue({
        totalInputTokens: 10_000,
        totalOutputTokens: 10_000,
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 0,
        lastCompactOutputTokens: 0,
        lastCompactCacheReadTokens: 0,
      });
      // Note: seededArtifacts is intentionally omitted from the return.
      const distillRun = vi.fn(async () => ({ summary: 's', tokensUsed: 5 }));
      mockBuildHandoffDistill.mockReturnValue(distillRun);

      const runner = view(coord).runner;
      await runner!.tickConversation('c1');

      const persisted = mockUpsertHandoffArtifact.mock.calls[0]?.[1] as { seededArtifacts: string | null };
      expect(persisted.seededArtifacts).toBeNull();
      coord.shutdown();
    });

    it('forwards model + endpoint + apiKey from the resolved provider to buildHandoffDistill', async () => {
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }]);
      mockGetSessionTokenSnapshot.mockReturnValue({
        totalInputTokens: 10_000,
        totalOutputTokens: 10_000,
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 0,
        lastCompactOutputTokens: 0,
        lastCompactCacheReadTokens: 0,
      });
      const distillRun = vi.fn(async () => ({ summary: 's', seededArtifacts: null, tokensUsed: 5 }));
      mockBuildHandoffDistill.mockReturnValue(distillRun);

      const runner = view(coord).runner;
      await runner!.tickConversation('c1');

      const args = mockBuildHandoffDistill.mock.calls[0]?.[0] as {
        model: string;
        apiKey: string;
        endpoint: string;
        loadMessages: () => unknown[];
        redact: (t: string) => string;
      };
      expect(args.model).toBe('deepseek-chat');
      expect(args.apiKey).toBe('sk-test-key');
      expect(args.endpoint).toBe('https://api.deepseek.com/chat/completions');
      // loadMessages is the closure bound to the live db — invoke it to confirm
      // the redaction pipeline composes against getRecentMessages.
      mockGetRecentMessages.mockReturnValue([
        { senderName: 'A', isFromMe: false, content: 'hi' } as never,
        { senderName: 'B', isFromMe: true, content: 'hello' } as never,
      ]);
      const out = args.loadMessages();
      expect(out).toHaveLength(2);
      // The redact closure is wired through to redactHandoffPii — drive it
      // so the line 135 closure body is counted as covered.
      expect(args.redact('plain text')).toBe('plain text');
      expect(args.redact('call +14155550123 now')).toContain('[REDACTED_PHONE]');
      coord.shutdown();
    });

    it('routes a thrown distill through the onDegraded wrapper (line 148 wiring)', async () => {
      // Cover the onDegraded arrow body in buildRunner by letting a real
      // distill throw — runHandoffDistill catches the error and fires
      // onDegraded(reason) → coordinator.onDegraded → emitAlertChecked.
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }]);
      mockGetSessionTokenSnapshot.mockReturnValue({
        totalInputTokens: 10_000,
        totalOutputTokens: 10_000,
        totalCacheReadTokens: 0,
        lastCompactInputTokens: 0,
        lastCompactOutputTokens: 0,
        lastCompactCacheReadTokens: 0,
      });
      const distillRun = vi.fn(async () => {
        throw new Error('upstream model exploded');
      });
      mockBuildHandoffDistill.mockReturnValue(distillRun);

      const runner = view(coord).runner;
      await runner!.tickConversation('c1');

      // The runner folded the error → onDegraded fired → emitAlertChecked
      // observed. Persist must NOT have run (failed distill = no artifact).
      expect(mockUpsertHandoffArtifact).not.toHaveBeenCalled();
      expect(mockEmitAlertChecked).toHaveBeenCalledTimes(1);
      const calls = mockEmitAlertChecked.mock.calls as unknown as Array<[string, string, string, string, string]>;
      const summary = calls[0]?.[2];
      expect(summary).toBe('Handoff distiller degraded');
      coord.shutdown();
    });
  });

  // ─── sweep() ───────────────────────────────────────────────────────────

  describe('sweep()', () => {
    it('does nothing when the runner is null (degenerate re-entrancy guard)', async () => {
      const coord = new HandoffDistillCoordinator({
        db: makeDb(),
        instanceName: 'test',
        isEnabled: () => false,
        getModel: () => 'deepseek-chat',
      });
      // runner is null; sweep() should early-return without throwing and
      // without consulting the session-db mock.
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }]);
      await expect(view(coord).sweep()).resolves.toBeUndefined();
      expect(mockListActiveSessionRows).not.toHaveBeenCalled();
    });

    it('iterates all active conversation keys, dedups repeats, and prunes the runner', async () => {
      const coord = armWithMockRunner();
      // Two rows map to the same conversation key — the second is a dedup hit.
      mockListActiveSessionRows.mockReturnValue([
        { conversationKey: 'c1', rowId: 1 },
        { conversationKey: 'c1', rowId: 2 }, // duplicate key, different row
        { conversationKey: 'c2', rowId: 3 },
      ]);
      mockGetSessionTokenSnapshot.mockReturnValue(null);
      const runner = view(coord).runner;
      // Spy on the runner's tickConversation + prune without replacing them.
      const tickSpy = vi.spyOn(runner!, 'tickConversation');
      const pruneSpy = vi.spyOn(runner!, 'prune');

      await view(coord).sweep();

      // 2 unique conversation keys → 2 tick calls (duplicate 'c1' is folded).
      expect(tickSpy).toHaveBeenCalledTimes(2);
      expect(tickSpy).toHaveBeenCalledWith('c1');
      expect(tickSpy).toHaveBeenCalledWith('c2');
      // Prune receives exactly the deduped set.
      expect(pruneSpy).toHaveBeenCalledTimes(1);
      const seen = pruneSpy.mock.calls[0]?.[0] as Set<string>;
      expect(seen).toEqual(new Set(['c1', 'c2']));
      // "sweep complete" log fires with the deduped count.
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ instance: 'test', ticked: 2 }),
        expect.stringContaining('sweep complete'),
      );
      tickSpy.mockRestore();
      pruneSpy.mockRestore();
      coord.shutdown();
    });

    it('folds a per-tick error and continues the sweep (warn log, no re-throw)', async () => {
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([
        { conversationKey: 'c-bad', rowId: 1 },
        { conversationKey: 'c-good', rowId: 2 },
      ]);
      mockGetSessionTokenSnapshot.mockReturnValue(null);
      const runner = view(coord).runner;
      // First call rejects; second resolves (so the sweep completes).
      const tickSpy = vi
        .spyOn(runner!, 'tickConversation')
        .mockRejectedValueOnce(new Error('runner tick failed'))
        .mockResolvedValueOnce(undefined);

      await expect(view(coord).sweep()).resolves.toBeUndefined();

      expect(tickSpy).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ instance: 'test', conversationKey: 'c-bad', err: 'runner tick failed' }),
        expect.stringContaining('tick failed'),
      );
      // Sweep still completes — the dedup set is computed even when one tick threw.
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ ticked: 2 }),
        expect.stringContaining('sweep complete'),
      );
      tickSpy.mockRestore();
      coord.shutdown();
    });

    it('folds an Error instance with `message` into the warn-log err field', async () => {
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }]);
      mockGetSessionTokenSnapshot.mockReturnValue(null);
      const runner = view(coord).runner;
      vi.spyOn(runner!, 'tickConversation').mockRejectedValueOnce(new Error('boom: model down'));

      await view(coord).sweep();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'boom: model down' }),
        expect.any(String),
      );
      coord.shutdown();
    });

    it('folds a non-Error rejection with String()-coerced err into the warn-log', async () => {
      const coord = armWithMockRunner();
      mockListActiveSessionRows.mockReturnValue([{ conversationKey: 'c1', rowId: 1 }]);
      mockGetSessionTokenSnapshot.mockReturnValue(null);
      const runner = view(coord).runner;
      // A non-Error rejection: a bare string.
      vi.spyOn(runner!, 'tickConversation').mockRejectedValueOnce('string-rejection');

      await view(coord).sweep();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'string-rejection' }),
        expect.any(String),
      );
      coord.shutdown();
    });

    it('swallows an enumeration failure without re-throwing (outer catch + warn)', async () => {
      const coord = armWithMockRunner();
      // Outer try only fires on a synchronous throw from the loop setup itself.
      // listActiveSessionRows is the most realistic throw site (DB down).
      mockListActiveSessionRows.mockImplementation(() => {
        throw new Error('db is gone');
      });

      await expect(view(coord).sweep()).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ instance: 'test', err: 'db is gone' }),
        expect.stringContaining('sweep failed'),
      );
      coord.shutdown();
    });

    it('outer-catch warns with String(err) when the synchronous throw is not an Error', async () => {
      const coord = armWithMockRunner();
      // A non-Error synchronous throw — exercises the String(err) branch of
      // the outer sweep's `err instanceof Error ? err.message : String(err)`.
      // Wrap the throw in a helper that explicitly types the param as `unknown`
      // so the cast remains auditable in the test.
      const nonErrorThrower = (): Array<{ conversationKey: string; rowId: number }> => {
        const e: unknown = 'db blew up (non-Error)';
        throw e;
      };
      mockListActiveSessionRows.mockImplementation(nonErrorThrower);

      await expect(view(coord).sweep()).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ instance: 'test', err: 'db blew up (non-Error)' }),
        expect.stringContaining('sweep failed'),
      );
      coord.shutdown();
    });
  });

  // ─── onDegraded() ───────────────────────────────────────────────────────

  describe('onDegraded()', () => {
    it('emits an alert with the redacted reason and severity=warning', () => {
      const coord = armWithMockRunner();
      // Bearer token + email + phone must be redacted before the alert leaves
      // the process — the body must not contain the literal token or email.
      const secret = 'tokFAKE1234567890abcd';
      const reason = `upstream failed: Bearer ${secret} from user@users.noreply.github.com about +14155550123`;
      view(coord).onDegraded('c1', reason);

      expect(mockEmitAlertChecked).toHaveBeenCalledTimes(1);
      const calls = mockEmitAlertChecked.mock.calls as unknown as Array<[string, string, string, string, string]>;
      const [instance, source, summary, evidence, severity] = calls[0] as [string, string, string, string, string];
      expect(instance).toBe('test');
      expect(source).toBe('handoff-distill:test');
      expect(summary).toBe('Handoff distiller degraded');
      expect(severity).toBe('warning');
      expect(evidence).toContain('conversation: c1');
      expect(evidence).toContain('reason:');
      // Reason body must have been redacted — the literal token / email
      // must not survive into the evidence blob.
      expect(evidence).not.toContain(secret);
      expect(evidence).not.toContain('user@users.noreply.github.com');
      expect(evidence).toContain('Bearer [REDACTED]');
      coord.shutdown();
    });

    it('truncates the redacted reason to <=200 characters', () => {
      const coord = armWithMockRunner();
      const longReason = 'a'.repeat(500);
      view(coord).onDegraded('c1', longReason);
      const calls = mockEmitAlertChecked.mock.calls as unknown as Array<[string, string, string, string, string]>;
      const evidence = calls[0]?.[3] ?? '';
      // Extract the `reason: …` payload (last line) and check its length.
      const reasonLine = evidence.split('\n').find((l) => l.startsWith('reason: ')) ?? '';
      const reasonValue = reasonLine.slice('reason: '.length);
      expect(reasonValue.length).toBeLessThanOrEqual(200);
      coord.shutdown();
    });

    it('swallows an alert-emit failure and logs a warn (no re-throw)', () => {
      const coord = armWithMockRunner();
      mockEmitAlertChecked.mockImplementation(() => {
        throw new Error('outbox down');
      });
      expect(() => view(coord).onDegraded('c1', 'reason x')).not.toThrow();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ instance: 'test', conversationKey: 'c1', err: 'outbox down' }),
        expect.stringContaining('failed to emit'),
      );
      coord.shutdown();
    });

    it('swallowed-alert warn uses String(err) when the emit throws a non-Error', () => {
      const coord = armWithMockRunner();
      // The emit failure is a string (non-Error) — the inner catch's
      // `err instanceof Error ? err.message : String(err)` ternary takes the
      // String() branch.
      const thrower = (): boolean => {
        const e: unknown = 'outbox down (non-Error)';
        throw e;
      };
      mockEmitAlertChecked.mockImplementation(thrower);
      expect(() => view(coord).onDegraded('c1', 'reason x')).not.toThrow();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ instance: 'test', conversationKey: 'c1', err: 'outbox down (non-Error)' }),
        expect.stringContaining('failed to emit'),
      );
      coord.shutdown();
    });
  });
});
