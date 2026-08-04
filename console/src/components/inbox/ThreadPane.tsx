/**
 * ThreadPane — v3.5 inbox thread pane (mockup inbox.html .thread):
 * header (avatar, name, line · channel · kind sub, takeover toggle),
 * bottom-anchored message lane (virtualized, sticky-scroll, load-older),
 * and the composer with the uniform 36px control height (bead acceptance).
 *
 * Honesty: fromMe rows render as operator sends; nothing is labeled an
 * "agent" message — the API carries no agent-attribution field. Takeover is
 * local UI state only (no runtime pause endpoint exists); the toggle says so.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import type { Message } from '../../types'
import type { Conversation } from '../../lib/inbox-unified'
import {
  conversationInitials,
  formatBubbleTime,
  senderInitial,
} from '../../lib/inbox-unified'
import { CHANNEL_LABEL } from '../../lib/transport-identity'
import { useStickyScroll } from '../../hooks/use-sticky-scroll'
import { useVirtualMessages } from '../../hooks/use-virtual-messages'
import { selectVirtualMessageRows, toChronologicalMessages } from '../../lib/inbox-virtualization'
import { useToast } from '../../hooks/toast-context'
import { api } from '../../lib/api'
import { Button } from '../primitives/Button'
import { TextInput } from '../primitives/FormControl'
import EmptyState from '../EmptyState'

const LOAD_OLDER_NOTE = 'Load older messages'

function MessageRow({ msg, isGroup }: { msg: Message; isGroup: boolean }) {
  const text = typeof msg.content === 'string' && msg.content.length > 0 ? msg.content : `[${msg.type}]`
  const modelBadge = msg.modelUsed ? <span className="inbox-bub__model">{msg.modelUsed}</span> : null
  if (msg.fromMe) {
    return (
      <div className="inbox-mrow inbox-mrow--me">
        <div className="inbox-bub">
          {text}
          <div className="inbox-bub__tm">{modelBadge}{formatBubbleTime(msg.timestamp)}</div>
        </div>
      </div>
    )
  }
  return (
    <div className="inbox-mrow">
      <span className="inbox-ma">{senderInitial(msg.senderName)}</span>
      <div className="inbox-bub">
        {isGroup ? <div className="inbox-bub__who">{msg.senderName}</div> : null}
        {text}
        <div className="inbox-bub__tm">{modelBadge}{formatBubbleTime(msg.timestamp)}</div>
      </div>
    </div>
  )
}

export function ThreadPane({
  conversation,
  messages,
  hasMore,
  loadingOlder,
  onLoadOlder,
  takeover,
  onToggleTakeover,
  onBack,
}: {
  conversation: Conversation
  messages: Message[]
  hasMore: boolean
  loadingOlder: boolean
  onLoadOlder: () => void
  takeover: boolean
  onToggleTakeover: () => void
  onBack: () => void
}) {
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [msgText, setMsgText] = useState('')
  const [isSending, setIsSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const selectionKey = `${conversation.line}\n${conversation.conversationKey}`
  useEffect(() => {
    setMsgText('')
    inputRef.current?.focus()
  }, [selectionKey])

  const renderedMessages = toChronologicalMessages(messages)
  const { scrollRef, showJump, handleScroll, jumpToBottom } = useStickyScroll(
    renderedMessages,
    selectionKey,
  )
  const messageVirtualizer = useVirtualMessages({
    messages: renderedMessages,
    getScrollElement: () => scrollRef.current,
  })
  const virtualMessageRows = selectVirtualMessageRows(renderedMessages, messageVirtualizer.getVirtualItems())

  const handleSend = async () => {
    const text = msgText.trim()
    if (!text || isSending) return
    setIsSending(true)
    setMsgText('')
    const optimisticPk = -Date.now()
    const optimisticMsg: Message = {
      pk: optimisticPk,
      conversationKey: conversation.conversationKey,
      senderName: 'You',
      senderJid: '',
      content: text,
      timestamp: new Date().toISOString(),
      fromMe: true,
      type: 'text',
    }
    const queryKey = ['messages', conversation.line, conversation.conversationKey]
    queryClient.setQueryData<Message[]>(queryKey, (old) => [optimisticMsg, ...(old ?? [])])
    try {
      await api.sendMessage(conversation.line, conversation.conversationKey, text)
      queryClient.invalidateQueries({ queryKey })
    } catch (e) {
      queryClient.setQueryData<Message[]>(queryKey, (old) => (old ?? []).filter((m) => m.pk !== optimisticPk))
      toast.error(`Send failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      setIsSending(false)
    }
  }

  return (
    <section className="inbox-thread" aria-label="Conversation thread">
      <div className="inbox-thead">
        <Button
          variant="ghost"
          className="inbox-back"
          aria-label="Back to conversations"
          onClick={onBack}
        >
          ←
        </Button>
        <span className={`inbox-ava inbox-ava--thead${conversation.isGroup ? ' inbox-ava--grp' : ''}`}>
          {conversationInitials(conversation.name)}
        </span>
        <div className="inbox-thead__id">
          <div className="inbox-thead__nm">{conversation.name}</div>
          <div className="inbox-thead__sub">
            {conversation.line} · {CHANNEL_LABEL[conversation.channel]} ·{' '}
            {conversation.isGroup ? 'room' : 'direct'}
          </div>
        </div>
        <div className="inbox-takeover">
          <span>takeover</span>
          <span
            className={`inbox-tgl${takeover ? ' inbox-tgl--on' : ''}`}
            role="switch"
            aria-checked={takeover}
            aria-label="Takeover"
            aria-description="Local takeover only — no runtime pause endpoint exists yet; messages send as the line regardless."
            title="Local takeover only — no runtime pause endpoint exists yet"
            tabIndex={0}
            onClick={onToggleTakeover}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onToggleTakeover()
              }
            }}
          />
        </div>
      </div>

      <div className="inbox-msgs" ref={scrollRef} onScroll={handleScroll}>
        {hasMore && messages.length > 0 ? (
          <Button variant="ghost" className="inbox-older" disabled={loadingOlder} onClick={onLoadOlder}>
            {loadingOlder ? 'Loading…' : LOAD_OLDER_NOTE}
          </Button>
        ) : null}
        {renderedMessages.length > 0 ? (
          <div
            className="inbox-msgs__lane"
            style={{
              height: messageVirtualizer.getTotalSize(),
              minHeight: messageVirtualizer.getTotalSize(),
            }}
          >
            {virtualMessageRows.map((row) => (
              <div
                key={String(row.key)}
                ref={messageVirtualizer.measureElement}
                data-index={row.index}
                className="inbox-msgs__row"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <MessageRow msg={row.message} isGroup={conversation.isGroup} />
              </div>
            ))}
          </div>
        ) : (
          <div className="inbox-msgs__empty">
            <EmptyState title="No messages loaded" description="Messages will appear here." />
          </div>
        )}
        {takeover ? (
          <div className="inbox-sys" role="status">
            takeover enabled — local only; no runtime pause endpoint yet
          </div>
        ) : null}
        {showJump ? (
          <Button variant="ghost" className="inbox-jump" onClick={jumpToBottom}>
            New messages
          </Button>
        ) : null}
      </div>

      <div className="inbox-composer">
        <div className="inbox-caps">
          <Button
            variant="ghost"
            className="inbox-cap"
            disabled
            title="No fleet media endpoint exists — image send is instance-local today"
            aria-description="Disabled: the fleet API has no media upload route; send_media is instance-local."
            aria-label="Send image"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
              <circle cx="5.5" cy="6.5" r="1.3" />
              <path d="M2 12l3.5-3.5 2.5 2.5 3-3L14 11" strokeLinejoin="round" />
            </svg>
          </Button>
          <Button
            variant="ghost"
            className="inbox-cap"
            disabled
            title="No fleet voice-note endpoint exists — voice send is instance-local today"
            aria-description="Disabled: the fleet API has no voice-note route; ptt send is instance-local."
            aria-label="Send voice note"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
              <path d="M3 8a5 5 0 0 0 10 0M8 13v2" />
            </svg>
          </Button>
          <Button
            variant="ghost"
            className="inbox-cap"
            disabled
            title="Polls have no fleet route — send_poll is MCP-only today"
            aria-description="Disabled: polls are only reachable through the instance MCP socket, not the fleet API."
            aria-label="Send poll"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M3 13V9m5 4V5m5 8V7" />
            </svg>
          </Button>
          <Button
            variant="ghost"
            className="inbox-cap"
            title="Scheduled messages live on this line's detail surface"
            aria-label="Open scheduled messages for this line"
            onClick={() => navigate(`/lines/${encodeURIComponent(conversation.line)}`)}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <circle cx="8" cy="8.5" r="5.5" />
              <path d="M8 5.5v3l2 1.5M6.5 1.5h3" />
            </svg>
          </Button>
        </div>
        <TextInput
          ref={inputRef}
          className="inbox-input"
          value={msgText}
          onChange={(e) => setMsgText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void handleSend()
            }
          }}
          placeholder={takeover ? 'Message as yourself (takeover)…' : `Message ${conversation.name}…`}
          aria-label="Type a message"
        />
        <Button
          variant="primary"
          className="inbox-send"
          disabled={isSending || !msgText.trim()}
          onClick={() => void handleSend()}
        >
          {isSending ? 'Sending' : 'Send'}
        </Button>
      </div>
    </section>
  )
}
