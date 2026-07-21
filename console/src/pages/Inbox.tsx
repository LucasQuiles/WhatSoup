import { useState, useEffect, useRef, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useLines, useChats, useMessages, useTyping } from '../hooks/use-fleet'
import { useTransportStatus } from '../hooks/use-transport-status'
import { useToast } from '../hooks/toast-context'
import { useStickyScroll } from '../hooks/use-sticky-scroll'
import { useVirtualMessages } from '../hooks/use-virtual-messages'
import { api } from '../lib/api'
import { resolveCurrentChat } from '../lib/inbox-chat-selection'
import { selectVirtualMessageRows, toChronologicalMessages } from '../lib/inbox-virtualization'
import type { Message, ChatItem } from '../types'
import EmptyState from '../components/EmptyState'
import { SaveContactDialog } from '../components/SaveContactDialog'
import ChatList from '../components/ChatList'
import MessageBubble from '../components/MessageBubble'
import LinePicker from '../components/LinePicker'
import { MessageSquare, Send, UserCheck, UserPlus, Ban, User, Users, ChevronDown, ChevronLeft, ChevronsUp, Loader2, Search, X, CheckCheck } from 'lucide-react'
import { SearchInput } from '../components/shared/SearchInput.js'
import { Button } from '../components/primitives/Button'
import { ActionButton } from '../components/primitives/ActionButton'
import { TextArea, Card } from '../components/primitives'
import { resolveDisplayName } from '../lib/text-utils'

export default function Inbox() {
  const { data: lines } = useLines()
  const transport = useTransportStatus()
  const toast = useToast()
  const [selectedLine, setSelectedLine] = useState<string>('')
  const [selectedChat, setSelectedChat] = useState<string | null>(null)
  const [msgText, setMsgText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [searchInput, setSearchInput] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [saveContactChat, setSaveContactChat] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const searchScrollRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current) return;
    const lineParam = searchParams.get('line');
    const chatParam = searchParams.get('chat');
    if (lineParam) {
      deepLinked.current = true;
      setSelectedLine(lineParam);
      if (chatParam) setSelectedChat(chatParam);
      // Clear params so back-navigation doesn't re-trigger
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Clear message input when switching chats or lines
  useEffect(() => { setMsgText('') }, [selectedChat, selectedLine])

  // Reset hasMore when chat changes
  useEffect(() => { setHasMore(true) }, [selectedChat, selectedLine])

  // Reset in-panel search when switching chats or lines
  useEffect(() => {
    setSearchInput('')
    setDebouncedSearch('')
  }, [selectedChat, selectedLine])

  // Auto-focus textarea when a chat is selected
  useEffect(() => {
    if (selectedChat && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [selectedChat])

  // Reset textarea height when text is cleared
  useEffect(() => {
    if (!msgText && textareaRef.current) {
      textareaRef.current.style.height = ''
      textareaRef.current.style.overflow = 'hidden'
    }
  }, [msgText])

  useEffect(() => {
    const trimmed = searchInput.trim()
    const timer = setTimeout(() => setDebouncedSearch(trimmed), trimmed ? 300 : 0)
    return () => clearTimeout(timer)
  }, [searchInput])

  const activeLine = selectedLine || (lines?.[0]?.name ?? '')
  const { data: chats, isError: chatsError } = useChats(activeLine)
  const { data: messages } = useMessages(activeLine, selectedChat || '')
  const { data: typingData } = useTyping()
  const typingJids = useMemo(() =>
    new Set((typingData ?? []).filter(t => t.instance === activeLine).map(t => t.jid)),
    [typingData, activeLine],
  )

  const currentLine = lines?.find(l => l.name === activeLine)
  const activeTransport = currentLine?.transport ?? currentLine?.health?.transport?.kind
  const currentChat = resolveCurrentChat(chats, selectedChat, messages)
  const isSearchMode = searchInput.trim().length > 0
  const isDebouncingSearch = isSearchMode && searchInput.trim() !== debouncedSearch

  // Search via React Query — cached, deduped, auto loading/error states
  const searchEnabled = !!selectedChat && !!debouncedSearch
  const { data: searchData, isLoading: searchLoading, error: searchQueryError, refetch: refetchSearch } = useQuery({
    queryKey: ['search', activeLine, selectedChat, debouncedSearch],
    queryFn: () => api.searchMessages(activeLine, debouncedSearch, selectedChat!),
    enabled: searchEnabled,
    staleTime: 30_000, // Cache search results for 30s
  })
  const searchResults = searchData?.results ?? []
  const searchTotal = searchData?.total ?? 0
  const searchError = searchQueryError ? (searchQueryError instanceof Error ? searchQueryError.message : String(searchQueryError)) : null
  const isSearchBusy = searchLoading || isDebouncingSearch
  const searchStatusText = isSearchBusy ? 'Searching…' : `${searchTotal} result${searchTotal === 1 ? '' : 's'}`

  const renderedMessages = useMemo(() => toChronologicalMessages(messages ?? []), [messages])

  // Sticky scroll for messages area
  const { scrollRef, showJump, handleScroll, jumpToBottom } = useStickyScroll(renderedMessages, selectedChat)
  const messageVirtualizer = useVirtualMessages({
    messages: renderedMessages,
    getScrollElement: () => scrollRef.current,
  })
  const searchVirtualizer = useVirtualMessages({
    messages: searchResults,
    getScrollElement: () => searchScrollRef.current,
  })
  const virtualMessageRows = selectVirtualMessageRows(renderedMessages, messageVirtualizer.getVirtualItems())
  const virtualSearchRows = selectVirtualMessageRows(searchResults, searchVirtualizer.getVirtualItems())
  const currentChatDisplayName = currentChat ? resolveDisplayName(currentChat.name) : ''

  const handleLoadOlder = async () => {
    if (!selectedChat || loadingOlder) return
    const oldestPk = messages?.[messages.length - 1]?.pk
    setLoadingOlder(true)
    try {
      const older = await api.getMessages(activeLine, selectedChat, oldestPk)
      if (!older || older.length === 0) {
        setHasMore(false)
      } else {
        queryClient.setQueryData<Message[]>(['messages', activeLine, selectedChat], (prev) => [...(prev ?? []), ...older])
      }
    } catch (e) {
      toast.error(`Failed to load older messages: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoadingOlder(false)
    }
  }

  // Track optimistic PKs for slide-in animation
  const [animatedPks, setAnimatedPks] = useState<Set<number>>(new Set())

  const handleSend = async () => {
    if (!msgText.trim() || !selectedChat || isSending) return
    const text = msgText.trim()
    setIsSending(true)
    setMsgText('')

    // Optimistic: inject message into cache immediately
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
    const queryKey = ['messages', activeLine, selectedChat]
    queryClient.setQueryData<Message[]>(queryKey, (old) => [optimisticMsg, ...(old ?? [])])
    setAnimatedPks(prev => new Set(prev).add(optimisticPk))

    try {
      await api.sendMessage(activeLine, selectedChat, text)
      queryClient.invalidateQueries({ queryKey })
    } catch (e) {
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

  const handleSaveContact = async (name: string) => {
    if (!saveContactChat || !name) return
    setActionBusy(true)
    const parts = name.split(/\s+/)
    const firstName = parts[0]
    const lastName = parts.slice(1).join(' ') || undefined
    const jid = saveContactChat.includes('@')
      ? saveContactChat
      : saveContactChat + '@s.whatsapp.net'
    try {
      await api.saveContact(activeLine, { jid, firstName, lastName })
      toast.success(`Saved contact: ${name}`)
      setSaveContactChat(null)
    } catch (err) {
      toast.error(`Failed to save: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setActionBusy(false)
    }
  }



  const ease = [0.22, 1, 0.36, 1] as const

  return (
    <motion.div
      className="soup-inbox-layout flex-1 flex min-h-0 overflow-hidden p-[var(--sp-4)] gap-[var(--sp-3)]"
      data-mobile-detail={selectedChat ? 'thread' : 'list'}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease }}
    >

      {/* ═══ Left: Line picker + Chat list ═══ */}
      <Card
        className="soup-inbox-chats flex-shrink-0 flex flex-col overflow-hidden w-[var(--inbox-pane-chats)]"
      >
        {/* Line picker — toolbar pattern */}
        <LinePicker
          lines={lines ?? []}
          activeLine={activeLine}
          onSelect={name => { setSelectedLine(name); setSelectedChat(null) }}
          variant="toolbar"
        />

        {/* Chat list — a transport drop reads as offline-with-cache (DD-29)
            instead of a hard failure; genuine errors while connected fall
            through to ChatList's own empty/loaded rendering. */}
        {chatsError && transport.isDisconnected ? (
          <div className="flex-1 min-h-0 flex items-center justify-center">
            <EmptyState
              variant="offline"
              title="Showing cached data"
              description="Reconnecting…"
            />
          </div>
        ) : (
          <ChatList
            chats={chats ?? []}
            selectedChat={selectedChat}
            onSelect={setSelectedChat}
            typingKeys={typingJids}
          />
        )}
      </Card>

      {/* ═══ Center: Messages ═══ */}
      <Card
        className="soup-inbox-thread flex-1 flex flex-col min-h-0 overflow-hidden"
      >
        {selectedChat && currentChat ? (
          <>
            {/* Chat header */}
            <div
              className="flex items-center bg-surface-raised c-toolbar c-border-b min-h-[var(--toolbar-h)] gap-[var(--sp-3)]"
            >
              {/* Mobile-only back affordance — returns to the conversation list on
                  narrow surfaces where the master-detail shows one pane at a time.
                  Hidden ≥640px via .soup-inbox-back (CSS); on desktop both panes
                  are visible so no back path is needed. */}
              <Button
                variant="ghost"
                size="sm"
                className="soup-inbox-back flex-shrink-0"
                icon={<ChevronLeft size={18} strokeWidth={1.75} />}
                aria-label="Back to conversations"
                onClick={() => setSelectedChat(null)}
              />
              <div
                className="rounded-full flex items-center justify-center flex-shrink-0 w-[var(--avatar-sm)] h-[var(--avatar-sm)] bg-surface-overlay"
              >
                {currentChat.isGroup
                  ? <Users size={16} className="text-text-2" />
                  : <User size={16} className="text-text-2" />
                }
              </div>
              <div className="flex-1">
                <div className="text-text-1 font-medium text-body">{resolveDisplayName(currentChat.name)}</div>
                <div className="text-text-2 font-mono text-label">
                  {activeLine} · {currentChat.isGroup ? 'group' : 'direct'}
                </div>
              </div>
              <span className="c-label">{currentChat.unreadCount > 0 ? `${currentChat.unreadCount} unread` : 'read'}</span>
            </div>

            <div
              className="flex items-center py-[var(--sp-3)] px-[var(--sp-4)] gap-[var(--sp-3)] c-border-b bg-surface-raised"
            >
              <SearchInput
                containerClassName="flex-1"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search this conversation..."
                aria-label="Search messages in this conversation" shortcutTarget
                endAdornment={
                  isSearchBusy ? (
                    <Loader2
                      size={14}
                      strokeWidth={1.75}
                      className="animate-spin text-text-2"
                    />
                  ) : isSearchMode ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setSearchInput('')}
                      className="c-hover cursor-pointer text-text-2 p-[var(--sp-1)]"
                      title="Clear search"
                      aria-label="Clear search"
                    >
                      <X size={14} strokeWidth={1.75} />
                    </Button>
                  ) : null
                }
              />
              {isSearchMode && (
                <span title={searchStatusText} className="c-label whitespace-nowrap">
                  {searchStatusText}
                </span>
              )}
            </div>

            {/* Messages */}
            {isSearchMode ? (
              <div
                ref={searchScrollRef}
                className="flex-1 overflow-auto scrollbar-hide flex flex-col min-h-0 min-w-0 py-[var(--sp-4)] px-[var(--sp-5)]"
              >
                {searchError ? (
                  <div className="flex-1 flex items-center justify-center">
                    <EmptyState
                      icon={<Search size={40} strokeWidth={1.25} />}
                      title="Search failed"
                      description={searchError}
                      onRetry={() => { void refetchSearch() }}
                    />
                  </div>
                ) : searchResults.length > 0 ? (
                  <div
                    className="relative w-full"
                    style={{
                      height: `${searchVirtualizer.getTotalSize()}px`,
                      minHeight: `${searchVirtualizer.getTotalSize()}px`,
                    }}
                  >
                    {virtualSearchRows.map((row) => (
                      <div
                        key={`search-${row.key}`}
                        ref={searchVirtualizer.measureElement}
                        data-index={row.index}
                        className="absolute left-0 top-0 w-full flex flex-col"
                        style={{ transform: `translateY(${row.start}px)` }}
                      >
                        <MessageBubble msg={row.message} highlightQuery={debouncedSearch} transport={activeTransport} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center">
                    <EmptyState
                      icon={isSearchBusy ? <Loader2 size={40} strokeWidth={1.25} className="animate-spin" /> : <Search size={40} strokeWidth={1.25} />}
                      title={isSearchBusy ? 'Searching messages' : 'No matches'}
                      description={isSearchBusy ? 'Looking for matching messages…' : 'Try a different search term.'}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="flex-1 overflow-auto scrollbar-hide flex flex-col min-h-0 min-w-0 relative py-[var(--sp-4)] px-[var(--sp-5)]"
              >
                {messages && messages.length > 0 && hasMore && (
                  <Button
                    variant="ghost"
                    onClick={handleLoadOlder}
                    disabled={loadingOlder}
                    className="pt-[var(--sp-2)] pb-[var(--sp-4)] gap-[var(--sp-2)] w-full justify-center text-text-2"
                    icon={loadingOlder
                      ? <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
                      : <ChevronsUp size={14} strokeWidth={1.75} />
                    }
                  >
                    <span className="text-sm">
                      {loadingOlder ? 'Loading…' : 'Load older messages'}
                    </span>
                  </Button>
                )}
                {renderedMessages.length > 0 ? (
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
                        className="absolute left-0 top-0 w-full flex flex-col"
                        style={{ transform: `translateY(${row.start}px)` }}
                      >
                        <MessageBubble msg={row.message} animate={animatedPks.has(row.message.pk)} transport={activeTransport} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center">
                    <EmptyState
                      icon={<MessageSquare size={40} strokeWidth={1.25} />}
                      title="No messages loaded"
                      description="Messages will appear here."
                    />
                  </div>
                )}
                {showJump && (
                  <Button
                    size="sm"
                    onClick={jumpToBottom}
                    className="absolute left-1/2 bottom-16 -translate-x-1/2 shadow-[var(--card-shadow)] z-[var(--z-float)] text-sm"
                    icon={<ChevronDown size={14} />}
                  >
                    New messages
                  </Button>
                )}
              </div>
            )}

            {/* Input bar */}
            <div
              className="flex flex-shrink-0 items-center py-[var(--sp-3)] px-[var(--sp-4)] gap-[var(--sp-3)] border-t border-[var(--border-hairline)] bg-surface-raised"
              style={{ borderTopWidth: 'var(--bw)' }}
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
                placeholder="Type a message..."
                aria-label="Type a message"
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
                className="flex-shrink-0"
                label={isSending ? 'Sending' : 'Send'}
                icon={isSending
                  ? <Loader2 size={16} strokeWidth={1.75} className="animate-spin" />
                  : <Send size={16} strokeWidth={1.75} />}
                onClick={handleSend}
                disabled={isSending || !msgText.trim()}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <EmptyState
              icon={<MessageSquare size={40} strokeWidth={1.25} />}
              title="Select a conversation"
              description="Choose a line and chat from the left panel."
            />
          </div>
        )}
      </Card>

      {/* ═══ Right: Contact details ═══ */}
      <Card
        className="soup-inbox-contact flex-shrink-0 flex flex-col overflow-hidden w-[var(--inbox-pane-contact)]"
      >
        {currentChat ? (
          <>
            {/* Contact header */}
            <div
              className="flex items-center bg-surface-raised c-toolbar c-border-b min-h-[var(--toolbar-h)] gap-[var(--sp-3)]"
            >
              <div
                className="rounded-full flex items-center justify-center flex-shrink-0 w-[var(--avatar-sm)] h-[var(--avatar-sm)] bg-surface-overlay"
              >
                {currentChat.isGroup
                  ? <Users size={16} className="text-text-2" />
                  : <User size={16} className="text-text-2" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <div title={currentChatDisplayName} className="text-text-1 font-medium truncate text-body">{currentChatDisplayName}</div>
                <div title={currentChat.conversationKey} className="c-label truncate">{currentChat.conversationKey.slice(0, 18)}...</div>
              </div>
            </div>

            {/* Details body */}
            <div className="flex-1 min-h-0 min-w-0 overflow-auto scrollbar-hide p-[var(--sp-4)]">
              {/* Info card */}
              <div className="mb-[var(--sp-4)]">
                <div className="c-col-header mb-[var(--sp-2)]">Details</div>
                <div
                  className="bg-surface-raised rounded-md py-[var(--sp-3)] px-[var(--sp-4)] c-border"
                >
                  {[
                    { label: 'Line', value: activeLine },
                    { label: 'Type', value: currentChat.isGroup ? 'Group' : 'Direct' },
                    { label: 'Unread', value: String(currentChat.unreadCount) },
                    { label: 'Mode', value: currentLine?.mode ?? '—' },
                  ].map((item, i, arr) => (
                    <div
                      key={item.label}
                      className={`flex justify-between py-[var(--sp-2)] px-0${i < arr.length - 1 ? ' c-border-b' : ''}`}
                    >
                      <span className="c-label">{item.label}</span>
                      <span className="font-mono text-text-2 text-data">{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quick actions */}
              <div>
                <div className="c-col-header mb-[var(--sp-2)]">Actions</div>
                <div className="flex flex-col gap-[var(--sp-2)]">
                  {currentChat.unreadCount > 0 && (
                    <Button
                      size="sm"
                      className="w-full justify-center border-[var(--border-subtle)] text-text-2"
                      disabled={actionBusy}
                      icon={<CheckCheck size={14} strokeWidth={1.75} />}
                      onClick={async () => {
                        setActionBusy(true)
                        queryClient.setQueryData<ChatItem[]>(['chats', activeLine], old =>
                          old?.map(c => c.conversationKey === currentChat.conversationKey ? { ...c, unreadCount: 0 } : c)
                        )
                        try {
                          await api.markRead(activeLine, currentChat.conversationKey)
                          queryClient.invalidateQueries({ queryKey: ['chats', activeLine] })
                          toast.success('Marked as read')
                        } catch (err) {
                          queryClient.invalidateQueries({ queryKey: ['chats', activeLine] })
                          toast.error(`Failed to mark read: ${err instanceof Error ? err.message : String(err)}`)
                        } finally {
                          setActionBusy(false)
                        }
                      }}
                    >
                      Mark Read
                    </Button>
                  )}
                  <Button
                    variant="success"
                    className="w-full justify-center"
                    disabled={actionBusy}
                    icon={<UserCheck size={14} strokeWidth={1.75} />}
                    onClick={async () => {
                      setActionBusy(true)
                      try {
                        const subjectType = currentChat.isGroup ? 'group' : 'number'
                        await api.accessDecision(activeLine, subjectType, currentChat.conversationKey, 'allow')
                        toast.success(`Allowed ${resolveDisplayName(currentChat.name)}`)
                      } catch (err) {
                        toast.error(`Failed to allow: ${err instanceof Error ? err.message : String(err)}`)
                      } finally {
                        setActionBusy(false)
                      }
                    }}
                  >
                    Allow Contact
                  </Button>
                  <Button
                    variant="danger"
                    className="w-full justify-center"
                    disabled={actionBusy}
                    icon={<Ban size={14} strokeWidth={1.75} />}
                    onClick={async () => {
                      setActionBusy(true)
                      try {
                        const subjectType = currentChat.isGroup ? 'group' : 'number'
                        await api.accessDecision(activeLine, subjectType, currentChat.conversationKey, 'block')
                        toast.info(`Blocked ${resolveDisplayName(currentChat.name)}`)
                      } catch (err) {
                        toast.error(`Failed to block: ${err instanceof Error ? err.message : String(err)}`)
                      } finally {
                        setActionBusy(false)
                      }
                    }}
                  >
                    Block Contact
                  </Button>
                  {!currentChat.isGroup && (
                    <Button
                      variant="neutral"
                      className="w-full justify-center border-[var(--border-subtle)] text-text-2"
                      disabled={actionBusy}
                      icon={<UserPlus size={14} strokeWidth={1.75} />}
                      onClick={() => {
                        setSaveContactChat(currentChat.conversationKey)
                      }}
                    >
                      Save Contact
                    </Button>
                  )}
                </div>
              </div>

            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center p-[var(--sp-4)]">
            <div className="text-center text-text-2 text-sm">
              Select a conversation to see details
            </div>
          </div>
        )}
      </Card>
      <SaveContactDialog
        key={saveContactChat ?? 'none'}
        open={saveContactChat !== null}
        busy={actionBusy}
        onSave={handleSaveContact}
        onClose={() => setSaveContactChat(null)}
      />
    </motion.div>
  )
}
