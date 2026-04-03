/**
 * WhatsApp-style text formatting to React elements.
 *
 * Handles: *bold*, _italic_, ~strikethrough~, `inline code`,
 * triple-backtick code blocks, and https:// URLs.
 *
 * Shared between MessageContent (chat bubbles) and FeedCard (activity feed previews).
 */

const WA_FORMAT_PATTERN = '```([\\s\\S]*?)```|`([^`]+)`|\\*\\*(.+?)\\*\\*|\\*(.+?)\\*|_(.+?)_|~(.+?)~|(https?:\\/\\/[^\\s<]+)';

export function formatWhatsAppText(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = [];
  let key = 0;

  const lines = text.split('\n');

  for (let li = 0; li < lines.length; li++) {
    if (li > 0) parts.push(<br key={`br-${key++}`} />);
    const line = lines[li];

    const pattern = new RegExp(WA_FORMAT_PATTERN, 'g');
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(line)) !== null) {
      if (match.index > lastIndex) {
        parts.push(line.slice(lastIndex, match.index));
      }

      if (match[1] !== undefined) {
        parts.push(
          <code key={key++} className="font-mono" style={{
            display: 'block',
            padding: 'var(--sp-1) var(--sp-2)',
            background: 'var(--color-d1)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'inherit',
            margin: 'var(--sp-1) 0',
            whiteSpace: 'pre-wrap',
            overflowX: 'auto',
          }}>{match[1]}</code>
        );
      } else if (match[2] !== undefined) {
        parts.push(
          <code key={key++} className="font-mono" style={{
            padding: '1px var(--sp-1)',
            background: 'var(--color-d1)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'inherit',
          }}>{match[2]}</code>
        );
      } else if (match[3] !== undefined) {
        parts.push(<strong key={key++}>{match[3]}</strong>);
      } else if (match[4] !== undefined) {
        parts.push(<strong key={key++}>{match[4]}</strong>);
      } else if (match[5] !== undefined) {
        parts.push(<em key={key++}>{match[5]}</em>);
      } else if (match[6] !== undefined) {
        parts.push(<s key={key++} className="text-t4">{match[6]}</s>);
      } else if (match[7] !== undefined) {
        parts.push(
          <a
            key={key++}
            href={match[7]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-m-cht hover:underline"
            style={{ wordBreak: 'break-all' }}
          >
            {match[7].length > 50 ? match[7].slice(0, 47) + '...' : match[7]}
          </a>
        );
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < line.length) {
      parts.push(line.slice(lastIndex));
    }
  }

  return parts;
}
