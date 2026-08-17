/**
 * Structured protocol-version capture (bond-revocation investigation, 2026-08-17).
 *
 * Four bots lost their WhatsApp bond to a server-side revocation within ~24h.
 * The single most diagnostic field for a client-protocol revocation is the
 * WhatsApp protocol version — and every one of those alerts reported it as
 * `[REDACTED_PHONE]`, because a real version such as `2.3000.1043857760`
 * carries 15 digits in dotted groups and the generic evidence redactor treats
 * a dotted 10-15 digit run as a phone number.
 *
 * The fix must NOT be a numeric-redaction loophole: widening the phone rule
 * would weaken it everywhere. Instead the version is parsed into bounded
 * integers and re-rendered from them, so the emitted text is a pure function
 * of validated numbers. These tests pin that contract from both sides — the
 * version survives, and everything the redactor is supposed to catch still
 * gets caught.
 */
import { describe, it, expect } from 'vitest';
import { parseBaileysProtocolVersion } from '../../src/fleet/health-poller.ts';

describe('parseBaileysProtocolVersion', () => {
  it('accepts the real production protocol version', () => {
    // Captured live from a bot host, 2026-08-17.
    expect(parseBaileysProtocolVersion('2.3000.1043857760')).toEqual({
      major: 2, minor: 3000, patch: 1043857760,
    });
  });

  it('accepts a second observed version and preserves every component', () => {
    expect(parseBaileysProtocolVersion('2.3000.1020194169')).toEqual({
      major: 2, minor: 3000, patch: 1020194169,
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseBaileysProtocolVersion('  2.3000.1043857760 ')).toEqual({
      major: 2, minor: 3000, patch: 1043857760,
    });
  });

  // ---- refusals: malformed, oversized, or not a bare triple ----

  it.each([
    ['a phone number', '+14155550123'],
    ['a dotted phone', '212.555.0181'],
    ['two components only', '2.3000'],
    ['four components', '2.3000.1043857760.7'],
    ['a semver prerelease suffix', '7.0.0-rc12'],
    ['version embedded in text', 'baileys_version=2.3000.1043857760'],
    ['trailing text', '2.3000.1043857760 lifecycle_host=mini8'],
    ['a signed component', '+2.3000.1043857760'],
    ['non-numeric components', 'x.y.z'],
    ['empty', ''],
    ['whitespace only', '   '],
    ['major over bound', '99999.1.1'],
    ['minor over bound', '2.9999999.1'],
    ['patch over bound', '2.3000.9999999999999'],
    ['an oversized string', '2.3000.' + '9'.repeat(40)],
  ])('refuses %s', (_label, input) => {
    expect(parseBaileysProtocolVersion(input)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 2.3],
    ['an object', { major: 2 }],
    ['an array', [2, 3000, 1]],
  ])('refuses non-string input: %s', (_label, input) => {
    expect(parseBaileysProtocolVersion(input)).toBeNull();
  });
});

describe('generic text redaction is unchanged by the structured field', () => {
  // Mirrors the redactor in health-poller.ts. The point of the structured
  // field is that this rule keeps its full strength.
  const PHONE_LIKE_RE = /(^|[^\w])(\+?(?:\d[\d\s().-]{8,}\d))(?![\w])/g;
  const redact = (value: string): string => value.replace(
    PHONE_LIKE_RE,
    (match, prefix: string, candidate: string) => {
      const digits = candidate.replace(/\D/g, '');
      const hasPhoneSyntax = candidate.trim().startsWith('+') || /[\s().-]/.test(candidate);
      return hasPhoneSyntax && digits.length >= 10 && digits.length <= 15
        ? `${prefix}[REDACTED_PHONE]`
        : match;
    },
  );

  it.each([
    ['an international phone', 'call +14155550123 now'],
    ['a separated domestic phone', 'ring 415-555-0123 please'],
    ['a dotted phone', 'dial 212.555.0181 today'],
    ['a spaced phone', 'reach +44 20 7946 0958 ok'],
  ])('still redacts %s', (_label, input) => {
    expect(redact(input)).toContain('[REDACTED_PHONE]');
  });

  it('still redacts version-LIKE text appearing in an arbitrary message', () => {
    // Critical: the structured field must not have created a general escape
    // hatch for dotted numbers in free text. A version-shaped run inside a
    // message body is still treated as phone-like by the generic rule.
    const out = redact('user said their number is 2.3000.1043857760 ok');
    expect(out).toContain('[REDACTED_PHONE]');
    expect(out).not.toContain('2.3000.1043857760');
  });
});
