import { describe, expect, it } from 'vitest';

import {
  EXPECTED_PROTECTION_PATH,
  diffProtection,
  loadExpectedProtection,
  parseObservedProtection,
  summarize,
  type ObservedProtection,
} from '../../scripts/branch-protection-drift-guard.ts';

/**
 * R-02 (required approving review on `main`) was applied by hand through the GitHub API.
 * Nothing detected it being turned off again — a setting that protects every merge was
 * itself unprotected. This comparator closes that: the expected shape is committed, so a
 * silent console change becomes a diff someone has to explain.
 *
 * The comparator is pure so it is testable without a token; the CLI feeds it whatever
 * `gh api .../branches/main/protection` returned.
 */
function observed(overrides: Record<string, unknown> = {}): ObservedProtection {
  return {
    required_status_checks: { strict: true, contexts: ['CodeQL', 'quality (24.x)', 'quality (25.x)'] },
    required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true },
    enforce_admins: false,
    allow_force_pushes: false,
    allow_deletions: false,
    required_linear_history: false,
    required_conversation_resolution: false,
    ...overrides,
  } as ObservedProtection;
}

describe('branch-protection-drift-guard — diffProtection', () => {
  it('reports no drift when observed matches the committed expectation', () => {
    const expected = loadExpectedProtection();
    expect(diffProtection(expected, observed())).toEqual([]);
  });

  it('detects a dropped required status check (the R-02 regression that matters most)', () => {
    const expected = loadExpectedProtection();
    const findings = diffProtection(
      expected,
      observed({ required_status_checks: { strict: true, contexts: ['CodeQL', 'quality (24.x)'] } }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].field).toBe('required_status_checks.contexts');
    expect(findings[0].detail).toContain('quality (25.x)');
  });

  it('detects required approvals being lowered to zero', () => {
    const expected = loadExpectedProtection();
    const findings = diffProtection(
      expected,
      observed({ required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: true } }),
    );
    expect(findings.map((f) => f.field)).toContain(
      'required_pull_request_reviews.required_approving_review_count',
    );
  });

  it('detects force-push or deletion being re-enabled', () => {
    const expected = loadExpectedProtection();
    const fields = diffProtection(expected, observed({ allow_force_pushes: true, allow_deletions: true })).map(
      (f) => f.field,
    );
    expect(fields).toContain('allow_force_pushes');
    expect(fields).toContain('allow_deletions');
  });

  it('reports an ADDED required check as drift too, not silently', () => {
    // Drift is any divergence from the recorded intent. An extra required check is a
    // change someone made without updating the expectation; it may be fine, but it must
    // be explained rather than absorbed.
    const expected = loadExpectedProtection();
    const findings = diffProtection(
      expected,
      observed({ required_status_checks: { strict: true, contexts: ['CodeQL', 'quality (24.x)', 'quality (25.x)', 'new-gate'] } }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toContain('new-gate');
  });

  it('is order-insensitive for contexts', () => {
    const expected = loadExpectedProtection();
    const findings = diffProtection(
      expected,
      observed({ required_status_checks: { strict: true, contexts: ['quality (25.x)', 'CodeQL', 'quality (24.x)'] } }),
    );
    expect(findings).toEqual([]);
  });
});

describe('branch-protection-drift-guard — fail-closed input handling', () => {
  it('treats absent observed input as INCONCLUSIVE, never as no drift', () => {
    // The whole failure mode this guard exists for is "the setting quietly went away".
    // A guard that reads nothing and prints "no drift" would be the same bug one level up.
    expect(() => parseObservedProtection('')).toThrow(/empty|no observed|inconclusive/i);
  });

  it('treats unparseable observed input as INCONCLUSIVE', () => {
    expect(() => parseObservedProtection('not json at all')).toThrow(/parse|invalid|inconclusive/i);
  });

  it('rejects a JSON payload that is missing the protection fields', () => {
    // `gh api` prints `{"message":"Not Found"}` when the token lacks admin scope. That is
    // an authorization failure wearing a 200-shaped costume, and must not read as clean.
    expect(() => parseObservedProtection('{"message":"Not Found"}')).toThrow(/missing|required_status_checks/i);
  });

  it('accepts the real GitHub payload shape', () => {
    const raw = JSON.stringify({
      required_status_checks: { strict: true, contexts: ['CodeQL'], checks: [{ context: 'CodeQL' }] },
      required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true },
      enforce_admins: { enabled: false },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      required_linear_history: { enabled: false },
      required_conversation_resolution: { enabled: false },
    });
    const parsed = parseObservedProtection(raw);
    // GitHub nests the booleans under `{enabled}`; the comparator sees plain booleans.
    expect(parsed.enforce_admins).toBe(false);
    expect(parsed.allow_force_pushes).toBe(false);
    expect(parsed.required_status_checks.contexts).toEqual(['CodeQL']);
  });
});

describe('branch-protection-drift-guard — committed expectation', () => {
  it('the expected snapshot exists and is complete', () => {
    const expected = loadExpectedProtection();
    expect(expected.required_status_checks.contexts.length).toBeGreaterThan(0);
    expect(expected.required_pull_request_reviews.required_approving_review_count).toBeGreaterThanOrEqual(1);
    expect(EXPECTED_PROTECTION_PATH).toMatch(/branch-protection-expected\.json$/);
  });

  it('records R-02 specifically — approvals required and stale reviews dismissed', () => {
    // If someone "simplifies" the snapshot, R-02 must not be what quietly disappears.
    const expected = loadExpectedProtection();
    expect(expected.required_pull_request_reviews.required_approving_review_count).toBe(1);
    expect(expected.required_pull_request_reviews.dismiss_stale_reviews).toBe(true);
    expect(expected.required_status_checks.strict).toBe(true);
  });

  it('summarize names every drifting field so the message is actionable', () => {
    const expected = loadExpectedProtection();
    const findings = diffProtection(expected, observed({ allow_force_pushes: true }));
    const text = summarize(findings);
    expect(text).toContain('allow_force_pushes');
    expect(text).toContain('expected');
  });
});
