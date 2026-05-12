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

  it('does not render a count when count is undefined or zero', () => {
    const { rerender } = render(<FilterPill label="Alerts" isActive={false} onClick={() => {}} />);

    expect(screen.getByRole('button', { name: 'Alerts' })).toBeDefined();
    expect(screen.queryByText('0')).toBeNull();

    rerender(<FilterPill label="Alerts" isActive={false} count={0} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Alerts' })).toBeDefined();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('renders a positive count inside the button name and visible content', () => {
    render(<FilterPill label="Alerts" isActive={false} count={7} onClick={() => {}} />);

    expect(screen.getByRole('button', { name: /^Alerts\s*7$/ })).toBeDefined();
    expect(screen.getByText('7')).toBeDefined();
  });

  it('renders suffix content inline after the label/count', () => {
    render(
      <FilterPill
        label="Alerts"
        isActive={false}
        count={2}
        onClick={() => {}}
        suffix={<em data-testid="suffix">new</em>}
      />,
    );

    const button = screen.getByRole('button', { name: /^Alerts\s*2\s*new$/ });
    expect(screen.getByTestId('suffix').textContent).toBe('new');
    expect(button.lastElementChild).toBe(screen.getByTestId('suffix'));
  });
});

describe('FilterPill — design-token state contract', () => {
  it('uses the default active text token when active and no override is given', () => {
    render(<FilterPill label="Active" isActive={true} onClick={() => {}} />);

    expect(screen.getByRole('button', { name: 'Active' }).className).toContain('text-t2');
  });

  it('uses a custom active text token when active', () => {
    render(<FilterPill label="Chats" isActive={true} activeColor="text-m-cht" onClick={() => {}} />);

    expect(screen.getByRole('button', { name: 'Chats' }).className).toContain('text-m-cht');
  });

  it('uses inactive text tokens when inactive even if an active token override is provided', () => {
    render(<FilterPill label="Chats" isActive={false} activeColor="text-m-cht" onClick={() => {}} />);

    const className = screen.getByRole('button', { name: 'Chats' }).className;
    expect(className).toContain('text-t4');
    expect(className).not.toContain('text-m-cht');
  });
});
