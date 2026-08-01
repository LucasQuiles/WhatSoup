import type { ReactNode } from 'react'
import { splitSearchHighlights } from './search-highlight'
import { isNonEmptyString } from './type-guards'

/**
 * WhatsApp-style text formatting to React elements.
 *
 * Handles: *bold*, _italic_, ~strikethrough~, `inline code`,
 * triple-backtick code blocks, and https:// URLs.
 *
 * Shared between MessageContent (chat bubbles) and FeedCard (activity feed previews).
 */

const WA_FORMAT_PATTERN = '```([\\s\\S]*?)```|`([^`]+)`|\\*\\*(.+?)\\*\\*|\\*(.+?)\\*|_(.+?)_|~(.+?)~|(https?:\\/\\/[^\\s<]+)';
const EMPTY_TEXT = '\u2014';

function displayText(text: string | null | undefined): string {
  return isNonEmptyString(text) ? text : EMPTY_TEXT;
}

function renderHighlightedText(text: string, query: string | undefined, keyRef: { value: number }): ReactNode[] {
  return splitSearchHighlights(text, query).map((segment) => {
    if (!segment.matched) return segment.text
    return (
      <mark
        key={`mark-${keyRef.value++}`}
        className="bg-[var(--m-cht-soft)] text-text-1 rounded-xs py-0 px-[var(--bw)]"
      >
        {segment.text}
      </mark>
    )
  })
}

function renderPlainText(text: string, query: string | undefined, keyRef: { value: number }, parts: ReactNode[]): void {
  const lines = text.split('\n');

  lines.forEach((line, index) => {
    if (index > 0) parts.push(<br key={`br-${keyRef.value++}`} />);
    if (line) parts.push(...renderHighlightedText(line, query, keyRef));
  });
}

export function formatWhatsAppText(text: string | null | undefined, highlightQuery?: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const keyRef = { value: 0 };

  const content = displayText(text);
  const pattern = new RegExp(WA_FORMAT_PATTERN, 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      renderPlainText(content.slice(lastIndex, match.index), highlightQuery, keyRef, parts);
    }

    if (match[1] !== undefined) {
      parts.push(
        <code key={keyRef.value++} className="font-mono block min-w-0 py-[var(--sp-1)] px-[var(--sp-2)] bg-surface-inset rounded-sm my-[var(--sp-1)] whitespace-pre-wrap overflow-x-auto" style={{
          fontSize: 'inherit',
        }}>{renderHighlightedText(match[1], highlightQuery, keyRef)}</code>
      );
    } else if (match[2] !== undefined) {
      parts.push(
        <code key={keyRef.value++} className="font-mono py-[var(--bw)] px-[var(--sp-1)] bg-surface-inset rounded-sm" style={{
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
      parts.push(<s key={keyRef.value++} className="text-text-2">{renderHighlightedText(match[6], highlightQuery, keyRef)}</s>);
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

  if (lastIndex < content.length) {
    renderPlainText(content.slice(lastIndex), highlightQuery, keyRef, parts);
  }

  return parts;
}
