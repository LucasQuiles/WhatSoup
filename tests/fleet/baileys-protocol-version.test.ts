/**
 * Structured protocol-version capture (bond-revocation investigation, 2026-08-17).
 *
 * Six bots lost their WhatsApp bond to a server-side revocation within ~24h.
 * The single most diagnostic field for a client-protocol revocation is the
 * WhatsApp protocol version — and every one of those alerts reported it as
 * `[REDACTED_PHONE]`, because a real version such as `2.3000.1043857760`
 * carries 15 digits in dotted groups and the generic evidence redactor treats
 * a dotted 10-15 digit run as a phone number.
 *
 * The fix must NOT be a numeric-redaction loophole: widening the phone rule
 * would weaken it everywhere. Instead the version is parsed into bounded
 * integers and emitted as separate integer components, so no dotted numeric
 * run is ever produced by this path and the redactor keeps its full strength
 * without an exception.
 *
 * These tests pin the PURE parser only. The production wiring — that the
 * poller actually calls the emitter and that the components reach real alert
 * evidence — is pinned in `health-poller.test.ts`, where the poller harness
 * lives. Deleting the emitter call must turn that test red; a parser-only
 * suite cannot detect it.
 */
import { describe, it, expect } from 'vitest';
import { parseBaileysProtocolVersion } from '../../src/fleet/health-poller.ts';

describe('parseBaileysProtocolVersion', () => {
  it('accepts the real production protocol version', () => {
    // Captured live from a fleet host, 2026-08-16.
    expect(parseBaileysProtocolVersion('2.3000.1043857760')).toEqual({
      major: 2, minor: 3000, patch: 1043857760,
    });
  });

  it('accepts a second observed version and preserves every component', () => {
    expect(parseBaileysProtocolVersion('2.3000.1020194169')).toEqual({
      major: 2, minor: 3000, patch: 1020194169,
    });
  });

  it('accepts the bundled library fallback tuple', () => {
    // node_modules/@whiskeysockets/baileys/lib/Defaults/index.js:5 — the value
    // every resolver failure class returns.
    expect(parseBaileysProtocolVersion('2.3000.1035194821')).toEqual({
      major: 2, minor: 3000, patch: 1035194821,
    });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseBaileysProtocolVersion('  2.3000.1043857760 ')).toEqual({
      major: 2, minor: 3000, patch: 1043857760,
    });
  });

  // ---- parity with the canonical transport contract ----
  //
  // src/transport/baileys-version.ts (parsePinnedBaileysVersion) accepts any
  // three dot-separated safe non-negative integers. A prior revision of this
  // parser added a digit-shape test that rejected these two transport-valid
  // values while accepting phone-shaped `1.41555.50123`. These cases exist so
  // that disagreement cannot silently return.

  it.each([
    ['the value used throughout the repo test mocks', '2.2413.1', { major: 2, minor: 2413, patch: 1 }],
    ['the documented pin example in docs/configuration.md', '2.3000.1021', { major: 2, minor: 3000, patch: 1021 }],
    ['a short triple', '1.2.3', { major: 1, minor: 2, patch: 3 }],
    ['zeroes', '0.0.0', { major: 0, minor: 0, patch: 0 }],
  ])('accepts %s (transport parity)', (_label, input, expected) => {
    expect(parseBaileysProtocolVersion(input)).toEqual(expected);
  });

  it('does not attempt to tell a version from a dotted phone by shape', () => {
    // Shape cannot separate these, and pretending otherwise broke transport
    // parity in both directions. A dotted triple parses as a triple; safety
    // comes from emitting integer components, never a dotted run — see
    // pushProtocolVersionEvidence.
    expect(parseBaileysProtocolVersion('212.555.0181')).toEqual({
      major: 212, minor: 555, patch: 181,
    });
    expect(parseBaileysProtocolVersion('1.41555.50123')).toEqual({
      major: 1, minor: 41555, patch: 50123,
    });
  });

  // ---- refusals: malformed, oversized, or not a bare triple ----

  it.each([
    ['an E.164 phone (not a triple)', '+14155550123'],
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
