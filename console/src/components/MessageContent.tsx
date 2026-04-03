import { type FC } from 'react'
import { Image, Film, FileAudio, FileText, HelpCircle } from 'lucide-react'
import type { Message } from '../types'
import { formatWhatsAppText } from '../lib/format-wa-text'

/**
 * Renders message content with WhatsApp-style formatting.
 * Handles text (with bold/italic/code/links), images, audio, documents.
 */

interface MessageContentProps {
  msg: Message
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
