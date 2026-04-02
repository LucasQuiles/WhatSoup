import { type FC, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { inputStyle, selectStyle, numberInputStyle, labelStyle, helperStyle, errorStyle, checkboxRowStyle, getBorderColor, confirmCheckStyle } from './form-styles'

// ── Form field wrapper ──

interface FieldProps {
  label: string
  error?: string
  helper?: string
  confirmed?: boolean
  children: ReactNode
}

export const Field: FC<FieldProps> = ({ label, error, helper, confirmed, children }) => (
  <div>
    <label className="c-heading" style={labelStyle}>{label}</label>
    <div className="flex items-center" style={{ gap: 'var(--sp-2)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {!error && confirmed && (
        <Check size={16} className="wizard-check" style={confirmCheckStyle} />
      )}
    </div>
    {error && <div style={errorStyle}>{error}</div>}
    {!error && helper && <div style={helperStyle}>{helper}</div>}
  </div>
)

// ── Typed input components ──

interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'style'> {
  error?: boolean
  confirmed?: boolean
}

export const TextInput: FC<TextInputProps> = ({ error, confirmed, className, ...props }) => (
  <input
    {...props}
    className={`font-mono ${className ?? ''}`}
    style={{ ...inputStyle, borderColor: getBorderColor(error, confirmed) }}
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
    className={`font-mono ${className ?? ''}`}
    style={{ ...numberInputStyle, borderColor: getBorderColor(error, confirmed) }}
  />
)

interface SelectInputProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'style'> {
  error?: boolean
  confirmed?: boolean
}

export const SelectInput: FC<SelectInputProps> = ({ error, confirmed, children, className, ...props }) => (
  <select
    {...props}
    className={className ?? ''}
    style={{ ...selectStyle, borderColor: getBorderColor(error, confirmed) }}
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
    className={`font-mono ${className ?? ''}`}
    style={{
      ...inputStyle,
      minHeight: minHeight ?? 80,
      resize: 'vertical',
      borderColor: getBorderColor(error, confirmed),
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
