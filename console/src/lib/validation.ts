// NOTE: Server-side duplicate exists at src/lib/phone.ts normalizePhoneE164()
function phoneText(value: string | number | null | undefined): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** Normalize a phone number to E.164-style digits (prepend 1 for 10-digit NANP numbers). */
export function normalizePhoneInput(value: string | number | null | undefined): string {
  const digits = phoneText(value).replace(/\D/g, '')
  return digits.length === 10 ? `1${digits}` : digits
}

/** Validate a phone number has 10-15 digits after normalization. */
export function validatePhone(value: string | number | null | undefined): boolean {
  const digits = normalizePhoneInput(value)
  return digits.length >= 10 && digits.length <= 15
}
