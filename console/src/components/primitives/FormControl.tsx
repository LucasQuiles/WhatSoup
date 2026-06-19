import { Check } from 'lucide-react';
import {
  cloneElement,
  type FC,
  type CSSProperties,
  type InputHTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react';

function borderColor(error?: boolean, confirmed?: boolean): string {
  if (error) return 'var(--status-crit-fg)';
  // Product-global accent: --wizard-accent only resolves inside .wizard-accent-scope,
  // leaving the confirmed border invisible for non-wizard consumers of this primitive.
  if (confirmed) return 'var(--accent)';
  return 'var(--border-subtle)';
}

interface FieldControlProps {
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-required'?: true;
}

function joinIds(...ids: Array<string | undefined>): string | undefined {
  const joined = ids.filter(Boolean).join(' ');
  return joined.length > 0 ? joined : undefined;
}

function injectFieldControlProps(control: ReactNode, fieldProps: FieldControlProps): ReactNode {
  if (!isValidElement(control)) return control;

  const element = control as ReactElement<Record<string, unknown>>;
  const existingDescription = typeof element.props['aria-describedby'] === 'string'
    ? element.props['aria-describedby']
    : undefined;
  const describedBy = joinIds(existingDescription, fieldProps['aria-describedby']);

  return cloneElement(element, {
    ...fieldProps,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
  });
}

export interface FieldProps {
  /** Field label. ReactNode so consumers can inline marks (e.g. a unit pill); a plain string is the common case. */
  label: ReactNode;
  error?: string;
  helper?: string;
  confirmed?: boolean;
  required?: boolean;
  /** Renders a muted "(optional)" marker after the label (mutually exclusive with `required`). */
  optional?: boolean;
  /**
   * Custom status indicator rendered in the control row, replacing the built-in confirmed Check.
   * For rich/async validation UI — e.g. a spinner while checking, an X when invalid. When omitted,
   * the `confirmed` Check is shown as before.
   */
  statusAdornment?: ReactNode;
  children: (id: string) => ReactNode;
}

export const Field: FC<FieldProps> = ({ label, error, helper, confirmed, required, optional, statusAdornment, children }) => {
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;
  const helperId = !error && helper ? `${id}-helper` : undefined;
  const fieldProps: FieldControlProps = {
    ...(errorId ?? helperId ? { 'aria-describedby': errorId ?? helperId } : {}),
    ...(error ? { 'aria-invalid': true } : {}),
    ...(required ? { 'aria-required': true } : {}),
  };
  const control = injectFieldControlProps(children(id), fieldProps);

  return (
    <div>
      <div>
        <label htmlFor={id} className="c-heading c-field-label">{label}</label>
        {required && <span aria-hidden="true" className="c-required-marker"> *</span>}
        {optional && !required && <span aria-hidden="true" className="c-optional-marker"> (optional)</span>}
      </div>
      <div className="flex items-center gap-[var(--sp-2)]">
        <div className="flex-1 min-w-0">{control}</div>
        {statusAdornment ?? (!error && confirmed ? <Check size={16} className="wizard-check" /> : null)}
      </div>
      {error && <div id={errorId} className="c-error">{error}</div>}
      {!error && helper && <div id={helperId} className="c-helper">{helper}</div>}
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
    // Default the numeric soft-keyboard per input.md:22; consumers may override
    // (e.g. inputMode="numeric" for integer-only fields like ports).
    inputMode="decimal"
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

export interface FileInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'style' | 'type' | 'value'> {
  ref?: RefObject<HTMLInputElement | null>;
  error?: boolean;
  confirmed?: boolean;
}

export const FileInput: FC<FileInputProps> = ({ error, confirmed, className, ref, ...props }) => (
  <input
    ref={ref}
    type="file"
    {...props}
    className={`c-input c-file-input text-data ${className ?? ''}`}
    style={{ borderColor: borderColor(error, confirmed) }}
  />
);

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'style'> {
  ref?: RefObject<HTMLTextAreaElement | null>;
  error?: boolean;
  confirmed?: boolean;
  minHeight?: CSSProperties['minHeight'];
  maxHeight?: CSSProperties['maxHeight'];
  overflow?: CSSProperties['overflow'];
  resize?: CSSProperties['resize'];
  dimmed?: boolean;
  textFace?: 'mono' | 'sans';
}

export const TextArea: FC<TextAreaProps> = ({
  error,
  confirmed,
  minHeight,
  maxHeight,
  overflow,
  resize,
  dimmed,
  textFace = 'mono',
  className,
  ref,
  ...props
}) => (
  <textarea
    ref={ref}
    {...props}
    className={`c-input ${textFace === 'sans' ? 'font-sans' : 'font-mono'} ${className ?? ''}`}
    style={{
      minHeight: minHeight ?? 80,
      maxHeight,
      overflow,
      resize: resize ?? 'vertical',
      opacity: dimmed ? 'var(--opacity-muted)' : undefined,
      borderColor: borderColor(error, confirmed),
    }}
  />
);

export interface RadioFieldProps {
  label: ReactNode;
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  labelClassName?: string;
}

export const RadioField: FC<RadioFieldProps> = ({
  label,
  name,
  value,
  checked,
  onChange,
  disabled,
  className,
  inputClassName,
  labelClassName,
}) => (
  <label className={`c-checkbox-row ${className ?? ''}`}>
    <input
      type="radio"
      name={name}
      value={value}
      checked={checked}
      disabled={disabled}
      onChange={event => onChange(event.target.value)}
      className={inputClassName}
    />
    <span className={`text-data c-checkbox-label ${labelClassName ?? ''}`}>{label}</span>
  </label>
);

export interface CheckboxFieldProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  id?: string;
  helper?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  labelClassName?: string;
  suffix?: ReactNode;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

export const CheckboxField: FC<CheckboxFieldProps> = ({
  label,
  checked,
  onChange,
  id,
  helper,
  disabled,
  className,
  inputClassName,
  labelClassName,
  suffix,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}) => {
  // Auto-wire the helper to the control so screen readers announce it (parity with
  // Field, which does the same). Without this the helper text was visually present
  // but programmatically orphaned. Consumer-supplied aria-describedby is preserved.
  const generatedId = useId();
  const helperId = helper ? generatedId : undefined;
  const describedBy = joinIds(ariaDescribedBy, helperId);
  return (
    <div>
      <label className={`c-checkbox-row ${className ?? ''}`}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={event => onChange(event.target.checked)}
          className={inputClassName}
          aria-describedby={describedBy}
          aria-invalid={ariaInvalid}
        />
        <span className={`text-data c-checkbox-label ${labelClassName ?? ''}`}>{label}</span>
        {suffix && <span aria-hidden="true">{suffix}</span>}
      </label>
      {helper && <div id={helperId} className="c-helper ml-[var(--sp-5)]">{helper}</div>}
    </div>
  );
};
