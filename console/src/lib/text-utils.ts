/** Capitalize single-letter instance names for display. */
export function displayInstanceName(name: string): string {
  return name.length === 1 ? name.toUpperCase() : name
}

/** Extract up to 2 initials from a name string. */
export function getInitials(name: string): string {
  return name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}

/** Strip markdown formatting for display in previews. */
export function stripMarkdown(text: string): string {
  return text
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
export function resolveDisplayName(name: string | null | undefined): string {
  if (!name) return '—'
  // If it's all digits (raw JID), format as phone
  if (/^\d{5,}$/.test(name)) return formatPhone(name)
  // If it ends with @g.us or @s.whatsapp.net, extract and format
  if (name.includes('@')) return formatPhone(name.split('@')[0])
  return name
}

/** Format a phone-like JID for display. */
export function formatPhone(raw: string): string {
  if (!raw || raw === 'unknown') return '—'
  const digits = raw.replace(/\D/g, '')
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
  return `+${digits}`
}
