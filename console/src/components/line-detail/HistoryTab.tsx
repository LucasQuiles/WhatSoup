import React from 'react'
import { Send, MessageSquareOff, ChevronsUp } from 'lucide-react'
import { useToast } from '../../hooks/toast-context'
import { useInboxComposer, type InboxComposer } from '../../hooks/use-inbox-composer'
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
function HistoryMessages({ messages, outgoingBg, selectedChat, lineName, composer }: {
  messages: Message[]; outgoingBg: string; selectedChat: string; lineName: string; composer: InboxComposer;
}) {
  const toast = useToast()
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const msgText = composer.text
  const isSending = composer.status === 'pending'
  const unconfirmed = composer.status === 'unconfirmed'
  const rejected = composer.status === 'rejected'

  // Reset textarea height when text is cleared
  React.useEffect(() => {
    if (!msgText && textareaRef.current) {
      textareaRef.current.style.height = ''
      textareaRef.current.style.overflow = 'hidden'
    }
  }, [msgText])

  React.useEffect(() => {
    if (composer.status === 'editing' || composer.status === 'rejected') textareaRef.current?.focus()
  }, [lineName, selectedChat, composer.status])

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

      {isSending || unconfirmed || rejected ? (
        <div role="status" className="text-text-2 px-[var(--sp-4)] py-[var(--sp-3)]">
          {isSending ? 'Sending message…' : rejected
            ? 'Message was not sent. Review it before trying again.'
            : 'Send not confirmed. Check this conversation before sending again.'}
          {unconfirmed ? <>
            <Button variant="ghost" onClick={composer.refresh}>Refresh messages</Button>
            <Button variant="ghost" onClick={composer.discard}>Discard draft</Button>
          </> : null}
        </div>
      ) : null}

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
          disabled={isSending || unconfirmed}
          onChange={e => {
            composer.setText(e.target.value)
            const el = e.target
            el.style.height = '0'
            el.style.height = Math.min(el.scrollHeight, 120) + 'px'
            el.style.overflow = el.scrollHeight > 120 ? 'auto' : 'hidden'
          }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void composer.send() } }}
        />
        <ActionButton
          label="Send"
          icon={<Send size={16} strokeWidth={1.75} />}
          className="flex-shrink-0"
          onClick={() => void composer.send()}
          disabled={isSending || unconfirmed || !msgText.trim()}
        />
      </div>
    </>
  )
}

export function HistoryTab({ chats, messages, selectedChat, onSelectChat, mode, lineName, typingJids }: {
  chats: ChatItem[]; messages: Message[]; selectedChat: string | null; onSelectChat: (key: string) => void; mode: Mode; lineName: string; typingJids: Set<string>;
}) {
  const composer = useInboxComposer(selectedChat ? { line: lineName, conversationKey: selectedChat } : null)
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
            composer={composer}
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
