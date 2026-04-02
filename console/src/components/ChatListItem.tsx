import { type FC } from 'react'
import { getInitials, stripMarkdown, resolveDisplayName } from '../lib/text-utils'
import { formatChatTime } from '../lib/format-time'
import type { ChatItem } from '../types'

interface ChatListItemProps {
  chat: ChatItem
  isSelected: boolean
  onClick: () => void
  isTyping?: boolean
}

const ChatListItem: FC<ChatListItemProps> = ({ chat, isSelected, onClick, isTyping }) => {
  const displayName = resolveDisplayName(chat.name)

  return (
    <div
      onClick={onClick}
      className={`flex cursor-pointer c-chat-item ${isSelected ? 'active' : ''}`}
      style={{
        padding: 'var(--sp-3) var(--sp-4)',
        gap: 'var(--sp-3)',
        borderBottom: 'var(--bw) solid var(--b1)',
        ...(isSelected ? { borderLeft: 'var(--bw-accent) solid var(--color-m-cht)', paddingLeft: 'var(--msg-pad-h)' } : {}),
      }}
    >
      {/* Avatar — fixed size */}
      <div
        className="rounded-full flex items-center justify-center flex-shrink-0 font-mono text-t3 font-semibold"
        style={{ width: 'var(--avatar-md)', height: 'var(--avatar-md)', background: 'var(--color-d5)', fontSize: 'var(--font-size-sm)' }}
      >
        {getInitials(displayName)}
      </div>

      {/* Body — fixed layout with overflow control */}
      <div className="flex-1" style={{ minWidth: 0, overflow: 'hidden' }}>
        {/* Row 1: Name + Time */}
        <div className="flex items-baseline" style={{ marginBottom: '2px', gap: 'var(--sp-2)' }}>
          <span
            className="text-t1 font-medium"
            style={{
              fontSize: 'var(--font-size-body)',
              flex: '1 1 0',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {displayName}
          </span>
          <span
            className="c-label flex-shrink-0"
            style={{ whiteSpace: 'nowrap' }}
          >
            {formatChatTime(chat.lastMessageAt)}
          </span>
        </div>

        {/* Row 2: Preview / Typing indicator + Unread badge */}
        <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
          {isTyping ? (
            <span className="flex items-center text-m-cht" style={{ fontSize: 'var(--font-size-data)', flex: '1 1 0', gap: '3px' }}>
              <span className="typing-dot" style={{ animationDelay: '0ms' }} />
              <span className="typing-dot" style={{ animationDelay: '150ms' }} />
              <span className="typing-dot" style={{ animationDelay: '300ms' }} />
              <span style={{ marginLeft: 'var(--sp-1)' }}>typing</span>
            </span>
          ) : (
          <span
            className="text-t4"
            style={{
              fontSize: 'var(--font-size-data)',
              flex: '1 1 0',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {stripMarkdown(chat.lastMessagePreview ?? '')}
          </span>
          )}
          {chat.unreadCount > 0 && (
            <span
              className="bg-m-cht text-d0 font-mono font-semibold flex items-center justify-center rounded-full flex-shrink-0"
              style={{ fontSize: 'var(--font-size-xs)', width: 'var(--badge-unread)', height: 'var(--badge-unread)' }}
            >
              {chat.unreadCount}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

export default ChatListItem
