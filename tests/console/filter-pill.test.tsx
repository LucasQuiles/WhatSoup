/**
 * Behavioral contract-lock for console/src/components/FilterPill.tsx.
 *
 * Pure render of a pressable toggle. Critical behavioral invariants:
 *   - type="button" (semantic), aria-pressed = isActive (a11y)
 *   - onClick prop is wired through to the underlying <button>
 *   - count badge appears IFF count !== undefined && count > 0
 *   - suffix slot renders inline after the label/count
 *
 * No prior test mirror. ReactElement tree inspection only (no DOM/jsdom).
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import FilterPill from '../../console/src/components/FilterPill.tsx';

type Props = {
  label: string;
  isActive: boolean;
  onClick: () => void;
  count?: number;
  activeColor?: string;
  activeBorder?: string;
  suffix?: ReactNode;
};

function render(props: Props): ReactElement {
  return (FilterPill as (p: Props) => ReactElement)(props);
}

function flatChildren(tree: ReactElement): ReactNode[] {
  const c = tree.props.children;
  return Array.isArray(c) ? c : [c];
}

describe('FilterPill — semantic + a11y', () => {
  it('renders a <button type="button"> (avoids accidental form submit)', () => {
    const tree = render({ label: 'All', isActive: false, onClick: () => {} });
    expect(tree.type).toBe('button');
    expect(tree.props.type).toBe('button');
  });

  it('aria-pressed = isActive=true', () => {
    const tree = render({ label: 'On', isActive: true, onClick: () => {} });
    expect(tree.props['aria-pressed']).toBe(true);
  });

  it('aria-pressed = isActive=false', () => {
    const tree = render({ label: 'Off', isActive: false, onClick: () => {} });
    expect(tree.props['aria-pressed']).toBe(false);
  });
});

describe('FilterPill — onClick wiring', () => {
  it('forwards the onClick handler to the underlying <button>', () => {
    const onClick = vi.fn();
    const tree = render({ label: 'X', isActive: false, onClick });
    expect(tree.props.onClick).toBe(onClick);
    // Simulate click by invoking the callback directly
    (tree.props.onClick as () => void)();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('FilterPill — label and active styling', () => {
  it('renders the label string literally', () => {
    const tree = render({ label: 'Inbox', isActive: false, onClick: () => {} });
    const children = flatChildren(tree);
    expect(children).toContain('Inbox');
  });

  it('uses the default activeColor (text-t2) when active and no override is given', () => {
    const tree = render({ label: 'a', isActive: true, onClick: () => {} });
    expect(String(tree.props.className)).toContain('text-t2');
  });

  it('honours a custom activeColor when active', () => {
    const tree = render({ label: 'a', isActive: true, activeColor: 'text-m-cht', onClick: () => {} });
    expect(String(tree.props.className)).toContain('text-m-cht');
  });

  it('falls back to inactive styling (text-t4) when isActive=false', () => {
    const tree = render({ label: 'a', isActive: false, activeColor: 'text-m-cht', onClick: () => {} });
    // Inactive styling overrides the activeColor prop
    expect(String(tree.props.className)).toContain('text-t4');
    expect(String(tree.props.className)).not.toContain('text-m-cht');
  });
});

describe('FilterPill — count badge presence', () => {
  it('does NOT render a count <span> when count is undefined', () => {
    const tree = render({ label: 'a', isActive: false, onClick: () => {} });
    const badgeStrings = flatChildren(tree).filter(
      (c): c is ReactElement =>
        typeof c === 'object' && c !== null && 'type' in c && (c as ReactElement).type === 'span',
    );
    expect(badgeStrings).toHaveLength(0);
  });

  it('does NOT render a count <span> when count is 0 (hidden empty filter)', () => {
    const tree = render({ label: 'a', isActive: false, count: 0, onClick: () => {} });
    const badgeStrings = flatChildren(tree).filter(
      (c): c is ReactElement =>
        typeof c === 'object' && c !== null && 'type' in c && (c as ReactElement).type === 'span',
    );
    expect(badgeStrings).toHaveLength(0);
  });

  it('renders a count <span> with the count value when count > 0', () => {
    const tree = render({ label: 'a', isActive: false, count: 7, onClick: () => {} });
    const spans = flatChildren(tree).filter(
      (c): c is ReactElement =>
        typeof c === 'object' && c !== null && 'type' in c && (c as ReactElement).type === 'span',
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].props.children).toBe(7);
  });
});

describe('FilterPill — suffix slot', () => {
  it('renders the suffix node as the last child when provided', () => {
    const suffix = createElement('em', { 'data-marker': 'suffix' }, 'x');
    const tree = render({ label: 'a', isActive: false, onClick: () => {}, suffix });
    const children = flatChildren(tree);
    // Last node should be the suffix em element
    const last = children[children.length - 1];
    expect(last).toBe(suffix);
  });

  it('omits the suffix slot gracefully (no error) when not provided', () => {
    const tree = render({ label: 'a', isActive: false, onClick: () => {} });
    const children = flatChildren(tree);
    // No <em data-marker=suffix> in children
    expect(
      children.find(
        (c) => typeof c === 'object' && c !== null && 'props' in c && (c as ReactElement).props?.['data-marker'] === 'suffix',
      ),
    ).toBeUndefined();
  });
});
