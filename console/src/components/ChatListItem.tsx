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
      role="option"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      aria-label={`Open conversation with ${displayName}`}
      aria-selected={isSelected}
      className={`flex cursor-pointer c-chat-item py-[var(--sp-3)] px-[var(--sp-4)] gap-[var(--sp-3)] c-border-b ${isSelected ? 'active' : ''}`}
      style={isSelected ? { borderLeftWidth: 'var(--bw-accent)', borderLeftStyle: 'solid', borderLeftColor: 'var(--color-m-cht)', paddingLeft: 'var(--msg-pad-h)' } : undefined}
    >
      {/* Avatar — fixed size */}
      <div
        className="rounded-full flex items-center justify-center flex-shrink-0 font-sans text-t3 font-semibold w-[var(--avatar-md)] h-[var(--avatar-md)] bg-d5 text-[var(--font-size-sm)]"
      >
        {getInitials(displayName)}
      </div>

      {/* Body — fixed layout with overflow control */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {/* Row 1: Name + Time */}
        <div className="flex items-baseline gap-[var(--sp-2)] mb-[var(--sp-0h)]">
          <span
            className="text-t1 font-medium flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--font-size-body)]"
          >
            {displayName}
          </span>
          <span className="c-label flex-shrink-0 whitespace-nowrap">
            {formatChatTime(chat.lastMessageAt)}
          </span>
        </div>

        {/* Row 2: Preview / Typing indicator + Unread badge */}
        <div className="flex items-center gap-[var(--sp-2)]">
          {isTyping ? (
            <span className="flex items-center text-m-cht gap-[var(--sp-0h)] flex-1 text-[var(--font-size-data)]">
              <span className="typing-dot" style={{ animationDelay: '0ms' }} />
              <span className="typing-dot" style={{ animationDelay: '150ms' }} />
              <span className="typing-dot" style={{ animationDelay: '300ms' }} />
              <span className="ml-[var(--sp-1)]">typing</span>
            </span>
          ) : (
          <span
            className="text-t4 flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--font-size-data)]"
          >
            {stripMarkdown(chat.lastMessagePreview ?? '')}
          </span>
          )}
          {chat.unreadCount > 0 && (
            <span
              className="bg-m-cht text-d0 font-mono font-semibold flex items-center justify-center rounded-full flex-shrink-0 w-[var(--badge-unread)] h-[var(--badge-unread)] text-[var(--font-size-xs)]"
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
