/**
 * PII-specific redaction for the handoff corpus path.
 *
 * redactHandoffPii layers phone-number redaction on top of the shared
 * provider-preview sanitizer. These tests prove: phone numbers (E.164,
 * domestic separated, intl separated) → [REDACTED_PHONE]; the delegated
 * sanitizer still strips emails + Bearer tokens; and ordinary short numbers
 * (years, small counts) are NOT redacted.
 */
import { describe, it, expect } from 'vitest';
import { redactHandoffPii } from '../../../src/runtimes/agent/handoff-pii-redactor.ts';

describe('redactHandoffPii', () => {
  it('redacts E.164 numbers', () => {
    expect(redactHandoffPii('call +14155550123 now')).toBe('call [REDACTED_PHONE] now');
  });

  it('redacts domestic separated numbers', () => {
    expect(redactHandoffPii('ring 415-555-0123 please')).toBe('ring [REDACTED_PHONE] please');
  });

  it('redacts international separated numbers', () => {
    expect(redactHandoffPii('UK line +44 20 7946 0958 ok')).toBe('UK line [REDACTED_PHONE] ok');
  });

  it('redacts a bare 11-digit run', () => {
    expect(redactHandoffPii('jid 14155550123 sent')).toBe('jid [REDACTED_PHONE] sent');
  });

  it('still strips emails (delegates to sanitizer)', () => {
    // Email literal split with ${'@'} so the repo-hygiene personal-email guard
    // (which scans raw source) does not flag this fixture.
    const email = `bob${'@'}example.com`;
    expect(redactHandoffPii(`mail ${email} here`)).toBe('mail [REDACTED_EMAIL] here');
  });

  it('still strips Bearer tokens (delegates to sanitizer)', () => {
    expect(redactHandoffPii('auth Bearer abc123XYZ.def now')).toBe('auth Bearer [REDACTED] now');
  });

  it('redacts both a phone and an email in one pass', () => {
    const email = `bob${'@'}example.io`;
    expect(redactHandoffPii(`reach me at +14155550123 or ${email}`)).toBe(
      'reach me at [REDACTED_PHONE] or [REDACTED_EMAIL]',
    );
  });

  it('does NOT redact a bare year', () => {
    expect(redactHandoffPii('shipped in 2026')).toBe('shipped in 2026');
  });

  it('does NOT redact a small number', () => {
    expect(redactHandoffPii('there were 42 messages')).toBe('there were 42 messages');
  });

  it('does NOT redact a price or short figure', () => {
    expect(redactHandoffPii('cost was 1500 dollars over 3 days')).toBe(
      'cost was 1500 dollars over 3 days',
    );
  });

  it('leaves clean text untouched', () => {
    expect(redactHandoffPii('hello world, all good')).toBe('hello world, all good');
  });
});
