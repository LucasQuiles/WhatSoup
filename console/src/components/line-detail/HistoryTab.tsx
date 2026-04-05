import React from 'react'
import { Send, MessageSquareOff, Loader2, ChevronsUp } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useToast } from '../../hooks/toast-context'
import { api } from '../../lib/api'
import { useVirtualMessages } from '../../hooks/use-virtual-messages'
import { selectVirtualMessageRows } from '../../lib/inbox-virtualization'
import { useStickyScroll } from '../../hooks/use-sticky-scroll'
import EmptyState from '../EmptyState'
import ChatListItem from '../ChatListItem'
import MessageBubble from '../MessageBubble'
import type { Mode, ChatItem, Message } from './types'

/* HistoryMessages — scroll-to-bottom + load older + send input */
function HistoryMessages({ messages, outgoingBg, selectedChat, lineName }: {
  messages: Message[]; outgoingBg: string; selectedChat: string; lineName: string;
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
        className="flex-1 overflow-y-auto scrollbar-hide"
        style={{ padding: 'var(--sp-4) var(--sp-5)' }}
      >
        {/* Load older messages */}
        {reversed.length > 0 && (
          hasMore ? (
            <div
              className={`flex items-center justify-center c-hover text-t5 ${loadingOlder ? '' : 'cursor-pointer hover:text-t2'}`}
              style={{ padding: 'var(--sp-3) 0 var(--sp-4)', gap: 'var(--sp-2)' }}
              onClick={loadOlder}
            >
              {loadingOlder ? (
                <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
              ) : (
                <ChevronsUp size={14} strokeWidth={1.75} />
              )}
              <span style={{ fontSize: 'var(--font-size-sm)' }}>
                {loadingOlder ? 'Loading...' : 'Load older messages'}
              </span>
            </div>
          ) : (
            <div
              className="flex items-center justify-center text-t5"
              style={{ padding: 'var(--sp-3) 0 var(--sp-4)', gap: 'var(--sp-2)' }}
            >
              <span style={{ fontSize: 'var(--font-size-sm)' }}>No more messages</span>
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
              />
            </div>
          ))}
        </div>
      </div>

      {/* Jump to newest */}
      {showJumpToBottom && (
        <div
          className="absolute flex items-center justify-center cursor-pointer hover:text-t2 c-hover text-t5"
          style={{
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: 'var(--sp-4)',
            padding: 'var(--sp-2) var(--sp-5)',
            gap: 'var(--sp-2)',
            background: 'color-mix(in srgb, var(--color-d4) 80%, transparent)',
            borderRadius: 'var(--radius-md)',
            backdropFilter: 'blur(4px)',
            zIndex: 10,
          }}
          onClick={jumpToBottom}
        >
          <ChevronsUp size={14} strokeWidth={1.75} className="rotate-180" />
          <span style={{ fontSize: 'var(--font-size-sm)' }}>Jump to newest</span>
        </div>
      )}
      </div>

      {/* Input bar */}
      <div
        className="flex flex-shrink-0 items-center"
        style={{ padding: 'var(--sp-3) var(--sp-4)', gap: 'var(--sp-3)', borderTop: 'var(--bw) solid var(--b1)', background: 'var(--color-d2)' }}
      >
        <textarea
          ref={textareaRef}
          className="flex-1 text-t2 font-sans placeholder-t5 outline-none leading-tight"
          rows={1}
          style={{
            fontSize: 'var(--font-size-body)',
            padding: 'var(--sp-2h) var(--sp-4)',
            background: 'var(--color-d1)',
            borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)',
            borderRadius: 'var(--radius-md)',
            maxHeight: '120px',
            resize: 'none',
            overflow: 'hidden',
          }}
          placeholder="Type a reply..."
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
        <button
          className="c-btn c-btn-primary c-btn-send flex-shrink-0"
          onClick={handleSend}
          disabled={isSending || !msgText.trim()}
        >
          <Send size={16} strokeWidth={2} />
          <span className="c-btn-send-label">Send</span>
        </button>
      </div>
    </>
  )
}

export function HistoryTab({ chats, messages, selectedChat, onSelectChat, mode, lineName, typingJids }: {
  chats: ChatItem[]; messages: Message[]; selectedChat: string | null; onSelectChat: (key: string) => void; mode: Mode; lineName: string; typingJids: Set<string>;
}) {
  const outgoingBg = mode === 'agent' ? 'var(--m-agt-soft)' : 'var(--m-cht-soft)'
  return (
    <div
      className="flex overflow-hidden h-full"
      style={{ borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b1)', borderRadius: 'var(--radius-lg)' }}
    >
      {/* Chat list */}
      <div
        className="flex-shrink-0 flex flex-col"
        style={{ width: 'var(--panel-history)', borderRight: 'var(--bw) solid var(--b1)', background: 'var(--color-d1)' }}
      >
        {/* Chat list header */}
        <div
          className="flex items-center justify-between flex-shrink-0 bg-d3 c-toolbar"
          style={{ borderBottom: 'var(--bw) solid var(--b1)', minHeight: 'var(--toolbar-h)' }}
        >
          <span className="c-heading">Conversations</span>
          <span className="c-label">{chats.length} chats</span>
        </div>

        <div className="flex-1 overflow-auto scrollbar-hide">
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
      <div className="flex-1 flex flex-col min-h-0" style={{ background: 'var(--color-d0)' }}>
        {selectedChat ? (
          <HistoryMessages
            messages={messages}
            outgoingBg={outgoingBg}
            selectedChat={selectedChat}
            lineName={lineName}
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
  )
}
