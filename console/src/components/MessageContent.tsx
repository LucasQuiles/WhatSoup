import { type FC } from 'react'
import { Image, FileAudio, FileText, HelpCircle } from 'lucide-react'
import type { Message } from '../mock-data'

/**
 * Renders message content with WhatsApp-style formatting.
 * Handles text (with bold/italic/code/links), images, audio, documents.
 */

interface MessageContentProps {
  msg: Message
}

/** Hoisted regex source — compiled per-call since /g flag is stateful. */
const WA_FORMAT_PATTERN = '```([\\s\\S]*?)```|`([^`]+)`|\\*\\*(.+?)\\*\\*|\\*(.+?)\\*|_(.+?)_|~(.+?)~|(https?:\\/\\/[^\\s<]+)'

/** Parse WhatsApp text formatting into React elements. */
function formatWhatsAppText(text: string): (string | JSX.Element)[] {
  const parts: (string | JSX.Element)[] = []
  let key = 0

  const lines = text.split('\n')

  for (let li = 0; li < lines.length; li++) {
    if (li > 0) parts.push(<br key={`br-${key++}`} />)
    const line = lines[li]

    // Regex for WhatsApp formatting patterns (must create new instance per line — /g is stateful)
    const pattern = new RegExp(WA_FORMAT_PATTERN, 'g')

    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = pattern.exec(line)) !== null) {
      if (match.index > lastIndex) {
        parts.push(line.slice(lastIndex, match.index))
      }

      if (match[1] !== undefined) {
        parts.push(
          <code key={key++} className="font-mono" style={{
            display: 'block',
            padding: 'var(--sp-2) var(--sp-3)',
            background: 'var(--color-d1)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--font-size-data)',
            margin: 'var(--sp-1) 0',
            whiteSpace: 'pre-wrap',
            overflowX: 'auto',
          }}>{match[1]}</code>
        )
      } else if (match[2] !== undefined) {
        parts.push(
          <code key={key++} className="font-mono" style={{
            padding: '1px var(--sp-1)',
            background: 'var(--color-d1)',
            borderRadius: '2px',
            fontSize: 'var(--font-size-data)',
          }}>{match[2]}</code>
        )
      } else if (match[3] !== undefined) {
        parts.push(<strong key={key++}>{match[3]}</strong>)
      } else if (match[4] !== undefined) {
        parts.push(<strong key={key++}>{match[4]}</strong>)
      } else if (match[5] !== undefined) {
        parts.push(<em key={key++}>{match[5]}</em>)
      } else if (match[6] !== undefined) {
        parts.push(<s key={key++} className="text-t4">{match[6]}</s>)
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
        )
      }

      lastIndex = match.index + match[0].length
    }

    if (lastIndex < line.length) {
      parts.push(line.slice(lastIndex))
    }
  }

  return parts
}

/** Media type indicator for non-text messages. */
const MediaIndicator: FC<{ type: string; caption?: string | null }> = ({ type, caption }) => {
  const icons: Record<string, JSX.Element> = {
    image: <Image size={16} strokeWidth={1.75} className="text-m-cht" />,
    audio: <FileAudio size={16} strokeWidth={1.75} className="text-m-agt" />,
    document: <FileText size={16} strokeWidth={1.75} className="text-s-warn" />,
    video: <Image size={16} strokeWidth={1.75} className="text-m-pas" />,
  }

  const labels: Record<string, string> = {
    image: 'Photo',
    audio: 'Voice message',
    document: 'Document',
    video: 'Video',
    sticker: 'Sticker',
    unknown: 'Message',
  }

  return (
    <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
      {icons[type] ?? <HelpCircle size={16} strokeWidth={1.75} className="text-t4" />}
      <span className="text-t3 italic" style={{ fontSize: 'var(--font-size-data)' }}>
        {labels[type] ?? type}
      </span>
      {caption && (
        <span className="text-t2" style={{ fontSize: 'var(--font-size-data)', marginLeft: 'var(--sp-1)' }}>
          {caption.length > 60 ? caption.slice(0, 57) + '...' : caption}
        </span>
      )}
    </div>
  )
}

const MessageContent: FC<MessageContentProps> = ({ msg }) => {
  if (msg.type !== 'text' || !msg.content) {
    return <MediaIndicator type={msg.type} caption={msg.content} />
  }

  return <>{formatWhatsAppText(msg.content)}</>
}

export default MessageContent
