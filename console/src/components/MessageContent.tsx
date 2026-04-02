import { type FC } from 'react'
import { Image, Film, FileAudio, FileText, HelpCircle } from 'lucide-react'
import type { Message } from '../types'

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
            borderRadius: 'var(--radius-sm)',
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

/** Format byte counts into human-readable strings. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/** Media type indicator for non-text messages (fallback). */
const MediaIndicator: FC<{ type: string; caption?: string | null }> = ({ type, caption }) => {
  const icons: Record<string, JSX.Element> = {
    image: <Image size={16} strokeWidth={1.75} className="text-m-cht" />,
    audio: <FileAudio size={16} strokeWidth={1.75} className="text-m-agt" />,
    document: <FileText size={16} strokeWidth={1.75} className="text-s-warn" />,
    video: <Film size={16} strokeWidth={1.75} className="text-m-pas" />,
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

/** Rich media renderer — extracts metadata from rawMessage, falls back to MediaIndicator. */
const RichMedia: FC<{ msg: Message }> = ({ msg }) => {
  // B01: Image thumbnails
  if (msg.type === 'image' && msg.rawMessage) {
    try {
      const raw = JSON.parse(msg.rawMessage)
      const thumb = raw?.message?.imageMessage?.jpegThumbnail
      if (thumb) {
        return (
          <div>
            <img
              src={`data:image/jpeg;base64,${thumb}`}
              alt={msg.content || 'Photo'}
              style={{
                maxHeight: '200px',
                maxWidth: '100%',
                borderRadius: 'var(--radius-md)',
                display: 'block',
              }}
            />
            {msg.content && <div className="text-t2" style={{ fontSize: 'var(--font-size-data)', marginTop: 'var(--sp-1)' }}>{msg.content}</div>}
          </div>
        )
      }
    } catch { /* fall through to default indicator */ }
  }

  // B02: Audio with duration
  if (msg.type === 'audio' && msg.rawMessage) {
    try {
      const raw = JSON.parse(msg.rawMessage)
      const audio = raw?.message?.audioMessage
      const seconds = audio?.seconds ?? 0
      const isPtt = audio?.ptt === true
      const label = isPtt ? 'Voice note' : 'Audio'
      const duration = seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : ''
      return (
        <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
          <FileAudio size={16} strokeWidth={1.75} className="text-m-agt" />
          <span className="text-t3 italic" style={{ fontSize: 'var(--font-size-data)' }}>
            {label}{duration ? ` \u00b7 ${duration}` : ''}
          </span>
        </div>
      )
    } catch { /* fall through */ }
  }

  // B03: Document card
  if (msg.type === 'document' && msg.rawMessage) {
    try {
      const raw = JSON.parse(msg.rawMessage)
      const doc = raw?.message?.documentMessage || raw?.message?.documentWithCaptionMessage?.message?.documentMessage
      if (doc) {
        const fileName = doc.fileName || 'Document'
        const fileSize = doc.fileLength ? formatBytes(Number(doc.fileLength)) : ''
        const ext = fileName.includes('.') ? fileName.split('.').pop()?.toUpperCase() : ''
        return (
          <div className="flex items-center" style={{ gap: 'var(--sp-3)', padding: 'var(--sp-1) 0' }}>
            <FileText size={20} strokeWidth={1.5} className="text-s-warn flex-shrink-0" />
            <div style={{ minWidth: 0 }}>
              <div className="text-t1 truncate" style={{ fontSize: 'var(--font-size-data)' }}>{fileName}</div>
              <div className="text-t4 font-mono" style={{ fontSize: 'var(--font-size-xs)' }}>
                {[ext, fileSize].filter(Boolean).join(' \u00b7 ')}
              </div>
            </div>
          </div>
        )
      }
    } catch { /* fall through */ }
  }

  // B04: Video thumbnails
  if (msg.type === 'video' && msg.rawMessage) {
    try {
      const raw = JSON.parse(msg.rawMessage)
      const video = raw?.message?.videoMessage
      const thumb = video?.jpegThumbnail
      const seconds = video?.seconds ?? 0
      const isGif = video?.gifPlayback === true
      const duration = seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : ''

      if (thumb) {
        return (
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <img
              src={`data:image/jpeg;base64,${thumb}`}
              alt={msg.content || (isGif ? 'GIF' : 'Video')}
              style={{
                maxHeight: '200px',
                maxWidth: '100%',
                borderRadius: 'var(--radius-md)',
                display: 'block',
              }}
            />
            {/* Duration badge + play icon overlay */}
            <div className="font-mono" style={{
              position: 'absolute',
              bottom: 'var(--sp-2)',
              right: 'var(--sp-2)',
              background: 'var(--overlay-badge)',
              color: 'white',
              padding: '2px var(--sp-2)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--font-size-xs)',
            }}>
              {isGif ? 'GIF' : duration || 'Video'}
            </div>
            {msg.content && (
              <div className="text-t2" style={{ fontSize: 'var(--font-size-data)', marginTop: 'var(--sp-1)' }}>
                {msg.content}
              </div>
            )}
          </div>
        )
      }
    } catch { /* fall through */ }
  }

  // Fallback: generic media indicator
  return <MediaIndicator type={msg.type} caption={msg.content} />
}

const MessageContent: FC<MessageContentProps> = ({ msg }) => {
  if (msg.type !== 'text' || !msg.content) {
    return <RichMedia msg={msg} />
  }

  return <>{formatWhatsAppText(msg.content)}</>
}

export default MessageContent
