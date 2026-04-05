export interface HighlightSegment {
  text: string
  matched: boolean
}

const BOOLEAN_OPERATORS = new Set(['and', 'or', 'not', 'near'])

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractTerms(query: string): string[] {
  const terms: string[] = []
  const phrasePattern = /"([^"]+)"/g
  let phraseMatch: RegExpExecArray | null

  while ((phraseMatch = phrasePattern.exec(query)) !== null) {
    const phrase = phraseMatch[1]?.trim()
    if (phrase) terms.push(phrase)
  }

  const remaining = query.replace(phrasePattern, ' ')
  for (const part of remaining.split(/\s+/)) {
    const normalized = part.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}*]+$/gu, '').replace(/\*+$/g, '')
    if (!normalized) continue
    if (BOOLEAN_OPERATORS.has(normalized.toLowerCase())) continue
    terms.push(normalized)
  }

  return [...new Set(terms)].sort((a, b) => b.length - a.length)
}

export function splitSearchHighlights(text: string, query?: string): HighlightSegment[] {
  if (!query?.trim()) return [{ text, matched: false }]

  const terms = extractTerms(query)
  if (terms.length === 0) return [{ text, matched: false }]

  const pattern = new RegExp(`(${terms.map(escapeRegex).join('|')})`, 'gi')
  const segments: HighlightSegment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), matched: false })
    }
    segments.push({ text: match[0], matched: true })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), matched: false })
  }

  return segments.length > 0 ? segments : [{ text, matched: false }]
}
