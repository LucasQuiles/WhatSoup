/**
 * FleetRowMenu — per-row action surface for the SOUP v3 fleet table.
 * @vitest-environment jsdom
 *
 * Adopts the Menu primitive (showcase §22; DD-43) as the trailing kebab on each
 * Lines-table row. Covers the load-bearing contract:
 *   - kebab opens a role="menu" surface with Restart / Stop / Delete line items
 *   - Restart calls api.restart directly (no confirm)
 *   - Stop routes through ConfirmDialog before calling api.stopInstance
 *   - Delete routes through ConfirmDialog before calling api.deleteLine, then
 *     invalidates the ['lines'] query (so the table drops the row)
 *   - the menu is hidden wholesale when the capability (canAct) is withheld
 *   - clicking the kebab does NOT bubble to a parent row-activation handler
 *     (stopPropagation), so opening the menu never opens the drawer
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context';

// Hoisted api + queryClient mocks.
const restartMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ status: 'ok', instance: 'x' })));
const stopInstanceMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ status: 'ok', instance: 'x' })));
const deleteLineMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ deleted: 'x' })));
const invalidateQueriesMock = vi.hoisted(() => vi.fn());

vi.mock('../../console/src/lib/api', () => ({
  api: {
    restart: restartMock,
    stopInstance: stopInstanceMock,
    deleteLine: deleteLineMock,
  },
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
  };
});

import FleetRowMenu from '../../console/src/components/FleetRowMenu';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderMenu(props: { name?: string; canAct?: boolean; onRowActivate?: () => void } = {}) {
  const toastValue: ToastContextValue = {
    toast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn(),
  };
  const rowActivate = props.onRowActivate ?? vi.fn();
  const ui = (
    <ToastContext.Provider value={toastValue}>
      {/* Stand-in for the TableRow's onActivate (open-drawer) so we can assert
          the kebab click does not bubble up to it. */}
      <div data-testid="row" onClick={rowActivate}>
        <FleetRowMenu name={props.name ?? 'alpha'} canAct={props.canAct ?? true} />
      </div>
    </ToastContext.Provider>
  );
  return { ...render(ui), rowActivate, toastValue };
}

function openMenu(name = 'alpha'): void {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
}

// ---------------------------------------------------------------------------
// Trigger + capability gate
// ---------------------------------------------------------------------------

describe('FleetRowMenu — trigger + capability gate', () => {
  it('renders an icon-only kebab trigger with an accessible per-line name', () => {
    renderMenu({ name: 'primary-line' });
    const trigger = screen.getByRole('button', { name: 'Actions for primary-line' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // The kebab is icon-only — no visible text label leaks into the cell.
    expect(trigger.textContent).toBe('');
  });

  it('does not render the menu at all when canAct is false', () => {
    renderMenu({ name: 'primary-line', canAct: false });
    expect(screen.queryByRole('button', { name: 'Actions for primary-line' })).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a role="menu" surface exposing Restart, Stop, and Delete line', () => {
    renderMenu();
    openMenu();
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Restart')).toBeDefined();
    expect(within(menu).getByText('Stop')).toBeDefined();
    expect(within(menu).getByText('Delete line')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// stopPropagation — opening the menu must not open the row drawer
// ---------------------------------------------------------------------------

describe('FleetRowMenu — stopPropagation', () => {
  it('clicking the kebab does not bubble to the row-activation handler', () => {
    const { rowActivate } = renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for alpha' }));
    expect(rowActivate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Restart — direct call (no confirm)
// ---------------------------------------------------------------------------

describe('FleetRowMenu — Restart', () => {
  it('calls api.restart with the line name and closes the surface (no confirm)', () => {
    renderMenu({ name: 'op-line' });
    openMenu('op-line');
    fireEvent.click(screen.getByText('Restart').closest('[role="menuitem"]')!);
    expect(restartMock).toHaveBeenCalledTimes(1);
    expect(restartMock).toHaveBeenCalledWith('op-line');
    // No confirm dialog — direct action; surface closes.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stop — routed through ConfirmDialog
// ---------------------------------------------------------------------------

describe('FleetRowMenu — Stop routes through ConfirmDialog', () => {
  it('does NOT call api.stopInstance directly; raises a confirm dialog', () => {
    renderMenu({ name: 'op-line' });
    openMenu('op-line');
    fireEvent.click(screen.getByText('Stop').closest('[role="menuitem"]')!);
    expect(stopInstanceMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Stop op-line\?/)).toBeDefined();
  });

  it('calls api.stopInstance only after the operator confirms', () => {
    renderMenu({ name: 'op-line' });
    openMenu('op-line');
    fireEvent.click(screen.getByText('Stop').closest('[role="menuitem"]')!);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop line' }));
    expect(stopInstanceMock).toHaveBeenCalledTimes(1);
    expect(stopInstanceMock).toHaveBeenCalledWith('op-line');
  });
});

// ---------------------------------------------------------------------------
// Delete — routed through ConfirmDialog, then invalidates lines query
// ---------------------------------------------------------------------------

describe('FleetRowMenu — Delete routes through ConfirmDialog', () => {
  it('does NOT call api.deleteLine on the menu click; raises the delete confirm', () => {
    renderMenu({ name: 'doomed' });
    openMenu('doomed');
    fireEvent.click(screen.getByText('Delete line').closest('[role="menuitem"]')!);
    expect(deleteLineMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Delete doomed\?/)).toBeDefined();
    // Canonical delete copy (matches Ops.tsx / LineDetail.tsx).
    expect(within(dialog).getByText(/This cannot be undone\./)).toBeDefined();
  });

  it('calls api.deleteLine and invalidates the lines query only after confirm', async () => {
    renderMenu({ name: 'doomed' });
    openMenu('doomed');
    fireEvent.click(screen.getByText('Delete line').closest('[role="menuitem"]')!);
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete permanently' }),
    );
    expect(deleteLineMock).toHaveBeenCalledTimes(1);
    expect(deleteLineMock).toHaveBeenCalledWith('doomed');
    // deleteLine resolves async; flush the microtask queue before asserting the
    // post-resolve query invalidation.
    await Promise.resolve();
    await Promise.resolve();
    expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ['lines'] });
  });

  it('cancelling the delete confirm leaves api.deleteLine unfired', () => {
    renderMenu({ name: 'doomed' });
    openMenu('doomed');
    fireEvent.click(screen.getByText('Delete line').closest('[role="menuitem"]')!);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(deleteLineMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
