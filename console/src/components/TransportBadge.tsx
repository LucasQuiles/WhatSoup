import { type FC } from 'react'
import { resolveTransport, type TransportKind } from '../lib/transport-meta'

interface TransportBadgeProps {
  kind: TransportKind | string | null | undefined
  backend?: 'imsg' | 'bluebubbles' | null
}

const TransportBadge: FC<TransportBadgeProps> = ({ kind, backend }) => {
  const entry = resolveTransport(kind)
  const unknown = Boolean(kind) && entry.subLabel === 'unknown'
  const label = entry.subLabel
    ? `${entry.label}·${entry.subLabel}`
    : backend === 'bluebubbles'
      ? `${entry.label}·BB`
      : backend === 'imsg'
        ? `${entry.label}·imsg`
        : entry.label

  return (
    <span className={unknown ? 'soup-transport soup-transport--unknown' : entry.transportClass} title={`Transport: ${label}`}>
      <span className="soup-transport__dot" aria-hidden="true" />
      {label}
    </span>
  )
}

export default TransportBadge
