/**
 * Behavioral coverage for console/src/components/FilterPill.tsx.
 *
 * User-visible contract:
 *   - renders as a named button, type="button"
 *   - aria-pressed reflects active state
 *   - click handlers are wired through the rendered control
 *   - count badge appears only for positive counts
 *   - suffix content renders inline with the label/count
 *
 * Design-token contract:
 *   - active/inactive state maps to the expected text token classes
 */
/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import FilterPill from '../../console/src/components/FilterPill.tsx';

afterEach(() => cleanup());

describe('FilterPill — semantic + a11y behavior', () => {
  it('renders a named <button type="button"> to avoid accidental form submit', () => {
    render(<FilterPill label="All" isActive={false} onClick={() => {}} />);

    const button = screen.getByRole('button', { name: 'All' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
  });

  it('sets aria-pressed from the active state', () => {
    const { rerender } = render(<FilterPill label="Status" isActive={true} onClick={() => {}} />);

    expect(screen.getByRole('button', { name: 'Status' }).getAttribute('aria-pressed')).toBe('true');

    rerender(<FilterPill label="Status" isActive={false} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Status' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('FilterPill — click behavior', () => {
  it('fires the provided onClick handler when clicked', () => {
    const onClick = vi.fn();
    render(<FilterPill label="Unread" isActive={false} onClick={onClick} />);

    fireEvent.click(screen.getByRole('button', { name: 'Unread' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('FilterPill — label, count, and suffix behavior', () => {
  it('renders the label as the accessible button name', () => {
    render(<FilterPill label="Inbox" isActive={false} onClick={() => {}} />);

    expect(screen.getByRole('button', { name: 'Inbox' })).toBeDefined();
  });

  it('does not render a count badge when count is undefined', () => {
    // Migration note (C2): Pill renders a count badge for count >= 0 (unlike old FilterPill which
    // only showed count > 0). FilterPill preserves old behaviour by not passing count=0 through.
    // When count is undefined, no badge is rendered.
    render(<FilterPill label="Alerts" isActive={false} onClick={() => {}} />);

    expect(screen.getByRole('button', { name: 'Alerts' })).toBeDefined();
    expect(document.querySelector('.soup-pill__count')).toBeNull();
  });

  it('renders a positive count inside the visible content', () => {
    // Migration note (C2): Pill's count lane is aria-hidden (counts are in the data lane, not the
    // accessible name). The button accessible name is 'Alerts'; count '7' is visible but not in name.
    render(<FilterPill label="Alerts" isActive={false} count={7} onClick={() => {}} />);

    expect(screen.getByRole('button', { name: 'Alerts' })).toBeDefined();
    expect(screen.getByText('7')).toBeDefined();
  });

  it('renders suffix content inline with the label', () => {
    // Migration note (C2): FilterPill now renders suffix outside the Pill button (as a sibling span).
    // Accessible name of the button is 'Alerts'; suffix is in the outer span.
    // button.lastElementChild pattern no longer applies (suffix is not inside the button).
    render(
      <FilterPill
        label="Alerts"
        isActive={false}
        count={2}
        onClick={() => {}}
        suffix={<em data-testid="suffix">new</em>}
      />,
    );

    expect(screen.getByRole('button', { name: 'Alerts' })).toBeDefined();
    expect(screen.getByTestId('suffix').textContent).toBe('new');
    expect(screen.getByText('2')).toBeDefined();
  });
});

describe('FilterPill — design-token state contract', () => {
  it('uses soup-pill--neutral class (default neutral tone) when active/inactive', () => {
    // Migration note (C2): FilterPill now uses semantic Pill tones (soup-pill--neutral) instead of
    // legacy text-t2/text-t4 utility classes. activeColor/activeBorder props are deprecated no-ops.
    // Interactive state is conveyed via aria-pressed and soup-pill--pressed class.
    render(<FilterPill label="Active" isActive={true} onClick={() => {}} />);

    const btn = screen.getByRole('button', { name: 'Active' });
    expect(btn.className).toContain('soup-pill--neutral');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('applies soup-pill--pressed when active, not pressed when inactive', () => {
    // Migration note (C2): pressed/active state uses soup-pill--pressed class + aria-pressed.
    const { rerender } = render(<FilterPill label="Chats" isActive={true} onClick={() => {}} />);
    expect(screen.getByRole('button').className).toContain('soup-pill--pressed');

    rerender(<FilterPill label="Chats" isActive={false} onClick={() => {}} />);
    expect(screen.getByRole('button').className).not.toContain('soup-pill--pressed');
  });

  it('deprecated activeColor prop does not crash and is ignored', () => {
    // Migration note (C2): activeColor is deprecated; FilterPill accepts it silently.
    render(<FilterPill label="Chats" isActive={true} activeColor="text-m-cht" onClick={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Chats' });
    // Class does NOT contain the raw legacy token (it was not forwarded)
    expect(btn.className).not.toContain('text-m-cht');
    // But does contain soup-pill--pressed (the active state)
    expect(btn.className).toContain('soup-pill--pressed');
  });
});
