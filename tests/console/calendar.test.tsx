/** @vitest-environment jsdom */
/**
 * Calendar primitive contract (datetimepicker.md § Phase B; showcase §25):
 * a role=grid month view with day gridcells, today=aria-current, selected=
 * aria-selected, disabled past days, and prev/next month navigation. The
 * component reads ONLY the date portion of the datetime-local value; the parent
 * preserves the time on selection (proven via the onSelect Date payload).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Calendar } from '../../console/src/components/primitives';

afterEach(() => cleanup());

// A fixed far-future value → deterministic month (June 2099), every day selectable.
const FUTURE = '2099-06-15T09:00';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function todayLocalValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

describe('Calendar — month grid', () => {
  it('renders a role=grid month view labelled with the displayed month', () => {
    render(<Calendar value={FUTURE} onSelect={() => {}} />);
    const grid = screen.getByRole('grid');
    expect(grid.getAttribute('aria-label')).toMatch(/Calendar,.*2099/i);
  });

  it('marks the value day as aria-selected', () => {
    render(<Calendar value={FUTURE} onSelect={() => {}} />);
    const grid = screen.getByRole('grid');
    const selected = within(grid)
      .getAllByRole('gridcell')
      .filter((c) => c.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain('15');
  });

  it('calls onSelect with a Date when a day is clicked', () => {
    const onSelect = vi.fn();
    render(<Calendar value={FUTURE} onSelect={onSelect} />);
    const grid = screen.getByRole('grid');
    // Click an in-month, enabled day (the 20th).
    const cells = within(grid).getAllByRole('gridcell');
    const twentieth = cells.find(
      (c) => c.textContent?.trim() === '20' && !(c as HTMLButtonElement).disabled,
    );
    expect(twentieth).toBeDefined();
    fireEvent.click(twentieth!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBeInstanceOf(Date);
    expect((onSelect.mock.calls[0][0] as Date).getDate()).toBe(20);
  });

  it('navigates to the next month when the next-month button is pressed', () => {
    render(<Calendar value={FUTURE} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Next month/i }));
    expect(screen.getByRole('grid').getAttribute('aria-label')).toMatch(/July.*2099/i);
  });

  it('marks today with aria-current="date" and disables a past day', () => {
    render(<Calendar value={todayLocalValue()} onSelect={() => {}} />);
    const grid = screen.getByRole('grid');
    const current = within(grid)
      .getAllByRole('gridcell')
      .filter((c) => c.getAttribute('aria-current') === 'date');
    expect(current).toHaveLength(1);
    // Yesterday-or-earlier in this month (if today is the 1st, the 1st is today —
    // so only assert disabled days exist when today is not the 1st).
    const today = new Date().getDate();
    if (today > 1) {
      const disabled = within(grid)
        .getAllByRole('gridcell')
        .filter((c) => (c as HTMLButtonElement).disabled && c.textContent?.trim());
      expect(disabled.length).toBeGreaterThan(0);
    }
  });
});

describe('Calendar — keyboard navigation (WAI-ARIA grid)', () => {
  // June 1 2099 is a Monday, so June 15 sits at gridIndex 14 (week 2, Monday).
  // Focus seeds on the selected day (15), making every move deterministic.
  function setup() {
    const onSelect = vi.fn();
    render(<Calendar value={FUTURE} onSelect={onSelect} />);
    return { onSelect, grid: screen.getByRole('grid') };
  }
  // Fire a nav key, then Enter to select the now-focused day; return its date-of-month.
  function dateAfter(key: string): number {
    const { onSelect, grid } = setup();
    fireEvent.keyDown(grid, { key });
    fireEvent.keyDown(grid, { key: 'Enter' });
    return (onSelect.mock.calls[0][0] as Date).getDate();
  }

  it('Enter selects the focused day (seeded on the value)', () => {
    const { onSelect, grid } = setup();
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect((onSelect.mock.calls[0][0] as Date).getDate()).toBe(15);
  });

  it('Space selects the focused day', () => {
    const { onSelect, grid } = setup();
    fireEvent.keyDown(grid, { key: ' ' });
    expect((onSelect.mock.calls[0][0] as Date).getDate()).toBe(15);
  });

  it('ArrowRight moves to the next day', () => {
    expect(dateAfter('ArrowRight')).toBe(16);
  });

  it('ArrowLeft moves to the previous day', () => {
    expect(dateAfter('ArrowLeft')).toBe(14);
  });

  it('ArrowDown moves one week forward', () => {
    expect(dateAfter('ArrowDown')).toBe(22);
  });

  it('ArrowUp moves one week back', () => {
    expect(dateAfter('ArrowUp')).toBe(8);
  });

  it('Home jumps to the start (Monday) of the focused row', () => {
    // 15 is itself the Monday of its row → Home stays on 15.
    expect(dateAfter('Home')).toBe(15);
  });

  it('End jumps to the end (Sunday) of the focused row', () => {
    expect(dateAfter('End')).toBe(21);
  });

  it('PageDown advances the displayed month; PageUp reverses it', () => {
    const { grid } = setup();
    fireEvent.keyDown(grid, { key: 'PageDown' });
    expect(grid.getAttribute('aria-label')).toMatch(/July.*2099/i);
    fireEvent.keyDown(grid, { key: 'PageUp' });
    expect(grid.getAttribute('aria-label')).toMatch(/June.*2099/i);
  });

  it('the previous-month button navigates back a month', () => {
    render(<Calendar value={FUTURE} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Previous month/i }));
    expect(screen.getByRole('grid').getAttribute('aria-label')).toMatch(/May.*2099/i);
  });

  it('Enter does not select a past day (keyboard mirrors the disabled-past click guard)', () => {
    // A value on the 1st of the current month: if today is later in the month,
    // the seeded focus is a past day, and Enter must NOT select it.
    const now = new Date();
    if (now.getDate() <= 1) return; // only meaningful when the 1st is in the past
    const firstOfMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01T09:00`;
    const onSelect = vi.fn();
    render(<Calendar value={firstOfMonth} onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders no selected day for an empty value (seed falls back to first in-month day)', () => {
    // Empty value → opens on the current month with NO selected day; the focus
    // seed falls back to the first in-month cell (covers the idx===-1 branch).
    render(<Calendar value="" onSelect={() => {}} />);
    const selected = within(screen.getByRole('grid'))
      .getAllByRole('gridcell')
      .filter((c) => c.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(0);
  });
});
