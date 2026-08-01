/**
 * Inbox — v3.5 unified conversation surface (T5 b-07; mockup inbox.html SSOT).
 *
 * One conversation plane across every line: channel chips (only channels with
 * real lines render), Direct|Rooms seg, conversation list (virtualized >50),
 * bottom-anchored thread, uniform-36px composer, context cards.
 *
 * Data honesty (verified against src/fleet routes):
 * - Channel is line-level (health.transport.kind); chips/counts derive from it.
 * - Takeover has NO runtime endpoint (pausedChats is restart-gated config with
 *   no read state) — it is local UI state and says so wherever it renders.
 * - Composer media/voice/poll caps have no fleet route → disabled with notes;
 *   scheduling lives on the line detail surface and the cap navigates there.
 * - Messages send for real (POST /api/lines/:name/send, optimistic insert);
 *   opening a conversation with unread marks it read (real mark-read route).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueries, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { getChatsQueryOptions, useLines, useMessages } from '../hooks/use-fleet'
import { useRealtime } from '../hooks/use-websocket'
import { useToast, type ToastContextValue } from '../hooks/toast-context'
import { api } from '../lib/api'
import type { ChatItem, MarkConversationReadResult, Message } from '../types'
import type { InboxChannel, InboxSeg } from '../lib/inbox-unified'
import {
  conversationId,
  countByChannel,
  filterConversations,
  mergeConversations,
  presentChannels,
} from '../lib/inbox-unified'
import { ConversationList } from '../components/inbox/ConversationList'
import { ThreadPane } from '../components/inbox/ThreadPane'
import { ContextPane } from '../components/inbox/ContextPane'
import { ChannelGlyph } from '../components/inbox/channel-glyphs'
import { CHANNEL_LABEL } from '../lib/transport-identity'
import { Button } from '../components/primitives/Button'
import EmptyState from '../components/EmptyState'

/**
 * #2550: the local `unread_count` zero already happened (optimistic, at the
 * call site) — this only decides whether the operator needs to be told the
 * REMOTE side disagrees. `acked`/`nothing_to_ack` settle silently (today's
 * behavior, unchanged); `offline`/`failed` are the states the console used
 * to discard, rendering a remote failure identically to a real ack.
 */
function applyMarkReadOutcome(
  result: MarkConversationReadResult,
  ctx: { line: string; queryClient: QueryClient; toast: ToastContextValue },
): void {
  switch (result.remote) {
    case 'acked':
    case 'nothing_to_ack':
      return
    case 'offline':
      ctx.toast.info('Read marked locally — the line is offline, so the read receipt was not sent yet. It will resync once reconnected.')
      return
    case 'failed':
      ctx.queryClient.invalidateQueries({ queryKey: ['chats', ctx.line] })
      ctx.toast.error('Read receipt failed to send — the line may still show this chat as unread.')
      return
    default: {
      // Compile-time exhaustiveness guard: a new backend `remote` state must
      // be handled explicitly above, not silently fall through as if acked.
      const unreachable: never = result.remote
      ctx.toast.error(`Unrecognized mark-read outcome: ${String(unreachable)}`)
    }
  }
}

export default function Inbox() {
  const { data: lines } = useLines()
  const toast = useToast()
  const queryClient = useQueryClient()

  const [channel, setChannel] = useState<InboxChannel | 'all'>('all')
  const [seg, setSeg] = useState<InboxSeg>('direct')
  const [selected, setSelected] = useState<{ line: string; key: string } | null>(null)
  const [takeoverIds, setTakeoverIds] = useState<ReadonlySet<string>>(new Set())
  const [hasMore, setHasMore] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)

  // Deep links (?line=&chat=) — consumed once, then cleared so back-navigation
  // doesn't re-trigger (same contract the v3 page honored).
  const [searchParams, setSearchParams] = useSearchParams()
  const deepLinked = useRef(false)
  useEffect(() => {
    if (deepLinked.current) return
    const lineParam = searchParams.get('line')
    const chatParam = searchParams.get('chat')
    if (lineParam && chatParam) {
      deepLinked.current = true
      setSelected({ line: lineParam, key: chatParam })
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, setSearchParams])

  // Unified plane: one chats query per line, sharing the ['chats', name] keys
  // so WS chat_updated invalidation lands here exactly as on per-line pages.
  const { connected } = useRealtime()
  const chatQueries = useQueries({
    queries: (lines ?? []).map((line) => getChatsQueryOptions(line.name, connected ? false : undefined)),
  })
  const chatsByLine = useMemo(() => {
    const map = new Map<string, ChatItem[]>()
    ;(lines ?? []).forEach((line, i) => {
      const data = chatQueries[i]?.data
      if (data) map.set(line.name, data)
    })
    return map
  }, [lines, chatQueries])

  const conversations = useMemo(
    () => mergeConversations(lines ?? [], chatsByLine),
    [lines, chatsByLine],
  )
  const channels = useMemo(() => presentChannels(conversations), [conversations])
  const channelCounts = useMemo(() => countByChannel(conversations), [conversations])
  const visible = useMemo(
    () => filterConversations(conversations, channel, seg),
    [conversations, channel, seg],
  )

  // Keep the channel filter honest: if the active channel disappears (line
  // removed), fall back to All rather than showing an empty filtered list.
  useEffect(() => {
    if (channel !== 'all' && !channels.includes(channel)) setChannel('all')
  }, [channel, channels])

  const selectedId = selected ? conversationId(selected.line, selected.key) : null
  const selectedConversation = useMemo(
    () => (selected ? conversations.find((c) => conversationId(c.line, c.conversationKey) === selectedId) ?? null : null),
    [conversations, selected, selectedId],
  )

  const { data: messages } = useMessages(selected?.line ?? '', selected?.key ?? '')
  useEffect(() => {
    setHasMore(true)
  }, [selectedId])

  // Mark-read on open — the real route; optimistic zero, invalidate to settle.
  const markedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selected || !selectedConversation) return
    if (selectedConversation.unreadCount <= 0) return
    if (markedRef.current === selectedId) return
    markedRef.current = selectedId
    const { line, key } = selected
    queryClient.setQueryData<ChatItem[]>(['chats', line], (old) =>
      old?.map((c) => (c.conversationKey === key ? { ...c, unreadCount: 0 } : c)),
    )
    api.markRead(line, key)
      .then((result) => applyMarkReadOutcome(result, { line, queryClient, toast }))
      .catch((e) => {
        queryClient.invalidateQueries({ queryKey: ['chats', line] })
        toast.error(`Failed to mark read: ${e instanceof Error ? e.message : e}`)
      })
  }, [selected, selectedConversation, selectedId, queryClient, toast])

  const handleLoadOlder = async () => {
    if (!selected || loadingOlder) return
    const oldestPk = messages?.[messages.length - 1]?.pk
    setLoadingOlder(true)
    try {
      const older = await api.getMessages(selected.line, selected.key, oldestPk)
      if (!older || older.length === 0) {
        setHasMore(false)
      } else {
        queryClient.setQueryData<Message[]>(['messages', selected.line, selected.key], (prev) => [
          ...(prev ?? []),
          ...older,
        ])
      }
    } catch (e) {
      toast.error(`Failed to load older messages: ${e instanceof Error ? e.message : e}`)
    } finally {
      setLoadingOlder(false)
    }
  }

  const toggleTakeover = (id: string) => {
    setTakeoverIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const lineForSelected = selectedConversation
    ? (lines ?? []).find((l) => l.name === selectedConversation.line)
    : undefined

  return (
    <div className="inbox-page" data-mobile-detail={selectedConversation ? 'thread' : 'list'}>
      {/* Single-h1 law: the chrome header title is an aria-hidden span, so the
          surface owns the document h1 — visually clipped (mockup's header is
          the chrome band the app already renders). */}
      <h1 className="inbox-sr-h1">Inbox</h1>

      <div className="inbox-chips" role="group" aria-label="Channel filter">
        <Button
          variant="ghost"
          className={`inbox-chip${channel === 'all' ? ' inbox-chip--on' : ''}`}
          onClick={() => setChannel('all')}
        >
          All <span className="inbox-chip__c">{conversations.length}</span>
        </Button>
        {channels.map((k) => (
          <Button
            variant="ghost"
            key={k}
            className={`inbox-chip${channel === k ? ' inbox-chip--on' : ''}`}
            onClick={() => setChannel(k)}
          >
            <ChannelGlyph channel={k} className="inbox-chip__glyph" />
            {CHANNEL_LABEL[k]} <span className="inbox-chip__c">{channelCounts.get(k) ?? 0}</span>
          </Button>
        ))}
      </div>

      <div className="inbox-wrap">
        <ConversationList
          conversations={visible}
          seg={seg}
          onSegChange={setSeg}
          selectedId={selectedId}
          takeoverIds={takeoverIds}
          onSelect={(c) => setSelected({ line: c.line, key: c.conversationKey })}
        />

        {selectedConversation ? (
          <ThreadPane
            conversation={selectedConversation}
            messages={messages ?? []}
            hasMore={hasMore}
            loadingOlder={loadingOlder}
            onLoadOlder={() => void handleLoadOlder()}
            takeover={takeoverIds.has(selectedId!)}
            onToggleTakeover={() => toggleTakeover(selectedId!)}
            onBack={() => setSelected(null)}
          />
        ) : (
          <section className="inbox-thread" aria-label="Conversation thread">
            <div className="inbox-thread__empty">
              <EmptyState
                title="Select a conversation"
                description="Choose a chat from the list."
              />
            </div>
          </section>
        )}

        {selectedConversation ? (
          <ContextPane
            conversation={selectedConversation}
            line={lineForSelected}
            takeover={takeoverIds.has(selectedId!)}
          />
        ) : (
          <aside className="inbox-ctx" aria-label="Conversation context">
            <div className="inbox-ctx__empty">Select a conversation to see details</div>
          </aside>
        )}
      </div>
    </div>
  )
}
