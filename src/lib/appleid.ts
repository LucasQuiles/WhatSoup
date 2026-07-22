export const APPLEID_EMAIL_RE = /^(?!.*[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}])[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function isAppleIdEmail(value: unknown): value is string {
  return typeof value === 'string' && APPLEID_EMAIL_RE.test(value);
}
