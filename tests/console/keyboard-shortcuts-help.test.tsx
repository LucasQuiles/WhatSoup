/**
 * @vitest-environment jsdom
 *
 * Behavioral contract-lock for KeyboardShortcutsHelp dialog.
 *
 * Migration note (C2): This test was rewritten from raw React-element inspection
 * (calling component as function + flattenElements tree walk) to DOM-level RTL tests.
 * Reason: After migration to the Modal primitive, KeyboardShortcutsHelp returns
 * <Modal ...> (not a bare <div>), so raw element inspection no longer works —
 * Modal renders via createPortal and the root element type is 'Modal' not 'div'.
 *
 * All behavioral contracts are preserved:
 *   - open/closed gate
 *   - dialog a11y wiring (role=dialog, aria-modal, aria-labelledby, title id)
 *   - click-outside dismisses (dismissable=true in the migration)
 *   - SHORTCUTS row arity + text+keycap structure
 *   - footer hint with ? and Esc keycaps
 *
 * NEW contract that was a bug in the old implementation:
 *   - Escape key now actually closes the dialog (was broken before: UI claimed
 *     "Press Esc to close" but no handler was wired).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KeyboardShortcutsHelp } from '../../console/src/components/KeyboardShortcutsHelp.tsx';

afterEach(() => { cleanup(); });

// ---------------------------------------------------------------------------
// Open/closed gate
// ---------------------------------------------------------------------------

describe('KeyboardShortcutsHelp — open/closed gate', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <KeyboardShortcutsHelp open={false} onClose={vi.fn()} />
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    // portal renders to document.body — make sure nothing leaked
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders dialog when open=true', () => {
    render(<KeyboardShortcutsHelp open={true} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Dialog a11y contract
// ---------------------------------------------------------------------------

describe('KeyboardShortcutsHelp — dialog a11y contract', () => {
  it('inner panel carries role=dialog with aria-modal=true and labelledby wiring', () => {
    render(<KeyboardShortcutsHelp open onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('kbd-shortcuts-title');
  });

  it('a labelled element with id="kbd-shortcuts-title" exists and reads "Keyboard Shortcuts"', () => {
    render(<KeyboardShortcutsHelp open onClose={vi.fn()} />);
    const titleEl = document.getElementById('kbd-shortcuts-title');
    expect(titleEl).not.toBeNull();
    expect(titleEl!.textContent?.trim()).toBe('Keyboard Shortcuts');
  });
});

// ---------------------------------------------------------------------------
// Escape key — NEW CONTRACT (was broken before migration, now fixed)
// ---------------------------------------------------------------------------

describe('KeyboardShortcutsHelp — Escape key (real bug fix)', () => {
  it('Escape key calls onClose when dialog is open', () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsHelp open onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape key does NOT call onClose when dialog is closed', () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsHelp open={false} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape', bubbles: true });
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Click-outside behavior (dismissable=true)
// ---------------------------------------------------------------------------

describe('KeyboardShortcutsHelp — overlay vs panel click handling', () => {
  it('clicking outside the dialog shell (on backdrop) calls onClose', () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsHelp open onClose={onClose} />);
    // Fire pointerdown on document.body (outside the dialog shell)
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the dialog shell does NOT call onClose', () => {
    const onClose = vi.fn();
    render(<KeyboardShortcutsHelp open onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    fireEvent.pointerDown(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SHORTCUTS list contract
// ---------------------------------------------------------------------------

describe('KeyboardShortcutsHelp — SHORTCUTS list contract', () => {
  it('renders exactly 6 shortcut rows', () => {
    render(<KeyboardShortcutsHelp open onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    // Each row has a div with flex + justify-between
    const rows = Array.from(dialog.querySelectorAll('div.flex.items-center.justify-between'));
    expect(rows.length).toBe(6);
  });

  it('each row contains both a label span and at least one kbd element', () => {
    render(<KeyboardShortcutsHelp open onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    const rows = Array.from(dialog.querySelectorAll('div.flex.items-center.justify-between'));
    for (const row of rows) {
      const kbds = row.querySelectorAll('kbd');
      expect(kbds.length).toBeGreaterThanOrEqual(1);
      // Label span — has text-data class
      const labelSpan = row.querySelector('.text-data');
      expect(labelSpan).not.toBeNull();
      expect(labelSpan!.textContent!.trim().length).toBeGreaterThan(0);
    }
  });

  it('locks the canonical label set (order-independent)', () => {
    render(<KeyboardShortcutsHelp open onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    const rows = Array.from(dialog.querySelectorAll('div.flex.items-center.justify-between'));
    const labels = rows
      .map((row) => row.querySelector('.text-data')?.textContent?.trim() ?? '')
      .filter(Boolean)
      .sort();
    expect(labels).toEqual(
      [
        'Close modals',
        'Focus search',
        'Go to Inbox',
        'Go to Ops',
        'Go to Soup Kitchen',
        'Show this help',
      ].sort()
    );
  });

  it('platform-aware modifier: "Focus search" row uses ⌘ or Ctrl+K', () => {
    render(<KeyboardShortcutsHelp open onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    const rows = Array.from(dialog.querySelectorAll('div.flex.items-center.justify-between'));
    const focusRow = rows.find((row) => row.querySelector('.text-data')?.textContent?.includes('Focus search'));
    expect(focusRow).toBeDefined();
    const kbd = focusRow!.querySelector('kbd');
    expect(kbd).not.toBeNull();
    const keyText = kbd!.textContent!;
    expect(keyText === '⌘+K' || keyText === 'Ctrl+K').toBe(true);
  });

  it('numeric and special rows render their literal keycaps', () => {
    render(<KeyboardShortcutsHelp open onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    const rows = Array.from(dialog.querySelectorAll('div.flex.items-center.justify-between'));
    const keysByLabel = new Map<string, string[]>();
    for (const row of rows) {
      const label = row.querySelector('.text-data')?.textContent?.trim() ?? '';
      const kbds = Array.from(row.querySelectorAll('kbd')).map((k) => k.textContent!);
      keysByLabel.set(label, kbds);
    }
    expect(keysByLabel.get('Go to Soup Kitchen')).toEqual(['1']);
    expect(keysByLabel.get('Go to Inbox')).toEqual(['2']);
    expect(keysByLabel.get('Go to Ops')).toEqual(['3']);
    expect(keysByLabel.get('Close modals')).toEqual(['Esc']);
    expect(keysByLabel.get('Show this help')).toEqual(['?']);
  });
});

// ---------------------------------------------------------------------------
// Footer hint
// ---------------------------------------------------------------------------

describe('KeyboardShortcutsHelp — footer hint', () => {
  it('renders a centered footer with ? and Esc keycaps and "to close" text', () => {
    render(<KeyboardShortcutsHelp open onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    const footer = dialog.querySelector('.text-center');
    expect(footer).not.toBeNull();
    const kbds = Array.from(footer!.querySelectorAll('kbd')).map((k) => k.textContent!);
    expect(kbds).toEqual(['?', 'Esc']);
    expect(footer!.textContent).toContain('to close');
  });
});
