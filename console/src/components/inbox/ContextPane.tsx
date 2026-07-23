/**
 * ContextPane — v3.5 inbox context rail (mockup inbox.html .ctx):
 * Person card (identity rows), Agent-in-this-chat card, Line card.
 *
 * Honesty: every row renders real data or an explicit empty note.
 * "Agent in this chat" reads the line's checkpoint registry (the only
 * per-conversation session signal that exists) and says so when there
 * is none. Takeover is local UI state and is labeled local.
 */
import { useQuery } from '@tanstack/react-query'
import type { Conversation } from '../../lib/inbox-unified'
import { conversationInitials } from '../../lib/inbox-unified'
import { CHANNEL_LABEL, transportConnectedOf } from '../../lib/transport-identity'
import { api } from '../../lib/api'
import type { LineInstance } from '../../types'
import { ChannelGlyph } from './channel-glyphs'

export function ContextPane({
  conversation,
  line,
  takeover,
}: {
  conversation: Conversation
  line: LineInstance | undefined
  takeover: boolean
}) {
  const { data: checkpoints } = useQuery({
    queryKey: ['checkpoints', conversation.line],
    queryFn: () => api.getCheckpoints(conversation.line),
    staleTime: 30_000,
  })
  const checkpoint = checkpoints?.checkpoints.find(
    (c) => c.conversationKey === conversation.conversationKey,
  )

  const connected = transportConnectedOf(line)

  return (
    <aside className="inbox-ctx" aria-label="Conversation context">
      <h3>{conversation.isGroup ? 'Room' : 'Person'}</h3>
      <div className="inbox-pcard">
        <div className="inbox-pcard__top">
          <span className={`inbox-ava inbox-ava--pcard${conversation.isGroup ? ' inbox-ava--grp' : ''}`}>
            {conversationInitials(conversation.name)}
          </span>
          <div>
            <div className="inbox-pcard__nm">{conversation.name}</div>
            <div className="inbox-pcard__sub">{conversation.isGroup ? 'room' : 'direct'}</div>
          </div>
        </div>
        <div className="inbox-idrow">
          <ChannelGlyph channel={conversation.channel} className="inbox-idrow__glyph" />
          <span className="inbox-idrow__h">{CHANNEL_LABEL[conversation.channel]}</span>
          <span className="inbox-idrow__v" title={conversation.conversationKey}>
            {conversation.conversationKey}
          </span>
        </div>
        <div className="inbox-idrow">
          <span className="inbox-idrow__h">line</span>
          <span className="inbox-idrow__v">{conversation.line}</span>
        </div>
      </div>

      <h3>Agent in this chat</h3>
      <div className="inbox-agcard" data-testid="inbox-agent-card">
        {checkpoint ? (
          <>
            <div>
              <div className="inbox-agcard__nm">session {checkpoint.sessionStatus}</div>
              <div className="inbox-agcard__sub">
                {checkpoint.resumable ? 'resumable' : 'not resumable'}
                {takeover ? ' · takeover (local)' : ''}
              </div>
            </div>
          </>
        ) : (
          <div>
            <div className="inbox-agcard__nm">no agent session recorded</div>
            <div className="inbox-agcard__sub">{takeover ? 'takeover (local)' : 'checkpoint registry is empty for this chat'}</div>
          </div>
        )}
      </div>

      <h3>Line</h3>
      <div className="inbox-pcard">
        <div className="inbox-idrow">
          <span className="inbox-idrow__h inbox-idrow__h--strong">{conversation.line}</span>
          <span className="inbox-idrow__v">
            <span className={`inbox-badge${connected ? ' inbox-badge--live' : ''}`}>
              {connected === null ? 'unknown' : connected ? 'live' : 'degraded'}
            </span>
          </span>
        </div>
        <div className="inbox-idrow">
          <span className="inbox-idrow__h">transport</span>
          <span className="inbox-idrow__v">{CHANNEL_LABEL[conversation.channel]}</span>
        </div>
        <div className="inbox-idrow">
          <span className="inbox-idrow__h">access</span>
          <span className="inbox-idrow__v">{line?.accessMode ?? '—'}</span>
        </div>
        <div className="inbox-idrow">
          <span className="inbox-idrow__h">mode</span>
          <span className="inbox-idrow__v">{line?.mode ?? '—'}</span>
        </div>
      </div>
    </aside>
  )
}
