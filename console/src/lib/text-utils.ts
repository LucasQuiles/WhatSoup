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

/** Format a phone-like JID for display. */
export function formatPhone(raw: string): string {
  if (!raw || raw === 'unknown') return '—'
  // Strip non-digits
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  if (digits.length === 10) {
    return `+1 ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  return `+${digits}`
}
