// Failure-class regression suite: "silent provider-limit non-rollover".
//
// Ground truth for the matched strings is the agent provider CLI's limit-name
// map (captured from its binary string table): the 5-hour session cap, the 7-day
// weekly cap, the per-model-tier weekly caps, and the usage-credit overage,
// assembled by `You've hit your ${name}${ · resets ...}` and `Approaching ${name}`.
//
// The production incident was the verbatim string below slipping past
// isUsageLimitMessage() because it says "session limit", not "usage limit", so the
// provider-fallback rollover never armed.
import { describe, expect, it } from 'vitest';

import {
  classifyProviderFailure,
  isUsageLimitMessage,
  providerFailureArmsFallback,
  LIMIT_NAME_TOKENS,
} from '../../../src/runtimes/agent/failure-taxonomy.ts';

const INCIDENT = "Error: Error during compaction: You've hit your session limit · resets 5pm (America/New_York)";

describe('terminal provider-limit detection (silent-non-rollover failure class)', () => {
  it('classifies the verbatim incident string as a fallback-arming usage-limit', () => {
    expect(isUsageLimitMessage(INCIDENT)).toBe(true);
    expect(classifyProviderFailure(INCIDENT)).toBe('usage-limit');
    expect(providerFailureArmsFallback('usage-limit')).toBe(true);
  });

  it('detects the full provider-CLI "You\'ve hit your <name>" limit family', () => {
    for (const name of ['session limit', 'weekly limit', 'Opus limit', 'Sonnet limit', 'usage credit limit', 'fast limit', 'monthly spend limit']) {
      expect(isUsageLimitMessage(`You've hit your ${name}`), name).toBe(true);
      expect(isUsageLimitMessage(`You've hit your ${name} · resets 5pm (America/New_York)`), name).toBe(true);
    }
  });

  it('detects "<name> reached" phrasings', () => {
    expect(isUsageLimitMessage('session limit reached')).toBe(true);
    expect(isUsageLimitMessage('usage credit limit reached')).toBe(true);
    expect(isUsageLimitMessage('weekly limit reached')).toBe(true);
  });

  it('detects credit / org-allocation exhaustion family', () => {
    // D2 dedup refactor: "You're out of usage credits" and 'Your org is out of
    // usage — add funds to continue' used to be asserted here too, byte-identical
    // to two tests/fixtures/failure-taxonomy-corpus.jsonl rows (credit-out-of-usage-credits,
    // credit-org-add-funds) consumed by failure-taxonomy.test.ts's 'failure-taxonomy
    // corpus' describe, whose per-row check asserts isUsageLimitMessage(true)
    // directly. Removed here as pure duplication, not a coverage loss. The other
    // two strings below are unique to this file and stay.
    expect(isUsageLimitMessage('You have hit your usage credit limit · resets 1:30pm (America/New_York)')).toBe(true);
    expect(isUsageLimitMessage("Your group's usage limit is set to $0")).toBe(true);
  });

  it('still matches the pre-existing usage-limit phrasings (no regression)', () => {
    expect(isUsageLimitMessage("You're out of extra usage. Claude will be available at 8pm.")).toBe(true);
    expect(isUsageLimitMessage('Quota exceeded; Claude resets at 9pm.')).toBe(true);
    expect(isUsageLimitMessage('Provider returned insufficient_quota for this API request.')).toBe(true);
  });

  it('treats "Approaching <name>" as a WARNING, not a terminal limit (no premature rollover)', () => {
    // Approaching means the provider can still serve this turn. Arming fallback here
    // would introduce a premature-rollover failure mode — deliberately excluded.
    expect(isUsageLimitMessage('Approaching session limit')).toBe(false);
    expect(isUsageLimitMessage('Approaching weekly limit · resets 9pm')).toBe(false);
    expect(classifyProviderFailure('Approaching session limit · resets 9pm')).not.toBe('usage-limit');
  });

  it('classifies the model-policy credit gate (Fable-5-only plan) as a terminal usage-limit', () => {
    // Real provider compaction error when the account plan only permits a
    // credit-gated model. Must arm fallback instead of stalling.
    expect(isUsageLimitMessage('Compaction unavailable: your model policy only allows Fable 5, which requires usage credits · /model to set it up')).toBe(true);
    expect(classifyProviderFailure('Compaction unavailable: your model policy only allows Fable 5, which requires usage credits · /model to set it up')).toBe('usage-limit');
  });

  it('still classifies a terminal message that merely contains "approaching"/"now using" in a non-warning position', () => {
    // Anchored warning guard must not swallow a genuinely-terminal message.
    expect(isUsageLimitMessage('Weekly limit approaching and now exceeded. Claude will be available at 9pm.')).toBe(true);
    expect(isUsageLimitMessage("You've hit your session limit; you're now using metered access. Resets 5pm (America/New_York)")).toBe(true);
  });

  it('does not over-trigger on conversational mentions of limits (false-positive guard)', () => {
    expect(isUsageLimitMessage('Please document how the session limit and usage limit should be handled.')).toBe(false);
    expect(isUsageLimitMessage('I hit a session limit in my game design and had to refactor.')).toBe(false);
    expect(isUsageLimitMessage('We should add a weekly limit to the rate limiter config.')).toBe(false);
  });

  it('preserves context-overflow precedence over usage-limit', () => {
    expect(classifyProviderFailure('Prompt is too long: maximum context length exceeded.')).toBe('context-overflow');
  });

  it('exposes a single SSOT limit-token registry so parsers cannot drift', () => {
    expect(Array.isArray(LIMIT_NAME_TOKENS)).toBe(true);
    for (const t of ['session limit', 'weekly limit', 'opus limit', 'sonnet limit', 'usage credit limit', 'usage limit', 'usage cap', 'plan limit']) {
      expect(LIMIT_NAME_TOKENS, t).toContain(t);
    }
  });
});
