import { Users } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api.js'
import EmptyState from '../EmptyState.js'
import type { GroupInfo } from '../../types.js'

export function GroupsTab({ lineName }: { lineName: string }) {
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

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<Users size={40} strokeWidth={1.25} />}
        title="No groups"
        description="Groups this instance participates in will appear here."
      />
    )
  }

  return (
    <div className="flex flex-col" style={{ gap: 'var(--sp-2)' }}>
      <div className="c-col-header text-t4" style={{ padding: 'var(--sp-2) var(--sp-4)' }}>
        {groups.length} group{groups.length !== 1 ? 's' : ''}
      </div>
      {groups.map((group) => (
        <div
          key={group.jid}
          className="c-card flex items-start gap-3"
          style={{
            padding: 'var(--sp-3) var(--sp-4)',
          }}
        >
          <Users size={16} strokeWidth={1.75} className="text-t4 flex-shrink-0" style={{ marginTop: '2px' }} />
          <div className="flex-1 min-w-0">
            <div className="font-mono text-t2 truncate" style={{ fontSize: 'var(--font-size-data)' }}>
              {group.subject}
            </div>
            <div className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)', marginTop: '2px' }}>
              {group.participants} participant{group.participants !== 1 ? 's' : ''}
              {group.desc ? ` · ${group.desc.length > 80 ? group.desc.slice(0, 77) + '...' : group.desc}` : ''}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
