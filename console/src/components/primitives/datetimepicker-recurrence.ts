/**
 * datetimepicker-recurrence.ts — recurrence model + cron mappers for DateTimePicker.
 *
 * Split out of DateTimePicker.tsx so the component module exports ONLY the component
 * (react-refresh/only-export-components — value exports beside a component break Fast
 * Refresh). The backend recurrence contract is a cron string; these map the segmented
 * Once/Daily/Weekly/Cron model to and from it, preserving arbitrary expressions.
 */

export type RecurrenceValue =
  | { kind: 'once' }
  | { kind: 'daily' }
  | { kind: 'weekly' }
  | { kind: 'cron'; expr: string };

/** Locked v2 presets — mirror the prior RECURRENCE_PRESETS in ScheduleComposerModal. */
export const DAILY_CRON = '0 9 * * *';
export const WEEKLY_CRON = '0 9 * * 1';

/**
 * Render a RecurrenceValue to the cron string the backend expects. Once → undefined
 * (the modal emits NO recurrence field in that case, matching today's recurring=false path).
 * Daily/Weekly → the locked preset cron. Cron → the trimmed expression, or undefined if blank.
 */
export function recurrenceToCron(r: RecurrenceValue): string | undefined {
  switch (r.kind) {
    case 'once':
      return undefined;
    case 'daily':
      return DAILY_CRON;
    case 'weekly':
      return WEEKLY_CRON;
    case 'cron':
      return r.expr.trim() ? r.expr.trim() : undefined;
  }
}

/**
 * Map an existing editMessage.recurrence cron string (or undefined) back into a
 * RecurrenceValue. Preserves arbitrary cron expressions: a non-preset cron lands on
 * the Cron segment with its expression intact (so an existing every-30-min cron row edits
 * back into the same Cron segment rather than being snapped to a preset).
 */
export function cronToRecurrence(expr: string | undefined): RecurrenceValue {
  if (!expr) return { kind: 'once' };
  if (expr === DAILY_CRON) return { kind: 'daily' };
  if (expr === WEEKLY_CRON) return { kind: 'weekly' };
  return { kind: 'cron', expr };
}
