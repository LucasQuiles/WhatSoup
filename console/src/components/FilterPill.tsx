import { type FC, type ReactNode } from 'react'

interface FilterPillProps {
  label: string
  isActive: boolean
  activeColor?: string    // Tailwind text color class when active, e.g. "text-m-pas"
  activeBorder?: string   // CSS border value when active, e.g. "var(--bw) solid var(--color-m-pas)"
  onClick: () => void
  suffix?: ReactNode      // Optional suffix element (e.g., count badge)
  style?: React.CSSProperties  // Optional style overrides
}

const FilterPill: FC<FilterPillProps> = ({
  label, isActive, activeColor = 'text-t2', activeBorder, onClick, suffix, style,
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`font-mono cursor-pointer c-hover inline-flex items-center ${
        isActive ? `${activeColor} bg-d4` : 'text-t4 hover:text-t2 hover:bg-d3'
      }`}
      style={{
        fontSize: 'var(--font-size-label)',
        letterSpacing: 'var(--tracking-pill)',
        padding: 'var(--sp-0h) var(--sp-2)',
        borderRadius: 'var(--radius-sm)',
        border: isActive
          ? (activeBorder ?? 'var(--bw) solid var(--b4)')
          : 'var(--bw) solid var(--b1)',
        ...style,
      }}
    >
      {label}
      {suffix}
    </button>
  )
}

export default FilterPill
