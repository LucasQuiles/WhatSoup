import { type FC, useState, useCallback, type KeyboardEvent } from 'react'
import { TextInput } from './primitives'
import { Pill, type PillTone } from './primitives/Pill'

// ---------------------------------------------------------------------------
// accentColor → PillTone mapping
//
// accentColor is a CSS custom-property string passed by wizard/dialog
// consumers. Rather than forwarding raw inline styles onto the Pill
// primitive, we resolve the string to the nearest semantic PillTone.
//
// Mapping (callers enumerated by grep as of 2026-06-12):
//   'var(--wizard-accent)'  → 'accent'  (runtime token; nearest channel = accent)
//   'var(--color-m-agt)'   → 'agent'
//   'var(--color-m-cht)'   → 'chat'
//   'var(--color-m-pas)'   → 'passive'
//   'var(--color-s-ok)'    → 'ok'
//   'var(--color-s-warn)'  → 'warn'
//   'var(--color-s-crit)'  → 'crit'
//   undefined              → 'neutral'
//   (unrecognised)         → 'neutral'
//
// Visual change (C-B2-3): per-wizard arbitrary-color chip tint is replaced by
// the closest Pill semantic tone. Reviewed at the live frontend-design
// checkpoint.
// ---------------------------------------------------------------------------
const ACCENT_TO_TONE: Record<string, PillTone> = {
  'var(--wizard-accent)': 'accent',
  'var(--color-m-agt)':   'agent',
  'var(--color-m-cht)':   'chat',
  'var(--color-m-pas)':   'passive',
  'var(--color-s-ok)':    'ok',
  'var(--color-s-warn)':  'warn',
  'var(--color-s-crit)':  'crit',
}

function resolveTone(accentColor: string | undefined): PillTone {
  if (!accentColor) return 'neutral'
  return ACCENT_TO_TONE[accentColor] ?? 'neutral'
}

function hasUnsafeTrimBoundary(raw: string, trimmed: string): boolean {
  const start = raw.indexOf(trimmed)
  const boundary = `${raw.slice(0, start)}${raw.slice(start + trimmed.length)}`
  return [...boundary].some(character => character !== ' ')
}

// ---------------------------------------------------------------------------
// Props — public contract preserved verbatim (DD-13).
// accentColor is still accepted so existing consumers (ConfigStep,
// IdentityStep, ConfigEditDialog) compile without change.
// ---------------------------------------------------------------------------
interface TagInputProps {
  values: string[]
  onChange: (values: string[]) => void
  id?: string
  placeholder?: string
  validate?: (value: string) => boolean
  normalizeValue?: (value: string) => string
  accentColor?: string  // CSS var for pill accent, e.g. 'var(--wizard-accent)'
  /** Optional display labels for values. Map from value → display string. */
  displayLabels?: Record<string, string>
  'aria-describedby'?: string
  'aria-invalid'?: true
}

const TagInput: FC<TagInputProps> = ({
  values,
  onChange,
  id,
  placeholder,
  validate,
  normalizeValue,
  accentColor,
  displayLabels,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}) => {
  const [input, setInput] = useState('')

  const tone = resolveTone(accentColor)

  const addTag = useCallback((raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    if (hasUnsafeTrimBoundary(raw, trimmed)) return
    const tag = normalizeValue ? normalizeValue(trimmed) : trimmed
    if (!tag) return
    if (values.includes(tag)) return
    if (validate && !validate(tag)) return
    onChange([...values, tag])
    setInput('')
  }, [values, onChange, validate, normalizeValue])

  const removeTag = useCallback((index: number) => {
    onChange(values.filter((_, i) => i !== index))
  }, [values, onChange])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addTag(input)
    } else if (e.key === 'Backspace' && input === '' && values.length > 0) {
      removeTag(values.length - 1)
    }
  }, [input, values, addTag, removeTag])

  return (
    <div>
      <TextInput
        id={id}
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => addTag(input)}
        placeholder={placeholder ? `${placeholder} (press Enter to add)` : 'Press Enter to add'}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        className="w-full"
      />
      {values.length > 0 && (
        <div className="flex flex-wrap gap-[var(--sp-2)] mt-[var(--sp-2)]">
          {values.map((tag, i) => {
            const label = displayLabels?.[tag] ?? tag
            return (
              <Pill
                key={tag}
                variant="removable"
                tone={tone}
                onRemove={() => removeTag(i)}
                removeLabel={`Remove ${label}`}
              >
                {label}
              </Pill>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default TagInput
