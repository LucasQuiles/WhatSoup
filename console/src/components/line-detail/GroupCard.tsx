import { Users, Shield } from 'lucide-react'
import type { GroupInfo } from '../../types.js'
import { avatarColor, roleLabel, roleBadgeStyle } from './groups-utils.js'
import { getInitials } from '../../lib/text-utils.js'

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
    <button
      type="button"
      className="w-full flex items-center gap-3 c-hover text-left"
      style={{
        padding: 'var(--sp-3) var(--sp-4)',
        background: 'var(--color-d2)',
        borderWidth: 'var(--bw)',
        borderStyle: 'solid',
        borderColor: 'var(--b1)',
        borderRadius: 'var(--radius-md)',
      }}
      onClick={() => onSelect(group)}
    >
      {/* Avatar */}
      <div
        className="flex-shrink-0 flex items-center justify-center font-sans font-semibold"
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          background: color,
          color: 'var(--color-t1)',
          fontSize: 'var(--font-size-data)',
        }}
      >
        {initials}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-t2 truncate" style={{ fontSize: 'var(--font-size-data)' }}>
            {group.subject}
          </span>
          {badge && (
            <span
              className="inline-flex items-center gap-1 font-mono flex-shrink-0"
              style={{
                fontSize: 'var(--font-size-xs)',
                padding: '1px var(--sp-1)',
                borderRadius: 'var(--radius-sm)',
                background: badge.bg,
                color: badge.color,
              }}
            >
              <Shield size={10} />
              {roleLabel(myParticipant?.admin)}
            </span>
          )}
        </div>
        <div className="font-mono text-t4" style={{ fontSize: 'var(--font-size-xs)', marginTop: '2px' }}>
          <Users size={11} className="inline" style={{ marginRight: '4px', verticalAlign: '-1px' }} />
          {group.participants.length} participant{group.participants.length !== 1 ? 's' : ''}
          {group.desc ? ` · ${group.desc.length > 80 ? group.desc.slice(0, 77) + '...' : group.desc}` : ''}
        </div>
      </div>
    </button>
  )
}
