import { describe, expect, it } from 'vitest';

import {
  classifyProviderFailure,
  providerFailureArmsFallback,
  type ProviderFailureKind,
} from '../../../src/runtimes/agent/failure-taxonomy.ts';

// PR-A-P1: the central provider-failure classifier is the single source of truth
// for recognising terminal provider/CLI failure strings. It is pure text matching;
// the "unknown-terminal" default-deny decision lives in the result handler (PR-A-P2),
// because only the result handler knows the event was an is_error result.

describe('classifyProviderFailure — known failure patterns', () => {
  const cases: Array<{ name: string; text: string; kind: ProviderFailureKind }> = [
    { name: 'usage limit reached', text: 'Claude usage limit reached. Resets at 3pm.', kind: 'usage-limit' },
    { name: 'out of extra usage', text: 'You are out of extra usage for now.', kind: 'usage-limit' },
    { name: 'credit balance exhausted', text: 'Provider error: insufficient credits. Please add credits to continue.', kind: 'usage-limit' },
    { name: 'account balance exhausted', text: 'Provider billing error: your account balance is too low to complete this request.', kind: 'usage-limit' },
    { name: 'api insufficient quota code', text: 'Error code: insufficient_quota. You exceeded your current quota, please check your billing details.', kind: 'usage-limit' },
    { name: 'auth: not logged in', text: 'Not logged in · Please run /login', kind: 'auth-required' },
    { name: 'auth: invalid api key', text: 'Error: invalid API key provided', kind: 'auth-required' },
    { name: 'rate limit', text: 'Provider rate limited, please slow down', kind: 'rate-limit' },
    { name: 'rate limit 429', text: 'HTTP 429 too many requests', kind: 'rate-limit' },
    { name: 'policy block', text: 'This request violates our policy.', kind: 'policy-block' },
    { name: 'context overflow', text: 'Error: prompt is too long for the context window', kind: 'context-overflow' },
    {
      name: 'model-unavailable (incident shape, synthetic model)',
      text: "There's an issue with the selected model (inaccessible-model-for-test). It may not exist or you may not have access to it. Run --model to pick a different model.",
      kind: 'model-unavailable',
    },
    {
      name: 'model-unavailable (api phrasing)',
      text: 'The model inaccessible-model-for-test does not exist or you do not have access to it.',
      kind: 'model-unavailable',
    },
    {
      name: 'model-unavailable (opencode catalog)',
      text: 'fallback model not found in provider catalog',
      kind: 'model-unavailable',
    },
  ];

  for (const c of cases) {
    it(`classifies ${c.name} → ${c.kind}`, () => {
      expect(classifyProviderFailure(c.text)).toBe(c.kind);
    });
  }
});

describe('classifyProviderFailure — precedence preserves origin/main semantics', () => {
  it('prompt-too-long is context-overflow, NOT usage-limit (mirrors isUsageLimitMessage guard)', () => {
    // origin/main: isUsageLimitMessage returns false when isPromptTooLongMessage is true.
    expect(classifyProviderFailure('maximum context length exceeded — token limit exceeded')).toBe('context-overflow');
  });

  it('usage-limit wins over rate-limit when both cues present (mirrors isRateLimitResultMessage exclusion)', () => {
    // origin/main: isRateLimitResultMessage excludes usage-limit messages.
    expect(classifyProviderFailure('Claude usage limit reached; 429 too many requests')).toBe('usage-limit');
  });
});

describe('classifyProviderFailure — negative cases (no false positives)', () => {
  it('genuine assistant prose mentioning a missing model is NOT a failure', () => {
    expect(
      classifyProviderFailure(
        "I looked but couldn't find a model called foo in the documentation — want me to search elsewhere?",
      ),
    ).toBeNull();
  });

  it('ordinary reply text is not a failure', () => {
    expect(classifyProviderFailure('Sure — I sent the message and updated the sheet.')).toBeNull();
  });

  it('ordinary financial prose is not a provider credit failure', () => {
    expect(
      classifyProviderFailure('The customer has a low balance, but their credit account is still active.'),
    ).toBeNull();
    expect(classifyProviderFailure('Your account balance is too low to complete this transfer.')).toBeNull();
    expect(classifyProviderFailure('The student has insufficient credits to graduate this semester.')).toBeNull();
    expect(classifyProviderFailure("Error: the student's transcript shows insufficient credits to graduate.")).toBeNull();
  });

  it('empty text is not a failure', () => {
    expect(classifyProviderFailure('')).toBeNull();
  });
});

describe('providerFailureArmsFallback — which kinds activate provider fallback', () => {
  it('usage/rate/auth/model-unavailable arm fallback', () => {
    for (const k of ['usage-limit', 'rate-limit', 'auth-required', 'model-unavailable'] as ProviderFailureKind[]) {
      expect(providerFailureArmsFallback(k)).toBe(true);
    }
  });

  it('policy-block and context-overflow do NOT arm fallback (suppress-only, mirrors origin/main)', () => {
    for (const k of ['policy-block', 'context-overflow'] as ProviderFailureKind[]) {
      expect(providerFailureArmsFallback(k)).toBe(false);
    }
  });

  it('transient-network does NOT arm fallback (recoverable — next message respawns session)', () => {
    expect(providerFailureArmsFallback('transient-network')).toBe(false);
  });
});

describe('classifyProviderFailure — transient-network', () => {
  it('classifies socket-close text as transient-network', () => {
    expect(classifyProviderFailure(
      'API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
    )).toBe('transient-network');
  });

  it('classifies ECONNRESET as transient-network', () => {
    expect(classifyProviderFailure('Error: read ECONNRESET')).toBe('transient-network');
  });

  it('classifies socket hang up as transient-network', () => {
    expect(classifyProviderFailure('socket hang up')).toBe('transient-network');
  });

  it('classifies connection reset by peer as transient-network', () => {
    expect(classifyProviderFailure('connection reset by peer')).toBe('transient-network');
  });

  it('does NOT classify benign documentation prose about sockets as transient-network', () => {
    expect(classifyProviderFailure('Please document how socket timeouts and connection resets are handled.')).toBeNull();
  });
});
