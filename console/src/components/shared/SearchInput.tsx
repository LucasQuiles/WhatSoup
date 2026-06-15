import type { ReactNode } from 'react'
import { Search } from 'lucide-react'
import { TextInput, type TextInputProps } from '../primitives'

interface SearchInputProps extends Omit<TextInputProps, 'type'> {
  containerClassName?: string
  endAdornment?: ReactNode
  shortcutTarget?: boolean
}

export function SearchInput({ containerClassName, className, endAdornment, shortcutTarget = false, ...props }: SearchInputProps) {
  return (
    <div className={['relative', containerClassName].filter(Boolean).join(' ')}>
      <Search
        size={13}
        strokeWidth={1.75}
        className="absolute top-1/2 -translate-y-1/2 pointer-events-none text-t5 left-[var(--sp-2h)]"
      />
      <TextInput
        type="text"
        {...props}
        data-search-shortcut-target={shortcutTarget ? 'true' : undefined}
        className={['c-input c-input-search', className].filter(Boolean).join(' ')}
      />
      {endAdornment ? (
        <div
          className="absolute top-1/2 -translate-y-1/2 right-[var(--sp-2h)]"
        >
          {endAdornment}
        </div>
      ) : null}
    </div>
  )
}
