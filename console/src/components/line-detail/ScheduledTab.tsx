import { useState, useMemo } from 'react'
import { Clock, Plus } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api.js'
import { useToast } from '../../hooks/toast-context.js'
import EmptyState from '../EmptyState.js'
import { ScheduledMessageRow } from './ScheduledMessageRow.js'
import { ScheduleComposerModal } from './ScheduleComposerModal.js'
import type { ScheduledMessage, ChatItem } from '../../types.js'

export function ScheduledTab({ lineName }: { lineName: string }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [cancelling, setCancelling] = useState<number | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [editMessage, setEditMessage] = useState<ScheduledMessage | undefined>(undefined)

  const { data, isLoading, error } = useQuery({
    queryKey: ['scheduled', lineName],
    queryFn: () => api.getScheduled(lineName),
    enabled: !!lineName,
    refetchInterval: 30_000,
  })

  const { data: chatsData } = useQuery({
    queryKey: ['chats', lineName],
    queryFn: () => api.getChats(lineName),
    enabled: !!lineName,
    staleTime: 60_000,
  })

  const chats: ChatItem[] = chatsData ?? []

  // Sort: pending first (ASC by scheduledAt), then others (DESC by scheduledAt)
  const sorted = useMemo(() => {
    const all: ScheduledMessage[] = data?.messages ?? []
    const pending = all
      .filter(m => m.status === 'pending' || m.status === 'processing')
      .sort((a, b) => a.scheduledAt - b.scheduledAt)
    const rest = all
      .filter(m => m.status !== 'pending' && m.status !== 'processing')
      .sort((a, b) => b.scheduledAt - a.scheduledAt)
    return [...pending, ...rest]
  }, [data])

  const messages = data?.messages ?? []

  const handleCancel = async (id: number) => {
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

  const handleEdit = (message: ScheduledMessage) => {
    setEditMessage(message)
    setComposerOpen(true)
  }

  const handleDuplicate = (message: ScheduledMessage) => {
    // Open composer with message pre-filled but negative ID signals "create new, not edit"
    setEditMessage({ ...message, id: -1 } as ScheduledMessage)
    setComposerOpen(true)
  }

  const handleNew = () => {
    setEditMessage(undefined)
    setComposerOpen(true)
  }

  const handleComposerClose = () => {
    setComposerOpen(false)
    setEditMessage(undefined)
  }

  const handleCreated = () => {
    queryClient.invalidateQueries({ queryKey: ['scheduled', lineName] })
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

  return (
    <>
      <div className="flex flex-col gap-[var(--sp-2)]">
        {/* Header bar */}
        <div className="flex items-center justify-between py-[var(--sp-2)] px-[var(--sp-4)]">
          <span className="c-col-header text-t4 font-mono text-[var(--font-size-xs)]">
            {messages.length} scheduled message{messages.length !== 1 ? 's' : ''}
          </span>
          <button
            type="button"
            onClick={handleNew}
            className="c-btn c-btn-sm c-btn-primary font-mono flex items-center gap-1 text-[var(--font-size-xs)]"
          >
            <Plus size={12} strokeWidth={2} />
            New Scheduled Message
          </button>
        </div>

        {sorted.length === 0 ? (
          <EmptyState
            icon={<Clock size={40} strokeWidth={1.25} />}
            title="No scheduled messages"
            description="Messages scheduled via the agent or MCP tools will appear here."
          />
        ) : (
          sorted.map(msg => (
            <ScheduledMessageRow
              key={msg.id}
              message={msg}
              onCancel={handleCancel}
              onEdit={handleEdit}
              onDuplicate={handleDuplicate}
              cancelling={cancelling}
            />
          ))
        )}
      </div>

      <ScheduleComposerModal
        open={composerOpen}
        onClose={handleComposerClose}
        onCreated={handleCreated}
        lineName={lineName}
        chats={chats}
        editMessage={editMessage?.id ? editMessage : undefined}
      />
    </>
  )
}
