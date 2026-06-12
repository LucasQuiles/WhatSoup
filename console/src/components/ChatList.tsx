/**
 * ChatList — listbox-pattern home for the Inbox chat list.
 *
 * Roving tabindex contract (DD-17):
 *   - Exactly one tab stop: the selected row (tabIndex 0), falling back to the
 *     first row when nothing is selected.
 *   - ArrowDown / ArrowUp move focus WITHOUT changing selection (manual
 *     activation). Selection fires only on Enter / Space — or via onClick,
 *     which the item already handles. This keeps arrow traversal from
 *     triggering message fetches on every keystroke (§6.4).
 *   - Home / End jump to first / last row.
 *   - Clamp at both ends (no wrap — consistent with B2 option-list clamp, C-B4-7).
 *   - Roving target is tracked by conversationKey, not index, so focus survives
 *     a chats-array reorder or partial removal (§6.5).
 *   - If the focused chat is removed from the list the stop falls back to the
 *     selected row, or the first row, without stealing focus from outside the
 *     list.
 */
import { type FC, useCallback, useRef, useState } from 'react'
import type { ChatItem } from '../types'
import ChatListItem from './ChatListItem'

interface ChatListProps {
  chats: ChatItem[]
  selectedChat: string | null
  onSelect: (conversationKey: string) => void
  typingKeys?: ReadonlySet<string>
}

const ChatList: FC<ChatListProps> = ({ chats, selectedChat, onSelect, typingKeys }) => {
  // The last key that received explicit keyboard or click focus within the list.
  // Updated only in event handlers (arrow keys, click) — never in effects.
  // When this key is no longer present in the chats array the tab-stop
  // computation below falls back to selectedChat or the first row.
  const [rovingKey, setRovingKey] = useState<string | null>(null)

  // Resolve the effective tab stop for this render:
  //   1. The last explicitly navigated key — if still in the list.
  //   2. The selected chat — if present.
  //   3. The first chat.
  //   4. null (empty list — handled by the early-return branch below).
  const chatKeys = new Set(chats.map(c => c.conversationKey))
  const tabStopKey = (() => {
    if (rovingKey && chatKeys.has(rovingKey)) return rovingKey
    if (selectedChat && chatKeys.has(selectedChat)) return selectedChat
    return chats[0]?.conversationKey ?? null
  })()

  const listRef = useRef<HTMLDivElement | null>(null)

  // Focus the DOM row for a given key imperatively (roving keyboard move).
  // Iterates over [data-conv-key] elements — avoids CSS.escape, which is
  // not available in all test environments.
  const focusRow = useCallback((key: string) => {
    if (!listRef.current) return
    const rows = listRef.current.querySelectorAll<HTMLElement>('[data-conv-key]')
    for (const row of Array.from(rows)) {
      if (row.getAttribute('data-conv-key') === key) {
        row.focus()
        return
      }
    }
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const navigable = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!navigable.includes(e.key)) return
    if (chats.length === 0) return

    e.preventDefault()

    // Use the pre-computed tab stop as the current position anchor.
    const currentIndex = chats.findIndex(c => c.conversationKey === tabStopKey)
    let nextIndex = currentIndex < 0 ? 0 : currentIndex

    if (e.key === 'ArrowDown') nextIndex = Math.min(nextIndex + 1, chats.length - 1)
    if (e.key === 'ArrowUp') nextIndex = Math.max(nextIndex - 1, 0)
    if (e.key === 'Home') nextIndex = 0
    if (e.key === 'End') nextIndex = chats.length - 1

    const next = chats[nextIndex]
    if (!next) return
    setRovingKey(next.conversationKey)
    focusRow(next.conversationKey)
  }, [chats, tabStopKey, focusRow])

  if (chats.length === 0) {
    return (
      <div
        role="listbox"
        aria-label="Chat conversations"
        aria-multiselectable="false"
        className="flex-1 overflow-auto scrollbar-hide"
      >
        <div className="text-center py-[var(--sp-8)] px-[var(--sp-4)]">
          <span className="c-body">No chats found</span>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Chat conversations"
      aria-multiselectable="false"
      className="flex-1 overflow-auto scrollbar-hide"
      onKeyDown={handleKeyDown}
    >
      {chats.map(chat => (
        <ChatListItem
          key={chat.conversationKey}
          chat={chat}
          isSelected={selectedChat === chat.conversationKey}
          tabIndex={chat.conversationKey === tabStopKey ? 0 : -1}
          onClick={() => {
            setRovingKey(chat.conversationKey)
            onSelect(chat.conversationKey)
          }}
          isTyping={typingKeys?.has(chat.conversationKey)}
        />
      ))}
    </div>
  )
}

export default ChatList
