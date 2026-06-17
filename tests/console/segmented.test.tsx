/**
 * @vitest-environment jsdom
 *
 * Primitive tests: Segmented (segmented.md).
 *
 * Covers:
 *   - Renders N options as a role="group" with the passed aria-label
 *   - Exactly one button has aria-pressed=true for the active value
 *   - Clicking a button calls onChange with its value
 *   - disabled=true marks every button disabled AND short-circuits onChange
 *   - Buttons are real <button type="button"> elements
 *   - Uses the .soup-toolbar-seg BEM family (no new dialect)
 *   - Re-render with a different value flips the pressed button (controlled)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Segmented } from '../../console/src/components/primitives/Segmented';

afterEach(() => { cleanup(); });

const OPTIONS = [
  { label: 'Once', value: 'once' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Cron', value: 'cron' },
];

// ---------------------------------------------------------------------------
// Anatomy
// ---------------------------------------------------------------------------

describe('Segmented — anatomy', () => {
  it('renders a role="group" with the passed aria-label', () => {
    render(<Segmented label="Recurrence" options={OPTIONS} value="once" onChange={() => {}} />);
    const group = screen.getByRole('group', { name: 'Recurrence' });
    expect(group.getAttribute('aria-label')).toBe('Recurrence');
  });

  it('renders exactly N buttons, one per option, in DOM order', () => {
    render(<Segmented label="Recurrence" options={OPTIONS} value="once" onChange={() => {}} />);
    const group = screen.getByRole('group', { name: 'Recurrence' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons).toHaveLength(OPTIONS.length);
    expect(buttons.map((b) => b.textContent)).toEqual(OPTIONS.map((o) => o.label));
  });

  it('uses the .soup-toolbar-seg BEM family (no new dialect)', () => {
    const { container } = render(
      <Segmented label="Recurrence" options={OPTIONS} value="once" onChange={() => {}} />,
    );
    expect(container.querySelector('.soup-toolbar-seg')).not.toBeNull();
    expect(container.querySelectorAll('.soup-toolbar-seg__btn')).toHaveLength(OPTIONS.length);
  });

  it('seg buttons are real <button type="button"> elements', () => {
    render(<Segmented label="Recurrence" options={OPTIONS} value="once" onChange={() => {}} />);
    const group = screen.getByRole('group', { name: 'Recurrence' });
    const buttons = within(group).getAllByRole('button');
    for (const btn of buttons) {
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.getAttribute('type')).toBe('button');
    }
  });
});

// ---------------------------------------------------------------------------
// aria-pressed exactly-one invariant
// ---------------------------------------------------------------------------

describe('Segmented — aria-pressed exactly-one', () => {
  it('marks exactly one button aria-pressed=true for the active value', () => {
    render(<Segmented label="Recurrence" options={OPTIONS} value="weekly" onChange={() => {}} />);
    const group = screen.getByRole('group', { name: 'Recurrence' });
    const buttons = within(group).getAllByRole('button');
    const pressed = buttons.filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0]!.textContent).toBe('Weekly');
  });

  it('every other button has aria-pressed="false"', () => {
    render(<Segmented label="Recurrence" options={OPTIONS} value="daily" onChange={() => {}} />);
    const group = screen.getByRole('group', { name: 'Recurrence' });
    const buttons = within(group).getAllByRole('button');
    const unpressed = buttons.filter((b) => b.getAttribute('aria-pressed') === 'false');
    expect(unpressed).toHaveLength(OPTIONS.length - 1);
  });

  it('re-rendering with a different value flips the pressed button (controlled)', () => {
    const { rerender } = render(
      <Segmented label="Recurrence" options={OPTIONS} value="once" onChange={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Once' }).getAttribute('aria-pressed')).toBe('true');

    rerender(
      <Segmented label="Recurrence" options={OPTIONS} value="cron" onChange={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Cron' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Once' }).getAttribute('aria-pressed')).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// onChange wiring
// ---------------------------------------------------------------------------

describe('Segmented — onChange', () => {
  it('clicking a button calls onChange with its option value', () => {
    const onChange = vi.fn();
    render(<Segmented label="Recurrence" options={OPTIONS} value="once" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('daily');
  });

  it('clicking a different option emits its value', () => {
    const onChange = vi.fn();
    render(<Segmented label="Recurrence" options={OPTIONS} value="once" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cron' }));
    expect(onChange).toHaveBeenLastCalledWith('cron');
  });

  it('clicking the currently active option also emits its value (controlled ignores it)', () => {
    const onChange = vi.fn();
    render(<Segmented label="Recurrence" options={OPTIONS} value="daily" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    expect(onChange).toHaveBeenCalledWith('daily');
  });
});

// ---------------------------------------------------------------------------
// disabled contract
// ---------------------------------------------------------------------------

describe('Segmented — disabled', () => {
  it('all buttons carry disabled when disabled=true', () => {
    render(
      <Segmented label="Recurrence" options={OPTIONS} value="once" onChange={() => {}} disabled />,
    );
    const group = screen.getByRole('group', { name: 'Recurrence' });
    const buttons = within(group).getAllByRole('button') as HTMLButtonElement[];
    for (const btn of buttons) {
      expect(btn.disabled).toBe(true);
    }
  });

  it('onChange is NOT called when disabled=true and a button is clicked', () => {
    const onChange = vi.fn();
    render(
      <Segmented label="Recurrence" options={OPTIONS} value="once" onChange={onChange} disabled />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Daily' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disabled=undefined (default) leaves buttons enabled and onChange fires', () => {
    const onChange = vi.fn();
    render(<Segmented label="Recurrence" options={OPTIONS} value="once" onChange={onChange} />);
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
    for (const btn of buttons) {
      expect(btn.disabled).toBe(false);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
    expect(onChange).toHaveBeenCalledWith('weekly');
  });
});
