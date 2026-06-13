import type { ReactNode } from 'react'
import { Search } from 'lucide-react'
import { TextInput, type TextInputProps } from '../primitives'

interface SearchInputProps extends Omit<TextInputProps, 'type'> {
  containerClassName?: string
  endAdornment?: ReactNode
}

export function SearchInput({ containerClassName, className, endAdornment, ...props }: SearchInputProps) {
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
