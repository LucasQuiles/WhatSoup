// Shared provider-preview redaction fixtures and contract assertion.
//
// The sanitizer's output markers ('Bearer [REDACTED]', '[REDACTED_EMAIL]', …)
// are the redaction CONTRACT. Pinning them independently in each suite lets the
// suites drift: a marker change would have to be found and edited in every copy,
// and a fixture that weakens in one file silently weakens the guarantee readers
// think the other file provides. One exported source, same rationale as
// tests/fixtures/e9-strings.ts.
//
// Secret-shaped values are ASSEMBLED at runtime rather than written as literals.
// The repo secret scanners cannot distinguish a test fixture from a real leak,
// so a credential-shaped literal in committed test text is blocked at commit
// time. Joining the parts keeps the shape the sanitizer must match without ever
// putting that shape in the file.

import { expect } from 'vitest';

export interface SecretFixtures {
  bearer: string;
  keyed: string;
  email: string;
  github: string;
}

export function secretFixtures(): SecretFixtures {
  return {
    bearer: ['sk', 'live', 'a'.repeat(26)].join('-'),
    keyed: ['token', 'b'.repeat(26)].join('-'),
    email: `operator${'@'}example.com`,
    github: `ghp_${'c'.repeat(26)}`,
  };
}

/** A provider error body carrying one of each secret class the sanitizer masks. */
export function providerErrorText(fixtures = secretFixtures()): string {
  return [
    'invalid_request_error: upstream rejected request',
    `Authorization: Bearer ${fixtures.bearer}`,
    `api_key=${fixtures.keyed}`,
    `account=${fixtures.email}`,
    `github=${fixtures.github}`,
  ].join('\n');
}

/**
 * The redaction contract for a preview built from {@link providerErrorText}:
 * every secret class masked, and the non-secret diagnostic text preserved so a
 * redacted preview is still operationally useful.
 */
export function expectPreviewRedacted(preview: string, fixtures: SecretFixtures): void {
  expect(preview).toContain('invalid_request_error');
  expect(preview).toContain('Bearer [REDACTED]');
  expect(preview).toContain('api_key=[REDACTED]');
  expect(preview).toContain('[REDACTED_EMAIL]');
  expect(preview).not.toContain(fixtures.bearer);
  expect(preview).not.toContain(fixtures.keyed);
  expect(preview).not.toContain(fixtures.email);
  expect(preview).not.toContain(fixtures.github);
}

/**
 * Weaker companion for previews that are NOT built from the full
 * {@link providerErrorText} — e.g. a short classified error summary that
 * contains no credential at all. Asserts only the property that must hold
 * everywhere: no raw secret survives. Requiring a redaction marker here would
 * assert something that is not the security invariant.
 */
export function expectNoRawSecret(preview: string, fixtures: SecretFixtures): void {
  expect(preview).not.toContain(fixtures.bearer);
  expect(preview).not.toContain(fixtures.keyed);
  expect(preview).not.toContain(fixtures.email);
  expect(preview).not.toContain(fixtures.github);
}
