import { type FC, type ReactNode, type KeyboardEvent, useRef } from 'react'

interface CardOption {
  value: string
  label: string
  description: string
  icon: ReactNode
  color: string
}

interface CardSelectorProps {
  /** Accessible name for the radiogroup (required by DD-14 / WAI radiogroup pattern). */
  label: string
  options: CardOption[]
  selected: string | null
  onChange: (value: string) => void
  'aria-describedby'?: string
  'aria-invalid'?: true
  disabled?: boolean
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
  return map[color] ?? 'var(--btn-neutral-bg)'
}

const CardSelector: FC<CardSelectorProps> = ({
  label,
  options,
  selected,
  onChange,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  disabled = false,
}) => {
  const groupRef = useRef<HTMLDivElement | null>(null)

  // WAI radiogroup: Arrow keys move focus AND select (selection follows focus).
  // Space selects the currently focused option (handles Tab-then-Space entry).
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', ' '].includes(e.key)) return
    const radios = Array.from(
      groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [],
    )
    if (radios.length === 0) return
    const focusedIndex = radios.indexOf(document.activeElement as HTMLElement)

    if (e.key === ' ') {
      // Select the currently focused radio.
      e.preventDefault()
      if (focusedIndex >= 0) {
        onChange(options[focusedIndex]!.value)
      }
      return
    }

    e.preventDefault()
    let next = focusedIndex
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = focusedIndex < 0 ? 0 : (focusedIndex + 1) % radios.length
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = focusedIndex < 0 ? radios.length - 1 : (focusedIndex - 1 + radios.length) % radios.length
    }

    radios[next]?.focus()
    // WAI radiogroup: selection follows focus (differs from Tabs manual activation)
    onChange(options[next]!.value)
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid}
      aria-disabled={disabled || undefined}
      className="flex flex-wrap gap-[var(--sp-3)]"
      onKeyDown={handleKeyDown}
    >
      {options.map((opt, index) => {
        const isSelected = opt.value === selected
        // Roving tabindex: selected option is tabbable; when nothing is selected,
        // the first option is tabbable (WAI radio pattern, none-selected fallback).
        const tabIndex = disabled ? -1 : isSelected ? 0 : (selected === null && index === 0 ? 0 : -1)
        return (
          <div
            key={opt.value}
            role="radio"
            aria-checked={isSelected}
            tabIndex={tabIndex}
            aria-disabled={disabled || undefined}
            onClick={() => { if (!disabled) onChange(opt.value) }}
            className={`${disabled ? 'cursor-not-allowed opacity-[var(--opacity-muted)]' : 'cursor-pointer c-hover'} flex flex-col items-center text-center flex-1 rounded-lg p-[var(--sp-4)] min-w-0 min-h-[var(--sp-12)]`}
            style={{
              background: isSelected ? colorToWash(opt.color) : 'var(--surface-raised)',
              border: isSelected
                ? `var(--bw) solid ${opt.color}`
                : 'var(--bw) solid var(--border-subtle)',
            }}
          >
            <div className="mb-[var(--sp-3)]" style={{ color: opt.color }}>
              {opt.icon}
            </div>
            <div className="c-heading mb-[var(--sp-1)]">
              {opt.label}
            </div>
            <div className="text-text-2 text-data">
              {opt.description}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default CardSelector
