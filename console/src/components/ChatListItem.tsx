import { type FC } from 'react'
import { escapeDisplayControls, stripMarkdown, resolveDisplayName } from '../lib/text-utils'
import { formatChatTime } from '../lib/format-time'
import { Avatar } from './primitives'
import type { ChatItem } from '../types'

interface ChatListItemProps {
  chat: ChatItem
  isSelected: boolean
  onClick: () => void
  /** Roving-tabindex stop: 0 when this row is the current stop, -1 otherwise.
   *  Owned by ChatList; ChatListItem is a pure presentation row. */
  tabIndex?: number
  isTyping?: boolean
}

const ChatListItem: FC<ChatListItemProps> = ({ chat, isSelected, onClick, tabIndex = 0, isTyping }) => {
  const displayName = resolveDisplayName(chat.name)
  const lastMessageTime = formatChatTime(chat.lastMessageAt)
  const previewText = escapeDisplayControls(stripMarkdown(chat.lastMessagePreview ?? ''))

  return (
    <div
      role="option"
      tabIndex={tabIndex}
      data-conv-key={chat.conversationKey}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      aria-label={`Open conversation with ${displayName}${chat.unreadCount > 0 ? `, ${chat.unreadCount} unread` : ''}`}
      aria-selected={isSelected}
      className={`flex cursor-pointer c-chat-item py-[var(--sp-3)] px-[var(--sp-4)] gap-[var(--sp-3)] c-border-b ${isSelected ? 'active' : ''}`}
      style={isSelected ? { borderLeftWidth: 'var(--bw-accent)', borderLeftStyle: 'solid', borderLeftColor: 'var(--color-m-cht)', paddingLeft: 'var(--msg-pad-h)' } : undefined}
    >
      {/* Avatar — the identity primitive (neutral initials, md size). */}
      <Avatar name={displayName} size="md" aria-label={displayName} />

      {/* Body — fixed layout with overflow control */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {/* Row 1: Name + Time */}
        <div className="flex items-baseline gap-[var(--sp-2)] mb-[var(--sp-0h)]">
          <span
            title={displayName}
            className="text-text-1 font-medium flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-body"
          >
            {displayName}
          </span>
          <span title={lastMessageTime} className="c-label flex-shrink-0 whitespace-nowrap">
            {lastMessageTime}
          </span>
        </div>

        {/* Row 2: Preview / Typing indicator + Unread badge */}
        <div className="flex items-center gap-[var(--sp-2)]">
          {isTyping ? (
            <span className="flex items-center text-m-cht gap-[var(--sp-0h)] flex-1 text-data">
              <span className="typing-dot" style={{ animationDelay: '0ms' }} />
              <span className="typing-dot" style={{ animationDelay: '150ms' }} />
              <span className="typing-dot" style={{ animationDelay: '300ms' }} />
              <span className="ml-[var(--sp-1)]">typing</span>
            </span>
          ) : (
          <span
            title={previewText || undefined}
            className="text-text-2 flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-data"
          >
            {previewText}
          </span>
          )}
          {chat.unreadCount > 0 && (
            <span
              aria-hidden="true"
              className="bg-m-cht text-d0 font-mono font-semibold flex items-center justify-center rounded-full flex-shrink-0 w-[var(--badge-unread)] h-[var(--badge-unread)] text-xs"
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
