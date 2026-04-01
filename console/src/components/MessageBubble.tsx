import { type FC } from 'react'
import { UserPlus } from 'lucide-react'
import { resolveDisplayName } from '../lib/text-utils'
import { formatTime } from '../lib/format-time'
import type { Message } from '../mock-data'

interface MessageBubbleProps {
  msg: Message
  outgoingBg?: string  // defaults to var(--m-cht-soft)
  onCreateContact?: (senderName: string) => void  // if provided, shows UserPlus icon for raw JIDs
}

const isRawJid = (name: string) => /^\d{5,}$/.test(name)

const MessageBubble: FC<MessageBubbleProps> = ({ msg, outgoingBg = 'var(--m-cht-soft)', onCreateContact }) => {
  return (
    <div className={`flex flex-col max-w-[65%] ${msg.fromMe ? 'self-end' : 'self-start'}`}>
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
      <div
        className="c-msg-bubble"
        style={{
          padding: 'var(--sp-2h) var(--msg-pad-h)',
          borderRadius: 'var(--radius-lg)',
          fontSize: 'var(--font-size-body)',
          ...(msg.fromMe
            ? { background: outgoingBg, borderBottomRightRadius: 'var(--radius-sm)' }
            : { background: 'var(--color-d3)', borderBottomLeftRadius: 'var(--radius-sm)' }),
        }}
      >
        <div className="text-t1 leading-relaxed">{msg.content}</div>
      </div>
      <span
        className={`font-mono text-t5 ${msg.fromMe ? 'text-right' : ''}`}
        style={{ fontSize: 'var(--font-size-xs)', marginTop: '2px', padding: '0 var(--sp-1)' }}
      >
        {formatTime(msg.timestamp)}
      </span>
    </div>
  )
}

export default MessageBubble
