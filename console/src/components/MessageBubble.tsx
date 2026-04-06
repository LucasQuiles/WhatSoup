import { type FC, useState, useRef, useCallback } from 'react'
import { UserPlus, Check, X, RotateCw } from 'lucide-react'
import { resolveDisplayName } from '../lib/text-utils'
import { formatTime } from '../lib/format-time'
import MessageContent from './MessageContent'
import type { Message } from '../types'

interface MessageBubbleProps {
  msg: Message
  outgoingBg?: string
  onCreateContact?: (senderName: string) => void
  highlightQuery?: string
  /** When true, plays the slide-in entrance animation. */
  animate?: boolean
  /** Called when user clicks retry on a failed message. */
  onRetry?: (msg: Message) => void
}

const isRawJid = (name: string) => /^\d{5,}$/.test(name)

/** Styled hover detail card — shown on hover. */
const DetailCard: FC<{ msg: Message }> = ({ msg }) => {
  const ts = new Date(msg.timestamp)
  const fullTime = ts.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })

  return (
    <div
      className="absolute z-50 pointer-events-none c-card c-card--detail mb-[var(--sp-2)]"
      style={{
        bottom: '100%',
        left: 0,
      }}
    >
      <div className="flex flex-col gap-[var(--sp-2)]">
        {[
          { label: 'Time', value: fullTime },
          { label: 'Sender', value: resolveDisplayName(msg.senderName) || (msg.fromMe ? 'You' : '\u2014') },
          ...(msg.senderJid ? [{ label: 'JID', value: msg.senderJid, muted: true }] : []),
          { label: 'Type', value: msg.type },
          { label: 'Direction', value: msg.fromMe ? 'Outbound' : 'Inbound' },
        ].map(({ label, value, muted }) => (
          <div key={label} className="flex justify-between gap-[var(--sp-4)]">
            <span className="c-label flex-shrink-0">{label}</span>
            <span className={`c-data truncate max-w-[var(--tooltip-val-max)] ${muted ? 'text-t5' : ''}`}>
              {value}
            </span>
          </div>
        ))}
        <div className="pt-[var(--sp-2)] mt-[var(--sp-1)] c-border-b-b2">
          <div className="flex justify-between">
            <span className="c-label">ID</span>
            <span className="c-data text-t5">
              {msg.pk < 0 ? 'pending' : `pk:${msg.pk}`}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Delivery status indicator for outgoing messages. */
const DeliveryStatus: FC<{ msg: Message; onRetry?: (msg: Message) => void }> = ({ msg, onRetry }) => {
  if (!msg.fromMe) return null

  // Failed messages (pk === -1 sentinel) — red X with retry button
  if (msg.pk === -1) {
    return (
      <span className="flex items-center gap-[var(--bw-accent)]">
        <X size={12} strokeWidth={2.5} className="text-s-crit" />
        {onRetry && (
          <button
            type="button"
            onClick={() => onRetry(msg)}
            className="c-btn c-btn-ghost c-btn-sm"
            aria-label="Retry send"
            title="Retry send"
          >
            <RotateCw size={10} strokeWidth={2.5} className="text-t1" />
          </button>
        )}
      </span>
    )
  }

  // Optimistic messages (negative pk) — pending, muted check
  if (msg.pk < 0) {
    return <Check size={12} strokeWidth={2} className="text-t5 opacity-[var(--opacity-soft)]" />
  }

  // Persisted messages — confirmed sent, green check
  return <Check size={12} strokeWidth={2} className="text-s-ok" />
}

const MessageBubble: FC<MessageBubbleProps> = ({ msg, outgoingBg = 'var(--m-cht-soft)', onCreateContact, highlightQuery, animate, onRetry }) => {
  const isMedia = msg.type !== 'text'
  const [showDetail, setShowDetail] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onEnter = useCallback(() => {
    hoverTimer.current = setTimeout(() => setShowDetail(true), 500)
  }, [])
  const onLeave = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    setShowDetail(false)
  }, [])

  return (
    <div
      className={`flex flex-col max-w-[65%] ${msg.fromMe ? 'self-end' : 'self-start'} ${animate ? 'animate-msg-slide-in' : ''}`}
    >
      {/* Sender label (incoming only) */}
      {!msg.fromMe && (
        <div className="flex items-center mb-[var(--sp-0h)] pl-[var(--sp-1)] gap-[var(--sp-2)] max-w-full">
          <span className="c-label truncate">{resolveDisplayName(msg.senderName)}</span>
          {onCreateContact && isRawJid(msg.senderName ?? '') && (
            <button
              type="button"
              onClick={() => onCreateContact(resolveDisplayName(msg.senderName))}
              className="c-btn c-btn-ghost c-btn-sm"
              aria-label="Save as contact"
              title="Save as contact"
            >
              <UserPlus size={10} strokeWidth={2} />
            </button>
          )}
        </div>
      )}

      {/* Message bubble — with hover detail card */}
      <div
        className="relative"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        {showDetail && <DetailCard msg={msg} />}
        <div
          className={`c-msg-bubble rounded-lg text-[var(--font-size-body)] ${isMedia ? 'py-[var(--sp-2)] px-[var(--sp-3)]' : 'py-[var(--sp-2h)] px-[var(--msg-pad-h)]'} ${msg.fromMe ? '' : 'bg-d3'}`}
          style={{
            ...(msg.fromMe
              ? { background: outgoingBg, borderBottomRightRadius: 'var(--radius-sm)' }
              : { borderBottomLeftRadius: 'var(--radius-sm)' }),
          }}
        >
          <div className="text-t1 leading-relaxed" style={{ overflowWrap: 'break-word' }}>
            <MessageContent msg={msg} highlightQuery={highlightQuery} />
          </div>
        </div>
      </div>

      {/* Timestamp + delivery status + type badge */}
      <div
        className={`flex items-center font-mono text-t5 text-[var(--font-size-xs)] mt-[var(--sp-0h)] py-0 px-[var(--sp-1)] gap-[var(--sp-2)] ${msg.fromMe ? 'justify-end' : ''}`}
      >
        {isMedia && (
          <span className="text-t5 text-[var(--font-size-xs)]">
            {msg.type}
          </span>
        )}
        <span>{formatTime(msg.timestamp)}</span>
        <DeliveryStatus msg={msg} onRetry={onRetry} />
      </div>
    </div>
  )
}

export default MessageBubble
