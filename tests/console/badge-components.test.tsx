/**
 * Behavioral contract-lock for ModeBadge + StatusDot.
 *
 * Both are small pure-render components with no test mirrors. Tests
 * inspect the returned ReactElement tree directly (no DOM/jsdom);
 * focus is on behavioral invariants (label, aria-label, presence
 * of conditional children, structural arity) rather than CSS classes,
 * which are brittle and frequently rewashed for design system updates.
 */
import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import ModeBadge from '../../console/src/components/ModeBadge.tsx';
import StatusDot from '../../console/src/components/StatusDot.tsx';

function asElement(node: ReactNode): ReactElement {
  if (typeof node === 'object' && node !== null && 'type' in node) {
    return node as ReactElement;
  }
  throw new Error(`expected ReactElement, got ${typeof node}: ${String(node)}`);
}

/** Recursively gather all string nodes in a ReactElement tree. */
function collectStrings(node: ReactNode): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectStrings);
  if (typeof node === 'object' && node !== null && 'props' in node) {
    return collectStrings((node as ReactElement).props.children);
  }
  return [];
}

/** Recursively walk a tree and return all ReactElements (depth-first). */
function flattenElements(node: ReactNode): ReactElement[] {
  if (typeof node !== 'object' || node === null) return [];
  if (Array.isArray(node)) return node.flatMap(flattenElements);
  if ('type' in node) {
    const el = node as ReactElement;
    return [el, ...flattenElements(el.props.children)];
  }
  return [];
}

/** Render the component into a ReactElement tree (no DOM). */
function render(component: ReactElement): ReactElement {
  const fn = component.type as (props: unknown) => ReactElement;
  return fn(component.props);
}

describe('ModeBadge — labels per mode', () => {
  for (const mode of ['passive', 'chat', 'agent'] as const) {
    it(`renders the literal label "${mode}" for mode="${mode}"`, () => {
      const tree = render(createElement(ModeBadge, { mode }));
      expect(collectStrings(tree).join(' ')).toContain(mode);
    });
  }

  it('returns a <span> as the outer element', () => {
    const tree = render(createElement(ModeBadge, { mode: 'passive' }));
    expect(tree.type).toBe('span');
  });

  it('renders exactly one inner dot <span> (sibling of the text label)', () => {
    const tree = render(createElement(ModeBadge, { mode: 'agent' }));
    const inner = flattenElements(tree.props.children).filter(
      (el) => el.type === 'span',
    );
    expect(inner.length).toBe(1);
  });

  it('the inner dot has a rounded-full + bg-* class for the mode', () => {
    const tree = render(createElement(ModeBadge, { mode: 'chat' }));
    const dot = flattenElements(tree.props.children).find(
      (el) => el.type === 'span',
    )!;
    expect(String(dot.props.className)).toContain('rounded-full');
    expect(String(dot.props.className)).toContain('bg-m-cht');
  });
});

describe('StatusDot — defaults', () => {
  it('defaults size="md" → 8px width and height', () => {
    const tree = render(createElement(StatusDot, { status: 'online' }));
    expect(tree.props.style.width).toBe('8px');
    expect(tree.props.style.height).toBe('8px');
  });

  it('respects size="sm" → 6px width and height', () => {
    const tree = render(createElement(StatusDot, { status: 'online', size: 'sm' }));
    expect(tree.props.style.width).toBe('6px');
    expect(tree.props.style.height).toBe('6px');
  });

  it('outer span exposes aria-label = status (screen-reader contract)', () => {
    const t1 = render(createElement(StatusDot, { status: 'online' }));
    const t2 = render(createElement(StatusDot, { status: 'degraded' }));
    const t3 = render(createElement(StatusDot, { status: 'unreachable' }));
    expect(t1.props['aria-label']).toBe('online');
    expect(t2.props['aria-label']).toBe('degraded');
    expect(t3.props['aria-label']).toBe('unreachable');
  });
});

describe('StatusDot — status → color class', () => {
  const cases: Array<['online' | 'degraded' | 'unreachable', string]> = [
    ['online', 'bg-s-ok'],
    ['degraded', 'bg-s-warn'],
    ['unreachable', 'bg-s-crit'],
  ];
  for (const [status, klass] of cases) {
    it(`inner dot carries ${klass} for status="${status}"`, () => {
      const tree = render(createElement(StatusDot, { status }));
      const dot = flattenElements(tree.props.children).find(
        (el) => el.type === 'span' && String(el.props.className).includes('rounded-full'),
      );
      expect(dot).toBeDefined();
      expect(String(dot!.props.className)).toContain(klass);
    });
  }
});

describe('StatusDot — animated ring is online-only', () => {
  function countRings(status: 'online' | 'degraded' | 'unreachable'): {
    rings: number;
    totalChildren: number;
  } {
    const tree = render(createElement(StatusDot, { status }));
    const children = flattenElements(tree.props.children);
    const rings = children.filter((el) =>
      String(el.props.className).includes('animate-breathe-ring'),
    ).length;
    return { rings, totalChildren: children.length };
  }

  it('online state renders exactly 1 ring + 1 dot (totalChildren = 2)', () => {
    const { rings, totalChildren } = countRings('online');
    expect(rings).toBe(1);
    expect(totalChildren).toBe(2);
  });

  it('degraded state renders 0 rings (only the dot, totalChildren = 1)', () => {
    const { rings, totalChildren } = countRings('degraded');
    expect(rings).toBe(0);
    expect(totalChildren).toBe(1);
  });

  it('unreachable state renders 0 rings (only the dot, totalChildren = 1)', () => {
    const { rings, totalChildren } = countRings('unreachable');
    expect(rings).toBe(0);
    expect(totalChildren).toBe(1);
  });
});
