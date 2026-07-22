export const APPLEID_EMAIL_RE = /^(?!.*[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}])[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function isAppleIdEmail(value: unknown): value is string {
  return typeof value === 'string' && APPLEID_EMAIL_RE.test(value);
}

/** Validate an AppleID email exactly as received, then canonicalize its case. */
export function canonicalizeAppleIdEmail(value: unknown): string | null {
  return isAppleIdEmail(value) ? value.toLowerCase() : null;
}
