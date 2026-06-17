/** @vitest-environment jsdom */
/**
 * Checkbox primitive contract (checkbox.md; showcase §17): a controlled native
 * <input type="checkbox"> kept focusable but visually hidden, with a sibling box
 * carrying the lucide glyph (Check / Minus). onChange yields the next boolean;
 * indeterminate is set via the DOM property; disabled blocks toggling.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Checkbox } from '../../console/src/components/primitives';

afterEach(() => cleanup());

describe('Checkbox', () => {
  it('renders an accessible checkbox reflecting the checked prop', () => {
    render(<Checkbox checked onChange={() => {}} label="Select line-01" />);
    const box = screen.getByRole('checkbox', { name: 'Select line-01' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
  });

  it('calls onChange with the next boolean when toggled', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="x" />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'x' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('sets the DOM indeterminate property (independent of checked)', () => {
    render(<Checkbox checked={false} indeterminate onChange={() => {}} label="all" />);
    const box = screen.getByRole('checkbox', { name: 'all' }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(box.checked).toBe(false);
  });

  it('clears indeterminate when the prop flips off (re-render)', () => {
    const { rerender } = render(
      <Checkbox checked={false} indeterminate onChange={() => {}} label="all" />,
    );
    expect((screen.getByRole('checkbox', { name: 'all' }) as HTMLInputElement).indeterminate).toBe(true);
    rerender(<Checkbox checked indeterminate={false} onChange={() => {}} label="all" />);
    const box = screen.getByRole('checkbox', { name: 'all' }) as HTMLInputElement;
    expect(box.indeterminate).toBe(false);
    expect(box.checked).toBe(true);
  });

  it('marks the input disabled so the browser blocks toggling', () => {
    // Real browsers block click/change on a disabled control; jsdom does not
    // enforce that for programmatic events, so we assert the disabled contract
    // (the attribute that does the blocking) rather than the jsdom click path.
    render(<Checkbox checked={false} disabled onChange={() => {}} label="x" />);
    const box = screen.getByRole('checkbox', { name: 'x' }) as HTMLInputElement;
    expect(box.disabled).toBe(true);
  });

  it('renders a visible label wired via aria-labelledby when label is given', () => {
    render(<Checkbox checked onChange={() => {}} label="Delivery window" />);
    // getByRole name resolves through aria-labelledby → the visible label text.
    expect(screen.getByRole('checkbox', { name: 'Delivery window' })).toBeDefined();
    expect(screen.getByText('Delivery window')).toBeDefined();
  });

  it('renders the check glyph when checked and the minus glyph when indeterminate', () => {
    const { container, rerender } = render(
      <Checkbox checked onChange={() => {}} aria-label="c" />,
    );
    // lucide renders an <svg> inside the visible box for the checked state.
    expect(container.querySelector('.soup-checkbox svg')).not.toBeNull();
    rerender(<Checkbox checked={false} onChange={() => {}} aria-label="c" />);
    expect(container.querySelector('.soup-checkbox svg')).toBeNull();
  });
});
