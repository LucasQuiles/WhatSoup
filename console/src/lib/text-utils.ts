function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
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
  const text = textValue(name).trim()
  if (!text) return '—'
  // LID format (WhatsApp Linked IDs) — very long digit strings that aren't phone numbers
  if (/^\d{15,}$/.test(text)) return `Contact ${text.slice(-4)}`
  // If it ends with @lid, it's a Linked ID JID
  if (text.endsWith('@lid')) return `Contact ${text.split('@')[0].slice(-4)}`
  // Signal UUID JID — truncate the UUID for display (PR 4b, S5)
  if (text.endsWith('@signal')) {
    const local = text.slice(0, -'@signal'.length)
    return /^[0-9a-f-]{36}$/i.test(local) ? `Signal …${local.slice(-4)}` : formatPhone(local)
  }
  // iMessage AppleID JID — show the email/handle as-is (PR 4b, S5)
  if (text.endsWith('@imessage')) {
    const local = text.slice(0, -'@imessage'.length)
    return local.includes('@') ? local : formatPhone(local)
  }
  // If it's all digits (raw JID), format as phone
  if (/^\d{5,}$/.test(text)) return formatPhone(text)
  // If it ends with @g.us or @s.whatsapp.net, extract and format
  if (text.includes('@')) return formatPhone(text.split('@')[0])
  return text
}

/**
 * Build the line's self-JID for group resolution (PR 4b, S5).
 *
 * Baileys: `{phone}@s.whatsapp.net` (the bot's own PN JID — the server's
 * group roster keys on this form).
 * Signal:  `{selfId}@signal` — selfId is the Signal number or UUID from the
 *          line's signalConfig.
 * iMessage: `{selfId}@imessage` — selfId is the AppleID or phone from the
 *          line's imessageConfig.
 * Twilio:  same as baileys (Twilio surfaces use the same WhatsApp JID space).
 *
 * `selfId` is the protocol-native identity (phone for baileys/twilio, number
 * or UUID for signal, AppleID or phone for imessage). Callers pass the
 * transport kind from the line's config / health block.
 */
export function buildSelfJid(
  transportKind: string | null | undefined,
  selfId: string | number | null | undefined,
): string | undefined {
  const id = textValue(selfId).trim()
  if (!id) return undefined
  const kind = transportKind ?? 'baileys'
  if (kind === 'signal') return `${id}@signal`
  if (kind === 'imessage') return `${id}@imessage`
  // baileys + twilio + unknown → WhatsApp JID space (back-compat)
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
