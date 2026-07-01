/**
 * makeIdleEligibilityResolver — TTL-memoised credential-presence resolver used by
 * the idle (health-path) fallback snapshot. The underlying resolver hits the
 * keyring (a subprocess on macOS/Linux), so the /health handler must not call it
 * per entry per poll. This memoises per entry key with a TTL and a injectable
 * clock so callers get fresh-enough eligibility without per-request keyring IO.
 */
import { describe, it, expect } from 'vitest';
import { makeIdleEligibilityResolver } from '../../../src/runtimes/agent/fallback-eligibility-cache.ts';
import type { AgentFallbackEntry } from '../../../src/core/fallback-chain.ts';

const opencode: AgentFallbackEntry = { provider: 'opencode-cli', model: 'minimax/MiniMax-M2.7' };
const claude: AgentFallbackEntry = { provider: 'claude-cli', model: 'claude-sonnet-4-6' };

describe('makeIdleEligibilityResolver', () => {
  it('passes through the underlying value (true/false/null)', () => {
    const resolve = makeIdleEligibilityResolver(
      (e) => (e.provider === 'opencode-cli' ? false : null),
      () => 0,
      60_000,
    );
    expect(resolve(opencode)).toBe(false);
    expect(resolve(claude)).toBe(null);
  });

  it('memoises per entry within the TTL — underlying resolver runs once per key', () => {
    const calls: string[] = [];
    let now = 1_000;
    const resolve = makeIdleEligibilityResolver(
      (e) => {
        calls.push(`${e.provider}/${e.model ?? ''}`);
        return e.provider === 'opencode-cli' ? false : null;
      },
      () => now,
      60_000,
    );
    resolve(opencode);
    resolve(opencode);
    now = 1_000 + 59_999; // still inside TTL
    resolve(opencode);
    expect(calls).toEqual(['opencode-cli/minimax/MiniMax-M2.7']);
  });

  it('keeps separate cache slots per entry key', () => {
    const calls: string[] = [];
    const resolve = makeIdleEligibilityResolver(
      (e) => {
        calls.push(e.provider);
        return null;
      },
      () => 0,
      60_000,
    );
    resolve(opencode);
    resolve(claude);
    resolve(opencode);
    expect(calls).toEqual(['opencode-cli', 'claude-cli']);
  });

  it('re-resolves after the TTL expires', () => {
    let now = 0;
    let value: boolean | null = false;
    const calls: number[] = [];
    const resolve = makeIdleEligibilityResolver(
      () => {
        calls.push(now);
        return value;
      },
      () => now,
      60_000,
    );
    expect(resolve(opencode)).toBe(false);
    value = true; // owner provisioned the key while the process ran
    now = 60_001; // past TTL
    expect(resolve(opencode)).toBe(true);
    expect(calls).toEqual([0, 60_001]);
  });
});
