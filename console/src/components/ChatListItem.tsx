import { type FC } from 'react'
import { getInitials, stripMarkdown, resolveDisplayName } from '../lib/text-utils'
import { formatChatTime } from '../lib/format-time'
import type { ChatItem } from '../mock-data'

interface ChatListItemProps {
  chat: ChatItem
  isSelected: boolean
  onClick: () => void
}

const ChatListItem: FC<ChatListItemProps> = ({ chat, isSelected, onClick }) => {
  return (
    <div
      onClick={onClick}
      className={`flex cursor-pointer c-chat-item ${isSelected ? 'active' : ''}`}
      style={{
        padding: 'var(--sp-3) var(--sp-4)',
        gap: 'var(--sp-3)',
        borderBottom: '1px solid var(--b1)',
        ...(isSelected ? { borderLeft: '2px solid var(--color-m-cht)', paddingLeft: 'var(--msg-pad-h)' } : {}),
      }}
    >
      {/* Avatar */}
      <div
        className="rounded-full flex items-center justify-center flex-shrink-0 font-mono text-t3 font-semibold"
        style={{ width: 'var(--avatar-md)', height: 'var(--avatar-md)', background: 'var(--color-d5)', fontSize: 'var(--font-size-sm)' }}
      >
        {getInitials(resolveDisplayName(chat.name))}
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between" style={{ marginBottom: '2px' }}>
          <span className="text-t1 font-medium truncate" style={{ fontSize: 'var(--font-size-body)', maxWidth: 'var(--chat-name-max)' }}>
            {resolveDisplayName(chat.name)}
          </span>
          <span className="c-label flex-shrink-0" style={{ marginLeft: 'var(--sp-2)' }}>
            {formatChatTime(chat.lastMessageAt)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <div className="text-t4 truncate" style={{ fontSize: 'var(--font-size-data)' }}>
            {stripMarkdown(chat.lastMessagePreview ?? '')}
          </div>
          {chat.unreadCount > 0 && (
            <span
              className="bg-m-cht text-d0 font-mono font-semibold flex items-center justify-center rounded-full flex-shrink-0"
              style={{ fontSize: 'var(--font-size-xs)', width: 'var(--badge-unread)', height: 'var(--badge-unread)', marginLeft: 'var(--sp-2)' }}
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
