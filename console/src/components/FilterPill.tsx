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
      className={`font-mono cursor-pointer c-hover inline-flex items-center text-[var(--font-size-sm)] tracking-[var(--tracking-pill)] py-[var(--sp-1)] px-[var(--sp-2h)] rounded-sm gap-[var(--sp-1h)] ${
        isActive ? `${activeColor} bg-d4` : 'text-t4 hover:text-t2 hover:bg-d3'
      } ${isActive ? 'border-[var(--bw)_solid]' : 'border-[var(--bw)_solid_var(--b1)]'}`}
      style={isActive && activeBorder ? {
        borderColor: activeBorder,
        ...style,
      } : style}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span
          className={`font-semibold leading-snug text-[var(--font-size-label)] min-w-[var(--sp-4)] text-center px-[var(--sp-1)] rounded-xs ${
            isActive ? 'bg-b3 text-t1' : 'bg-b2 text-t4'
          }`}
        >
          {count}
        </span>
      )}
      {suffix}
    </button>
  )
}

export default FilterPill
