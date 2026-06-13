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
 * Solution: normalize to digits-only at ingestion, and use suffix matching
 * for admin checks so "5551230006" matches "15551230006".
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

/**
 * Check if a phone number (from a JID) matches any admin phone.
 *
 * Uses suffix matching: if the extracted phone is "15551230006" and
 * adminPhones contains "5551230006", it matches because the admin
 * entry is a suffix of the full number. This handles the common case
 * where users omit the country code.
 *
 * Also handles the reverse: admin has "15551230006", extracted is
 * "5551230006" (less common but possible with LID JIDs).
 */
export function isAdminPhone(phone: string | number | null | undefined, adminPhones: Set<string>): boolean {
  const rawPhone = phoneText(phone);
  if (!rawPhone) return false;

  // Exact match first (fast path)
  if (adminPhones.has(rawPhone)) return true;

  // Suffix match: either the phone ends with an admin entry or vice versa
  // Minimum 7 digits required to prevent degenerate matches from misconfigured entries
  const digits = normalizePhone(rawPhone);
  if (digits.length < 7) return false;
  for (const admin of adminPhones) {
    const adminDigits = normalizePhone(admin);
    if (adminDigits.length < 7) continue;
    if (digits.endsWith(adminDigits) || adminDigits.endsWith(digits)) {
      return true;
    }
  }
  return false;
}
