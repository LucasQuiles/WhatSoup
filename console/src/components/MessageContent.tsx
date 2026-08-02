import { type FC, type ReactElement } from 'react'
import { Image, Film, FileAudio, FileText, HelpCircle } from 'lucide-react'
import type { Message } from '../types'
import { formatWhatsAppText } from '../lib/format-wa-text'
import { isNonEmptyString } from '../lib/type-guards'

function formatMediaDuration(seconds: number): string {
  return seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : ''
}

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

  if (type === 'image') {
    return (
      <div>
        <div className="flex items-center justify-center rounded-md bg-surface-raised w-full h-[var(--media-thumb-h)] min-w-[var(--media-thumb-w)]">
          <Image size={32} strokeWidth={1.25} className="text-text-3" />
        </div>
        {caption && (
          <div className="text-data text-text-2 mt-[var(--sp-1)]">
            {formatWhatsAppText(caption.length > 60 ? caption.slice(0, 57) + '...' : caption, highlightQuery)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-[var(--sp-2)]">
      {icons[type] ?? <HelpCircle size={16} strokeWidth={1.75} className="text-text-2" />}
      <span className="text-data text-text-2 italic">
        {labels[type] ?? type}
      </span>
      {caption && (
        <span className="text-data text-text-2 ml-[var(--sp-1)]">
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
              className="rounded-md block max-w-full"
              style={{ maxHeight: 'var(--media-thumb-h)' }}
            />
            {msg.content && (
              <div className="text-data text-text-2 mt-[var(--sp-1)]">
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
      const duration = formatMediaDuration(seconds)
      return (
        <div className="flex items-center gap-[var(--sp-2)]">
          <FileAudio size={16} strokeWidth={1.75} className="text-m-agt" />
          <span className="text-data text-text-2 italic">
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
        const fileName = isNonEmptyString(doc.fileName) ? doc.fileName : 'Document'
        const fileLength = doc.fileLength ? Number(doc.fileLength) : 0
        const fileSize = Number.isFinite(fileLength) && fileLength > 0 ? formatBytes(fileLength) : ''
        const ext = fileName.includes('.') ? fileName.split('.').pop()?.toUpperCase() : ''
        return (
          <div className="flex items-center gap-[var(--sp-3)] py-[var(--sp-1)] px-0">
            <FileText size={16} strokeWidth={1.75} className="text-s-warn flex-shrink-0" />
            <div className="min-w-0">
              <div title={fileName} className="text-data text-text-1 truncate">{fileName}</div>
              <div className="text-xs text-text-2 font-mono">
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
      const duration = formatMediaDuration(seconds)

      if (thumb) {
        return (
          <div className="relative inline-block">
            <img
              src={`data:image/jpeg;base64,${thumb}`}
              alt={msg.content || (isGif ? 'GIF' : 'Video')}
              className="rounded-md block max-w-full"
              style={{ maxHeight: 'var(--media-thumb-h)' }}
            />
            {/* Duration badge + play icon overlay */}
            <div className="absolute bottom-[var(--sp-2)] right-[var(--sp-2)] text-xs font-mono rounded-sm py-[var(--sp-0h)] px-[var(--sp-2)] bg-[var(--overlay-badge)] text-text-1">
              {isGif ? 'GIF' : duration || 'Video'}
            </div>
            {msg.content && (
              <div className="text-data text-text-2 mt-[var(--sp-1)]">
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
        const rawParticipant = inner.contextInfo.participant ?? inner.contextInfo.remoteJid ?? undefined
        const participant = typeof rawParticipant === 'string' ? rawParticipant : undefined
        // Extract text from quoted message (check common message types)
        const rawText = quoted.conversation
          ?? quoted.extendedTextMessage?.text
          ?? (quoted.imageMessage ? '📷 Photo' : undefined)
          ?? (quoted.videoMessage ? '🎥 Video' : undefined)
          ?? (quoted.audioMessage ? '🎵 Audio' : undefined)
          ?? (quoted.documentMessage ? `📎 ${quoted.documentMessage.fileName ?? 'Document'}` : undefined)
          ?? (quoted.stickerMessage ? '🏷️ Sticker' : undefined)
          ?? undefined
        const text = typeof rawText === 'string' ? rawText : undefined
        if (text || participant) return { participant, text }
      }
    }
  } catch { /* ignore parse errors */ }
  return null
}

/** Quoted message reply bar. */
const QuotedReplyBar: FC<{ participant?: string; text?: string }> = ({ participant, text }) => (
  <div
    className="overflow-hidden text-sm py-[var(--sp-1)] px-[var(--sp-2)] mb-[var(--sp-2)] bg-surface-raised rounded-tr-[var(--radius-sm)] rounded-br-[var(--radius-sm)]"
    style={{
      borderLeftWidth: 'var(--bw-accent, 3px)',
      borderLeftStyle: 'solid',
      borderLeftColor: 'var(--color-m-cht)',
      maxHeight: 'var(--sp-12)',
    }}
  >
    {participant && (
      <div title={participant} className="text-xs font-sans font-medium text-m-cht truncate">
        {participant.replace(/@.*/, '')}
      </div>
    )}
    {text && (
      <div title={text} className="text-text-2 truncate leading-snug">
        {text}
      </div>
    )}
  </div>
)

const MessageContent: FC<MessageContentProps> = ({ msg, highlightQuery }) => {
  const quoted = extractQuotedContext(msg.rawMessage)

  if (msg.type !== 'text') {
    return (
      <>
        {quoted && <QuotedReplyBar participant={quoted.participant} text={quoted.text} />}
        <RichMedia msg={msg} highlightQuery={highlightQuery} />
      </>
    )
  }

  // F-043: text-type with null/empty content renders an em-dash placeholder
  // instead of falling through to RichMedia (which produces an invisible bubble).
  return (
    <>
      {quoted && <QuotedReplyBar participant={quoted.participant} text={quoted.text} />}
      {msg.content ? formatWhatsAppText(msg.content, highlightQuery) : <em className="text-text-3">—</em>}
    </>
  )
}

export default MessageContent
