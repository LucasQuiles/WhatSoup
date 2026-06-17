/** @vitest-environment jsdom */
/**
 * BulkActionBar contract (showcase §17): a sticky multi-row action surface that
 * renders only when count>0, announces via role=region + aria-live, and exposes
 * Restart / Stop / Delete (danger) on the selection plus a Clear control. The
 * parent owns the confirm policy; the bar just fires the callbacks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import BulkActionBar from '../../console/src/components/BulkActionBar';

afterEach(() => cleanup());

function setup(count: number, overrides: Partial<Parameters<typeof BulkActionBar>[0]> = {}) {
  const handlers = {
    onRestart: vi.fn(),
    onStop: vi.fn(),
    onDelete: vi.fn(),
    onClear: vi.fn(),
  };
  render(<BulkActionBar count={count} {...handlers} {...overrides} />);
  return handlers;
}

describe('BulkActionBar', () => {
  it('renders nothing when count is 0', () => {
    setup(0);
    expect(screen.queryByRole('region', { name: 'Bulk actions' })).toBeNull();
  });

  it('renders a labelled live region with the selected count when count>0', () => {
    setup(3);
    const region = screen.getByRole('region', { name: 'Bulk actions' });
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain('3');
    expect(region.textContent).toMatch(/selected/i);
  });

  it('fires the matching handler for each action', () => {
    const h = setup(2);
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(h.onRestart).toHaveBeenCalledTimes(1);
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    expect(h.onClear).toHaveBeenCalledTimes(1);
  });

  it('disables every action when disabled', () => {
    const h = setup(2, { disabled: true });
    for (const name of ['Restart', 'Stop', 'Delete', 'Clear selection']) {
      const btn = screen.getByRole('button', { name }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
      fireEvent.click(btn);
    }
    expect(h.onRestart).not.toHaveBeenCalled();
    expect(h.onDelete).not.toHaveBeenCalled();
  });
});
