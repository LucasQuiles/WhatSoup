import { type FC, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react'
import { inputStyle, selectStyle, numberInputStyle, labelStyle, helperStyle, errorStyle, checkboxRowStyle } from './form-styles'

// ── Form field wrapper ──

interface FieldProps {
  label: string
  error?: string
  helper?: string
  children: ReactNode
}

export const Field: FC<FieldProps> = ({ label, error, helper, children }) => (
  <div>
    <label className="c-label" style={labelStyle}>{label}</label>
    {children}
    {error && <div style={errorStyle}>{error}</div>}
    {!error && helper && <div style={helperStyle}>{helper}</div>}
  </div>
)

// ── Typed input components ──

interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'style'> {
  error?: boolean
}

export const TextInput: FC<TextInputProps> = ({ error, className, ...props }) => (
  <input
    {...props}
    className={`font-mono ${className ?? ''}`}
    style={{ ...inputStyle, borderColor: error ? 'var(--color-s-crit)' : undefined }}
  />
)

interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'style' | 'type'> {
  error?: boolean
}

export const NumberInput: FC<NumberInputProps> = ({ error, className, ...props }) => (
  <input
    type="number"
    {...props}
    className={`font-mono ${className ?? ''}`}
    style={{ ...numberInputStyle, borderColor: error ? 'var(--color-s-crit)' : undefined }}
  />
)

interface SelectInputProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'style'> {
  error?: boolean
}

export const SelectInput: FC<SelectInputProps> = ({ error, children, className, ...props }) => (
  <select
    {...props}
    className={className ?? ''}
    style={{ ...selectStyle, borderColor: error ? 'var(--color-s-crit)' : undefined }}
  >
    {children}
  </select>
)

interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'style'> {
  error?: boolean
  minHeight?: number
}

export const TextArea: FC<TextAreaProps> = ({ error, minHeight, className, ...props }) => (
  <textarea
    {...props}
    className={`font-mono ${className ?? ''}`}
    style={{
      ...inputStyle,
      minHeight: minHeight ?? 80,
      resize: 'vertical',
      borderColor: error ? 'var(--color-s-crit)' : undefined,
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
    <label style={checkboxRowStyle}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ accentColor: 'var(--color-s-ok)' }}
      />
      <span style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-t2)' }}>{label}</span>
    </label>
    {helper && <div style={{ ...helperStyle, marginLeft: 'var(--sp-5)' }}>{helper}</div>}
  </div>
)
