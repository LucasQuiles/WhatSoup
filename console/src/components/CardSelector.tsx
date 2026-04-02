import { type FC, type ReactNode } from 'react'

interface CardOption {
  value: string
  label: string
  description: string
  icon: ReactNode
  color: string
}

interface CardSelectorProps {
  options: CardOption[]
  selected: string | null
  onChange: (value: string) => void
}

/** Derives a wash-opacity background from a CSS var color string. */
function colorToWash(color: string): string {
  const map: Record<string, string> = {
    'var(--color-m-pas)': 'var(--m-pas-wash)',
    'var(--color-m-cht)': 'var(--m-cht-wash)',
    'var(--color-m-agt)': 'var(--m-agt-wash)',
    'var(--color-s-ok)': 'var(--s-ok-wash)',
    'var(--color-s-warn)': 'var(--s-warn-wash)',
    'var(--color-s-crit)': 'var(--s-crit-wash)',
  }
  return map[color] ?? 'var(--color-d4)'
}

const CardSelector: FC<CardSelectorProps> = ({ options, selected, onChange }) => {
  return (
    <div className="flex flex-wrap" style={{ gap: 'var(--sp-3)' }}>
      {options.map(opt => {
        const isSelected = opt.value === selected
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="cursor-pointer c-hover flex flex-col items-center text-center flex-1"
            style={{
              background: isSelected ? colorToWash(opt.color) : 'var(--color-d3)',
              border: isSelected
                ? `var(--bw) solid ${opt.color}`
                : 'var(--bw) solid var(--b2)',
              borderRadius: 'var(--radius-lg)',
              padding: 'var(--sp-4)',
              minWidth: 0,
              minHeight: 'var(--sp-12)',
            }}
          >
            <div style={{ marginBottom: 'var(--sp-3)', color: opt.color }}>
              {opt.icon}
            </div>
            <div className="c-heading" style={{ marginBottom: 'var(--sp-1)' }}>
              {opt.label}
            </div>
            <div className="text-t3" style={{ fontSize: 'var(--font-size-data)' }}>
              {opt.description}
            </div>
          </button>
        )
      })}
    </div>
  )
}

export default CardSelector
