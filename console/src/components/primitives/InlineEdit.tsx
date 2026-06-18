/**
 * InlineEdit.tsx — the edit-in-place primitive (showcase §17 Inline edit).
 *
 * A dashed-underline button (display mode) that swaps to a TextInput on
 * activation. Enter commits via `onCommit` (awaited if a promise; the input
 * is disabled while pending), Esc and blur cancel (revert to the original
 * value, no commit), an unchanged value exits without committing, and an
 * optional `validate` blocks invalid input and surfaces an inline error.
 *
 * Anatomy:
 *   - Display: `<button type="button">` carrying `.soup-inline-edit`
 *     (body face, dashed `--border-hairline` bottom rule, 4px-grid padding,
 *     canonical focus ring) + a lucide `Pencil` affordance (`aria-hidden`).
 *     The button's accessible name is `Edit ${label}` so SR users hear the
 *     intent; native button gives Click / Enter / Space activation for free.
 *   - Edit: a `TextInput` (FormControl primitive) seeded with `value`,
 *     auto-focused on entry, accessible name `label`. Enter runs `validate`
 *     then `onCommit`; Escape and blur cancel.
 *
 * Commit lifecycle:
 *   - `validate(next)` first; if it returns a message the input is marked
 *     `aria-invalid` + `aria-describedby` and the edit persists.
 *   - `onCommit(next)` is awaited when it returns a promise; the input is
 *     disabled (busy) for the duration. On resolve the control returns to
 *     display mode; on reject it STAYS in edit mode so the caller can toast
 *     and the user can retry.
 *
 * Born-clean primitive tier: v3 tokens only (no legacy bg-d-star, text-t-star,
 *   or raw off-grid px).
 */
import {
  type FC,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Pencil } from 'lucide-react';
import { TextInput } from './FormControl';

export interface InlineEditProps {
  /** Current value (controlled). */
  value: string;
  /** Called with the committed next value on Enter (after validate passes). */
  onCommit: (next: string) => void | Promise<void>;
  /** Accessible label; also seeds the display button's `Edit ${label}` name. */
  label: string;
  /** Returns a human message to block commit, or null to accept. */
  validate?: (v: string) => string | null;
  /** Placeholder for the edit input. */
  placeholder?: string;
  /** Blocks entry; the display button is inert. */
  disabled?: boolean;
  /** Rendered in display mode when `value` is empty (default "—"). */
  emptyText?: string;
}

export const InlineEdit: FC<InlineEditProps> = ({
  value,
  onCommit,
  label,
  validate,
  placeholder,
  disabled = false,
  emptyText = '—',
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Guards blur-during-commit: disabling a focused input fires blur, but a
  // pending commit must not be cancelled by that synthetic blur.
  const committingRef = useRef(false);
  const errorId = useId();

  // Keep the draft in sync with external value changes (e.g. after a parent
  // refetch). During editing value is stable, so this is a no-op then.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  // Focus the input on entry into edit mode.
  useEffect(() => {
    if (editing) {
      setError(null);
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }
  }, [editing]);

  const cancel = () => {
    if (committingRef.current) return;
    setEditing(false);
    setError(null);
    setDraft(value);
  };

  const commit = async () => {
    const next = draft;
    // Unchanged → exit without firing onCommit.
    if (next === value) {
      setEditing(false);
      setError(null);
      return;
    }
    const message = validate ? validate(next) : null;
    if (message) {
      setError(message);
      return;
    }
    committingRef.current = true;
    setBusy(true);
    try {
      await onCommit(next);
      setEditing(false);
      setError(null);
    } catch {
      // Stay in edit mode; the caller owns the toast.
    } finally {
      setBusy(false);
      committingRef.current = false;
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="soup-inline-edit"
        aria-label={`Edit ${label}`}
        disabled={disabled}
        onClick={() => setEditing(true)}
      >
        <span className="soup-inline-edit__value">{value || emptyText}</span>
        <Pencil
          size={11}
          strokeWidth={1.5}
          aria-hidden="true"
          className="soup-inline-edit__pen"
        />
      </button>
    );
  }

  return (
    <span className="soup-inline-edit-field">
      <TextInput
        ref={inputRef}
        type="text"
        className="soup-inline-edit__input"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        value={draft}
        placeholder={placeholder}
        disabled={busy}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={cancel}
      />
      {error && (
        <span id={errorId} className="soup-inline-edit__error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
};

export default InlineEdit;
