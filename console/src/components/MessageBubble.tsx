import { type FC, type ReactNode } from 'react'
import { UserPlus, Check, X, RotateCw } from 'lucide-react'
import { escapeDisplayControls, resolveDisplayName } from '../lib/text-utils'
import { formatFullTime, formatTime } from '../lib/format-time'
import MessageContent from './MessageContent'
import { Button } from './primitives/Button'
import { HoverCard } from './primitives'
import type { Message } from '../types'
import type { TransportKind } from '../lib/transport-meta'

interface MessageBubbleProps {
  msg: Message
  outgoingBg?: string
  onCreateContact?: (senderName: string) => void
  highlightQuery?: string
  /** When true, plays the slide-in entrance animation. */
  animate?: boolean
  /** Called when user clicks retry on a failed message. */
  onRetry?: (msg: Message) => void
  transport?: TransportKind | string | null
}

const isRawJid = (name: string) => /^\d{5,}$/.test(name)

/**
 * The hover/focus detail rows shown inside the HoverCard panel (showcase §43).
 * Time / Sender / JID? / Type / Direction, then a rule-separated ID row. The panel
 * itself (surface, border, shadow, placement, hover-bridge, Escape, edge-anchoring)
 * is owned by the HoverCard primitive — these are only the rows.
 */
const detailRows = (msg: Message): ReactNode => {
  const fullTime = formatFullTime(msg.timestamp)
  const senderDisplayName = resolveDisplayName(msg.senderName) || (msg.fromMe ? 'You' : '—')
  const senderJidDisplay = msg.senderJid ? escapeDisplayControls(msg.senderJid) : ''
  const idValue = msg.pk === -1 ? 'failed' : msg.pk < 0 ? 'sending' : `pk:${msg.pk}`

  return (
    <div className="flex flex-col gap-[var(--sp-2)]">
      {[
        { label: 'Time', value: fullTime },
        { label: 'Sender', value: senderDisplayName },
        ...(senderJidDisplay ? [{ label: 'JID', value: senderJidDisplay, muted: true }] : []),
        { label: 'Type', value: msg.type },
        { label: 'Direction', value: msg.fromMe ? 'Outbound' : 'Inbound' },
      ].map(({ label, value, muted }) => (
        <div key={label} className="flex justify-between gap-[var(--sp-4)]">
          <span className="c-label flex-shrink-0">{label}</span>
          <span title={value} className={`c-data truncate max-w-[var(--tooltip-val-max)] ${muted ? 'text-text-3' : ''}`}>
            {value}
          </span>
        </div>
      ))}
      <div className="pt-[var(--sp-2)] mt-[var(--sp-1)] c-border-t-b2">
        <div className="flex justify-between">
          <span className="c-label">ID</span>
          <span className="c-data text-text-3">{idValue}</span>
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRetry(msg)}
            aria-label="Retry send"
            title="Retry send"
          >
            <RotateCw size={10} strokeWidth={2.5} className="text-text-1" />
          </Button>
        )}
      </span>
    )
  }

  // Optimistic messages (negative pk) — pending, muted check
  if (msg.pk < 0) {
    return <Check size={12} strokeWidth={1.75} className="text-text-3" style={{ opacity: 'var(--opacity-soft)' }} />
  }

  // Persisted messages — confirmed sent, green check
  return <Check size={12} strokeWidth={1.75} className="text-s-ok" />
}

const MessageBubble: FC<MessageBubbleProps> = ({ msg, outgoingBg = 'var(--m-cht-soft)', onCreateContact, highlightQuery, animate, onRetry, transport }) => {
  const isMedia = msg.type !== 'text'
  const senderDisplayName = resolveDisplayName(msg.senderName)

  return (
    <div
      className={`flex flex-col max-w-[var(--message-bubble-max-w)] ${msg.fromMe ? 'self-end' : 'self-start'}${animate ? ' msg-slide-in' : ''}`}
    >
      {/* Sender label (incoming only) */}
      {!msg.fromMe && (
        <div className="flex items-center mb-[var(--bw-accent)] pl-[var(--sp-1)] gap-[var(--sp-2)] max-w-full">
          <span title={senderDisplayName} className="c-label truncate">{senderDisplayName}</span>
          {onCreateContact && isRawJid(msg.senderName ?? '') && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onCreateContact(senderDisplayName)}
              aria-label="Save as contact"
              title="Save as contact"
            >
              <UserPlus size={10} strokeWidth={1.75} />
            </Button>
          )}
        </div>
      )}

      {/* Message bubble — the trigger; HoverCard owns the hover/focus detail panel
          (hover-bridge, 500ms reveal, Escape, edge-anchoring, OR-semantics). */}
      <HoverCard
        anchorX="edge"
        cardLabel="Message detail"
        openDelay={500}
        className="soup-hovercard--block"
        card={detailRows(msg)}
      >
        <div
          tabIndex={0}
          aria-label="Message detail"
          className={`text-body c-msg-bubble rounded-lg${msg.fromMe ? '' : ' bg-surface-raised'}`}
          style={{
            padding: isMedia ? 'var(--sp-2) var(--sp-3)' : 'var(--sp-2h) var(--msg-pad-h)',
            ...(msg.fromMe
              ? { background: outgoingBg, borderBottomRightRadius: 'var(--radius-sm)' }
              : { borderBottomLeftRadius: 'var(--radius-sm)' }),
          }}
        >
          <div className="text-text-1 leading-relaxed" style={{ overflowWrap: 'break-word' }}>
            <MessageContent msg={msg} highlightQuery={highlightQuery} transport={transport} />
          </div>
        </div>
      </HoverCard>

      {/* Timestamp + delivery status + type badge */}
      <div
        className={`text-xs flex items-center font-mono text-text-2 mt-[var(--bw-accent)] py-0 px-[var(--sp-1)] gap-[var(--sp-2)] ${msg.fromMe ? 'justify-end' : ''}`}
      >
        {isMedia && (
          <span className="text-xs text-text-2">
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
