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
      className={`font-mono cursor-pointer c-hover inline-flex items-center rounded-sm tracking-[var(--tracking-pill)] py-[var(--sp-1)] px-[var(--sp-2h)] gap-[var(--sp-1h)] ${
        isActive ? `${activeColor} bg-d4` : 'text-t4 hover:text-t2 hover:bg-d3'
      }`}
      style={{
        fontSize: 'var(--font-size-sm)',
        border: isActive
          ? (activeBorder ?? 'var(--bw) solid var(--b4)')
          : 'var(--bw) solid var(--b1)',
        ...style,
      }}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span
          className="font-semibold leading-snug text-center rounded-xs min-w-[var(--sp-4)] px-[var(--sp-1)]"
          style={{
            fontSize: 'var(--font-size-label)',
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
