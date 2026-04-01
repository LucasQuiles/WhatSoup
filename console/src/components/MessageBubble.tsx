import { type FC } from 'react'
import { UserPlus } from 'lucide-react'
import { resolveDisplayName } from '../lib/text-utils'
import { formatTime } from '../lib/format-time'
import MessageContent from './MessageContent'
import type { Message } from '../mock-data'

interface MessageBubbleProps {
  msg: Message
  outgoingBg?: string
  onCreateContact?: (senderName: string) => void
}

const isRawJid = (name: string) => /^\d{5,}$/.test(name)

const MessageBubble: FC<MessageBubbleProps> = ({ msg, outgoingBg = 'var(--m-cht-soft)', onCreateContact }) => {
  const isMedia = msg.type !== 'text'

  return (
    <div
      className={`flex flex-col max-w-[65%] ${msg.fromMe ? 'self-end' : 'self-start'}`}
      title={`${msg.type} · ${msg.senderJid ?? ''} · pk:${msg.pk}`}
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

      {/* Message bubble */}
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

      {/* Timestamp + type badge */}
      <div
        className={`flex items-center font-mono text-t5 ${msg.fromMe ? 'justify-end' : ''}`}
        style={{ fontSize: 'var(--font-size-xs)', marginTop: '2px', padding: '0 var(--sp-1)', gap: 'var(--sp-1)' }}
      >
        {isMedia && (
          <span className="text-t5" style={{ fontSize: 'var(--font-size-xs)' }}>
            {msg.type}
          </span>
        )}
        <span>{formatTime(msg.timestamp)}</span>
      </div>
    </div>
  )
}

export default MessageBubble
