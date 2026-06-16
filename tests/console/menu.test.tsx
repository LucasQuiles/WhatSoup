/**
 * Menu primitive (showcase §22; DD-43) — the role="menu" action surface.
 * @vitest-environment jsdom
 *
 * Covers the load-bearing contract:
 *   - trigger wiring: aria-haspopup="menu" + aria-expanded toggling
 *   - role="menu" surface with sections (role="group" + label)
 *   - roving focus: ArrowDown/ArrowUp move between items (wrap), Home/End jump,
 *     and the roving tabindex follows focus (one tabindex=0 at a time)
 *   - Escape closes the surface AND restores focus to the trigger
 *   - disabled-with-reason: aria-disabled + aria-describedby pointing at the
 *     reason text (not a bare title), and the item stays arrow-reachable
 *   - checkable items: role="menuitemcheckbox" + aria-checked, toggling keeps
 *     the surface open
 *   - destructive items route through ConfirmDialog — onSelect fires only after
 *     confirm, never directly on the menu click
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import {
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
} from '../../console/src/components/primitives/Menu';

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Harness — a representative row-action menu (sections + checkable + disabled +
// destructive) wired the way a real consumer would wire it.
// ---------------------------------------------------------------------------

function MenuHarness(props: {
  onRestart?: () => void;
  onDelete?: () => void;
  onSort?: () => void;
}) {
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  return (
    <Menu label="Line actions" triggerLabel="Actions">
      <MenuSection label="Line">
        <MenuItem shortcut="R" onSelect={props.onRestart}>
          Restart
        </MenuItem>
        <MenuItem>Pause</MenuItem>
        <MenuItem shortcut="⌘L">Open logs</MenuItem>
      </MenuSection>
      <MenuSection label="Sort by">
        <MenuItem
          checkable
          checked={sort === 'recent'}
          onSelect={() => {
            setSort('recent');
            props.onSort?.();
          }}
        >
          Last active
        </MenuItem>
        <MenuItem
          checkable
          checked={sort === 'name'}
          onSelect={() => setSort('name')}
        >
          Name
        </MenuItem>
      </MenuSection>
      <MenuSection label="Account">
        <MenuItem>Rename</MenuItem>
        <MenuItem disabled disabledReason="Billing requires a linked channel">
          Manage billing
        </MenuItem>
      </MenuSection>
      <MenuSeparator />
      <MenuItem
        destructive
        confirmTitle="Delete line?"
        confirmBody="This permanently removes the line."
        confirmLabel="Delete line"
        onSelect={props.onDelete}
      >
        Delete line
      </MenuItem>
    </Menu>
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
}

// ---------------------------------------------------------------------------
// Trigger + surface
// ---------------------------------------------------------------------------

describe('Menu — trigger + surface', () => {
  it('exposes aria-haspopup="menu" and toggles aria-expanded', () => {
    render(<MenuHarness />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('menu')).toBeDefined();
  });

  it('renders sections as role="group" with their labels', () => {
    render(<MenuHarness />);
    openMenu();
    const groups = screen.getAllByRole('group');
    // Line / Sort by / Account
    expect(groups.length).toBe(3);
    const labels = groups
      .map((g) => g.getAttribute('aria-labelledby'))
      .map((id) => (id ? document.getElementById(id)?.textContent : ''));
    expect(labels).toContain('Line');
    expect(labels).toContain('Sort by');
    expect(labels).toContain('Account');
  });
});

// ---------------------------------------------------------------------------
// Roving focus
// ---------------------------------------------------------------------------

describe('Menu — roving focus', () => {
  it('focuses the first item on open and rotates the roving tabindex', () => {
    render(<MenuHarness />);
    openMenu();
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    // First item focused, only it carries tabindex=0.
    expect(document.activeElement).toBe(items[0]);
    expect(items[0].getAttribute('tabindex')).toBe('0');
    expect(items[1].getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    expect(items[1].getAttribute('tabindex')).toBe('0');
    expect(items[0].getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('ArrowUp from the first item wraps to the last', () => {
    render(<MenuHarness />);
    openMenu();
    const menu = screen.getByRole('menu');
    // Surface mixes plain menuitems and menuitemcheckboxes; both are roving.
    expect(within(menu).getAllByRole('menuitem').length).toBeGreaterThan(0);
    expect(within(menu).getAllByRole('menuitemcheckbox').length).toBe(2);

    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    // Last roving item is the destructive "Delete line" menuitem.
    expect((document.activeElement as HTMLElement).textContent).toContain('Delete line');
  });

  it('Home and End jump to the first and last items', () => {
    render(<MenuHarness />);
    openMenu();
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'End' });
    expect((document.activeElement as HTMLElement).textContent).toContain('Delete line');
    fireEvent.keyDown(menu, { key: 'Home' });
    expect((document.activeElement as HTMLElement).textContent).toContain('Restart');
  });
});

// ---------------------------------------------------------------------------
// Escape closes + restores focus to the trigger
// ---------------------------------------------------------------------------

describe('Menu — Escape', () => {
  it('closes the surface and restores focus to the trigger', () => {
    render(<MenuHarness />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    openMenu();
    expect(screen.getByRole('menu')).toBeDefined();
    // Focus is inside the surface, not on the trigger.
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });
});

// ---------------------------------------------------------------------------
// Disabled-with-reason
// ---------------------------------------------------------------------------

describe('Menu — disabled with reason', () => {
  it('marks the item aria-disabled and exposes the reason via aria-describedby', () => {
    render(<MenuHarness />);
    openMenu();
    const billing = screen.getByText('Manage billing').closest('[role="menuitem"]')!;
    expect(billing.getAttribute('aria-disabled')).toBe('true');
    const describedBy = billing.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const reason = document.getElementById(describedBy!);
    expect(reason?.textContent).toBe('Billing requires a linked channel');
  });

  it('stays arrow-reachable (roving focus lands on it)', () => {
    render(<MenuHarness />);
    openMenu();
    const menu = screen.getByRole('menu');
    const billing = screen.getByText('Manage billing').closest('[role="menuitem"]')!;
    // Walk down until the disabled item gets focus — proves it is not skipped.
    let reached = false;
    for (let i = 0; i < 12; i++) {
      if (document.activeElement === billing) {
        reached = true;
        break;
      }
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
    }
    expect(reached).toBe(true);
  });

  it('does not fire onSelect when a disabled item is activated', () => {
    const onSort = vi.fn();
    // A disabled item has no onSelect here; assert clicking it is inert (no throw,
    // surface stays open).
    render(<MenuHarness onSort={onSort} />);
    openMenu();
    const billing = screen.getByText('Manage billing').closest('[role="menuitem"]')!;
    fireEvent.click(billing);
    expect(screen.getByRole('menu')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Checkable items
// ---------------------------------------------------------------------------

describe('Menu — checkable', () => {
  it('renders role="menuitemcheckbox" with aria-checked reflecting state', () => {
    render(<MenuHarness />);
    openMenu();
    const lastActive = screen
      .getByText('Last active')
      .closest('[role="menuitemcheckbox"]')!;
    const name = screen.getByText('Name').closest('[role="menuitemcheckbox"]')!;
    expect(lastActive.getAttribute('aria-checked')).toBe('true');
    expect(name.getAttribute('aria-checked')).toBe('false');
  });

  it('toggling a checkable item updates aria-checked and keeps the surface open', () => {
    render(<MenuHarness />);
    openMenu();
    const name = screen.getByText('Name').closest('[role="menuitemcheckbox"]')!;
    fireEvent.click(name);
    // Surface stays open; check moves to "Name".
    expect(screen.getByRole('menu')).toBeDefined();
    expect(
      screen.getByText('Name').closest('[role="menuitemcheckbox"]')!.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen.getByText('Last active').closest('[role="menuitemcheckbox"]')!.getAttribute('aria-checked'),
    ).toBe('false');
  });
});

// ---------------------------------------------------------------------------
// Destructive → ConfirmDialog
// ---------------------------------------------------------------------------

describe('Menu — destructive routes through ConfirmDialog', () => {
  it('does NOT fire onSelect directly; opens a confirm dialog instead', () => {
    const onDelete = vi.fn();
    render(<MenuHarness onDelete={onDelete} />);
    openMenu();
    const del = screen.getByText('Delete line').closest('[role="menuitem"]')!;
    fireEvent.click(del);

    // Destructive action is NOT fired yet.
    expect(onDelete).not.toHaveBeenCalled();
    // Menu closed, confirm dialog raised.
    expect(screen.queryByRole('menu')).toBeNull();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Delete line?')).toBeDefined();
    expect(within(dialog).getByText('This permanently removes the line.')).toBeDefined();
  });

  it('fires onSelect only after the user confirms', () => {
    const onDelete = vi.fn();
    render(<MenuHarness onDelete={onDelete} />);
    openMenu();
    fireEvent.click(screen.getByText('Delete line').closest('[role="menuitem"]')!);

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete line' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancelling the confirm dialog leaves the destructive action unfired', () => {
    const onDelete = vi.fn();
    render(<MenuHarness onDelete={onDelete} />);
    openMenu();
    fireEvent.click(screen.getByText('Delete line').closest('[role="menuitem"]')!);

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Plain action closes the surface and fires its handler
// ---------------------------------------------------------------------------

describe('Menu — plain action', () => {
  it('fires onSelect and closes the surface', () => {
    const onRestart = vi.fn();
    render(<MenuHarness onRestart={onRestart} />);
    openMenu();
    fireEvent.click(screen.getByText('Restart').closest('[role="menuitem"]')!);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Keyboard activation — opening from the trigger and activating items via keys
// ---------------------------------------------------------------------------

describe('Menu — keyboard activation', () => {
  it('opens from the trigger via ArrowDown, Enter, and Space', () => {
    render(<MenuHarness />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    for (const key of ['ArrowDown', 'Enter', ' ']) {
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.keyDown(trigger, { key });
      expect(screen.getByRole('menu')).toBeDefined();
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      fireEvent.keyDown(document, { key: 'Escape' });
    }
  });

  it('ignores non-activating keys on the trigger', () => {
    render(<MenuHarness />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    fireEvent.keyDown(trigger, { key: 'a' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('activates an item via Enter — fires onSelect and closes the surface', () => {
    const onRestart = vi.fn();
    render(<MenuHarness onRestart={onRestart} />);
    openMenu();
    const restart = screen.getByText('Restart').closest('[role="menuitem"]')!;
    fireEvent.keyDown(restart, { key: 'Enter' });
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('activates an item via Space', () => {
    const onRestart = vi.fn();
    render(<MenuHarness onRestart={onRestart} />);
    openMenu();
    const restart = screen.getByText('Restart').closest('[role="menuitem"]')!;
    fireEvent.keyDown(restart, { key: ' ' });
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Leading icon + default confirm copy (fallbacks)
// ---------------------------------------------------------------------------

describe('Menu — context guard', () => {
  it('throws if a MenuItem is rendered outside <Menu>', () => {
    // The thrown error surfaces through React; silence the expected console noise.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<MenuItem>Orphan</MenuItem>)).toThrow(/must render inside <Menu>/);
    spy.mockRestore();
  });
});

describe('Menu — icon + default confirm copy', () => {
  it('renders a leading icon when provided', () => {
    render(
      <Menu label="x" triggerLabel="Go">
        <MenuItem icon={<svg data-testid="menu-ic" />}>With icon</MenuItem>
      </Menu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.getByTestId('menu-ic')).toBeDefined();
  });

  it('falls back to default confirm title/body when none is supplied', () => {
    const onSelect = vi.fn();
    render(
      <Menu label="x" triggerLabel="Go">
        <MenuItem destructive onSelect={onSelect}>
          Wipe
        </MenuItem>
      </Menu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    fireEvent.click(screen.getByText('Wipe').closest('[role="menuitem"]')!);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Confirm action')).toBeDefined();
    expect(within(dialog).getByText('This action cannot be undone.')).toBeDefined();
  });
});
