import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function getProps(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== 'object') return {};
  return (node as { props?: Record<string, unknown> }).props ?? {};
}

function toChildren(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  const children = (node as { props?: { children?: unknown } }).props?.children;
  if (children === undefined || children === null) return [];
  return Array.isArray(children) ? children : [children];
}

function findByTestId(node: unknown, testId: string): unknown | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const props = getProps(node);
  if (props['data-testid'] === testId) return node;
  for (const child of toChildren(node)) {
    const found = findByTestId(child, testId);
    if (found) return found;
  }
  return undefined;
}

function findByText(node: unknown, text: string): boolean {
  if (!node) return false;
  if (typeof node === 'string') return node.includes(text);
  if (typeof node === 'number') return String(node).includes(text);
  if (typeof node !== 'object') return false;
  const children = toChildren(node);
  return children.some(c => findByText(c, text));
}

describe('ChartPanel', () => {
  it('renders loading shimmer when isLoading is true', async () => {
    const { ChartPanel } = await import('../../console/src/components/ChartPanel.tsx');

    const element = ChartPanel({
      title: 'Test Chart',
      isLoading: true,
      isError: false,
      hasData: false,
      instancesFailed: 0,
      children: null,
    });

    expect(findByText(element, 'Test Chart')).toBe(true);
    const shimmer = findByTestId(element, 'chart-shimmer');
    expect(getProps(shimmer)).toMatchObject({ 'data-testid': 'chart-shimmer' });
  });

  it('renders error state with retry button', async () => {
    const onRetry = vi.fn();
    const { ChartPanel } = await import('../../console/src/components/ChartPanel.tsx');

    const element = ChartPanel({
      title: 'Test Chart',
      isLoading: false,
      isError: true,
      hasData: false,
      instancesFailed: 0,
      onRetry,
      children: null,
    });

    expect(findByText(element, 'Failed to load')).toBe(true);
  });

  it('renders empty state when hasData is false', async () => {
    const { ChartPanel } = await import('../../console/src/components/ChartPanel.tsx');

    const element = ChartPanel({
      title: 'Test Chart',
      isLoading: false,
      isError: false,
      hasData: false,
      instancesFailed: 0,
      children: null,
    });

    expect(findByText(element, 'No data yet')).toBe(true);
  });

  it('renders children when hasData is true', async () => {
    const { ChartPanel } = await import('../../console/src/components/ChartPanel.tsx');

    const child = { type: 'div', props: { children: 'Chart content' }, key: null };
    const element = ChartPanel({
      title: 'Test Chart',
      isLoading: false,
      isError: false,
      hasData: true,
      instancesFailed: 0,
      children: child,
    });

    expect(findByText(element, 'Chart content')).toBe(true);
  });

  it('shows warning pill when instancesFailed > 0', async () => {
    const { ChartPanel } = await import('../../console/src/components/ChartPanel.tsx');

    const child = { type: 'div', props: { children: 'Chart content' }, key: null };
    const element = ChartPanel({
      title: 'Test Chart',
      isLoading: false,
      isError: false,
      hasData: true,
      instancesFailed: 2,
      children: child,
    });

    expect(findByText(element, '2 instance(s) unavailable')).toBe(true);
  });
});
