/**
 * ConversationList — v3.5 inbox list pane (mockup inbox.html .list):
 * Direct|Rooms seg control + conversation items (avatar with channel-glyph
 * badge, name, time, preview, takeover/unread badges). Virtualized past 50
 * rows per 19-performance-budget §3 (the WVR-016 ruling b-03 applied to the
 * lines table).
 */
import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Conversation, InboxSeg } from '../../lib/inbox-unified'
import { conversationId, conversationInitials, formatListTime } from '../../lib/inbox-unified'
import { ChannelGlyph } from './channel-glyphs'
import { Button } from '../primitives/Button'

const VIRTUALIZE_THRESHOLD = 50
const ESTIMATED_ROW_H = 62

function ConversationItem({
  conversation,
  selected,
  takeover,
  onSelect,
}: {
  conversation: Conversation
  selected: boolean
  takeover: boolean
  onSelect: (c: Conversation) => void
}) {
  return (
    <div
      className={`inbox-citem${selected ? ' inbox-citem--sel' : ''}`}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={() => onSelect(conversation)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(conversation)
        }
      }}
    >
      <span className={`inbox-ava${conversation.isGroup ? ' inbox-ava--grp' : ''}`}>
        {conversationInitials(conversation.name)}
        <ChannelGlyph channel={conversation.channel} className="inbox-ava__glyph" />
      </span>
      <div className="inbox-citem__mid">
        <div className="inbox-citem__row1">
          <span className="inbox-citem__nm">{conversation.name}</span>
          <span className="inbox-citem__tm">{formatListTime(conversation.lastMessageAt)}</span>
        </div>
        <div className="inbox-citem__pv">{conversation.lastMessagePreview}</div>
        {takeover || conversation.unreadCount > 0 ? (
          <div className="inbox-citem__badges">
            {takeover ? <span className="inbox-take">takeover</span> : null}
            {conversation.unreadCount > 0 ? (
              <span className="inbox-ub" aria-label={`${conversation.unreadCount} unread`}>
                {conversation.unreadCount}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ConversationList({
  conversations,
  seg,
  onSegChange,
  selectedId,
  takeoverIds,
  onSelect,
}: {
  conversations: Conversation[]
  seg: InboxSeg
  onSegChange: (s: InboxSeg) => void
  selectedId: string | null
  takeoverIds: ReadonlySet<string>
  onSelect: (c: Conversation) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- waiver:WVR-009 @tanstack/react-virtual's useVirtualizer is flagged by the react-hooks compiler heuristic but is a stable supported library hook; expires 2026-12-31
  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_H,
    overscan: 8,
    enabled: conversations.length > VIRTUALIZE_THRESHOLD,
  })
  const virtualized = conversations.length > VIRTUALIZE_THRESHOLD

  return (
    <aside className="inbox-list" aria-label="Conversations">
      <div className="inbox-seg" role="group" aria-label="Conversation kind">
        <Button
          variant="ghost"
          aria-pressed={seg === 'direct'}
          className={seg === 'direct' ? 'on' : ''}
          onClick={() => onSegChange('direct')}
        >
          Direct
        </Button>
        <Button
          variant="ghost"
          aria-pressed={seg === 'rooms'}
          className={seg === 'rooms' ? 'on' : ''}
          onClick={() => onSegChange('rooms')}
        >
          Rooms
        </Button>
      </div>
      <div className="inbox-list__scroll" ref={scrollRef} role="listbox" aria-label="Conversation list">
        {conversations.length === 0 ? (
          <div className="inbox-list__empty" data-testid="inbox-list-empty">
            No conversations
          </div>
        ) : virtualized ? (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((row) => {
              const c = conversations[row.index]!
              const id = conversationId(c.line, c.conversationKey)
              return (
                <div
                  key={id}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${row.start}px)` }}
                >
                  <ConversationItem
                    conversation={c}
                    selected={selectedId === id}
                    takeover={takeoverIds.has(id)}
                    onSelect={onSelect}
                  />
                </div>
              )
            })}
          </div>
        ) : (
          conversations.map((c) => {
            const id = conversationId(c.line, c.conversationKey)
            return (
              <ConversationItem
                key={id}
                conversation={c}
                selected={selectedId === id}
                takeover={takeoverIds.has(id)}
                onSelect={onSelect}
              />
            )
          })
        )}
      </div>
    </aside>
  )
}
