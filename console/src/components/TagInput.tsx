import { type FC, useState, useCallback, useRef, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'

interface TagInputProps {
  values: string[]
  onChange: (values: string[]) => void
  placeholder?: string
  validate?: (value: string) => boolean
}

const TagInput: FC<TagInputProps> = ({ values, onChange, placeholder, validate }) => {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const addTag = useCallback((raw: string) => {
    const tag = raw.trim()
    if (!tag) return
    if (values.includes(tag)) return
    if (validate && !validate(tag)) return
    onChange([...values, tag])
    setInput('')
  }, [values, onChange, validate])

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
        className="w-full font-mono"
        style={{
          background: 'var(--color-d1)',
          border: 'var(--bw) solid var(--b2)',
          borderRadius: 'var(--radius-sm)',
          padding: 'var(--sp-2) var(--sp-3)',
          fontSize: 'var(--font-size-data)',
          color: 'var(--color-t1)',
        }}
      />
      {values.length > 0 && (
        <div className="flex flex-wrap" style={{ gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
          {values.map((tag, i) => (
            <span
              key={tag}
              className="c-label inline-flex items-center"
              style={{
                background: 'var(--color-d4)',
                borderRadius: 'var(--radius-sm)',
                padding: 'var(--sp-1) var(--sp-2)',
                gap: 'var(--sp-1)',
              }}
            >
              {tag}
              <button
                type="button"
                onClick={() => removeTag(i)}
                className="inline-flex items-center justify-center cursor-pointer c-hover"
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--color-t3)',
                }}
              >
                <X style={{ width: 'var(--sp-3)', height: 'var(--sp-3)' }} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default TagInput
