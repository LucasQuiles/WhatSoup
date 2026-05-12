/**
 * Behavioral contract-lock for KpiCard.
 * Pure-render component with one hook (useId for SVG gradient id);
 * useId is stubbed so tests can inspect the returned ReactElement tree
 * directly (no DOM/jsdom).
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement, type CSSProperties, type ReactElement, type ReactNode } from 'react';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useId: () => 'test-grad-id',
  };
});

import KpiCard from '../../console/src/components/KpiCard.tsx';

type ElementProps = {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
  type?: string;
  onClick?: () => void;
  id?: string;
  fill?: string;
  stroke?: string;
  points?: string;
  viewBox?: string;
  offset?: string;
  stopColor?: string;
  stopOpacity?: string;
};

type TestElement = ReactElement<ElementProps>;

interface KpiCardProps {
  value: string | number;
  label: string;
  color: string;
  onClick?: () => void;
  active?: boolean;
  sparkData?: number[];
  suffix?: string;
}

function propsOf(element: TestElement): ElementProps {
  return element.props;
}

function classTokens(element: TestElement): string[] {
  return propsOf(element).className?.split(/\s+/).filter(Boolean) ?? [];
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

function flattenElements(node: ReactNode): TestElement[] {
  if (typeof node !== 'object' || node === null) return [];
  if (Array.isArray(node)) return node.flatMap(flattenElements);
  if ('type' in node) {
    const el = node as TestElement;
    return [el, ...flattenElements(propsOf(el).children)];
  }
  return [];
}

function render(props: KpiCardProps): TestElement {
  const fn = KpiCard as unknown as (p: KpiCardProps) => TestElement;
  return fn(props);
}

describe('KpiCard — root structure', () => {
  it('returns a <button type="button"> with aria-pressed bound to active', () => {
    const t1 = render({ value: 1, label: 'A', color: 'text-s-ok', active: true });
    const t2 = render({ value: 1, label: 'A', color: 'text-s-ok', active: false });
    const t3 = render({ value: 1, label: 'A', color: 'text-s-ok' });
    expect(t1.type).toBe('button');
    expect(propsOf(t1).type).toBe('button');
    expect(propsOf(t1)['aria-pressed']).toBe(true);
    expect(propsOf(t2)['aria-pressed']).toBe(false);
    // default for active is false
    expect(propsOf(t3)['aria-pressed']).toBe(false);
  });

  it('attaches the onClick handler passed in props', () => {
    const cb = vi.fn();
    const tree = render({ value: 1, label: 'A', color: 'text-s-ok', onClick: cb });
    expect(propsOf(tree).onClick).toBe(cb);
    propsOf(tree).onClick?.();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('omits an onClick prop when none is supplied', () => {
    const tree = render({ value: 1, label: 'A', color: 'text-s-ok' });
    expect(propsOf(tree).onClick).toBeUndefined();
  });

  it('locks the canonical class token set on the root button', () => {
    const tree = render({ value: 1, label: 'A', color: 'text-s-ok' });
    const tokens = classTokens(tree);
    expect(tokens).toEqual(
      expect.arrayContaining([
        'cursor-pointer',
        'select-none',
        'relative',
        'overflow-hidden',
        'c-kpi-pad',
        'c-kpi-hover',
        'rounded-md',
      ]),
    );
  });
});

describe('KpiCard — active state styling', () => {
  it('active=true uses d3 background + colored border + inset shadow', () => {
    const tree = render({ value: 1, label: 'A', color: 'text-s-ok', active: true });
    const style = propsOf(tree).style ?? {};
    expect(style.background).toBe('var(--color-d3)');
    expect(style.border).toBe('var(--bw) solid var(--color-s-ok)');
    expect(style.boxShadow).toBe('var(--shadow-inset)');
  });

  it('active=false uses d2 background + neutral border + no shadow', () => {
    const tree = render({ value: 1, label: 'A', color: 'text-s-ok', active: false });
    const style = propsOf(tree).style ?? {};
    expect(style.background).toBe('var(--color-d2)');
    expect(style.border).toBe('var(--bw) solid var(--b1)');
    expect(style.boxShadow).toBe('none');
  });

  it('falls back to currentColor when the color key is not in colorMap', () => {
    const tree = render({ value: 1, label: 'A', color: 'text-unknown-xyz', active: true });
    const style = propsOf(tree).style ?? {};
    expect(style.border).toBe('var(--bw) solid currentColor');
  });
});

describe('KpiCard — value + label content', () => {
  it('renders the value text inside the c-kpi-value container with the color class', () => {
    const tree = render({ value: 42, label: 'OPS', color: 'text-s-ok' });
    const children = flattenElements(propsOf(tree).children);
    const valueDiv = children.find(
      (el) => el.type === 'div' && classTokens(el).includes('c-kpi-value'),
    );
    expect(valueDiv).toBeDefined();
    expect(classTokens(valueDiv!)).toEqual(
      expect.arrayContaining(['c-kpi-value', 'text-s-ok']),
    );
    expect(collectStrings(propsOf(valueDiv!).children)).toEqual(['42']);
  });

  it('accepts string values and preserves them verbatim', () => {
    const tree = render({ value: 'N/A', label: 'OPS', color: 'text-s-ok' });
    const valueDiv = flattenElements(propsOf(tree).children).find(
      (el) => el.type === 'div' && classTokens(el).includes('c-kpi-value'),
    );
    expect(valueDiv).toBeDefined();
    expect(collectStrings(propsOf(valueDiv!).children)).toEqual(['N/A']);
  });

  it('renders the label inside an uppercase c-label container', () => {
    const tree = render({ value: 1, label: 'requests', color: 'text-s-ok' });
    const children = flattenElements(propsOf(tree).children);
    const labelDiv = children.find(
      (el) => el.type === 'div' && classTokens(el).includes('c-label'),
    );
    expect(labelDiv).toBeDefined();
    expect(classTokens(labelDiv!)).toEqual(
      expect.arrayContaining(['c-label', 'uppercase']),
    );
    expect(collectStrings(propsOf(labelDiv!).children)).toEqual(['requests']);
  });
});

describe('KpiCard — suffix slot', () => {
  it('omits the suffix span entirely when suffix is not provided', () => {
    const tree = render({ value: 42, label: 'A', color: 'text-s-ok' });
    const valueDiv = flattenElements(propsOf(tree).children).find(
      (el) => el.type === 'div' && classTokens(el).includes('c-kpi-value'),
    )!;
    const spans = flattenElements(propsOf(valueDiv).children).filter(
      (el) => el.type === 'span',
    );
    expect(spans).toHaveLength(0);
  });

  it('renders the suffix in a span sibling with text-data + font-normal tokens', () => {
    const tree = render({ value: 42, label: 'A', color: 'text-s-ok', suffix: 'ms' });
    const valueDiv = flattenElements(propsOf(tree).children).find(
      (el) => el.type === 'div' && classTokens(el).includes('c-kpi-value'),
    )!;
    const spans = flattenElements(propsOf(valueDiv).children).filter(
      (el) => el.type === 'span',
    );
    expect(spans).toHaveLength(1);
    expect(classTokens(spans[0]!)).toEqual(
      expect.arrayContaining(['text-data', 'font-normal']),
    );
    expect(collectStrings(propsOf(spans[0]!).children)).toEqual(['ms']);
  });
});

describe('KpiCard — sparkline gating', () => {
  it('omits the <svg> when sparkData is undefined', () => {
    const tree = render({ value: 1, label: 'A', color: 'text-s-ok' });
    const svgs = flattenElements(propsOf(tree).children).filter(
      (el) => el.type === 'svg',
    );
    expect(svgs).toHaveLength(0);
  });

  it('omits the <svg> when sparkData has length <= 1 (single-sample is not a line)', () => {
    const t0 = render({ value: 1, label: 'A', color: 'text-s-ok', sparkData: [] });
    const t1 = render({ value: 1, label: 'A', color: 'text-s-ok', sparkData: [0.5] });
    const svgs0 = flattenElements(propsOf(t0).children).filter((el) => el.type === 'svg');
    const svgs1 = flattenElements(propsOf(t1).children).filter((el) => el.type === 'svg');
    expect(svgs0).toHaveLength(0);
    expect(svgs1).toHaveLength(0);
  });

  it('renders the <svg> when sparkData has 2+ samples', () => {
    const tree = render({ value: 1, label: 'A', color: 'text-s-ok', sparkData: [0.2, 0.8] });
    const svgs = flattenElements(propsOf(tree).children).filter(
      (el) => el.type === 'svg',
    );
    expect(svgs).toHaveLength(1);
  });
});

describe('KpiCard — sparkline shape', () => {
  it('sets viewBox to "0 0 N-1 1" so each sample maps to one x-unit', () => {
    const tree = render({
      value: 1,
      label: 'A',
      color: 'text-s-ok',
      sparkData: [0.1, 0.5, 0.9, 0.3, 0.7],
    });
    const svg = flattenElements(propsOf(tree).children).find(
      (el) => el.type === 'svg',
    )!;
    expect(propsOf(svg).viewBox).toBe('0 0 4 1');
  });

  it('plots polyline points as "i,1-d" pairs in sample order', () => {
    const tree = render({
      value: 1,
      label: 'A',
      color: 'text-s-ok',
      sparkData: [0, 0.25, 1],
    });
    const polyline = flattenElements(propsOf(tree).children).find(
      (el) => el.type === 'polyline',
    )!;
    expect(propsOf(polyline).points).toBe('0,1 1,0.75 2,0');
    expect(propsOf(polyline).fill).toBe('none');
  });

  it('closes the polygon by prepending "0,1" and appending "N-1,1" to the line points', () => {
    const tree = render({
      value: 1,
      label: 'A',
      color: 'text-s-ok',
      sparkData: [0.25, 0.75],
    });
    const polygon = flattenElements(propsOf(tree).children).find(
      (el) => el.type === 'polygon',
    )!;
    expect(propsOf(polygon).points).toBe('0,1 0,0.75 1,0.25 1,1');
  });

  it('routes strokeColor from colorMap into both the polyline stroke and the gradient stops', () => {
    const tree = render({
      value: 1,
      label: 'A',
      color: 'text-m-agt',
      sparkData: [0.2, 0.8],
    });
    const polyline = flattenElements(propsOf(tree).children).find(
      (el) => el.type === 'polyline',
    )!;
    expect(propsOf(polyline).stroke).toBe('var(--color-m-agt)');

    const stops = flattenElements(propsOf(tree).children).filter(
      (el) => el.type === 'stop',
    );
    expect(stops).toHaveLength(2);
    expect(propsOf(stops[0]!).stopColor).toBe('var(--color-m-agt)');
    expect(propsOf(stops[1]!).stopColor).toBe('var(--color-m-agt)');
  });

  it('wires the polygon fill to url(#<gradientId>) matching the linearGradient id', () => {
    const tree = render({
      value: 1,
      label: 'A',
      color: 'text-s-ok',
      sparkData: [0.4, 0.6],
    });
    const polygon = flattenElements(propsOf(tree).children).find(
      (el) => el.type === 'polygon',
    )!;
    const gradient = flattenElements(propsOf(tree).children).find(
      (el) => el.type === 'linearGradient',
    )!;
    const gradientId = propsOf(gradient).id;
    expect(gradientId).toBe('test-grad-id');
    expect(propsOf(polygon).fill).toBe(`url(#${gradientId})`);
  });
});

describe('KpiCard — colorMap coverage', () => {
  const expectedMap: Array<[string, string]> = [
    ['text-s-ok', 'var(--color-s-ok)'],
    ['text-s-crit', 'var(--color-s-crit)'],
    ['text-s-warn', 'var(--color-s-warn)'],
    ['text-m-agt', 'var(--color-m-agt)'],
    ['text-m-cht', 'var(--color-m-cht)'],
    ['text-m-pas', 'var(--color-m-pas)'],
    ['text-t2', 'var(--color-t2)'],
  ];

  for (const [token, cssVar] of expectedMap) {
    it(`maps color="${token}" to stroke ${cssVar} and uses it for active border`, () => {
      const tree = render({
        value: 1,
        label: 'A',
        color: token,
        active: true,
        sparkData: [0.1, 0.9],
      });
      expect(propsOf(tree).style?.border).toBe(`var(--bw) solid ${cssVar}`);
      const polyline = flattenElements(propsOf(tree).children).find(
        (el) => el.type === 'polyline',
      )!;
      expect(propsOf(polyline).stroke).toBe(cssVar);
    });
  }
});
