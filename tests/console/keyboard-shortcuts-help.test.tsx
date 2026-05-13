/**
 * Behavioral contract-lock for KeyboardShortcutsHelp dialog.
 * Pure-render component (no hooks); tests inspect the returned ReactElement
 * tree directly (no DOM/jsdom). Locks open/closed gate, dialog a11y wiring,
 * SHORTCUTS row arity + text+keycap structure, and overlay-vs-panel click handling.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { KeyboardShortcutsHelp } from '../../console/src/components/KeyboardShortcutsHelp.tsx';

type AnyProps = {
  children?: ReactNode;
  className?: string;
  role?: string;
  id?: string;
  onClick?: (e: MouseEvent) => void;
  'aria-modal'?: string | boolean;
  'aria-labelledby'?: string;
};

type TestElement = ReactElement<AnyProps>;

function propsOf(el: TestElement): AnyProps {
  return el.props;
}

function flattenElements(node: ReactNode): TestElement[] {
  if (typeof node !== 'object' || node === null) return [];
  if (Array.isArray(node)) return node.flatMap(flattenElements);
  if ('type' in node) {
    const el = node as TestElement;
    return [el, ...flattenElements(propsOf(el).children)];
  }
  return [];
}

function collectStrings(node: ReactNode): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectStrings);
  if (typeof node === 'object' && node !== null && 'props' in node) {
    return collectStrings(propsOf(node as TestElement).children);
  }
  return [];
}

function plainText(node: ReactNode): string {
  return collectStrings(node).join('');
}

function render(component: ReactElement): TestElement | null {
  const fn = component.type as (props: unknown) => TestElement | null;
  return fn(component.props);
}

describe('KeyboardShortcutsHelp — open/closed gate', () => {
  it('returns null when open=false (renders nothing)', () => {
    const onClose = vi.fn();
    const tree = render(createElement(KeyboardShortcutsHelp, { open: false, onClose }));
    expect(tree).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns a non-null overlay element when open=true', () => {
    const tree = render(createElement(KeyboardShortcutsHelp, { open: true, onClose: vi.fn() }));
    expect(tree).not.toBeNull();
    expect(tree!.type).toBe('div');
    expect(propsOf(tree!).className).toContain('fixed inset-0');
  });
});

describe('KeyboardShortcutsHelp — dialog a11y contract', () => {
  function getDialog(): TestElement {
    const tree = render(createElement(KeyboardShortcutsHelp, { open: true, onClose: vi.fn() }))!;
    const dialog = flattenElements(propsOf(tree).children).find(
      (el) => propsOf(el).role === 'dialog',
    );
    expect(dialog).toBeDefined();
    return dialog!;
  }

  it('inner panel carries role=dialog with aria-modal=true and labelledby wiring', () => {
    const dialog = getDialog();
    expect(propsOf(dialog).role).toBe('dialog');
    expect(propsOf(dialog)['aria-modal']).toBe('true');
    expect(propsOf(dialog)['aria-labelledby']).toBe('kbd-shortcuts-title');
  });

  it('a labelled element with matching id="kbd-shortcuts-title" exists and reads "Keyboard Shortcuts"', () => {
    const dialog = getDialog();
    const title = flattenElements(propsOf(dialog).children).find(
      (el) => propsOf(el).id === 'kbd-shortcuts-title',
    );
    expect(title).toBeDefined();
    expect(plainText(title!)).toBe('Keyboard Shortcuts');
  });
});

describe('KeyboardShortcutsHelp — overlay vs panel click handling', () => {
  it('overlay onClick invokes onClose (click-outside-to-close)', () => {
    const onClose = vi.fn();
    const tree = render(createElement(KeyboardShortcutsHelp, { open: true, onClose }))!;
    const overlayOnClick = propsOf(tree).onClick;
    expect(overlayOnClick).toBeInstanceOf(Function);
    overlayOnClick!({} as MouseEvent);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('inner panel onClick stops propagation and does NOT invoke onClose', () => {
    const onClose = vi.fn();
    const tree = render(createElement(KeyboardShortcutsHelp, { open: true, onClose }))!;
    const dialog = flattenElements(propsOf(tree).children).find(
      (el) => propsOf(el).role === 'dialog',
    )!;
    const stopPropagation = vi.fn();
    const panelOnClick = propsOf(dialog).onClick;
    expect(panelOnClick).toBeInstanceOf(Function);
    panelOnClick!({ stopPropagation } as unknown as MouseEvent);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('KeyboardShortcutsHelp — SHORTCUTS list contract', () => {
  function getRows(): TestElement[] {
    const tree = render(createElement(KeyboardShortcutsHelp, { open: true, onClose: vi.fn() }))!;
    const dialog = flattenElements(propsOf(tree).children).find(
      (el) => propsOf(el).role === 'dialog',
    )!;
    const allElements = flattenElements(propsOf(dialog).children);
    return allElements.filter(
      (el) =>
        el.type === 'div' &&
        typeof propsOf(el).className === 'string' &&
        propsOf(el).className!.includes('justify-between'),
    );
  }

  it('renders exactly 6 shortcut rows, each row containing both a label and at least one <kbd>', () => {
    const rows = getRows();
    expect(rows.length).toBe(6);
    for (const row of rows) {
      const text = plainText(row).trim();
      expect(text.length).toBeGreaterThan(0);
      const kbdElems = flattenElements(propsOf(row).children).filter((el) => el.type === 'kbd');
      expect(kbdElems.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('locks the canonical label set (order-independent)', () => {
    const rows = getRows();
    const labels = rows.map((row) => {
      const labelSpan = flattenElements(propsOf(row).children).find(
        (el) => el.type === 'span' && typeof propsOf(el).className === 'string' && propsOf(el).className!.includes('text-data'),
      );
      return labelSpan ? plainText(labelSpan) : '';
    });
    expect(labels.sort()).toEqual(
      [
        'Close modals',
        'Focus search',
        'Go to Inbox',
        'Go to Ops',
        'Go to Soup Kitchen',
        'Show this help',
      ].sort(),
    );
  });

  it('platform-aware modifier: the "Focus search" row uses ⌘ on Mac or Ctrl elsewhere, suffixed with +K', () => {
    const rows = getRows();
    const focusRow = rows.find((row) => plainText(row).includes('Focus search'));
    expect(focusRow).toBeDefined();
    const kbd = flattenElements(propsOf(focusRow!).children).find((el) => el.type === 'kbd');
    expect(kbd).toBeDefined();
    const keyText = plainText(kbd!);
    expect(keyText === '⌘+K' || keyText === 'Ctrl+K').toBe(true);
  });

  it('numeric nav rows ("1","2","3") and special rows ("Esc","?") each render their literal keycap', () => {
    const rows = getRows();
    const keysByLabel = new Map<string, string[]>();
    for (const row of rows) {
      const labelSpan = flattenElements(propsOf(row).children).find(
        (el) => el.type === 'span' && typeof propsOf(el).className === 'string' && propsOf(el).className!.includes('text-data'),
      );
      const label = labelSpan ? plainText(labelSpan) : '';
      const kbds = flattenElements(propsOf(row).children)
        .filter((el) => el.type === 'kbd')
        .map((el) => plainText(el));
      keysByLabel.set(label, kbds);
    }
    expect(keysByLabel.get('Go to Soup Kitchen')).toEqual(['1']);
    expect(keysByLabel.get('Go to Inbox')).toEqual(['2']);
    expect(keysByLabel.get('Go to Ops')).toEqual(['3']);
    expect(keysByLabel.get('Close modals')).toEqual(['Esc']);
    expect(keysByLabel.get('Show this help')).toEqual(['?']);
  });
});

describe('KeyboardShortcutsHelp — footer hint', () => {
  it('renders a centered footer string mentioning "?" and "Esc" as keycaps', () => {
    const tree = render(createElement(KeyboardShortcutsHelp, { open: true, onClose: vi.fn() }))!;
    const dialog = flattenElements(propsOf(tree).children).find(
      (el) => propsOf(el).role === 'dialog',
    )!;
    const footer = flattenElements(propsOf(dialog).children).find(
      (el) =>
        el.type === 'div' &&
        typeof propsOf(el).className === 'string' &&
        propsOf(el).className!.includes('text-center'),
    );
    expect(footer).toBeDefined();
    const kbds = flattenElements(propsOf(footer!).children).filter((el) => el.type === 'kbd');
    expect(kbds.length).toBe(2);
    expect(kbds.map((el) => plainText(el))).toEqual(['?', 'Esc']);
    expect(plainText(footer!)).toContain('to close');
  });
});
