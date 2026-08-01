import { asNonEmptyString } from '../../lib/type-guards'

export function parseQrPayload(data: string): string | null {
  const raw = data.trim()
  if (!raw) return null

  try {
    const parsed = JSON.parse(data) as unknown
    return asNonEmptyString(parsed) ?? null
  } catch {
    return raw
  }
}

export function parseAuthErrorMessage(data: string | undefined): string {
  const fallback = 'Connection lost'
  const raw = data?.trim()
  if (!raw) return fallback

  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim()
    if (
      parsed &&
      typeof parsed === 'object' &&
      'message' in parsed &&
      typeof parsed.message === 'string' &&
      parsed.message.trim()
    ) {
      return parsed.message.trim()
    }
  } catch {
    return raw
  }

  return fallback
}
