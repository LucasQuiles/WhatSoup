/**
 * Calendar.tsx — month-grid picker for DateTimePicker Phase B (datetimepicker.md § Phase B).
 *
 * Renders a single month as a 7-column × 6-week grid with a weekday header and
 * prev/next month navigation buttons. Day cells carry shape+token state (today
 * ring, selected accent fill, disabled-past token, spillover dimmed) — never
 * color alone. Selection emits the chosen Date via the `onSelect` prop; the
 * parent (DateTimePicker) translates the Date into a datetime-local string,
 * preserving the time portion.
 *
 * Positioning, escape, focus-restore and outside-click are NOT handled here —
 * the Calendar is rendered as `children` of the existing Popover, which owns
 * those concerns (datetimepicker.md § Phase B "REUSE Popover").
 *
 * Keyboard (WAI-ARIA grid pattern, role=grid):
 *   Arrow keys  — move focus by day, clamping at grid bounds (no wrap)
 *   Home / End  — first / last day of the current row
 *   PageUp/Down — previous / next month (focused day stays the same if possible)
 *   Enter/Space — select focused day (calls onSelect + leaves open/close to parent)
 *   Escape      — handled by Popover (useDismissable capture-phase stack)
 *
 * Focus model: roving tabindex. The currently focused day cell has tabindex=0;
 * all other days have tabindex=-1. The Calendar never steals focus on mount —
 * the trigger keeps focus throughout the popover session, mirroring the listbox
 * contract in Popover.tsx (C-B2-1).
 */
import {
  type FC,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  type YearMonth,
  MAX_WEEKS_PER_MONTH,
  WEEKDAY_LABELS_MON_FIRST,
  buildMonthGrid,
  dayKey,
  initialMonthFor,
  todayLocalMidnight,
  ymKey,
  ymNext,
  ymPrev,
} from './calendar-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * English month abbreviations — the header label ("December 2026"). The grid
 * is not localised in Phase B; i18n is a future enhancement.
 */
const MONTH_LABELS: ReadonlyArray<string> = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function monthLabel(ym: YearMonth): string {
  return `${MONTH_LABELS[ym.month] ?? ''} ${ym.year}`;
}

// ---------------------------------------------------------------------------
// Public props
// ---------------------------------------------------------------------------

export interface CalendarProps {
  /**
   * Current datetime-local value (e.g. "2026-12-31T09:00"). The calendar uses
   * ONLY the DATE portion for the selected/today checks; the time is preserved
   * by the parent on selection.
   */
  value: string;
  /**
   * Called when a day is selected (Enter/Space/click). Receives the new Date
   * (local midnight) for the picked day. The parent owns the time preservation
   * + datetime-local string assembly.
   */
  onSelect: (date: Date) => void;
  /**
   * Optional initial month override. Defaults to the month of `value` (or
   * today if `value` is empty). Used by tests + future external callers.
   */
  initialMonth?: YearMonth;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export const Calendar: FC<CalendarProps> = ({
  value,
  onSelect,
  initialMonth,
}) => {
  // Anchor the displayed month on mount. Once the user clicks prev/next the
  // displayed month becomes internal state. We seed via lazy-init useState so
  // the initial computation runs once (no useMemo + empty-deps anti-pattern).
  const [displayed, setDisplayed] = useState<YearMonth>(
    () => initialMonth ?? initialMonthFor(value),
  );

  // Selected day key (from the date portion of value) — null when no parseable date.
  const selectedKey = useMemo(() => {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    return m ? m[1] : null;
  }, [value]);

  // Today (local midnight) — re-evaluated on render so day-level aria-current
  // tracking stays accurate across long-lived panels. Phase B scope is a single
  // session so this is fine; a multi-day calendar would memo on mount.
  const todayK = useMemo(() => dayKey(todayLocalMidnight()), []);

  // Build the 6×7 grid for the displayed month.
  const grid = useMemo(() => buildMonthGrid(displayed), [displayed]);

  // Focused cell — initial focus lands on the selected day if visible, else
  // the first in-month day of the displayed month (mirrors WAI-ARIA grid
  // single-tabindex roving pattern). gridIndex is the position in the 6×7 grid.
  // Computed ONCE at mount: subsequent value changes should NOT yank the user's
  // focus while they're navigating the grid (lazy useState initializer is the
  // idiomatic React way to express "compute on mount").
  const [focusIndex, setFocusIndex] = useState<number>(() => {
    const initialGrid = buildMonthGrid(displayed);
    if (selectedKey) {
      const idx = initialGrid.findIndex((c) => c.key === selectedKey);
      if (idx !== -1) return idx;
    }
    const idx = initialGrid.findIndex((c) => c.inMonth);
    return idx === -1 ? 0 : idx;
  });

  // focusIndex stays within the fixed 6×7 grid by construction: it is seeded to an
  // in-month cell, moveFocus clamps to [0, grid.length-1], and month-nav sets it to
  // an in-month gridIndex — so no post-render clamp effect is needed, and grid reads
  // are guarded at the use sites.

  // Roving-tabindex DOM focus: the ref tracks the currently-focused cell's button so
  // the effect below can move REAL focus (document.activeElement + :focus-visible + SR
  // position) when focusIndex changes via keyboard. pendingFocusRef gates it to keyboard
  // navigation only — never on mount/value-change — preserving the "no focus steal on
  // mount" contract (docstring) and the C-B2-1 trigger-keeps-focus model.
  const focusedCellRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef(false);

  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    focusedCellRef.current?.focus();
  }, [focusIndex]);

  // Move helper — clamps to grid bounds (no wrap on boundaries per grid pattern).
  const moveFocus = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(grid.length - 1, next));
      pendingFocusRef.current = true;
      setFocusIndex(clamped);
    },
    [grid.length],
  );

  // Month-nav preserving the focused day-of-month if possible.
  const shiftMonth = useCallback(
    (direction: 1 | -1) => {
      const currentCell = grid[focusIndex];
      const targetMonth =
        direction === 1 ? ymNext(displayed) : ymPrev(displayed);
      const targetGrid = buildMonthGrid(targetMonth);
      // Preserve day-of-month: pick the in-month cell with the same dom, else
      // fall back to the last in-month day of the target month.
      const preserved =
        currentCell && targetGrid.find(
          (c) => c.inMonth && c.dayOfMonth === currentCell.dayOfMonth,
        );
      const fallback = targetGrid.find((c) => c.inMonth);
      const targetCell = preserved ?? fallback;
      setDisplayed(targetMonth);
      if (targetCell) {
        pendingFocusRef.current = true;
        setFocusIndex(targetCell.gridIndex);
      }
    },
    [grid, focusIndex, displayed],
  );

  // Keyboard handler — grid roving tabindex + WAI-ARIA grid pattern.
  const handleGridKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const key = e.key;
      if (key === 'ArrowRight') {
        e.preventDefault();
        moveFocus(focusIndex + 1);
      } else if (key === 'ArrowLeft') {
        e.preventDefault();
        moveFocus(focusIndex - 1);
      } else if (key === 'ArrowDown') {
        e.preventDefault();
        moveFocus(focusIndex + 7);
      } else if (key === 'ArrowUp') {
        e.preventDefault();
        moveFocus(focusIndex - 7);
      } else if (key === 'Home') {
        e.preventDefault();
        // First day of the current row (Mon of the focused row).
        const rowStart = Math.floor(focusIndex / 7) * 7;
        moveFocus(rowStart);
      } else if (key === 'End') {
        e.preventDefault();
        // Last day of the current row (Sun of the focused row).
        const rowEnd = Math.floor(focusIndex / 7) * 7 + 6;
        moveFocus(rowEnd);
      } else if (key === 'PageUp') {
        e.preventDefault();
        shiftMonth(-1);
      } else if (key === 'PageDown') {
        e.preventDefault();
        shiftMonth(1);
      } else if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        const cell = grid[focusIndex];
        if (cell && cell.inMonth) {
          // Disabled-past check — mirror the click guard so Enter/Space can't
          // bypass the disable state.
          if (cell.key < todayK) return;
          onSelect(cell.date);
        }
      }
      // Escape is handled by the Popover's useDismissable capture-phase stack.
    },
    [focusIndex, grid, moveFocus, onSelect, shiftMonth, todayK],
  );

  return (
    <div className="soup-calendar" data-month={ymKey(displayed)}>
      <div className="soup-calendar__header">
        <button
          type="button"
          className="soup-calendar__nav"
          aria-label={`Previous month, ${monthLabel(ymPrev(displayed))}`}
          onClick={() => shiftMonth(-1)}
        >
          <ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <div className="soup-calendar__title" aria-live="polite">
          {monthLabel(displayed)}
        </div>
        <button
          type="button"
          className="soup-calendar__nav"
          aria-label={`Next month, ${monthLabel(ymNext(displayed))}`}
          onClick={() => shiftMonth(1)}
        >
          <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      <div
        role="grid"
        aria-label={`Calendar, ${monthLabel(displayed)}`}
        className="soup-calendar__grid"
        onKeyDown={handleGridKeyDown}
      >
        <div role="row" className="soup-calendar__weekdays">
          {WEEKDAY_LABELS_MON_FIRST.map((wd) => (
            <div
              key={wd}
              role="columnheader"
              className="soup-calendar__weekday"
              aria-label={wd}
            >
              {wd}
            </div>
          ))}
        </div>

        {Array.from({ length: MAX_WEEKS_PER_MONTH }, (_, rowIdx) => (
          <div
            key={`row-${rowIdx}`}
            role="row"
            className="soup-calendar__row"
          >
            {grid.slice(rowIdx * 7, rowIdx * 7 + 7).map((cell) => {
              const isFocused = cell.gridIndex === focusIndex;
              const isSelected = cell.key === selectedKey;
              const isToday = cell.key === todayK;
              const isPast = cell.inMonth && cell.key < todayK;
              const tabIndex = isFocused ? 0 : -1;
              const classes = [
                'soup-calendar__day',
                cell.inMonth ? '' : 'soup-calendar__day--out',
                isSelected ? 'soup-calendar__day--selected' : '',
                isToday ? 'soup-calendar__day--today' : '',
                isPast ? 'soup-calendar__day--past' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={cell.key}
                  ref={isFocused ? focusedCellRef : null}
                  type="button"
                  role="gridcell"
                  tabIndex={tabIndex}
                  aria-selected={isSelected}
                  aria-current={isToday ? 'date' : undefined}
                  aria-disabled={isPast || undefined}
                  disabled={isPast || undefined}
                  data-day-key={cell.key}
                  className={classes}
                  onClick={() => {
                    if (isPast) return;
                    onSelect(cell.date);
                  }}
                >
                  <span className="soup-calendar__day-num">{cell.dayOfMonth}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

// Date helpers + types live in ./calendar-utils and are re-exported from the
// primitives barrel directly (keeping this module component-only for Fast Refresh).
