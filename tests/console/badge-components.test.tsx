/**
 * Behavioral contract-lock for ModeBadge + StatusDot.
 *
 * Both are small pure-render components with no test mirrors. Tests
 * inspect the returned ReactElement tree directly (no DOM/jsdom);
 * focus is on behavioral invariants (label, aria-label, presence
 * of conditional children, structural arity) plus explicit design-token
 * class mappings that gate semantic colors and motion.
 */
import { describe, expect, it } from 'vitest';
import { createElement, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import ModeBadge from '../../console/src/components/ModeBadge.tsx';
import StatusDot from '../../console/src/components/StatusDot.tsx';

type ElementProps = {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
};

type TestElement = ReactElement<ElementProps>;

function propsOf(element: TestElement): ElementProps {
  return element.props;
}

function classTokens(element: TestElement): string[] {
  return propsOf(element).className?.split(/\s+/).filter(Boolean) ?? [];
}

function expectClassTokens(element: TestElement, tokens: string[]): void {
  expect(classTokens(element)).toEqual(expect.arrayContaining(tokens));
}

/** Recursively gather all string nodes in a ReactElement tree. */
function collectStrings(node: ReactNode): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectStrings);
  if (typeof node === 'object' && node !== null && 'props' in node) {
    return collectStrings(propsOf(node as TestElement).children);
  }
  return [];
}

/** Recursively walk a tree and return all ReactElements (depth-first). */
function flattenElements(node: ReactNode): TestElement[] {
  if (typeof node !== 'object' || node === null) return [];
  if (Array.isArray(node)) return node.flatMap(flattenElements);
  if ('type' in node) {
    const el = node as TestElement;
    return [el, ...flattenElements(propsOf(el).children)];
  }
  return [];
}

/** Render the component into a ReactElement tree (no DOM). */
function render<P>(component: ReactElement<P>): TestElement {
  const fn = component.type as (props: P) => TestElement;
  return fn(component.props);
}

describe('ModeBadge — labels per mode', () => {
  for (const mode of ['passive', 'chat', 'agent'] as const) {
    it(`renders the literal label "${mode}" for mode="${mode}"`, () => {
      const tree = render(createElement(ModeBadge, { mode }));
      expect(collectStrings(tree)).toEqual([mode]);
    });
  }

  it('returns a <span> as the outer element', () => {
    const tree = render(createElement(ModeBadge, { mode: 'passive' }));
    expect(tree.type).toBe('span');
  });

  it('renders exactly one inner dot <span> (sibling of the text label)', () => {
    const tree = render(createElement(ModeBadge, { mode: 'agent' }));
    const inner = flattenElements(propsOf(tree).children).filter(
      (el) => el.type === 'span',
    );
    expect(inner.length).toBe(1);
  });

  const modeTokenCases: Array<[
    'passive' | 'chat' | 'agent',
    { textToken: string; dotToken: string; washToken: string },
  ]> = [
    ['passive', { textToken: 'text-m-pas', dotToken: 'bg-m-pas', washToken: 'var(--m-pas-soft)' }],
    ['chat', { textToken: 'text-m-cht', dotToken: 'bg-m-cht', washToken: 'var(--m-cht-soft)' }],
    ['agent', { textToken: 'text-m-agt', dotToken: 'bg-m-agt', washToken: 'var(--m-agt-soft)' }],
  ];

  for (const [mode, { textToken, dotToken, washToken }] of modeTokenCases) {
    it(`locks design tokens for mode="${mode}"`, () => {
      const tree = render(createElement(ModeBadge, { mode }));
      const dot = flattenElements(propsOf(tree).children).find(
        (el) => el.type === 'span',
      );
      expect(dot).toBeDefined();
      expectClassTokens(tree, [textToken]);
      expect(propsOf(tree).style?.backgroundColor).toBe(washToken);
      expectClassTokens(dot!, ['rounded-full', dotToken]);
    });
  }
});

describe('StatusDot — defaults', () => {
  it('defaults size="md" → 8px width and height', () => {
    const tree = render(createElement(StatusDot, { status: 'online' }));
    expect(propsOf(tree).style?.width).toBe('8px');
    expect(propsOf(tree).style?.height).toBe('8px');
  });

  it('respects size="sm" → 6px width and height', () => {
    const tree = render(createElement(StatusDot, { status: 'online', size: 'sm' }));
    expect(propsOf(tree).style?.width).toBe('6px');
    expect(propsOf(tree).style?.height).toBe('6px');
  });

  it('outer span exposes aria-label = status (screen-reader contract)', () => {
    const t1 = render(createElement(StatusDot, { status: 'online' }));
    const t2 = render(createElement(StatusDot, { status: 'degraded' }));
    const t3 = render(createElement(StatusDot, { status: 'unreachable' }));
    expect(propsOf(t1)['aria-label']).toBe('online');
    expect(propsOf(t2)['aria-label']).toBe('degraded');
    expect(propsOf(t3)['aria-label']).toBe('unreachable');
  });
});

describe('StatusDot — status → design color token', () => {
  const cases: Array<['online' | 'degraded' | 'unreachable', string]> = [
    ['online', 'bg-s-ok'],
    ['degraded', 'bg-s-warn'],
    ['unreachable', 'bg-s-crit'],
  ];
  for (const [status, klass] of cases) {
    it(`locks ${klass} for status="${status}"`, () => {
      const tree = render(createElement(StatusDot, { status }));
      const dot = flattenElements(propsOf(tree).children).find(
        (el) => el.type === 'span' && classTokens(el).includes('rounded-full'),
      );
      expect(dot).toBeDefined();
      expectClassTokens(dot!, ['rounded-full', klass]);
    });
  }
});

describe('StatusDot — animated ring is online-only', () => {
  function countRings(status: 'online' | 'degraded' | 'unreachable'): {
    rings: number;
    totalChildren: number;
  } {
    const tree = render(createElement(StatusDot, { status }));
    const children = flattenElements(propsOf(tree).children);
    const rings = children.filter((el) =>
      classTokens(el).includes('animate-breathe-ring'),
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
