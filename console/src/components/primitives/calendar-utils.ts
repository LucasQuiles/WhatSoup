/**
 * calendar-utils.ts — pure date helpers for the DateTimePicker Calendar (Phase B).
 *
 * Split out of Calendar.tsx so the component module exports ONLY the component
 * (react-refresh/only-export-components — value exports beside a component break
 * Fast Refresh). All functions are pure (no DOM, no React) and deterministic so
 * the same wall-clock at any DOM produces the same calendar grid.
 *
 * Calendar layout matches the WAI-ARIA grid pattern (week starts Sunday by default
 * — locale-driven override is a future enhancement; the system today renders a
 * Mon-first grid to match the legacy ScheduleComposerModal which used Mon-first
 * weekday labels). The grid is 7 columns × N weeks (always 6 weeks so the panel
 * height is stable across months).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ISO weekday: 1=Mon..7=Sun. The calendar grid renders Mon..Sun (Mon-first). */
export const WEEKDAY_LABELS_MON_FIRST: ReadonlyArray<string> = [
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
];

/** Maximum number of weeks rendered in any month view — guarantees a stable panel height. */
export const MAX_WEEKS_PER_MONTH = 6;

// ---------------------------------------------------------------------------
// Year/month key (serialisable month handle)
// ---------------------------------------------------------------------------

export interface YearMonth {
  year: number;
  /** Zero-indexed month (0=Jan, 11=Dec) — matches Date#getMonth. */
  month: number;
}

export function ymKey(ym: YearMonth): string {
  return `${ym.year}-${String(ym.month).padStart(2, '0')}`;
}

export function ymFromDate(d: Date): YearMonth {
  return { year: d.getFullYear(), month: d.getMonth() };
}

export function ymNext(ym: YearMonth): YearMonth {
  if (ym.month === 11) return { year: ym.year + 1, month: 0 };
  return { year: ym.year, month: ym.month + 1 };
}

export function ymPrev(ym: YearMonth): YearMonth {
  if (ym.month === 0) return { year: ym.year - 1, month: 11 };
  return { year: ym.year, month: ym.month - 1 };
}

// ---------------------------------------------------------------------------
// Day key (stable identifier for a calendar day across re-renders)
// ---------------------------------------------------------------------------

export interface CalendarDay {
  /** Calendar date for this cell (local time). */
  date: Date;
  /** YYYY-MM-DD — stable across renders; used as the React key and aria id. */
  key: string;
  /** 1..31 day-of-month. */
  dayOfMonth: number;
  /**
   * Zero-indexed position within the 6×7 grid. Index 0 is the first cell of
   * week 0 (the Monday-before-or-on-the-1st of the displayed month). Cells
   * that belong to the previous or next month still carry a valid index so
   * arrow-key navigation can move through them.
   */
  gridIndex: number;
  /** True if this cell belongs to the displayed month (vs. spillover). */
  inMonth: boolean;
}

export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Grid generation
// ---------------------------------------------------------------------------

/**
 * Build the 6×7 grid of CalendarDay cells for the displayed month.
 *
 * Week starts on Monday: the first cell is the Monday on-or-before the 1st of
 * `ym`. Trailing cells are filled with the start of the following month until
 * the grid is full (always 42 cells / 6 weeks — stable panel height).
 */
export function buildMonthGrid(ym: YearMonth): CalendarDay[] {
  const firstOfMonth = new Date(ym.year, ym.month, 1);
  // JS getDay: 0=Sun..6=Sat. Convert to Mon-first: Mon=0..Sun=6.
  const monFirstIdx = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(ym.year, ym.month, 1 - monFirstIdx);
  const cells: CalendarDay[] = [];
  for (let i = 0; i < MAX_WEEKS_PER_MONTH * 7; i += 1) {
    const date = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i,
    );
    cells.push({
      date,
      key: dayKey(date),
      dayOfMonth: date.getDate(),
      gridIndex: i,
      inMonth: date.getMonth() === ym.month && date.getFullYear() === ym.year,
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Today (anchored at call time so tests can drive "now" via vi.useFakeTimers)
// ---------------------------------------------------------------------------

/**
 * Return today's date stripped to midnight local time. The Calendar uses this
 * for the `aria-current="date"` marker and for the past-day disable rule.
 *
 * Re-evaluated on every render — the grid re-computes its today check from the
 * current date each time the month changes. There's no internal "today" state.
 */
export function todayLocalMidnight(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// ---------------------------------------------------------------------------
// datetime-local <-> Date/YearMonth helpers
// ---------------------------------------------------------------------------

/**
 * Parse the DATE portion of a datetime-local string ("YYYY-MM-DDTHH:mm") into
 * a Date at local midnight. Returns undefined for empty / malformed input so
 * the Calendar can render an unselected state without an exception.
 */
export function parseDateOnly(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return undefined;
  }
  return new Date(year, month - 1, day);
}

/**
 * Replace the DATE portion of a datetime-local string, preserving the time.
 * If `time` ("HH:mm" or empty) is omitted, defaults to 09:00 to match the
 * Daily preset seed and the ScheduleComposerModal's prior default.
 *
 * Returns the original string unchanged if the input is malformed (defensive:
 * a bad edit must never widen to a default when the user already typed it).
 */
export function setDateOnly(value: string, newDate: Date): string {
  const tMatch = /^(\d{4}-\d{2}-\d{2})(T(\d{2}:\d{2}))?/.exec(value);
  const time = tMatch?.[3] ?? '09:00';
  const y = newDate.getFullYear();
  const m = String(newDate.getMonth() + 1).padStart(2, '0');
  const d = String(newDate.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}T${time}`;
}

/**
 * Produce the YearMonth to show when the popover opens. If the existing value
 * has a parseable date, open on that month; otherwise open on the current
 * month (so the user always lands somewhere meaningful).
 */
export function initialMonthFor(value: string | undefined): YearMonth {
  const parsed = parseDateOnly(value);
  if (parsed) return ymFromDate(parsed);
  const today = todayLocalMidnight();
  return ymFromDate(today);
}
