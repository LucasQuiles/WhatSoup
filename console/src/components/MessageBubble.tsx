import { type FC, useState } from 'react'
import { UserPlus, Check } from 'lucide-react'
import { resolveDisplayName } from '../lib/text-utils'
import { formatTime } from '../lib/format-time'
import MessageContent from './MessageContent'
import type { Message } from '../mock-data'

interface MessageBubbleProps {
  msg: Message
  outgoingBg?: string
  onCreateContact?: (senderName: string) => void
  /** When true, plays the slide-in entrance animation. */
  animate?: boolean
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
      className="absolute z-50 pointer-events-none"
      style={{
        bottom: '100%',
        left: 0,
        marginBottom: 'var(--sp-1)',
        padding: 'var(--sp-3) var(--sp-4)',
        background: 'var(--color-d6)',
        border: '1px solid var(--b2)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-md)',
        minWidth: '220px',
        fontSize: 'var(--font-size-sm)',
      }}
    >
      <div className="flex flex-col" style={{ gap: 'var(--sp-1)' }}>
        <div className="flex justify-between">
          <span className="c-label">Time</span>
          <span className="font-mono text-t2" style={{ fontSize: 'var(--font-size-data)' }}>{fullTime}</span>
        </div>
        <div className="flex justify-between">
          <span className="c-label">Sender</span>
          <span className="font-mono text-t2 truncate" style={{ fontSize: 'var(--font-size-data)', maxWidth: '160px' }}>
            {resolveDisplayName(msg.senderName) || (msg.fromMe ? 'You' : '—')}
          </span>
        </div>
        {msg.senderJid && (
          <div className="flex justify-between">
            <span className="c-label">JID</span>
            <span className="font-mono text-t4 truncate" style={{ fontSize: 'var(--font-size-xs)', maxWidth: '160px' }}>
              {msg.senderJid}
            </span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="c-label">Type</span>
          <span className="font-mono text-t2" style={{ fontSize: 'var(--font-size-data)' }}>{msg.type}</span>
        </div>
        <div className="flex justify-between">
          <span className="c-label">Direction</span>
          <span className="font-mono text-t2" style={{ fontSize: 'var(--font-size-data)' }}>{msg.fromMe ? 'Outbound' : 'Inbound'}</span>
        </div>
        <div className="flex justify-between" style={{ borderTop: '1px solid var(--b1)', paddingTop: 'var(--sp-1)', marginTop: 'var(--sp-1)' }}>
          <span className="c-label">ID</span>
          <span className="font-mono text-t5" style={{ fontSize: 'var(--font-size-xs)' }}>
            {msg.pk < 0 ? 'pending' : `pk:${msg.pk}`}
          </span>
        </div>
      </div>
    </div>
  )
}

/** Delivery status indicator for outgoing messages. */
const DeliveryStatus: FC<{ msg: Message }> = ({ msg }) => {
  if (!msg.fromMe) return null

  // Optimistic messages (negative pk) show single check in muted color
  const isPending = msg.pk < 0
  if (isPending) {
    return <Check size={12} strokeWidth={2} className="text-t5" style={{ opacity: 0.5 }} />
  }

  // Persisted messages — confirmed sent (single check in accent color)
  return <Check size={12} strokeWidth={2} className="text-m-cht" />
}

const MessageBubble: FC<MessageBubbleProps> = ({ msg, outgoingBg = 'var(--m-cht-soft)', onCreateContact, animate }) => {
  const isMedia = msg.type !== 'text'
  const [showDetail, setShowDetail] = useState(false)

  return (
    <div
      className={`flex flex-col max-w-[65%] ${msg.fromMe ? 'self-end' : 'self-start'}`}
      style={animate ? {
        animation: 'msg-slide-in 0.25s ease-out both',
      } : undefined}
    >
      {/* Sender label (incoming only) */}
      {!msg.fromMe && (
        <div className="flex items-center" style={{ marginBottom: '2px', paddingLeft: 'var(--sp-1)', gap: 'var(--sp-2)' }}>
          <span className="c-label">{resolveDisplayName(msg.senderName)}</span>
          {onCreateContact && isRawJid(msg.senderName ?? '') && (
            <button
              onClick={() => onCreateContact(resolveDisplayName(msg.senderName))}
              className="c-hover cursor-pointer text-t5 hover:text-m-cht"
              style={{ fontSize: 'var(--font-size-xs)' }}
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
        onMouseEnter={() => setShowDetail(true)}
        onMouseLeave={() => setShowDetail(false)}
      >
        {showDetail && <DetailCard msg={msg} />}
        <div
          className="c-msg-bubble"
          style={{
            padding: isMedia ? 'var(--sp-2) var(--sp-3)' : 'var(--sp-2h) var(--msg-pad-h)',
            borderRadius: 'var(--radius-lg)',
            fontSize: 'var(--font-size-body)',
            ...(msg.fromMe
              ? { background: outgoingBg, borderBottomRightRadius: 'var(--radius-sm)' }
              : { background: 'var(--color-d3)', borderBottomLeftRadius: 'var(--radius-sm)' }),
          }}
        >
          <div className="text-t1 leading-relaxed" style={{ overflowWrap: 'break-word' }}>
            <MessageContent msg={msg} />
          </div>
        </div>
      </div>

      {/* Timestamp + delivery status + type badge */}
      <div
        className={`flex items-center font-mono text-t5 ${msg.fromMe ? 'justify-end' : ''}`}
        style={{ fontSize: 'var(--font-size-xs)', marginTop: '2px', padding: '0 var(--sp-1)', gap: 'var(--sp-2)' }}
      >
        {isMedia && (
          <span className="text-t5" style={{ fontSize: 'var(--font-size-xs)' }}>
            {msg.type}
          </span>
        )}
        <span>{formatTime(msg.timestamp)}</span>
        <DeliveryStatus msg={msg} />
      </div>
    </div>
  )
}

export default MessageBubble
