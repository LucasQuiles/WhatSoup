import { useState } from 'react'
import { Users, Plus } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api.js'
import EmptyState from '../EmptyState.js'
import { GroupCard } from './GroupCard.js'
import { GroupDetailModal } from './GroupDetailModal.js'
import { CreateGroupModal } from './CreateGroupModal.js'
import type { GroupInfo } from '../../types.js'

export function GroupsTab({ lineName, myJid }: { lineName: string; myJid?: string }) {
  const queryClient = useQueryClient()
  const [selectedGroup, setSelectedGroup] = useState<GroupInfo | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['groups', lineName],
    queryFn: () => api.getGroups(lineName),
    enabled: !!lineName,
    refetchInterval: 30_000,
  })

  const groups: GroupInfo[] = (data as { groups?: GroupInfo[] })?.groups ?? []

  if (isLoading) {
    return <EmptyState title="Loading groups..." description="Fetching groups for this instance." />
  }

  if (error) {
    return (
      <EmptyState
        variant="error"
        title="Failed to load groups"
        description={error instanceof Error ? error.message : 'MCP socket may not be available.'}
      />
    )
  }

  return (
    <>
      <div className="flex flex-col gap-[var(--sp-2)]">
        {/* Header bar */}
        <div className="flex items-center justify-between py-[var(--sp-2)] px-[var(--sp-4)]">
          <span className="c-col-header text-t4 font-mono">
            {groups.length} group{groups.length !== 1 ? 's' : ''}
          </span>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="c-btn c-btn-sm c-btn-primary font-mono"
          >
            <Plus size={12} strokeWidth={1.75} />
            Create Group
          </button>
        </div>

        {groups.length === 0 ? (
          <EmptyState
            icon={<Users size={40} strokeWidth={1.25} />}
            title="No groups"
            description="Groups this instance participates in will appear here."
          />
        ) : (
          <div className="flex flex-col gap-[var(--sp-2)] py-0 px-[var(--sp-4)]">
            {groups.map(group => (
              <GroupCard
                key={group.id}
                group={group}
                onSelect={setSelectedGroup}
                myJid={myJid}
              />
            ))}
          </div>
        )}
      </div>

      <GroupDetailModal
        open={!!selectedGroup}
        group={selectedGroup}
        lineName={lineName}
        myJid={myJid}
        onClose={() => setSelectedGroup(null)}
      />

      <CreateGroupModal
        open={showCreate}
        lineName={lineName}
        onClose={() => setShowCreate(false)}
        onCreated={() => queryClient.invalidateQueries({ queryKey: ['groups', lineName] })}
      />
    </>
  )
}
