/**
 * Direct unit coverage for src/runtimes/agent/providers/budget.ts.
 *
 * ProviderBudget enforces per-provider rate limits across 4 dimensions:
 *   - requestsPerMinute (with pessimistic in-flight tracking)
 *   - tokensPerMinute
 *   - dailySpendCapUsd (estimated from token counts)
 *   - chatBurstLimit (per-chat requests/minute)
 *
 * Plus a daily-reset mechanism that fires automatically at midnight.
 *
 * Tests use vi.useFakeTimers + vi.setSystemTime to control the sliding-
 * window clock without real wall-time delays.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ProviderBudget } from '../../../../src/runtimes/agent/providers/budget.ts';

describe('ProviderBudget — no-config defaults', () => {
  it('allows any request when no limits are configured', () => {
    const budget = new ProviderBudget('test-provider', {});
    expect(budget.checkBudget()).toEqual({ allowed: true });
  });

  it('records usage without throwing when no limits are configured', () => {
    const budget = new ProviderBudget('test-provider', {});
    expect(() => budget.recordUsage({ input: 100, output: 50 })).not.toThrow();
  });
});

describe('ProviderBudget — requestsPerMinute limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('allows requests up to the limit then rejects', () => {
    const budget = new ProviderBudget('p', { requestsPerMinute: 3 });
    expect(budget.checkBudget().allowed).toBe(true);
    expect(budget.checkBudget().allowed).toBe(true);
    expect(budget.checkBudget().allowed).toBe(true);
    const result = budget.checkBudget();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('3 req/min for p');
  });

  it('pessimistic counting: pending requests count toward the limit', () => {
    // checkBudget reserves a pending slot when allowed AND requestsPerMinute set.
    // 2 sequential checkBudget calls without recordUsage produce 2 pendings.
    const budget = new ProviderBudget('p', { requestsPerMinute: 2 });
    expect(budget.checkBudget().allowed).toBe(true);
    expect(budget.checkBudget().allowed).toBe(true);
    // Third must be denied even though no recordUsage has fired
    expect(budget.checkBudget().allowed).toBe(false);
  });

  it('recordUsage decrements pending and adds to the request window', () => {
    const budget = new ProviderBudget('p', { requestsPerMinute: 1 });
    expect(budget.checkBudget().allowed).toBe(true); // pending=1
    expect(budget.checkBudget().allowed).toBe(false); // pending blocks
    budget.recordUsage({ input: 10, output: 5 }); // pending=0, requestWindow=1
    expect(budget.checkBudget().allowed).toBe(false); // window now blocks
  });

  it('cancelPending decrements pending without recording usage', () => {
    const budget = new ProviderBudget('p', { requestsPerMinute: 1 });
    expect(budget.checkBudget().allowed).toBe(true);
    expect(budget.checkBudget().allowed).toBe(false);
    budget.cancelPending();
    // After cancel, a fresh request should now be allowed
    expect(budget.checkBudget().allowed).toBe(true);
  });

  it('clamps an impossible negative pending count before enforcing limits', () => {
    const budget = new ProviderBudget('p', { requestsPerMinute: 1 });
    const internals = budget as unknown as { pendingRequests: number };
    internals.pendingRequests = -1;

    expect(budget.checkBudget().allowed).toBe(true);
    expect(internals.pendingRequests).toBe(1);
    expect(budget.checkBudget().allowed).toBe(false);
  });

  it('prunes window entries older than 60 seconds', () => {
    const budget = new ProviderBudget('p', { requestsPerMinute: 2 });
    budget.recordUsage({ input: 1, output: 0 });
    budget.recordUsage({ input: 1, output: 0 });
    expect(budget.checkBudget().allowed).toBe(false);
    // Advance past the 60s window
    vi.setSystemTime(new Date('2026-05-12T12:01:01Z'));
    expect(budget.checkBudget().allowed).toBe(true);
  });
});

describe('ProviderBudget — tokensPerMinute limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('blocks when accumulated tokens in the window reach the limit', () => {
    const budget = new ProviderBudget('p', { tokensPerMinute: 100 });
    budget.recordUsage({ input: 50, output: 30 }); // 80
    expect(budget.checkBudget().allowed).toBe(true);
    budget.recordUsage({ input: 15, output: 5 }); // 80+20 = 100
    const r = budget.checkBudget();
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('100 tokens/min');
  });

  it('omits input/output gracefully (treats as 0)', () => {
    const budget = new ProviderBudget('p', { tokensPerMinute: 100 });
    budget.recordUsage({}); // 0 tokens
    expect(budget.checkBudget().allowed).toBe(true);
  });
});

describe('ProviderBudget — dailySpendCapUsd limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('blocks when daily token spend reaches the cap at the configured rate', () => {
    const budget = new ProviderBudget('p', {
      dailySpendCapUsd: 1, // $1 cap
      costPerMillionTokens: 10, // $10 per 1M = $0.00001 per token
    });
    // Need 100_000 tokens to hit $1
    budget.recordUsage({ input: 100_000, output: 0 });
    const r = budget.checkBudget();
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('Daily spend cap: $1');
  });

  it('uses default $3/million rate when costPerMillionTokens is omitted', () => {
    const budget = new ProviderBudget('p', { dailySpendCapUsd: 3 });
    // At $3/M, need 1M tokens for $3
    budget.recordUsage({ input: 1_000_000, output: 0 });
    expect(budget.checkBudget().allowed).toBe(false);
  });
});

describe('ProviderBudget — chatBurstLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('counts chat-scoped requests independently per chat', () => {
    const budget = new ProviderBudget('p', { chatBurstLimit: 2 });
    budget.recordUsage({ input: 1, output: 0 }, 'chat-a');
    budget.recordUsage({ input: 1, output: 0 }, 'chat-a');
    // chat-a is at limit; chat-b is empty
    expect(budget.checkBudget('chat-a').allowed).toBe(false);
    expect(budget.checkBudget('chat-b').allowed).toBe(true);
  });

  it('chat tracking is opt-in: requests without chatId do not count against any chat', () => {
    const budget = new ProviderBudget('p', { chatBurstLimit: 1 });
    budget.recordUsage({ input: 1, output: 0 }); // no chatId
    expect(budget.checkBudget('chat-a').allowed).toBe(true);
  });
});

describe('ProviderBudget.getSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('returns the canonical snapshot shape with current values', () => {
    const budget = new ProviderBudget('p', { tokensPerMinute: 1000 });
    budget.recordUsage({ input: 50, output: 50 });
    budget.recordUsage({ input: 100, output: 100 });
    const snap = budget.getSnapshot();
    expect(snap.requestsLastMinute).toBe(2);
    expect(snap.tokensLastMinute).toBe(300);
    expect(snap.isThrottled).toBe(false);
    expect(snap.throttleReason).toBeNull();
    expect(typeof snap.estimatedDailySpendUsd).toBe('number');
  });

  it('snapshot reports isThrottled=true with throttleReason populated when over limit', () => {
    const budget = new ProviderBudget('p', { tokensPerMinute: 10 });
    budget.recordUsage({ input: 6, output: 5 }); // 11 > 10
    const snap = budget.getSnapshot();
    expect(snap.isThrottled).toBe(true);
    expect(snap.throttleReason).toContain('10 tokens/min');
  });

  it('getSnapshot does NOT increment pendingRequests (uses peek mode)', () => {
    const budget = new ProviderBudget('p', { requestsPerMinute: 1 });
    // First call to getSnapshot must not consume the single allowed slot.
    budget.getSnapshot();
    expect(budget.checkBudget().allowed).toBe(true);
  });
});

describe('ProviderBudget.resetDaily', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('resetDaily() zeroes the dailyTokens counter (frees spend-cap allowance)', () => {
    const budget = new ProviderBudget('p', {
      dailySpendCapUsd: 1,
      costPerMillionTokens: 10,
    });
    budget.recordUsage({ input: 100_000, output: 0 });
    expect(budget.checkBudget().allowed).toBe(false);
    budget.resetDaily();
    expect(budget.checkBudget().allowed).toBe(true);
  });

  it('automatically resets daily spend after the reset time passes', () => {
    const budget = new ProviderBudget('p', {
      dailySpendCapUsd: 1,
      costPerMillionTokens: 10,
    });
    const internals = budget as unknown as { dailyResetTime: number };
    budget.recordUsage({ input: 100_000, output: 0 });
    expect(budget.checkBudget().allowed).toBe(false);

    internals.dailyResetTime = Date.now() - 1;

    expect(budget.checkBudget().allowed).toBe(true);
    expect(budget.getSnapshot().estimatedDailySpendUsd).toBe(0);
  });
});
