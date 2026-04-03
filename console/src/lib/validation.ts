/** Validate a phone number has 10-15 digits. */
export function validatePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 15
}
