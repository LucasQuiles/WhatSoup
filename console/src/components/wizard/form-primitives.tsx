import { type FC, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode, useId } from 'react'
import { Check } from 'lucide-react'

function borderColor(error?: boolean, confirmed?: boolean): string {
  if (error) return 'var(--color-s-crit)'
  if (confirmed) return 'var(--wizard-accent)'
  return 'var(--b2)'
}

// ── Form field wrapper ──

interface FieldProps {
  label: string
  error?: string
  helper?: string
  confirmed?: boolean
  children: (id: string) => ReactNode
}

export const Field: FC<FieldProps> = ({ label, error, helper, confirmed, children }) => {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="c-heading c-field-label">{label}</label>
      <div className="flex items-center gap-[var(--sp-2)]">
        <div className="flex-1 min-w-0">{children(id)}</div>
        {!error && confirmed && (
          <Check size={16} className="wizard-check" />
        )}
      </div>
      {error && <div className="c-error">{error}</div>}
      {!error && helper && <div className="c-helper">{helper}</div>}
    </div>
  )
}

// ── Typed input components ──

interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'style'> {
  error?: boolean
  confirmed?: boolean
}

export const TextInput: FC<TextInputProps> = ({ error, confirmed, className, ...props }) => (
  <input
    {...props}
    className={`c-input font-mono ${className ?? ''}`}
    style={{ borderColor: borderColor(error, confirmed) }}
  />
)

interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'style' | 'type'> {
  error?: boolean
  confirmed?: boolean
}

export const NumberInput: FC<NumberInputProps> = ({ error, confirmed, className, ...props }) => (
  <input
    type="number"
    {...props}
    className={`c-input c-input-number font-mono ${className ?? ''}`}
    style={{ borderColor: borderColor(error, confirmed) }}
  />
)

interface SelectInputProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'style'> {
  error?: boolean
  confirmed?: boolean
}

export const SelectInput: FC<SelectInputProps> = ({ error, confirmed, children, className, ...props }) => (
  <select
    {...props}
    className={`c-input c-select ${className ?? ''}`}
    style={{ borderColor: borderColor(error, confirmed) }}
  >
    {children}
  </select>
)

interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'style'> {
  error?: boolean
  confirmed?: boolean
  minHeight?: number
}

export const TextArea: FC<TextAreaProps> = ({ error, confirmed, minHeight, className, ...props }) => (
  <textarea
    {...props}
    className={`c-input font-mono ${className ?? ''}`}
    style={{
      minHeight: minHeight ?? 80,
      resize: 'vertical',
      borderColor: borderColor(error, confirmed),
    }}
  />
)

interface CheckboxFieldProps {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  helper?: string
}

export const CheckboxField: FC<CheckboxFieldProps> = ({ label, checked, onChange, helper }) => (
  <div>
    <label className="c-checkbox-row">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        /* accentColor set globally in index.css */
      />
      <span className="text-t2" style={{ fontSize: 'var(--font-size-data)' }}>{label}</span>
    </label>
    {helper && <div className="c-helper ml-[var(--sp-5)]">{helper}</div>}
  </div>
)
