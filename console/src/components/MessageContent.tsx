import { type FC, type ReactElement } from 'react'
import { Image, Film, FileAudio, FileText, HelpCircle } from 'lucide-react'
import type { Message } from '../types'
import { formatWhatsAppText } from '../lib/format-wa-text'

/**
 * Renders message content with WhatsApp-style formatting.
 * Handles text (with bold/italic/code/links), images, audio, documents.
 */

interface MessageContentProps {
  msg: Message
  highlightQuery?: string
}

/** Format byte counts into human-readable strings. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/** Media type indicator for non-text messages (fallback). */
const MediaIndicator: FC<{ type: string; caption?: string | null; highlightQuery?: string }> = ({ type, caption, highlightQuery }) => {
  const icons: Record<string, ReactElement> = {
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
    <div className="flex items-center gap-[var(--sp-2)]">
      {icons[type] ?? <HelpCircle size={16} strokeWidth={1.75} className="text-t4" />}
      <span className="text-t3 italic text-[var(--font-size-data)]">
        {labels[type] ?? type}
      </span>
      {caption && (
        <span className="text-t2 text-[var(--font-size-data)] ml-[var(--sp-1)]">
          {formatWhatsAppText(caption.length > 60 ? caption.slice(0, 57) + '...' : caption, highlightQuery)}
        </span>
      )}
    </div>
  )
}

/** Rich media renderer — extracts metadata from rawMessage, falls back to MediaIndicator. */
const RichMedia: FC<{ msg: Message; highlightQuery?: string }> = ({ msg, highlightQuery }) => {
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
                maxHeight: 'var(--sp-12)',
                maxWidth: '100%',
                display: 'block',
              }}
              className="rounded-md"
            />
            {msg.content && (
              <div className="text-t2 text-[var(--font-size-data)] mt-[var(--sp-1)]">
                {formatWhatsAppText(msg.content, highlightQuery)}
              </div>
            )}
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
        <div className="flex items-center gap-[var(--sp-2)]">
          <FileAudio size={16} strokeWidth={1.75} className="text-m-agt" />
          <span className="text-t3 italic text-[var(--font-size-data)]">
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
          <div className="flex items-center gap-[var(--sp-3)] py-[var(--sp-1)] px-0">
            <FileText size={20} strokeWidth={1.5} className="text-s-warn flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-t1 truncate text-[var(--font-size-data)]">{fileName}</div>
              <div className="text-t4 font-mono text-[var(--font-size-xs)]">
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
                maxHeight: 'var(--sp-12)',
                maxWidth: '100%',
                display: 'block',
              }}
              className="rounded-md"
            />
            {/* Duration badge + play icon overlay */}
            <div className="font-mono absolute bg-[var(--overlay-badge)] text-white py-px px-[var(--sp-2)] rounded-sm text-[var(--font-size-xs)]" style={{
              bottom: 'var(--sp-2)',
              right: 'var(--sp-2)',
            }}>
              {isGif ? 'GIF' : duration || 'Video'}
            </div>
            {msg.content && (
              <div className="text-t2 text-[var(--font-size-data)] mt-[var(--sp-1)]">
                {formatWhatsAppText(msg.content, highlightQuery)}
              </div>
            )}
          </div>
        )
      }
    } catch { /* fall through */ }
  }

  // Fallback: generic media indicator
  return <MediaIndicator type={msg.type} caption={msg.content} highlightQuery={highlightQuery} />
}

/** Extract quoted message context from rawMessage proto. */
function extractQuotedContext(rawMessage?: string): { participant?: string; text?: string } | null {
  if (!rawMessage) return null
  try {
    const raw = JSON.parse(rawMessage)
    const msgContent = raw?.message
    if (!msgContent) return null
    // Check all message types for contextInfo.quotedMessage
    for (const key of Object.keys(msgContent)) {
      const inner = msgContent[key]
      if (inner?.contextInfo?.quotedMessage) {
        const quoted = inner.contextInfo.quotedMessage
        const participant = inner.contextInfo.participant ?? inner.contextInfo.remoteJid ?? undefined
        // Extract text from quoted message (check common message types)
        const text = quoted.conversation
          ?? quoted.extendedTextMessage?.text
          ?? (quoted.imageMessage ? '📷 Photo' : undefined)
          ?? (quoted.videoMessage ? '🎥 Video' : undefined)
          ?? (quoted.audioMessage ? '🎵 Audio' : undefined)
          ?? (quoted.documentMessage ? `📎 ${quoted.documentMessage.fileName ?? 'Document'}` : undefined)
          ?? (quoted.stickerMessage ? '🏷️ Sticker' : undefined)
          ?? undefined
        if (text || participant) return { participant, text }
      }
    }
  } catch { /* ignore parse errors */ }
  return null
}

/** Quoted message reply bar. */
const QuotedReplyBar: FC<{ participant?: string; text?: string }> = ({ participant, text }) => (
  <div
    className="py-[var(--sp-1)] px-[var(--sp-2)] mb-[var(--sp-2)] bg-d4 text-[var(--font-size-sm)]"
    style={{
      borderLeftWidth: 'var(--bw-accent, 3px)',
      borderLeftStyle: 'solid',
      borderLeftColor: 'var(--color-m-cht)',
      borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
      maxHeight: 'var(--sp-12)',
      overflow: 'hidden',
    }}
  >
    {participant && (
      <div className="font-sans font-medium text-m-cht truncate text-[var(--font-size-xs)]">
        {participant.replace(/@.*/, '')}
      </div>
    )}
    {text && (
      <div className="text-t3 truncate leading-snug">
        {text}
      </div>
    )}
  </div>
)

const MessageContent: FC<MessageContentProps> = ({ msg, highlightQuery }) => {
  const quoted = extractQuotedContext(msg.rawMessage)

  if (msg.type !== 'text' || !msg.content) {
    return (
      <>
        {quoted && <QuotedReplyBar participant={quoted.participant} text={quoted.text} />}
        <RichMedia msg={msg} highlightQuery={highlightQuery} />
      </>
    )
  }

  return (
    <>
      {quoted && <QuotedReplyBar participant={quoted.participant} text={quoted.text} />}
      {formatWhatsAppText(msg.content, highlightQuery)}
    </>
  )
}

export default MessageContent
