import { Users, Shield } from 'lucide-react'
import type { GroupInfo } from '../../types.js'
import { avatarColor, roleLabel, roleBadgeStyle } from './groups-utils.js'
import { getInitials } from '../../lib/text-utils.js'
import { Button } from '../primitives/Button'

interface GroupCardProps {
  group: GroupInfo
  onSelect: (group: GroupInfo) => void
  myJid?: string
}

export function GroupCard({ group, onSelect, myJid }: GroupCardProps) {
  // Match by full JID or by phone-number prefix (handles @s.whatsapp.net vs @lid variants)
  const myPhone = myJid?.split('@')[0]
  const myParticipant = myJid
    ? group.participants.find(p => p.id === myJid || (myPhone && p.id.split('@')[0] === myPhone))
    : undefined
  const badge = roleBadgeStyle(myParticipant?.admin)
  const initials = getInitials(group.subject)
  const color = avatarColor(group.id)

  return (
    <Button
      variant="ghost"
      className="c-card w-full flex items-center gap-3 c-hover text-left py-[var(--sp-3)] px-[var(--sp-4)]"
      onClick={() => onSelect(group)}
    >
      {/* Avatar */}
      <div
        className="flex-shrink-0 flex items-center justify-center font-sans font-semibold w-[var(--avatar-md)] h-[var(--avatar-md)] rounded-full text-t1 text-sm"
        style={{
          background: color,
        }}
      >
        {initials}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="c-body truncate">
            {group.subject}
          </span>
          {badge && (
            <span
              className="inline-flex items-center gap-1 c-meta flex-shrink-0 py-[var(--bw)] px-[var(--sp-1)] rounded-sm"
              style={{
                background: badge.bg,
                color: badge.color,
              }}
            >
              <Shield size={10} strokeWidth={1.75} />
              {roleLabel(myParticipant?.admin)}
            </span>
          )}
        </div>
        <div className="c-label mt-[calc(var(--sp-1)/2)]">
          <Users size={11} strokeWidth={1.75} className="inline mr-[var(--sp-1)]" style={{ verticalAlign: 'calc(var(--bw) * -1)' }} />
          {group.participants.length} participant{group.participants.length !== 1 ? 's' : ''}
          {group.desc ? ` · ${group.desc.length > 80 ? group.desc.slice(0, 77) + '...' : group.desc}` : ''}
        </div>
      </div>
    </Button>
  )
}
