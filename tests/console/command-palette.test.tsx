/** @vitest-environment jsdom */
// ---------------------------------------------------------------------------
//  CommandPalette — ⌘K palette v1 (nav + jump-to-line, read-only)
//  Behavior: open/close, fuzzy filter, ↑/↓ active row, Enter navigates a route
//  AND a line-jump, Esc closes, empty-state, mouse hover.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

afterEach(() => cleanup());

const mockNavigate = vi.hoisted(() => vi.fn());
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const useLinesMock = vi.hoisted(() => vi.fn());
vi.mock('../../console/src/hooks/use-fleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../console/src/hooks/use-fleet')>();
  return { ...actual, useLines: useLinesMock };
});

import { CommandPalette } from '../../console/src/components/CommandPalette';

function renderPalette(overrides: { open?: boolean; onClose?: () => void } = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const open = overrides.open ?? true;
  render(
    <MemoryRouter>
      <CommandPalette open={open} onClose={onClose} />
    </MemoryRouter>,
  );
  return { onClose };
}

function combobox(): HTMLInputElement {
  return screen.getByRole('combobox') as HTMLInputElement;
}

beforeEach(() => {
  mockNavigate.mockClear();
  useLinesMock.mockReturnValue({
    data: [
      { name: 'support-eu-01', status: 'online' },
      { name: 'support-us-02', status: 'online' },
    ],
    isError: false,
    error: null,
  });
});

describe('CommandPalette — visibility', () => {
  it('renders nothing when closed', () => {
    renderPalette({ open: false });
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
  });

  it('renders the dialog + combobox when open', () => {
    renderPalette();
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(combobox()).toBeTruthy();
  });
});

describe('CommandPalette — command list', () => {
  it('empty query lists routes first, then one row per line', () => {
    renderPalette();
    const list = screen.getByRole('listbox', { name: 'Commands' });
    const options = within(list).getAllByRole('option');
    const labels = options.map((o) => o.textContent);
    // 4 routes + 2 lines.
    expect(options).toHaveLength(6);
    expect(labels[0]).toContain('Kitchen');
    expect(labels.some((l) => l?.includes('support-eu-01'))).toBe(true);
    expect(labels.some((l) => l?.includes('support-us-02'))).toBe(true);
  });

  it('fuzzy-filters as the query narrows', () => {
    renderPalette();
    fireEvent.change(combobox(), { target: { value: 'inbox' } });
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain('Inbox');
  });

  it('shows an empty-state row when nothing matches', () => {
    renderPalette();
    fireEvent.change(combobox(), { target: { value: 'zzzzzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No results')).toBeTruthy();
  });

  it('announces the live result count when results are present (#1100)', () => {
    renderPalette();
    fireEvent.change(combobox(), { target: { value: 'inbox' } });
    const count = within(screen.getByRole('listbox')).getAllByRole('option').length;
    expect(count).toBeGreaterThan(0);
    expect(screen.getByRole('status').textContent).toBe(`${count} result${count === 1 ? '' : 's'} available`);
  });

  it('announces "No results available" via the live region on empty (#1100)', () => {
    renderPalette();
    fireEvent.change(combobox(), { target: { value: 'zzzzzz' } });
    // Single status live region (the visual empty-state no longer carries role=status).
    expect(screen.getByRole('status').textContent).toBe('No results available');
  });

  it('renders only routes when no lines are loaded yet', () => {
    useLinesMock.mockReturnValue({ data: undefined, isError: false, error: null });
    renderPalette();
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options).toHaveLength(4);
  });
});

describe('CommandPalette — keyboard navigation', () => {
  it('ArrowDown / ArrowUp move the active row (aria-selected + activedescendant)', () => {
    renderPalette();
    const input = combobox();
    const list = screen.getByRole('listbox');
    const first = within(list).getAllByRole('option')[0];

    // First row active on open.
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(first.id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const second = within(list).getAllByRole('option')[1];
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(second.id);

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(within(list).getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');
  });

  it('ArrowUp from the first row wraps to the last', () => {
    renderPalette();
    const input = combobox();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options[options.length - 1].getAttribute('aria-selected')).toBe('true');
  });
});

describe('CommandPalette — execute', () => {
  it('Enter navigates to the active route and closes', () => {
    const { onClose } = renderPalette();
    fireEvent.change(combobox(), { target: { value: 'metrics' } });
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/metrics');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Enter on a line row jumps to /lines/:name', () => {
    const { onClose } = renderPalette();
    fireEvent.change(combobox(), { target: { value: 'support-eu' } });
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(mockNavigate).toHaveBeenCalledWith('/lines/support-eu-01');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mouse down on a row executes that row', () => {
    renderPalette();
    const inboxRow = screen
      .getAllByRole('option')
      .find((o) => o.textContent?.includes('Inbox'))!;
    fireEvent.mouseDown(inboxRow);
    expect(mockNavigate).toHaveBeenCalledWith('/inbox');
  });

  it('Enter with no matches does nothing', () => {
    const { onClose } = renderPalette();
    fireEvent.change(combobox(), { target: { value: 'zzzzzz' } });
    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CommandPalette — dismissal', () => {
  it('Escape closes the palette (owned by Modal/useDismissable)', async () => {
    const { onClose } = renderPalette();
    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
