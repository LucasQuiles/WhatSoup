import { type FC, useState, useCallback, useRef, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
// inputStyle replaced by c-input CSS class

interface TagInputProps {
  values: string[]
  onChange: (values: string[]) => void
  placeholder?: string
  validate?: (value: string) => boolean
  normalizeValue?: (value: string) => string
  accentColor?: string  // CSS var for pill accent, e.g. 'var(--wizard-accent)'
  /** Optional display labels for values. Map from value → display string. */
  displayLabels?: Record<string, string>
}

const TagInput: FC<TagInputProps> = ({ values, onChange, placeholder, validate, normalizeValue, accentColor, displayLabels }) => {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const addTag = useCallback((raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
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
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => addTag(input)}
        placeholder={placeholder ? `${placeholder} (press Enter to add)` : 'Press Enter to add'}
        className="c-input w-full font-mono"
        style={{
          borderColor: (accentColor && values.length > 0) ? accentColor : 'var(--b2)',
        }}
      />
      {values.length > 0 && (
        <div className="flex flex-wrap gap-[var(--sp-2)] mt-[var(--sp-2)]">
          {values.map((tag, i) => (
            <span
              key={tag}
              className="inline-flex items-center font-mono font-medium rounded-sm py-[var(--sp-1)] px-[var(--sp-2)] gap-[var(--sp-1)] text-label"
              style={{
                background: accentColor ? `color-mix(in srgb, ${accentColor} 15%, var(--color-d4))` : 'var(--color-d4)',
                color: accentColor ?? 'var(--color-t4)',
                borderWidth: 'var(--bw)',
                borderStyle: 'solid',
                borderColor: accentColor ?? 'var(--b2)',
              }}
            >
              {displayLabels?.[tag] ?? tag}
              <button
                type="button"
                onClick={() => removeTag(i)}
                className="inline-flex items-center justify-center cursor-pointer c-hover text-t3"
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                }}
              >
                <X className="w-[var(--sp-3)] h-[var(--sp-3)]" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default TagInput
