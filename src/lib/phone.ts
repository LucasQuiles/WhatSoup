/**
 * Phone number normalization.
 *
 * Users enter phone numbers in many formats: +1-555-123-0006, 5551230006,
 * 15551230006, (555) 123-0006. WhatsApp JIDs always use the full E.164
 * number without the + prefix (e.g. 15551230006@s.whatsapp.net).
 *
 * The core problem: users often omit the country code, so adminPhones
 * may contain "5551230006" while the JID yields "15551230006". A strict
 * Set.has() comparison fails.
 *
 * Admin matching first accepts an exact configured identity, then permits
 * digit-normalized equality or an 8–15 digit pair differing by a 1–3 digit
 * prefix. The prefix is not validated as an assigned country code.
 */

function phoneText(input: string | number | null | undefined): string {
  if (typeof input === 'string') return input;
  if (typeof input === 'number' && Number.isFinite(input)) return String(input);
  return '';
}

/** Strip a phone number to digits only. */
export function normalizePhone(input: string | number | null | undefined): string {
  return phoneText(input).replace(/\D/g, '');
}

/**
 * Normalize a phone number to E.164 digits (with country code).
 *
 * If the number is 10 digits (US/CA), prepends "1".
 * Otherwise returns digits-only as-is.
 */
// NOTE: Browser-side duplicate exists at console/src/lib/validation.ts normalizePhoneInput()
export function normalizePhoneE164(input: string | number | null | undefined): string {
  const digits = normalizePhone(input);
  // 10-digit NANP number → prepend country code 1
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

/** Canonical E.164 matcher shared by core validation and transport adapters. */
export const E164_RE = /^\+[1-9]\d{6,14}$/;

/** True only for a canonical, plus-prefixed E.164 provider wire identity. */
export function isE164Wire(input: string): boolean {
  return E164_RE.test(input);
}

/** Normalize phone-formatted input to provider-wire E.164, rejecting embedded junk. */
export function normalizePhoneE164Wire(
  input: string | number | null | undefined,
): string | null {
  const text = phoneText(input).trim();
  if (!/^\+?[\d\s().-]+$/.test(text)) return null;
  const wire = `+${normalizePhoneE164(text)}`;
  return isE164Wire(wire) ? wire : null;
}

/**
 * A phone-shaped local part (7-15 digits, E.164 ballpark). Shape check only —
 * a bare 12-15-digit local can also be an unmapped LID (see
 * src/core/chat-display-name.ts LID_SUSPECT_MIN_DIGITS for how render paths
 * disambiguate).
 */
export function isPhoneLocal(local: string): boolean {
  return /^\d{7,15}$/.test(local);
}

/**
 * Check if a phone number (from a JID) matches any admin phone.
 *
 * Exact configured identities match first. Otherwise alphabetic/email-shaped
 * input is rejected and both digit forms must be 8–15 digits. Equal digits,
 * or a longer form with a 1–3 digit prefix before the shorter form, match.
 * This is country-code-tolerant matching, not strict normalized E.164 equality.
 */
export function isAdminPhone(phone: string | number | null | undefined, adminPhones: Set<string>): boolean {
  const rawPhone = phoneText(phone);
  if (!rawPhone) return false;

  // Exact match first (fast path)
  if (adminPhones.has(rawPhone)) return true;

  // Non-phone transport identities (for example Signal UUIDs and AppleID
  // emails) are authorization identifiers too, but they must never enter the
  // digit-normalization path. Otherwise a prefixed/suffixed lookalike can
  // collapse to the same digits as the configured identity.
  if (/[A-Za-z@]/.test(rawPhone)) return false;

  // QR-033: this is an AUTH boundary (admin commands, elevated access), so it must
  // NOT be a fuzzy suffix match. The previous bidirectional `>=7-digit` suffix test
  // granted admin to ANY number ending in the admin's (country-code-less) digits — an
  // attacker who provisions a number ending in / prefixing the admin's trailing digits
  // gained full admin — and to any 7+-digit suffix of the admin's number.
  //
  // Replacement: exact digit match, OR a strictly country-code-tolerant match — the
  // longer form must equal the shorter plus a 1-3 digit prefix (E.164 country codes
  // are 1-3 digits). This still matches "admin configured without the country code"
  // (e.g. 5551230006 vs 15551230006). Prefixes longer than three digits are rejected;
  // shorter numeric prefixes are not validated as country codes. The floor is 8 digits so a 7-digit stub cannot suffix-match
  // a real number; an international admin whose national number is <8 digits must be
  // configured with its full country code.
  const digits = normalizePhone(rawPhone);
  if (digits.length < 8 || digits.length > 15) return false;
  for (const admin of adminPhones) {
    const adminDigits = normalizePhone(admin);
    if (adminDigits.length < 8 || adminDigits.length > 15) continue;
    if (digits === adminDigits) return true;
    const longer = digits.length >= adminDigits.length ? digits : adminDigits;
    const shorter = digits.length >= adminDigits.length ? adminDigits : digits;
    const ccLen = longer.length - shorter.length;
    if (ccLen >= 1 && ccLen <= 3 && longer.endsWith(shorter)) return true;
  }
  return false;
}
