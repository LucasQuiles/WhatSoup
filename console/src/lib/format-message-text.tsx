import type { ReactNode } from 'react'
import { splitSearchHighlights } from './search-highlight'
import type { TransportKind } from './transport-meta'

/**
 * Transport-aware message-text formatting to React elements (PR 4b-ii).
 *
 * Renamed from format-wa-text.tsx — the formatter is no longer
 * WhatsApp-specific. Handles *bold*, _italic_, ~strikethrough~, `inline code`,
 * triple-backtick code blocks, and https:// URLs, gated by the transport's
 * formatting capability (design doc §4):
 *
 *   - baileys / twilio: full WhatsApp markdown (*bold* _italic_ ~strike~ `code`)
 *   - signal:           subset (*bold* _italic_ `code` — no ~strike~)
 *   - imessage:         passthrough (plain text + URLs only; Apple clients
 *                       don't render markdown)
 *
 * Callers pass the line's transport kind; when omitted the full WhatsApp
 * pattern set applies (back-compat for existing call sites).
 *
 * Shared between MessageContent (chat bubbles) and FeedCard (activity feed
 * previews).
 */

const EMPTY_TEXT = '—';

/** Pattern variants per transport capability. */
const PATTERNS: Record<'full' | 'subset' | 'passthrough', string> = {
  full: '```([\\s\\S]*?)```|`([^`]+)`|\\*\\*(.+?)\\*\\*|\\*(.+?)\\*|_(.+?)_|~(.+?)~|(https?:\\/\\/[^\\s<]+)',
  subset: '```([\\s\\S]*?)```|`([^`]+)`|\\*\\*(.+?)\\*\\*|\\*(.+?)\\*|_(.+?)_|(https?:\\/\\/[^\\s<]+)',
  passthrough: '(https?:\\/\\/[^\\s<]+)',
};

function capabilityFor(kind: TransportKind | string | null | undefined): keyof typeof PATTERNS {
  if (kind === 'signal') return 'subset';
  if (kind === 'imessage') return 'passthrough';
  return 'full'; // baileys, twilio, unknown → full WhatsApp markdown (back-compat)
}

function displayText(text: string | null | undefined): string {
  return typeof text === 'string' && text.trim() ? text : EMPTY_TEXT;
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

/**
 * Format message text to React elements.
 *
 * @param text           Raw message content.
 * @param highlightQuery Optional search-highlight query.
 * @param transport      Optional transport kind — gates the pattern set
 *                       (full / subset / passthrough per design doc §4).
 */
export function formatMessageText(
  text: string | null | undefined,
  highlightQuery?: string,
  transport?: TransportKind | string | null,
): ReactNode[] {
  const parts: ReactNode[] = [];
  const keyRef = { value: 0 };

  const content = displayText(text);
  const pattern = new RegExp(PATTERNS[capabilityFor(transport)], 'g');
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      renderPlainText(content.slice(lastIndex, match.index), highlightQuery, keyRef, parts);
    }

    // Group indices depend on the pattern variant:
    //   full:        1=code-block 2=inline-code 3=**bold** 4=*bold* 5=_italic_ 6=~strike~ 7=url
    //   subset:      1=code-block 2=inline-code 3=**bold** 4=*bold* 5=_italic_ 6=url
    //   passthrough: 1=url
    const cap = capabilityFor(transport);
    if (cap === 'full') {
      if (match[1] !== undefined) {
        parts.push(
          <code key={keyRef.value++} className="font-mono block min-w-0 py-[var(--sp-1)] px-[var(--sp-2)] bg-surface-inset rounded-sm my-[var(--sp-1)] whitespace-pre-wrap overflow-x-auto" style={{ fontSize: 'inherit' }}>{renderHighlightedText(match[1], highlightQuery, keyRef)}</code>
        );
      } else if (match[2] !== undefined) {
        parts.push(
          <code key={keyRef.value++} className="font-mono py-[var(--bw)] px-[var(--sp-1)] bg-surface-inset rounded-sm" style={{ fontSize: 'inherit' }}>{renderHighlightedText(match[2], highlightQuery, keyRef)}</code>
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
    } else if (cap === 'subset') {
      if (match[1] !== undefined) {
        parts.push(
          <code key={keyRef.value++} className="font-mono block min-w-0 py-[var(--sp-1)] px-[var(--sp-2)] bg-surface-inset rounded-sm my-[var(--sp-1)] whitespace-pre-wrap overflow-x-auto" style={{ fontSize: 'inherit' }}>{renderHighlightedText(match[1], highlightQuery, keyRef)}</code>
        );
      } else if (match[2] !== undefined) {
        parts.push(
          <code key={keyRef.value++} className="font-mono py-[var(--bw)] px-[var(--sp-1)] bg-surface-inset rounded-sm" style={{ fontSize: 'inherit' }}>{renderHighlightedText(match[2], highlightQuery, keyRef)}</code>
        );
      } else if (match[3] !== undefined) {
        parts.push(<strong key={keyRef.value++}>{renderHighlightedText(match[3], highlightQuery, keyRef)}</strong>);
      } else if (match[4] !== undefined) {
        parts.push(<strong key={keyRef.value++}>{renderHighlightedText(match[4], highlightQuery, keyRef)}</strong>);
      } else if (match[5] !== undefined) {
        parts.push(<em key={keyRef.value++}>{renderHighlightedText(match[5], highlightQuery, keyRef)}</em>);
      } else if (match[6] !== undefined) {
        parts.push(
          <a
            key={keyRef.value++}
            href={match[6]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-m-cht hover:underline"
            style={{ wordBreak: 'break-all' }}
          >
            {renderHighlightedText(match[6].length > 50 ? match[6].slice(0, 47) + '...' : match[6], highlightQuery, keyRef)}
          </a>
        );
      }
    } else {
      // passthrough — only URLs (group 1)
      if (match[1] !== undefined) {
        parts.push(
          <a
            key={keyRef.value++}
            href={match[1]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-m-cht hover:underline"
            style={{ wordBreak: 'break-all' }}
          >
            {renderHighlightedText(match[1].length > 50 ? match[1].slice(0, 47) + '...' : match[1], highlightQuery, keyRef)}
          </a>
        );
      }
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    renderPlainText(content.slice(lastIndex), highlightQuery, keyRef, parts);
  }

  return parts;
}

/** Back-compat alias — prefer formatMessageText at new call sites. */
export const formatWhatsAppText = formatMessageText;
