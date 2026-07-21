// NOTE: Server-side duplicate exists at src/lib/phone.ts normalizePhoneE164()
function phoneText(value: string | number | null | undefined): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** Validate a canonical plus-prefixed E.164 provider wire identity. */
export function isE164WireInput(value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 8 || value.length > 16) return false
  if (value[0] !== '+' || value[1] === '0') return false
  return [...value.slice(1)].every(character => character >= '0' && character <= '9')
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

/** Validate user-entered phone formatting without accepting arbitrary embedded text. */
export function validatePhoneIdentityInput(value: string | number | null | undefined): boolean {
  const raw = phoneText(value).trim()
  if (!raw) return false
  let plusSeen = false
  for (const [index, character] of [...raw].entries()) {
    if (character >= '0' && character <= '9') continue
    if (character === '+') {
      if (index !== 0 || plusSeen) return false
      plusSeen = true
      continue
    }
    if (character !== ' ' && character !== '(' && character !== ')' && character !== '.' && character !== '-') {
      return false
    }
  }
  const normalized = normalizePhoneInput(raw)
  return normalized.length >= 10 && normalized.length <= 15 && normalized[0] !== '0'
}

/** Normalize a validated user-entered phone identity, or fail closed with an empty result. */
export function normalizePhoneIdentityInput(value: string): string {
  return validatePhoneIdentityInput(value) ? normalizePhoneInput(value) : ''
}
