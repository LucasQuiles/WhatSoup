import { type FC, type ReactNode } from 'react'

interface FilterPillProps {
  label: string
  isActive: boolean
  activeColor?: string
  activeBorder?: string
  onClick: () => void
  count?: number
  suffix?: ReactNode
  style?: React.CSSProperties
}

const FilterPill: FC<FilterPillProps> = ({
  label, isActive, activeColor = 'text-t2', activeBorder, onClick, count, suffix, style,
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`font-mono cursor-pointer c-hover inline-flex items-center ${
        isActive ? `${activeColor} bg-d4` : 'text-t4 hover:text-t2 hover:bg-d3'
      }`}
      style={{
        fontSize: 'var(--font-size-sm)',
        letterSpacing: 'var(--tracking-pill)',
        padding: 'var(--sp-1) var(--sp-2h)',
        borderRadius: 'var(--radius-sm)',
        border: isActive
          ? (activeBorder ?? 'var(--bw) solid var(--b4)')
          : 'var(--bw) solid var(--b1)',
        gap: 'var(--sp-1h)',
        ...style,
      }}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span
          className={`font-semibold leading-snug`}
          style={{
            fontSize: 'var(--font-size-label)',
            minWidth: 'var(--sp-4)',
            textAlign: 'center',
            padding: '0 var(--sp-1)',
            borderRadius: 'var(--radius-xs)',
            backgroundColor: isActive ? 'var(--b3)' : 'var(--b2)',
            color: isActive ? 'var(--color-t1)' : 'var(--color-t4)',
          }}
        >
          {count}
        </span>
      )}
      {suffix}
    </button>
  )
}

export default FilterPill
