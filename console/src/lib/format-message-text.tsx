import type { ReactNode } from 'react'
import { splitSearchHighlights } from './search-highlight'
import type { TransportKind } from './transport-meta'

const PATTERNS = {
  full: '```([\\s\\S]*?)```|`([^`]+)`|\\*\\*(.+?)\\*\\*|\\*(.+?)\\*|_(.+?)_|~(.+?)~|(https?:\\/\\/[^\\s<]+)',
  signal: '```([\\s\\S]*?)```|`([^`]+)`|\\*\\*(.+?)\\*\\*|\\*(.+?)\\*|_(.+?)_|(https?:\\/\\/[^\\s<]+)',
  plain: '(https?:\\/\\/[^\\s<]+)',
} as const

type Capability = keyof typeof PATTERNS

function capability(transport: TransportKind | string | null | undefined): Capability {
  if (transport === 'signal') return 'signal'
  if (transport === 'imessage') return 'plain'
  return 'full'
}

function displayText(text: string | null | undefined): string {
  return typeof text === 'string' && text.trim() ? text : '—'
}

function highlighted(text: string, query: string | undefined, keyRef: { value: number }): ReactNode[] {
  return splitSearchHighlights(text, query).map((segment) => segment.matched ? (
    <mark
      key={`mark-${keyRef.value++}`}
      className="bg-[var(--m-cht-soft)] text-text-1 rounded-xs py-0 px-[var(--bw)]"
    >
      {segment.text}
    </mark>
  ) : segment.text)
}

function plainText(text: string, query: string | undefined, keyRef: { value: number }, parts: ReactNode[]): void {
  text.split('\n').forEach((line, index) => {
    if (index > 0) parts.push(<br key={`br-${keyRef.value++}`} />)
    if (line) parts.push(...highlighted(line, query, keyRef))
  })
}

function code(text: string, block: boolean, query: string | undefined, keyRef: { value: number }): ReactNode {
  return (
    <code
      key={keyRef.value++}
      className={block
        ? 'font-mono block min-w-0 py-[var(--sp-1)] px-[var(--sp-2)] bg-surface-inset rounded-sm my-[var(--sp-1)] whitespace-pre-wrap overflow-x-auto'
        : 'font-mono py-[var(--bw)] px-[var(--sp-1)] bg-surface-inset rounded-sm'}
      style={{ fontSize: 'inherit' }}
    >
      {highlighted(text, query, keyRef)}
    </code>
  )
}

function link(url: string, query: string | undefined, keyRef: { value: number }): ReactNode {
  const shown = url.length > 50 ? `${url.slice(0, 47)}...` : url
  return (
    <a
      key={keyRef.value++}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-m-cht hover:underline"
      style={{ wordBreak: 'break-all' }}
    >
      {highlighted(shown, query, keyRef)}
    </a>
  )
}

export function formatMessageText(
  text: string | null | undefined,
  highlightQuery?: string,
  transport?: TransportKind | string | null,
): ReactNode[] {
  const parts: ReactNode[] = []
  const keyRef = { value: 0 }
  const content = displayText(text)
  const cap = capability(transport)
  const pattern = new RegExp(PATTERNS[cap], 'g')
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) plainText(content.slice(lastIndex, match.index), highlightQuery, keyRef, parts)

    if (cap === 'plain') {
      parts.push(link(match[1]!, highlightQuery, keyRef))
    } else if (match[1] !== undefined) {
      parts.push(code(match[1], true, highlightQuery, keyRef))
    } else if (match[2] !== undefined) {
      parts.push(code(match[2], false, highlightQuery, keyRef))
    } else if (match[3] !== undefined || match[4] !== undefined) {
      parts.push(<strong key={keyRef.value++}>{highlighted(match[3] ?? match[4]!, highlightQuery, keyRef)}</strong>)
    } else if (match[5] !== undefined) {
      parts.push(<em key={keyRef.value++}>{highlighted(match[5], highlightQuery, keyRef)}</em>)
    } else if (cap === 'full' && match[6] !== undefined) {
      parts.push(<s key={keyRef.value++} className="text-text-2">{highlighted(match[6], highlightQuery, keyRef)}</s>)
    } else {
      const url = cap === 'full' ? match[7] : match[6]
      if (url !== undefined) parts.push(link(url, highlightQuery, keyRef))
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < content.length) plainText(content.slice(lastIndex), highlightQuery, keyRef, parts)
  return parts
}
