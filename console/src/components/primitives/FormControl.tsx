import { Check } from 'lucide-react';
import {
  type FC,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react';

function borderColor(error?: boolean, confirmed?: boolean): string {
  if (error) return 'var(--status-crit-fg)';
  if (confirmed) return 'var(--wizard-accent)';
  return 'var(--border-subtle)';
}

export interface FieldProps {
  label: string;
  error?: string;
  helper?: string;
  confirmed?: boolean;
  children: (id: string) => ReactNode;
}

export const Field: FC<FieldProps> = ({ label, error, helper, confirmed, children }) => {
  const id = useId();
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
  );
};

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'style'> {
  ref?: RefObject<HTMLInputElement | null>;
  error?: boolean;
  confirmed?: boolean;
}

export const TextInput: FC<TextInputProps> = ({ error, confirmed, className, ref, ...props }) => (
  <input
    ref={ref}
    {...props}
    className={`c-input font-mono ${className ?? ''}`}
    style={{ borderColor: borderColor(error, confirmed) }}
  />
);

export interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'style' | 'type'> {
  ref?: RefObject<HTMLInputElement | null>;
  error?: boolean;
  confirmed?: boolean;
}

export const NumberInput: FC<NumberInputProps> = ({ error, confirmed, className, ref, ...props }) => (
  <input
    ref={ref}
    type="number"
    {...props}
    className={`c-input c-input-number font-mono ${className ?? ''}`}
    style={{ borderColor: borderColor(error, confirmed) }}
  />
);

export interface SelectInputProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'style'> {
  ref?: RefObject<HTMLSelectElement | null>;
  error?: boolean;
  confirmed?: boolean;
}

export const SelectInput: FC<SelectInputProps> = ({ error, confirmed, children, className, ref, ...props }) => (
  <select
    ref={ref}
    {...props}
    className={`c-input c-select ${className ?? ''}`}
    style={{ borderColor: borderColor(error, confirmed) }}
  >
    {children}
  </select>
);

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'style'> {
  ref?: RefObject<HTMLTextAreaElement | null>;
  error?: boolean;
  confirmed?: boolean;
  minHeight?: number;
}

export const TextArea: FC<TextAreaProps> = ({ error, confirmed, minHeight, className, ref, ...props }) => (
  <textarea
    ref={ref}
    {...props}
    className={`c-input font-mono ${className ?? ''}`}
    style={{
      minHeight: minHeight ?? 80,
      resize: 'vertical',
      borderColor: borderColor(error, confirmed),
    }}
  />
);

export interface CheckboxFieldProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  helper?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  labelClassName?: string;
  suffix?: ReactNode;
}

export const CheckboxField: FC<CheckboxFieldProps> = ({
  label,
  checked,
  onChange,
  helper,
  disabled,
  className,
  inputClassName,
  labelClassName,
  suffix,
}) => (
  <div>
    <label className={`c-checkbox-row ${className ?? ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
        className={inputClassName}
      />
      <span className={`text-data ${labelClassName ?? ''}`} style={{ color: 'var(--text-2)' }}>{label}</span>
      {suffix && <span aria-hidden="true">{suffix}</span>}
    </label>
    {helper && <div className="c-helper ml-[var(--sp-5)]">{helper}</div>}
  </div>
);
