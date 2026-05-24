import type { ReactNode } from 'react'
import { splitSearchHighlights } from './search-highlight'

/**
 * WhatsApp-style text formatting to React elements.
 *
 * Handles: *bold*, _italic_, ~strikethrough~, `inline code`,
 * triple-backtick code blocks, and https:// URLs.
 *
 * Shared between MessageContent (chat bubbles) and FeedCard (activity feed previews).
 */

const WA_FORMAT_PATTERN = '```([\\s\\S]*?)```|`([^`]+)`|\\*\\*(.+?)\\*\\*|\\*(.+?)\\*|_(.+?)_|~(.+?)~|(https?:\\/\\/[^\\s<]+)';

function renderHighlightedText(text: string, query: string | undefined, keyRef: { value: number }): ReactNode[] {
  return splitSearchHighlights(text, query).map((segment) => {
    if (!segment.matched) return segment.text
    return (
      <mark
        key={`mark-${keyRef.value++}`}
        className="bg-[var(--m-cht-soft)] text-t1 rounded-xs"
        style={{
          padding: '0 var(--bw-accent)',
        }}
      >
        {segment.text}
      </mark>
    )
  })
}

export function formatWhatsAppText(text: string, highlightQuery?: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const keyRef = { value: 0 };

  const lines = text.split('\n');

  for (let li = 0; li < lines.length; li++) {
    if (li > 0) parts.push(<br key={`br-${keyRef.value++}`} />);
    const line = lines[li];

    const pattern = new RegExp(WA_FORMAT_PATTERN, 'g');
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(line)) !== null) {
      if (match.index > lastIndex) {
        parts.push(...renderHighlightedText(line.slice(lastIndex, match.index), highlightQuery, keyRef));
      }

      if (match[1] !== undefined) {
        parts.push(
          <code key={keyRef.value++} className="font-mono block py-[var(--sp-1)] px-[var(--sp-2)] bg-d1 rounded-sm my-[var(--sp-1)] whitespace-pre-wrap overflow-x-auto" style={{
            fontSize: 'inherit',
          }}>{renderHighlightedText(match[1], highlightQuery, keyRef)}</code>
        );
      } else if (match[2] !== undefined) {
        parts.push(
          <code key={keyRef.value++} className="font-mono py-[var(--bw)] px-[var(--sp-1)] bg-d1 rounded-sm" style={{
            fontSize: 'inherit',
          }}>{renderHighlightedText(match[2], highlightQuery, keyRef)}</code>
        );
      } else if (match[3] !== undefined) {
        parts.push(<strong key={keyRef.value++}>{renderHighlightedText(match[3], highlightQuery, keyRef)}</strong>);
      } else if (match[4] !== undefined) {
        parts.push(<strong key={keyRef.value++}>{renderHighlightedText(match[4], highlightQuery, keyRef)}</strong>);
      } else if (match[5] !== undefined) {
        parts.push(<em key={keyRef.value++}>{renderHighlightedText(match[5], highlightQuery, keyRef)}</em>);
      } else if (match[6] !== undefined) {
        parts.push(<s key={keyRef.value++} className="text-t4">{renderHighlightedText(match[6], highlightQuery, keyRef)}</s>);
      } else if (match[7] !== undefined) {
        parts.push(
          <a
            key={keyRef.value++}
            href={match[7]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-m-cht hover:underline"
            style={{ wordBreak: 'break-all' }}
          >
            {renderHighlightedText(match[7].length > 50 ? match[7].slice(0, 47) + '...' : match[7], highlightQuery, keyRef)}
          </a>
        );
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < line.length) {
      parts.push(...renderHighlightedText(line.slice(lastIndex), highlightQuery, keyRef));
    }
  }

  return parts;
}
