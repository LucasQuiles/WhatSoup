// Fail-loud precondition for the silent provider-limit non-rollover failure class:
// a single-auth-surface (*-cli) primary with no INDEPENDENT fallback target.
// See docs/specs/2026-06-16-terminal-limit-fallback-failure-class.md (defect D).
import { describe, expect, it } from 'vitest';

import { lacksIndependentFallback } from '../../src/core/fallback-chain.ts';

describe('lacksIndependentFallback', () => {
  it('flags the exact mini8 shape: claude-cli primary with an empty chain', () => {
    expect(lacksIndependentFallback('claude-cli', [])).toBe(true);
  });

  it('flags a chain that only repeats the primary provider (no independence)', () => {
    expect(lacksIndependentFallback('claude-cli', [{ provider: 'claude-cli', model: 'opus' }])).toBe(true);
  });

  it('passes when an independent fallback provider is present', () => {
    expect(lacksIndependentFallback('claude-cli', [{ provider: 'opencode-cli' }])).toBe(false);
    expect(lacksIndependentFallback('claude-cli', [
      { provider: 'claude-cli', model: 'sonnet' },
      { provider: 'codex-cli' },
    ])).toBe(false);
  });

  it('applies to every *-cli subscription primary', () => {
    expect(lacksIndependentFallback('opencode-cli', [])).toBe(true);
    expect(lacksIndependentFallback('codex-cli', [{ provider: 'codex-cli' }])).toBe(true);
  });

  it('does not flag API-keyed primaries (own billing surface, not session-limited)', () => {
    expect(lacksIndependentFallback('openai-api', [])).toBe(false);
    expect(lacksIndependentFallback('anthropic-api', [])).toBe(false);
  });

  it('defaults a missing primary to claude-cli (the platform default)', () => {
    expect(lacksIndependentFallback(null, [])).toBe(true);
    expect(lacksIndependentFallback(undefined, [{ provider: 'opencode-cli' }])).toBe(false);
  });
});
