// PII-specific redaction for the handoff corpus path.
//
// The handoff summarizer ships WhatsApp sender names + message content to a
// third-party cheap-summarizer model. sanitizeProviderPreviewText already
// strips Bearer tokens, key=value secrets, known token prefixes, and emails —
// but NOT phone numbers, which WhatsApp content routinely carries (the JID, a
// "call me at ..." line, a forwarded contact). We layer a conservative phone
// redactor on top so real numbers never cross to the summarizer.

import { sanitizeProviderPreviewText } from './provider-preview-sanitizer.ts';

// Phone matcher. Two alternatives, both deliberately bounded to avoid clobbering
// ordinary short numbers (years like `2026`, small counts like `42`, prices):
//
//  1. `\+` + 8-15 digits with optional space/hyphen/paren/dot separators. The
//     leading `+` is a strong signal of an international/E.164 number; E.164
//     caps the national+country number at 15 digits, and the shortest plausible
//     international subscriber numbers are ~8 digits.
//
//  2. A separator-bearing run that yields 10-15 digits total — covers domestic
//     formats like `415-555-0123` and `(020) 7946 0958`. The run MUST contain
//     at least one separator group (the `(?:[\s().-]+\d{2,4}){2,}` tail), so a
//     bare unseparated integer is only matched when it is a 10-15 digit run on
//     its own (alternative 3). This keeps 4-digit years and short integers out.
//
//  3. A bare 10-15 consecutive-digit run (no separators) — a raw phone/JID like
//     `14155550123`. 10 is the floor so years/PINs/short counts are untouched;
//     15 is the E.164 ceiling. Anchored on digit boundaries (not \d-adjacent) so
//     it does not bite into longer numeric blobs.
//
// Conservative by design: it will MISS some unusually short/oddly-formatted
// numbers rather than risk redacting legitimate non-PII figures. Over-redaction
// of a long order/tracking number is the accepted trade for never leaking a
// real phone number.
const PHONE_RE = new RegExp(
  [
    // 1. + intl prefix, 8-15 digits with optional separators
    '\\+\\d(?:[\\s().-]*\\d){7,14}',
    // 2. separator-bearing domestic group, 10-15 digits across >=3 groups
    '(?<![\\d.])\\d{2,4}(?:[\\s().-]+\\d{2,4}){2,}(?![\\d.])',
    // 3. bare 10-15 consecutive digits
    '(?<![\\d.])\\d{10,15}(?![\\d.])',
  ].join('|'),
  'g',
);

// Count digits in a candidate; alternatives 2/3 must land in [10,15] to qualify
// as a phone number (alternative 1 already self-bounds via its + prefix).
function digitCount(s: string): number {
  let n = 0;
  for (const ch of s) if (ch >= '0' && ch <= '9') n += 1;
  return n;
}

/**
 * Redact PII from a handoff-corpus string: first the shared provider-preview
 * sanitizer (Bearer/secret/token/email), then phone numbers → `[REDACTED_PHONE]`.
 */
export function redactHandoffPii(text: string): string {
  const base = sanitizeProviderPreviewText(text);
  return base.replace(PHONE_RE, (match) => {
    const digits = digitCount(match);
    // Alt 1 (leading +) is trusted as a phone regardless; alts 2/3 must hold
    // 10-15 digits. The regex already bounds these, but re-checking guards
    // against any borderline match the alternation produced.
    if (match.startsWith('+')) {
      return digits >= 8 && digits <= 15 ? '[REDACTED_PHONE]' : match;
    }
    return digits >= 10 && digits <= 15 ? '[REDACTED_PHONE]' : match;
  });
}
