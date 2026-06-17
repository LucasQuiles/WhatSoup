/** @vitest-environment jsdom */
/**
 * DateTimePicker primitive contract (datetimepicker.md).
 *
 * Phase A: native `<input type="datetime-local">` wrapped in `Field` + segmented
 * recurrence row (Once · Daily · Weekly · Cron) reusing the `.soup-toolbar-seg`
 * BEM family. The Cron segment reveals a free-text cron input + human preview line.
 *
 * Class-only assertions prove the CSS hook exists, not the rendered ink.
 * Behavioural assertions cover the prop contract, the helpers, and the
 * Field error contract that the primitive depends on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  DateTimePicker,
  recurrenceToCron,
  cronToRecurrence,
  DAILY_CRON,
  WEEKLY_CRON,
  type RecurrenceValue,
} from '../../console/src/components/primitives';

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// 1. Helper functions — pure (no DOM)
// ---------------------------------------------------------------------------

describe('recurrenceToCron', () => {
  it('returns undefined for once', () => {
    expect(recurrenceToCron({ kind: 'once' })).toBeUndefined();
  });

  it('returns the locked Daily preset', () => {
    expect(recurrenceToCron({ kind: 'daily' })).toBe(DAILY_CRON);
  });

  it('returns the locked Weekly preset', () => {
    expect(recurrenceToCron({ kind: 'weekly' })).toBe(WEEKLY_CRON);
  });

  it('returns the trimmed cron expression when non-empty', () => {
    expect(recurrenceToCron({ kind: 'cron', expr: '*/30 * * * *' })).toBe('*/30 * * * *');
  });

  it('returns undefined for a blank cron expression', () => {
    expect(recurrenceToCron({ kind: 'cron', expr: '   ' })).toBeUndefined();
  });

  it('trims surrounding whitespace from cron expressions', () => {
    expect(recurrenceToCron({ kind: 'cron', expr: '  0 9 * * 1  ' })).toBe('0 9 * * 1');
  });
});

describe('cronToRecurrence', () => {
  it('returns once for undefined', () => {
    expect(cronToRecurrence(undefined)).toEqual({ kind: 'once' });
  });

  it('returns daily for the Daily preset cron', () => {
    expect(cronToRecurrence(DAILY_CRON)).toEqual({ kind: 'daily' });
  });

  it('returns weekly for the Weekly preset cron', () => {
    expect(cronToRecurrence(WEEKLY_CRON)).toEqual({ kind: 'weekly' });
  });

  it('preserves a non-preset cron expression on the Cron segment', () => {
    expect(cronToRecurrence('*/30 * * * *')).toEqual({ kind: 'cron', expr: '*/30 * * * *' });
  });

  it('preserves the Monthly cadence on the Cron segment (folded from preset)', () => {
    expect(cronToRecurrence('0 9 1 * *')).toEqual({ kind: 'cron', expr: '0 9 1 * *' });
  });
});

describe('recurrenceToCron ⇄ cronToRecurrence round-trip', () => {
  const cases: Array<[RecurrenceValue, string | undefined]> = [
    [{ kind: 'once' }, undefined],
    [{ kind: 'daily' }, DAILY_CRON],
    [{ kind: 'weekly' }, WEEKLY_CRON],
    [{ kind: 'cron', expr: '*/30 * * * *' }, '*/30 * * * *'],
    [{ kind: 'cron', expr: '0 9 1 * *' }, '0 9 1 * *'],
  ];

  it.each(cases)('round-trips %o via cron → recurrence → cron', (input, expectedCron) => {
    const cron = recurrenceToCron(input);
    expect(cron).toBe(expectedCron);
    const back = cronToRecurrence(cron);
    expect(back).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// 2. Rendered anatomy — segmented recurrence row
// ---------------------------------------------------------------------------

function renderControlled(initial?: RecurrenceValue) {
  const onRecurrenceChange = vi.fn();
  const onChange = vi.fn();
  const utils = render(
    <DateTimePicker
      value="2099-01-01T09:00"
      onChange={onChange}
      recurrence={initial ?? { kind: 'once' }}
      onRecurrenceChange={onRecurrenceChange}
    />,
  );
  return { ...utils, onChange, onRecurrenceChange };
}

describe('DateTimePicker — segmented row', () => {
  it('renders exactly four buttons labelled Once, Daily, Weekly, Cron', () => {
    renderControlled();

    const group = screen.getByRole('group', { name: 'Recurrence' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Once', 'Daily', 'Weekly', 'Cron']);
  });

  it('uses the .soup-toolbar-seg BEM family (no new dialect)', () => {
    const { container } = renderControlled();

    expect(container.querySelector('.soup-toolbar-seg')).not.toBeNull();
    expect(container.querySelectorAll('.soup-toolbar-seg__btn').length).toBe(4);
  });

  it('marks exactly one button aria-pressed=true for each segment kind', () => {
    const cases: Array<[RecurrenceValue, string]> = [
      [{ kind: 'once' }, 'Once'],
      [{ kind: 'daily' }, 'Daily'],
      [{ kind: 'weekly' }, 'Weekly'],
      [{ kind: 'cron', expr: '0 9 * * 1' }, 'Cron'],
    ];
    for (const [r, expected] of cases) {
      cleanup();
      renderControlled(r);
      const group = screen.getByRole('group', { name: 'Recurrence' });
      const buttons = within(group).getAllByRole('button');
      const pressed = buttons.filter((b) => b.getAttribute('aria-pressed') === 'true');
      expect(pressed.length).toBe(1);
      expect(pressed[0]!.textContent).toBe(expected);
      cleanup();
    }
  });

  it('aria-pressed reflects the prop (controlled) — re-render with daily', () => {
    const { rerender } = render(
      <DateTimePicker
        value="2099-01-01T09:00"
        onChange={() => {}}
        recurrence={{ kind: 'once' }}
        onRecurrenceChange={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Once' }).getAttribute('aria-pressed')).toBe('true');

    rerender(
      <DateTimePicker
        value="2099-01-01T09:00"
        onChange={() => {}}
        recurrence={{ kind: 'daily' }}
        onRecurrenceChange={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'Daily' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Once' }).getAttribute('aria-pressed')).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// 3. Segment selection → onRecurrenceChange
// ---------------------------------------------------------------------------

describe('DateTimePicker — segment clicks emit onRecurrenceChange', () => {
  it('clicking Once emits {kind:"once"}', () => {
    const { onRecurrenceChange } = renderControlled({ kind: 'daily' });
    fireEvent.click(screen.getByRole('button', { name: 'Once' }));
    expect(onRecurrenceChange).toHaveBeenLastCalledWith({ kind: 'once' });
  });

  it('clicking Daily emits {kind:"daily"}', () => {
    const { onRecurrenceChange } = renderControlled({ kind: 'once' });
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    expect(onRecurrenceChange).toHaveBeenLastCalledWith({ kind: 'daily' });
  });

  it('clicking Weekly emits {kind:"weekly"}', () => {
    const { onRecurrenceChange } = renderControlled({ kind: 'once' });
    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
    expect(onRecurrenceChange).toHaveBeenLastCalledWith({ kind: 'weekly' });
  });

  it('clicking Cron from a Once segment seeds with the Daily preset', () => {
    const { onRecurrenceChange } = renderControlled({ kind: 'once' });
    fireEvent.click(screen.getByRole('button', { name: 'Cron' }));
    expect(onRecurrenceChange).toHaveBeenLastCalledWith({ kind: 'cron', expr: DAILY_CRON });
  });

  it('clicking Cron from an existing Cron segment preserves the current expr', () => {
    const expr = '*/15 * * * *';
    const { onRecurrenceChange } = renderControlled({ kind: 'cron', expr });
    fireEvent.click(screen.getByRole('button', { name: 'Cron' }));
    expect(onRecurrenceChange).toHaveBeenLastCalledWith({ kind: 'cron', expr });
  });
});

// ---------------------------------------------------------------------------
// 4. Cron segment reveal + free-text input + preview line
// ---------------------------------------------------------------------------

describe('DateTimePicker — Cron segment reveal', () => {
  it('hides the free-text input when recurrence is once', () => {
    renderControlled({ kind: 'once' });
    expect(screen.queryByPlaceholderText(/Cron expression/i)).toBeNull();
  });

  it('hides the free-text input when recurrence is daily', () => {
    renderControlled({ kind: 'daily' });
    expect(screen.queryByPlaceholderText(/Cron expression/i)).toBeNull();
  });

  it('hides the free-text input when recurrence is weekly', () => {
    renderControlled({ kind: 'weekly' });
    expect(screen.queryByPlaceholderText(/Cron expression/i)).toBeNull();
  });

  it('shows the free-text input when recurrence is cron', () => {
    renderControlled({ kind: 'cron', expr: '0 9 * * *' });
    const input = screen.getByPlaceholderText(/Cron expression/i) as HTMLInputElement;
    expect(input.value).toBe('0 9 * * *');
  });

  it('editing the cron input emits onRecurrenceChange with the new expr', () => {
    const { onRecurrenceChange } = renderControlled({ kind: 'cron', expr: '0 9 * * *' });
    const input = screen.getByPlaceholderText(/Cron expression/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '*/10 * * * *' } });
    expect(onRecurrenceChange).toHaveBeenLastCalledWith({ kind: 'cron', expr: '*/10 * * * *' });
  });

  it('shows the human preview line for a recognizable cron (Daily at 09:00)', () => {
    renderControlled({ kind: 'cron', expr: '0 9 * * *' });
    expect(screen.getByText(/Daily at 09:00/i)).toBeDefined();
  });

  it('shows the human preview line for a Weekly cron (Monday at 09:00)', () => {
    renderControlled({ kind: 'cron', expr: '0 9 * * 1' });
    expect(screen.getByText(/Weekly on Monday at 09:00/i)).toBeDefined();
  });

  it('omits the human preview line when the cron expr is blank', () => {
    renderControlled({ kind: 'cron', expr: '' });
    expect(screen.queryByText(/Daily at|Weekly on|Monthly on/i)).toBeNull();
  });

  it('falls back to "Cron: <expr>" for an unrecognised 5-field expression', () => {
    // A comma-list minute is not one of cronToHuman's recognised shapes (every-N /
    // specific-time), so it renders the raw "Cron: <expr>" fallback. (Note `*/7 * * * *`
    // IS recognised as "Every 7 minutes".)
    renderControlled({ kind: 'cron', expr: '15,45 * * * *' });
    expect(screen.getByText('Cron: 15,45 * * * *')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Date+time field — wires value/onChange through Field
// ---------------------------------------------------------------------------

describe('DateTimePicker — date+time field', () => {
  it('renders a native datetime-local input with the value', () => {
    render(
      <DateTimePicker
        value="2099-12-31T23:59"
        onChange={() => {}}
        recurrence={{ kind: 'once' }}
        onRecurrenceChange={() => {}}
      />,
    );

    const input = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    expect(input.type).toBe('datetime-local');
    expect(input.value).toBe('2099-12-31T23:59');
    expect(input.classList.contains('c-input')).toBe(true);
    expect(input.classList.contains('font-mono')).toBe(true);
  });

  it('emits onChange when the date+time value is edited', () => {
    const onChange = vi.fn();
    render(
      <DateTimePicker
        value="2099-12-31T23:59"
        onChange={onChange}
        recurrence={{ kind: 'once' }}
        onRecurrenceChange={() => {}}
      />,
    );

    const input = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2099-12-31T22:00' } });
    expect(onChange).toHaveBeenLastCalledWith('2099-12-31T22:00');
  });

  it('honours a custom label prop', () => {
    render(
      <DateTimePicker
        value="2099-01-01T09:00"
        onChange={() => {}}
        recurrence={{ kind: 'once' }}
        onRecurrenceChange={() => {}}
        label="When to fire"
      />,
    );

    expect(screen.getByLabelText('When to fire')).toBeDefined();
  });

  it('associates the date+time input with its label (Field owns the id wiring)', () => {
    render(
      <DateTimePicker
        value="2099-01-01T09:00"
        onChange={() => {}}
        recurrence={{ kind: 'once' }}
        onRecurrenceChange={() => {}}
      />,
    );

    // Field generates the id and wires label[for] → input[id]; getByLabelText only
    // resolves when that association is intact.
    const input = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement;
    expect(input).toBeDefined();
    expect(input.id).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// 6. Field error contract — error prop wires aria-invalid + describedby
// ---------------------------------------------------------------------------

describe('DateTimePicker — Field error contract', () => {
  it('renders no error node and no aria-invalid when error is absent', () => {
    render(
      <DateTimePicker
        value="2099-01-01T09:00"
        onChange={() => {}}
        recurrence={{ kind: 'once' }}
        onRecurrenceChange={() => {}}
      />,
    );

    const input = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('marks aria-invalid=true and renders the error message when error is set', () => {
    render(
      <DateTimePicker
        value="2099-01-01T09:00"
        onChange={() => {}}
        recurrence={{ kind: 'once' }}
        onRecurrenceChange={() => {}}
        error="Time is in the past"
      />,
    );

    const errorNode = screen.getByText('Time is in the past');
    const input = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement;

    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(errorNode.id);
  });
});

// ---------------------------------------------------------------------------
// 7. minNow prop — adds native min attribute
// ---------------------------------------------------------------------------

describe('DateTimePicker — minNow prop', () => {
  it('does not set the min attribute by default', () => {
    render(
      <DateTimePicker
        value="2099-01-01T09:00"
        onChange={() => {}}
        recurrence={{ kind: 'once' }}
        onRecurrenceChange={() => {}}
      />,
    );

    const input = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement;
    expect(input.getAttribute('min')).toBeNull();
  });

  it('sets a datetime-local-shaped min attribute when minNow is true', () => {
    render(
      <DateTimePicker
        value="2099-01-01T09:00"
        onChange={() => {}}
        recurrence={{ kind: 'once' }}
        onRecurrenceChange={() => {}}
        minNow
      />,
    );

    const input = screen.getByLabelText(/Scheduled time/i) as HTMLInputElement;
    const min = input.getAttribute('min');
    expect(min).not.toBeNull();
    expect(min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});