/**
 * DateTimePicker.tsx — Phase A primitive for `console/src/components/line-detail/ScheduleComposerModal.tsx`.
 *
 * Phase A goal: collapse the modal's native `<input type="datetime-local">` + recurring toggle +
 * preset buttons + free-text cron box into ONE composite primitive whose headline is a segmented
 * recurrence row (Once · Daily · Weekly · Cron). The calendar popover is explicitly DEFERRED to a
 * later leaf (Phase B) — this primitive still renders a native `<input type="datetime-local">` for
 * the date+time portion.
 *
 * Design constraints:
 *  - NO new tokens (Phase A). Reuses `Field` for the date+time + error contract, the `.soup-toolbar-seg`
 *    BEM family for the recurrence row, and the existing `TextInput` primitive for the free-text cron.
 *  - No raw inline styles; everything routes through existing utility classes (`font-mono`, `c-meta`)
 *    or class hooks (`.soup-toolbar-seg`, `.soup-toolbar-seg__btn`).
 *  - The recurrence row is a `role="group"` with `aria-label="Recurrence"`, exactly mirroring the
 *    `ToolbarTimeRange` segmented control (so AT users get the same pressed-button affordance), but
 *    rendered WITHOUT the surrounding `Toolbar` shell because it is not part of a list/toolbar —
 *    it is a form control cluster.
 *  - Behavior is preserved: emit `recurrence` as a cron string (or none for Once); edit-load maps
 *    an existing `recurrence` value back into the right segment via `cronToRecurrence`.
 */
import { type ChangeEventHandler, type FC } from 'react';
import { cronToHuman } from '../line-detail/scheduled-utils.js';
import { Field, TextInput } from './FormControl.js';
import {
  type RecurrenceValue,
  DAILY_CRON,
  recurrenceToCron,
} from './datetimepicker-recurrence.js';

/**
 * Phase A recurrence value. Once carries no schedule; Daily/Weekly carry the locked v2 presets
 * (matching the prior `RECURRENCE_PRESETS` in ScheduleComposerModal); Cron carries a free-text
 * expression so any non-preset cron survives a round-trip.
 *
 * NOTE on Monthly: the prior presets exposed `0 9 1 * *` as "Monthly" — Phase A folds that
 * intent into the Cron segment (the prior modal surfaced Monthly alongside Daily/Weekly as a
 * preset button, but the backend contract is still a cron string; one segment fewer in the
 * row keeps the headline calm and a non-preset entry is no longer hidden behind a Monthly
 * button that does not exist for arbitrary dom-of-month cadences).
 */
const SEG_KINDS: ReadonlyArray<{ kind: RecurrenceValue['kind']; label: string }> = [
  { kind: 'once', label: 'Once' },
  { kind: 'daily', label: 'Daily' },
  { kind: 'weekly', label: 'Weekly' },
  { kind: 'cron', label: 'Cron' },
];

function recurrenceKind(r: RecurrenceValue): RecurrenceValue['kind'] {
  return r.kind;
}

export interface DateTimePickerProps {
  /** datetime-local value (e.g. "2026-12-31T09:00"). */
  value: string;
  onChange: (v: string) => void;
  /** Active recurrence segment. Controlled — the parent owns the state. */
  recurrence: RecurrenceValue;
  onRecurrenceChange: (r: RecurrenceValue) => void;
  /** Optional error to wire through `Field` (border + aria-invalid + describedby). */
  error?: string;
  /** Label for the date+time field. Defaults to "Scheduled time (local)". */
  label?: string;
  /**
   * When true, the field carries `min={now}` so the native picker prevents past selections.
   * Not enforced on `value` because `Field`/`TextInput` does not own the min attribute plumbing —
   * callers wanting server-side validation still do that.
   */
  minNow?: boolean;
}

/**
 * Phase A: native `<input type="datetime-local">` wrapped in `Field` for the error contract,
 * plus a `.soup-toolbar-seg` row of four buttons. The Cron segment reveals a free-text
 * `<input>` + a `cronToHuman` preview line (both routed through the existing `TextInput`
 * primitive + `.c-meta` utility). Once/Daily/Weekly hide the free-text.
 */
export const DateTimePicker: FC<DateTimePickerProps> = ({
  value,
  onChange,
  recurrence,
  onRecurrenceChange,
  error,
  label = 'Scheduled time (local)',
  minNow = false,
}) => {
  const handleDateChange: ChangeEventHandler<HTMLInputElement> = (e) => {
    onChange(e.target.value);
  };

  const handleCronChange: ChangeEventHandler<HTMLInputElement> = (e) => {
    onRecurrenceChange({ kind: 'cron', expr: e.target.value });
  };

  const handleSegClick = (kind: RecurrenceValue['kind']) => {
    if (kind === 'cron') {
      // Seed the Cron segment with the current expr (or Daily preset as a sane default) so
      // users see something in the free-text box the moment Cron is selected.
      const seed: RecurrenceValue =
        recurrence.kind === 'cron' && recurrence.expr.trim()
          ? recurrence
          : { kind: 'cron', expr: recurrenceToCron(recurrence) ?? DAILY_CRON };
      onRecurrenceChange(seed);
      return;
    }
    onRecurrenceChange({ kind } as RecurrenceValue);
  };

  const activeKind = recurrenceKind(recurrence);
  const cronPreview =
    recurrence.kind === 'cron' && recurrence.expr.trim() ? cronToHuman(recurrence.expr) : '';
  const minAttr = minNow
    ? (() => {
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        return (
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
          `T${pad(d.getHours())}:${pad(d.getMinutes())}`
        );
      })()
    : undefined;

  return (
    <div className="flex flex-col gap-[var(--sp-3)]">
      <Field label={label} error={error}>
        {(controlId) => (
          <input
            id={controlId}
            type="datetime-local"
            value={value}
            onChange={handleDateChange}
            min={minAttr}
            className="c-input font-mono"
          />
        )}
      </Field>

      <div role="group" aria-label="Recurrence" className="soup-toolbar-seg">
        {SEG_KINDS.map((opt) => (
          <button
            key={opt.kind}
            type="button"
            className="soup-toolbar-seg__btn"
            aria-pressed={activeKind === opt.kind}
            onClick={() => handleSegClick(opt.kind)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {recurrence.kind === 'cron' && (
        <div className="flex flex-col gap-[var(--sp-2)]">
          <TextInput
            type="text"
            value={recurrence.expr}
            onChange={handleCronChange}
            placeholder="Cron expression (min hr dom mon dow)"
            className="text-text-2"
          />
          {cronPreview && (
            <div className="c-meta mt-[var(--sp-1)]">{cronPreview}</div>
          )}
        </div>
      )}
    </div>
  );
};