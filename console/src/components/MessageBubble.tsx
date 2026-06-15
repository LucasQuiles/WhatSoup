import { type FC, useState, useRef, useCallback } from 'react'
import { UserPlus, Check, X, RotateCw } from 'lucide-react'
import { resolveDisplayName } from '../lib/text-utils'
import { formatFullTime, formatTime } from '../lib/format-time'
import MessageContent from './MessageContent'
import { Button } from './primitives/Button'
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

/** Card placement resolved by edge measurement. */
type CardPlacement = 'above' | 'below'

const isRawJid = (name: string) => /^\d{5,}$/.test(name)

/** Styled hover/focus detail card — shown on hover or focus. */
const DetailCard: FC<{ msg: Message; placement: CardPlacement; rightAnchored: boolean }> = ({
  msg,
  placement,
  rightAnchored,
}) => {
  const fullTime = formatFullTime(msg.timestamp)
  const senderDisplayName = resolveDisplayName(msg.senderName) || (msg.fromMe ? 'You' : '—')

  const style: React.CSSProperties =
    placement === 'below'
      ? { top: '100%', left: rightAnchored ? undefined : 0, right: rightAnchored ? 0 : undefined }
      : { bottom: '100%', left: rightAnchored ? undefined : 0, right: rightAnchored ? 0 : undefined }

  return (
    <div
      data-placement={placement}
      className="absolute z-[var(--z-float)] pointer-events-none c-card c-card--detail mb-[var(--sp-2)]"
      style={style}
    >
      <div className="flex flex-col gap-[var(--sp-2)]">
        {[
          { label: 'Time', value: fullTime },
          { label: 'Sender', value: senderDisplayName },
          ...(msg.senderJid ? [{ label: 'JID', value: msg.senderJid, muted: true }] : []),
          { label: 'Type', value: msg.type },
          { label: 'Direction', value: msg.fromMe ? 'Outbound' : 'Inbound' },
        ].map(({ label, value, muted }) => (
          <div key={label} className="flex justify-between gap-[var(--sp-4)]">
            <span className="c-label flex-shrink-0">{label}</span>
            <span title={value} className={`c-data truncate max-w-[var(--tooltip-val-max)] ${muted ? 'text-t5' : ''}`}>
              {value}
            </span>
          </div>
        ))}
        <div className="pt-[var(--sp-2)] mt-[var(--sp-1)] c-border-t-b2">
          <div className="flex justify-between">
            <span className="c-label">ID</span>
            <span className="c-data text-t5">
              {msg.pk === -1 ? 'failed' : msg.pk < 0 ? 'sending' : `pk:${msg.pk}`}
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRetry(msg)}
            aria-label="Retry send"
            title="Retry send"
          >
            <RotateCw size={10} strokeWidth={2.5} className="text-t1" />
          </Button>
        )}
      </span>
    )
  }

  // Optimistic messages (negative pk) — pending, muted check
  if (msg.pk < 0) {
    return <Check size={12} strokeWidth={1.75} className="text-t5" style={{ opacity: 'var(--opacity-soft)' }} />
  }

  // Persisted messages — confirmed sent, green check
  return <Check size={12} strokeWidth={1.75} className="text-s-ok" />
}

const MessageBubble: FC<MessageBubbleProps> = ({ msg, outgoingBg = 'var(--m-cht-soft)', onCreateContact, highlightQuery, animate, onRetry }) => {
  const isMedia = msg.type !== 'text'
  const [showByHover, setShowByHover] = useState(false)
  const [showByFocus, setShowByFocus] = useState(false)
  const [placement, setPlacement] = useState<CardPlacement>('above')
  const [rightAnchored, setRightAnchored] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const showDetail = showByHover || showByFocus
  const senderDisplayName = resolveDisplayName(msg.senderName)

  /**
   * Measure the wrapper position and resolve card placement + right-anchor.
   * Card is absolutely positioned relative to the wrapper. We estimate card
   * height (160px) and width (220px) to detect viewport clipping.
   *
   * Zero-rect guard: when width, height, and all coordinates are zero (jsdom
   * default), the measurement is uninformative — keep the default 'above'/
   * left-anchored placement so tests that do not stub rects run unchanged.
   */
  const measureAndSetPlacement = useCallback(() => {
    if (!wrapperRef.current) return
    const rect = wrapperRef.current.getBoundingClientRect()
    // Uninformative zero-rect (jsdom default) — keep defaults
    if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0) return
    const estimatedCardHeight = 160
    const estimatedCardWidth = 220
    const wouldClipTop = rect.top - estimatedCardHeight < 0
    const wouldClipRight = rect.left + estimatedCardWidth > window.innerWidth
    setPlacement(wouldClipTop ? 'below' : 'above')
    setRightAnchored(wouldClipRight)
  }, [])

  // ── Hover path (500ms delay — byte-identical to original semantics) ────────
  const onEnter = useCallback(() => {
    hoverTimer.current = setTimeout(() => {
      measureAndSetPlacement()
      setShowByHover(true)
    }, 500)
  }, [measureAndSetPlacement])

  const onLeave = useCallback(() => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    setShowByHover(false)
  }, [])

  // ── Focus path (instant reveal per motion law §7) ─────────────────────────
  const onFocus = useCallback(() => {
    measureAndSetPlacement()
    setShowByFocus(true)
  }, [measureAndSetPlacement])

  const onBlur = useCallback(() => {
    setShowByFocus(false)
  }, [])

  // ── Escape dismiss (one-layer law §2 — stopPropagation) ───────────────────
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape' && showDetail) {
        e.stopPropagation()
        setShowByHover(false)
        setShowByFocus(false)
        if (hoverTimer.current) {
          clearTimeout(hoverTimer.current)
          hoverTimer.current = null
        }
      }
    },
    [showDetail],
  )

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

      {/* Message bubble — with hover/focus detail card */}
      <div
        ref={wrapperRef}
        className="relative"
        tabIndex={0}
        aria-label="Message detail"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      >
        {showDetail && <DetailCard msg={msg} placement={placement} rightAnchored={rightAnchored} />}
        <div
          className={`text-body c-msg-bubble rounded-lg${msg.fromMe ? '' : ' bg-d3'}`}
          style={{
            padding: isMedia ? 'var(--sp-2) var(--sp-3)' : 'var(--sp-2h) var(--msg-pad-h)',
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
        className={`text-xs flex items-center font-mono text-t2 mt-[var(--bw-accent)] py-0 px-[var(--sp-1)] gap-[var(--sp-2)] ${msg.fromMe ? 'justify-end' : ''}`}
      >
        {isMedia && (
          <span className="text-xs text-t2">
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
