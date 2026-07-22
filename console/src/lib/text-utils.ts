import { isE164WireInput } from './validation'

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

const SIGNAL_UUID_DISPLAY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SIGNAL_GROUP_DISPLAY_RE = /^[A-Za-z0-9+/]{16,}={0,2}$/
const IMESSAGE_EMAIL_DISPLAY_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const IMESSAGE_GROUP_PREFIX = 'iMessage;+;'

type TransportNamespace = 'sms' | 'signal' | 'imessage'

function escapeIdentityControls(value: string): string {
  return [...value].map(character => {
    const code = character.charCodeAt(0)
    const unsafe = code <= 0x1F
      || (code >= 0x7F && code <= 0x9F)
      || code === 0x061C
      || code === 0x200E
      || code === 0x200F
      || (code >= 0x202A && code <= 0x202E)
      || (code >= 0x2066 && code <= 0x2069)
    if (!unsafe) return character
    return `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`
  }).join('')
}

function isPlaceholderIdentity(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === '' || normalized === 'unknown' || normalized === 'not connected'
}

function isNamespaceIdentity(namespace: TransportNamespace, identity: string): boolean {
  if (namespace === 'sms') return isE164WireInput(identity)
  if (namespace === 'signal') {
    return isE164WireInput(identity)
      || SIGNAL_UUID_DISPLAY_RE.test(identity)
      || (!identity.startsWith('+') && SIGNAL_GROUP_DISPLAY_RE.test(identity))
  }
  return isE164WireInput(identity)
    || IMESSAGE_EMAIL_DISPLAY_RE.test(identity)
    || (identity.startsWith(IMESSAGE_GROUP_PREFIX) && identity.length > IMESSAGE_GROUP_PREFIX.length)
}

function stripTransportSuffix(value: string): { identity: string; transport: TransportNamespace | null } {
  for (const transport of ['sms', 'signal', 'imessage'] as const) {
    const suffix = `@${transport}`
    if (value.endsWith(suffix)) {
      return { identity: value.slice(0, -suffix.length), transport }
    }
  }
  return { identity: value, transport: null }
}

function declaredTransportNamespace(transport: string): TransportNamespace | null {
  return transport === 'twilio'
    ? 'sms'
    : transport === 'signal' || transport === 'imessage'
      ? transport
      : null
}

function lineIdentityCandidate(value: string, transport: string): string | null {
  const safeValue = escapeIdentityControls(value.trim())
  if (!safeValue) return null
  const namespace = declaredTransportNamespace(transport)
  if (namespace === null) return isPlaceholderIdentity(safeValue) ? null : safeValue
  const suffix = `@${namespace}`
  if (!safeValue.endsWith(suffix)) {
    return isPlaceholderIdentity(safeValue) ? null : safeValue
  }
  const identity = safeValue.slice(0, -suffix.length)
  if (isPlaceholderIdentity(identity)) return null
  return isNamespaceIdentity(namespace, identity) ? identity : safeValue
}

/** Capitalize the first letter of a string. */
export function capitalize(s: string | number | null | undefined): string {
  const text = textValue(s)
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Capitalize single-letter instance names for display. */
export function displayInstanceName(name: string | number | null | undefined): string {
  const text = textValue(name).trim()
  if (!text) return '—'
  return text.length === 1 ? text.toUpperCase() : text
}

/** Extract up to 2 initials from a name string. */
export function getInitials(name: string | number | null | undefined): string {
  const text = textValue(name).trim()
  if (!text) return ''
  return text.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}

/**
 * Deterministic 0..7 index into the 8-hue avatar identity palette
 * (--avatar-hue-0..7). Same hashing idiom as line-detail/groups-utils.avatarColor
 * so a given identity resolves to a stable hue across the app.
 */
export function avatarHueIndex(name: string | number | null | undefined): number {
  const text = textValue(name)
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  const HUE_COUNT = 8
  return ((hash % HUE_COUNT) + HUE_COUNT) % HUE_COUNT
}

/** Strip markdown formatting for display in previews. */
export function stripMarkdown(text: string | number | null | undefined): string {
  const source = textValue(text)
  if (!source) return ''
  return source
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold**
    .replace(/\*(.+?)\*/g, '$1')        // *italic*
    .replace(/_(.+?)_/g, '$1')          // _italic_
    .replace(/~(.+?)~/g, '$1')          // ~strikethrough~
    .replace(/`(.+?)`/g, '$1')          // `code`
    .replace(/```[\s\S]*?```/g, '[code]') // code blocks
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // [text](url)
    .replace(/^#+\s/gm, '')             // # headings
    .replace(/^[-*]\s/gm, '')           // - list items
    .replace(/\n+/g, ' ')              // newlines to spaces
    .trim()
}

/** Resolve a chat display name — format raw JIDs as phone numbers. */
export function resolveDisplayName(name: string | number | null | undefined): string {
  const text = escapeIdentityControls(textValue(name).trim())
  if (!text) return '—'
  const transportRef = stripTransportSuffix(text)
  if (transportRef.transport) {
    if (isPlaceholderIdentity(transportRef.identity)) return '—'
    if (!isNamespaceIdentity(transportRef.transport, transportRef.identity)) return text
    if (isE164WireInput(transportRef.identity)) return formatPhone(transportRef.identity)
    return transportRef.identity
  }
  // LID format (WhatsApp Linked IDs) — very long digit strings that aren't phone numbers
  if (/^\d{15,}$/.test(text)) return `Contact ${text.slice(-4)}`
  // If it ends with @lid, it's a Linked ID JID
  if (text.endsWith('@lid')) return `Contact ${text.split('@')[0].slice(-4)}`
  // If it's all digits (raw JID), format as phone
  if (/^\d{5,}$/.test(text)) return formatPhone(text)
  // Only WhatsApp address namespaces are phone-formatted. Email identities and
  // unknown provider namespaces must remain visible rather than becoming "—".
  if (/@(?:g\.us|s\.whatsapp\.net)$/.test(text)) return formatPhone(text.split('@')[0])
  return text
}

export function lineIdentity(line: {
  selfId?: string | number | null
  phone?: string | number | null
  transport?: string | null
}): string {
  const preferred = textValue(line.selfId).trim()
  const fallback = textValue(line.phone).trim()
  const transport = textValue(line.transport).trim()
  return lineIdentityCandidate(preferred, transport)
    ?? lineIdentityCandidate(fallback, transport)
    ?? '—'
}

export function buildSelfJid(
  transport: string | null | undefined,
  selfId: string | number | null | undefined,
): string | undefined {
  const id = textValue(selfId).trim()
  if (!id || id.toLowerCase() === 'not connected') return undefined
  if (/@(?:s\.whatsapp\.net|sms|signal|imessage)$/.test(id)) return id
  if (transport === 'twilio') return `${id}@sms`
  if (transport === 'signal') return `${id}@signal`
  if (transport === 'imessage') return `${id}@imessage`
  return `${id}@s.whatsapp.net`
}

/** Format large numbers compactly: 1234 → "1.2K", 2450000 → "2.4M" */
export function formatCompact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Format exact counts with locale grouping for labels and tooltips. */
export function formatCount(value: number | null | undefined): string {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return n.toLocaleString('en-US')
}

/** Format a phone-like JID for display. */
export function formatPhone(raw: string | number | null | undefined): string {
  const text = textValue(raw).trim()
  if (!text || text === 'unknown') return '—'
  const digits = text.replace(/\D/g, '')
  // US number: +1 XXX-XXX-XXXX
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  if (digits.length === 10) {
    return `+1 ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  // International with country code (12-15 digits)
  if (digits.length >= 12 && digits.length <= 15) {
    return `+${digits.slice(0, digits.length - 10)} ${digits.slice(-10, -7)}-${digits.slice(-7, -4)}-${digits.slice(-4)}`
  }
  // LID or other long identifier — show abbreviated
  if (digits.length > 15) {
    return `#${digits.slice(-6)}`
  }
  if (!digits) return '—'
  return `+${digits}`
}
