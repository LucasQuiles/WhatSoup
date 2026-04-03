/**
 * Phone number normalization.
 *
 * Users enter phone numbers in many formats: +1-845-978-0919, 8459780919,
 * 18459780919, (845) 978-0919. WhatsApp JIDs always use the full E.164
 * number without the + prefix (e.g. 18459780919@s.whatsapp.net).
 *
 * The core problem: users often omit the country code, so adminPhones
 * may contain "8459780919" while the JID yields "18459780919". A strict
 * Set.has() comparison fails.
 *
 * Solution: normalize to digits-only at ingestion, and use suffix matching
 * for admin checks so "8459780919" matches "18459780919".
 */

/** Strip a phone number to digits only. */
export function normalizePhone(input: string): string {
  return input.replace(/\D/g, '');
}

/**
 * Check if a phone number (from a JID) matches any admin phone.
 *
 * Uses suffix matching: if the extracted phone is "18459780919" and
 * adminPhones contains "8459780919", it matches because the admin
 * entry is a suffix of the full number. This handles the common case
 * where users omit the country code.
 *
 * Also handles the reverse: admin has "18459780919", extracted is
 * "8459780919" (less common but possible with LID JIDs).
 */
export function isAdminPhone(phone: string, adminPhones: Set<string>): boolean {
  // Exact match first (fast path)
  if (adminPhones.has(phone)) return true;

  // Suffix match: either the phone ends with an admin entry or vice versa
  // Minimum 7 digits required to prevent degenerate matches from misconfigured entries
  const digits = normalizePhone(phone);
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
