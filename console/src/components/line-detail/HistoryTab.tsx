import React from 'react'
import { Send, MessageSquareOff, ChevronsUp } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useToast } from '../../hooks/toast-context'
import { api } from '../../lib/api'
import { useVirtualMessages } from '../../hooks/use-virtual-messages'
import { selectVirtualMessageRows } from '../../lib/inbox-virtualization'
import { useStickyScroll } from '../../hooks/use-sticky-scroll'
import EmptyState from '../EmptyState'
import ChatListItem from '../ChatListItem'
import MessageBubble from '../MessageBubble'
import { TextArea } from '../primitives'
import { Button } from '../primitives/Button'
import { ActionButton } from '../primitives/ActionButton'
import type { Mode, ChatItem, Message } from './types'

/* HistoryMessages — scroll-to-bottom + load older + send input */
function HistoryMessages({ messages, outgoingBg, selectedChat, lineName, transport }: {
  messages: Message[]; outgoingBg: string; selectedChat: string; lineName: string; transport?: string | null;
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const [msgText, setMsgText] = React.useState('')
  const [isSending, setIsSending] = React.useState(false)

  // Reset textarea height when text is cleared
  React.useEffect(() => {
    if (!msgText && textareaRef.current) {
      textareaRef.current.style.height = ''
      textareaRef.current.style.overflow = 'hidden'
    }
  }, [msgText])

  // Clear message input when switching conversations
  React.useEffect(() => { setMsgText('') }, [selectedChat])

  // Cursor pagination state
  const [olderMessages, setOlderMessages] = React.useState<Message[]>([])
  const [loadingOlder, setLoadingOlder] = React.useState(false)
  const [hasMore, setHasMore] = React.useState(true)

  // Reset pagination when conversation changes
  React.useEffect(() => { setOlderMessages([]); setHasMore(true) }, [selectedChat])

  const loadOlder = async () => {
    if (loadingOlder || !hasMore) return
    const allMsgs = [...(messages || []), ...olderMessages]
    const positivePks = allMsgs.map(m => m.pk).filter(pk => pk > 0)
    const oldestPk = positivePks.length > 0 ? Math.min(...positivePks) : undefined
    if (!oldestPk) return

    setLoadingOlder(true)
    try {
      const older = await api.getMessages(lineName, selectedChat, oldestPk)
      if (older.length === 0) {
        setHasMore(false)
      } else {
        setOlderMessages(prev => [...prev, ...older])
      }
    } catch (e) {
      toast.error(`Failed to load older messages: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoadingOlder(false)
    }
  }

  // Track which message PKs were just added optimistically so we can animate them
  const [animatedPks, setAnimatedPks] = React.useState<Set<number>>(new Set())

  const handleSend = async () => {
    if (!msgText.trim() || !selectedChat || isSending) return
    const text = msgText.trim()
    setIsSending(true)
    setMsgText('')

    // Optimistic: inject message into cache immediately with a negative pk
    const optimisticPk = -Date.now()
    const optimisticMsg: Message = {
      pk: optimisticPk,
      conversationKey: selectedChat,
      senderName: 'You',
      senderJid: '',
      content: text,
      timestamp: new Date().toISOString(),
      fromMe: true,
      type: 'text',
    }
    const queryKey = ['messages', lineName, selectedChat]
    queryClient.setQueryData<Message[]>(queryKey, (old) => [optimisticMsg, ...(old ?? [])])
    setAnimatedPks(prev => new Set(prev).add(optimisticPk))

    try {
      await api.sendMessage(lineName, selectedChat, text)
      // Refetch to get the real persisted message (replaces the optimistic one)
      queryClient.invalidateQueries({ queryKey })
    } catch (e) {
      // Remove optimistic message on failure
      queryClient.setQueryData<Message[]>(queryKey, (old) => (old ?? []).filter(m => m.pk !== optimisticPk))
      toast.error(`Send failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setIsSending(false)
      // Drop the optimistic PK from the animation set: the entrance animation has played and
      // the optimistic bubble is now replaced by server data (or removed on error). Without
      // this the Set grows by one negative PK per send for the component's lifetime.
      setAnimatedPks(prev => {
        if (!prev.has(optimisticPk)) return prev
        const next = new Set(prev)
        next.delete(optimisticPk)
        return next
      })
    }
  }

  // Combine live + older messages, deduplicate by pk
  const allMessages = React.useMemo(() => {
    const combined = [...(messages || []), ...olderMessages]
    const seen = new Set<number>()
    return combined.filter(m => { if (seen.has(m.pk)) return false; seen.add(m.pk); return true })
  }, [messages, olderMessages])

  const reversed = React.useMemo(() => [...allMessages].reverse(), [allMessages])

  // Shared auto-scroll hook
  const { scrollRef: stickyScrollRef, showJump: showJumpToBottom, handleScroll, jumpToBottom } = useStickyScroll(reversed, selectedChat)

  // Virtual scrolling for message list
  const messageVirtualizer = useVirtualMessages({
    messages: reversed,
    getScrollElement: () => stickyScrollRef.current,
  })
  const virtualMessageRows = selectVirtualMessageRows(reversed, messageVirtualizer.getVirtualItems())

  return (
    <>
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={stickyScrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto scrollbar-hide py-[var(--sp-4)] px-[var(--sp-5)]"
      >
        {/* Load older messages */}
        {reversed.length > 0 && (
          hasMore ? (
            <Button
              variant="ghost"
              size="sm"
              className="w-full flex items-center justify-center c-hover text-text-2 pt-[var(--sp-3)] pb-[var(--sp-4)] gap-[var(--sp-2)]"
              onClick={loadOlder}
              loading={loadingOlder}
              icon={<ChevronsUp size={14} strokeWidth={1.75} />}
            >
              <span className="text-sm">
                {loadingOlder ? 'Loading...' : 'Load older messages'}
              </span>
            </Button>
          ) : (
            <div
              className="flex items-center justify-center text-text-2 pt-[var(--sp-3)] pb-[var(--sp-4)] gap-[var(--sp-2)]"
            >
              <span className="text-sm">No more messages</span>
            </div>
          )
        )}

        {/* Virtualized message list */}
        <div
          className="relative w-full"
          style={{
            height: `${messageVirtualizer.getTotalSize()}px`,
            minHeight: `${messageVirtualizer.getTotalSize()}px`,
          }}
        >
          {virtualMessageRows.map((row) => (
            <div
              key={String(row.key)}
              ref={messageVirtualizer.measureElement}
              data-index={row.index}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <MessageBubble
                msg={row.message}
                outgoingBg={outgoingBg}
                onCreateContact={(name) => toast.info(`Save contact: ${name}`)}
                animate={animatedPks.has(row.message.pk)}
                transport={transport}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Jump to newest */}
      {showJumpToBottom && (
        <Button
          variant="ghost"
          size="sm"
          className="absolute flex items-center justify-center c-hover text-text-2 left-1/2 -translate-x-1/2 bottom-[var(--sp-4)] py-[var(--sp-2)] px-[var(--sp-5)] gap-[var(--sp-2)] rounded-md z-[var(--z-float)]"
          style={{
            background: 'color-mix(in srgb, var(--btn-neutral-bg) 80%, transparent)',
            backdropFilter: 'blur(4px)',
          }}
          onClick={jumpToBottom}
          aria-label="Jump to newest"
          icon={<ChevronsUp size={14} strokeWidth={1.75} className="rotate-180" />}
        >
          <span className="text-sm">Jump to newest</span>
        </Button>
      )}
      </div>

      {/* Input bar */}
      <div
        className="flex flex-shrink-0 items-center py-[var(--sp-3)] px-[var(--sp-4)] gap-[var(--sp-3)] c-border-t bg-surface-raised"
      >
        <TextArea
          ref={textareaRef}
          className="flex-1 text-text-2 placeholder-text-3 leading-tight py-[var(--sp-2h)] px-[var(--sp-4)] text-body"
          rows={1}
          minHeight={0}
          maxHeight="var(--feed-preview-max)"
          resize="none"
          overflow="hidden"
          textFace="sans"
          placeholder="Type a reply..."
          aria-label="Type a reply"
          value={msgText}
          onChange={e => {
            setMsgText(e.target.value)
            const el = e.target
            el.style.height = '0'
            el.style.height = Math.min(el.scrollHeight, 120) + 'px'
            el.style.overflow = el.scrollHeight > 120 ? 'auto' : 'hidden'
          }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
        />
        <ActionButton
          label="Send"
          icon={<Send size={16} strokeWidth={1.75} />}
          className="flex-shrink-0"
          onClick={handleSend}
          disabled={isSending || !msgText.trim()}
        />
      </div>
    </>
  )
}

export function HistoryTab({ chats, messages, selectedChat, onSelectChat, mode, lineName, typingJids, transport }: {
  chats: ChatItem[]; messages: Message[]; selectedChat: string | null; onSelectChat: (key: string) => void; mode: Mode; lineName: string; typingJids: Set<string>; transport?: string | null;
}) {
  const outgoingBg = mode === 'agent' ? 'var(--m-agt-soft)' : 'var(--m-cht-soft)'
  return (
    // soup-history-split: container-query root for the split-fold law
    // (DD-18r — list + thread stack below the 640px stress threshold).
    <div className="soup-history-split h-full">
    <div
      className="soup-history-split__row flex overflow-hidden h-full c-border rounded-lg"
    >
      {/* Chat list */}
      <div
        className="soup-history-split__list flex-shrink-0 flex flex-col w-[var(--panel-history)] c-border-r bg-surface-inset"
      >
        {/* Chat list header */}
        <div
          className="flex items-center justify-between flex-shrink-0 bg-surface-raised c-toolbar c-border-b min-h-[var(--toolbar-h)]"
        >
          <span className="c-heading">Conversations</span>
          <span className="c-label">{chats.length} chats</span>
        </div>

        <div className="flex-1 min-h-0 min-w-0 overflow-auto scrollbar-hide">
          {chats.map(chat => (
            <ChatListItem
              key={chat.conversationKey}
              chat={chat}
              isSelected={selectedChat === chat.conversationKey}
              onClick={() => onSelectChat(chat.conversationKey)}
              isTyping={typingJids.has(chat.conversationKey)}
            />
          ))}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 flex flex-col min-h-0 bg-surface-base">
        {selectedChat ? (
          <HistoryMessages
            messages={messages}
            outgoingBg={outgoingBg}
            selectedChat={selectedChat}
            lineName={lineName}
            transport={transport}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={<MessageSquareOff size={40} strokeWidth={1.25} />}
              title="No messages yet"
              description="Select a conversation from the list to view messages."
            />
          </div>
        )}
      </div>
    </div>
    </div>
  )
}
