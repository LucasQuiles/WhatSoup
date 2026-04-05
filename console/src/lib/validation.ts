/** Normalize a phone number to E.164-style digits (prepend 1 for 10-digit NANP numbers). */
export function normalizePhoneInput(value: string): string {
  const digits = value.replace(/\D/g, '')
  return digits.length === 10 ? `1${digits}` : digits
}

/** Validate a phone number has 10-15 digits after normalization. */
export function validatePhone(value: string): boolean {
  const digits = normalizePhoneInput(value)
  return digits.length >= 10 && digits.length <= 15
}
