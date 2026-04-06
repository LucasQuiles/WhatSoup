import { useState } from 'react'
import { Clock, Trash2, Loader2 } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api.js'
import { useToast } from '../../hooks/toast-context.js'
import EmptyState from '../EmptyState.js'
import type { ScheduledMessage } from '../../types.js'

export function ScheduledTab({ lineName }: { lineName: string }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [cancelling, setCancelling] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['scheduled', lineName],
    queryFn: () => api.getScheduled(lineName),
    enabled: !!lineName,
    refetchInterval: 30_000,
  })

  const messages: ScheduledMessage[] = (data as { scheduled?: ScheduledMessage[] })?.scheduled ?? []

  const handleCancel = async (id: string) => {
    setCancelling(id)
    try {
      await api.cancelScheduled(lineName, id)
      toast.success('Scheduled message cancelled')
      queryClient.invalidateQueries({ queryKey: ['scheduled', lineName] })
    } catch (err) {
      toast.error(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCancelling(null)
    }
  }

  if (isLoading) {
    return <EmptyState title="Loading scheduled messages..." description="Fetching queue for this instance." />
  }

  if (error) {
    return (
      <EmptyState
        variant="error"
        title="Failed to load scheduled messages"
        description={error instanceof Error ? error.message : 'MCP socket may not be available.'}
      />
    )
  }

  if (messages.length === 0) {
    return (
      <EmptyState
        icon={<Clock size={40} strokeWidth={1.25} />}
        title="No scheduled messages"
        description="Messages scheduled via the agent or MCP tools will appear here."
      />
    )
  }

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-2)' }}>
      <div className="c-col-header text-t4" style={{ padding: 'var(--sp-2) var(--sp-4)' }}>
        {messages.length} scheduled message{messages.length !== 1 ? 's' : ''}
      </div>
      {messages.map((msg) => (
        <div
          key={msg.id}
          className="flex items-start gap-3"
          style={{
            padding: 'var(--sp-3) var(--sp-4)',
            background: 'var(--color-d2)',
            borderWidth: 'var(--bw)',
            borderStyle: 'solid',
            borderColor: 'var(--b1)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          <Clock size={16} strokeWidth={1.75} className="text-t4 flex-shrink-0" style={{ marginTop: '2px' }} />
          <div className="flex-1 min-w-0">
            <div className="font-mono text-t2 truncate" style={{ fontSize: 'var(--font-size-data)' }}>
              {msg.text.length > 100 ? msg.text.slice(0, 97) + '...' : msg.text}
            </div>
            <div className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)', marginTop: '2px' }}>
              {msg.chatName ?? msg.chatJid} · {new Date(msg.scheduledAt).toLocaleString()}
            </div>
          </div>
          <button
            onClick={() => handleCancel(msg.id)}
            disabled={cancelling === msg.id}
            aria-label={`Cancel scheduled message to ${msg.chatName ?? msg.chatJid}`}
            className="flex items-center gap-1 px-2 py-1 rounded font-mono text-s-crit hover:bg-d5 cursor-pointer c-hover flex-shrink-0"
            style={{ fontSize: 'var(--font-size-label)', borderWidth: 'var(--bw)', borderStyle: 'solid', borderColor: 'var(--b2)' }}
          >
            {cancelling === msg.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} strokeWidth={1.75} />}
            Cancel
          </button>
        </div>
      ))}
    </div>
  )
}
