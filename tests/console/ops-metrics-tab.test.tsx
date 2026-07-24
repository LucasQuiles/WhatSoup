/**
 * Ops Metrics tab — the b-09a absorption shell contract.
 *
 * Pins: the Operator renders Console by default, the Metrics tab swaps to
 * the absorbed surface, ?tab=metrics deep-links select it, and /metrics
 * redirects to /ops?tab=metrics (App route pin).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ReactNode } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

// framer-motion: render motion.div as a plain div in jsdom.
vi.mock('framer-motion', async () => {
  const React = await import('react')
  return {
    motion: {
      div: ({
        children,
        className,
        initial: _i,
        animate: _a,
        transition: _t,
        ...rest
      }: Record<string, unknown> & { children?: ReactNode; className?: string }) =>
        React.createElement('div', { className, ...rest }, children),
    },
  }
})

// use-fleet / use-metrics hooks: minimal resolved data.
vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: () => ({ data: [], isLoading: false, error: null, refetch: vi.fn() }),
  useLogs: () => ({ data: [], error: null, refetch: vi.fn() }),
  useFeed: () => ({ data: [], error: null, refetch: vi.fn() }),
}))
vi.mock('../../console/src/hooks/use-metrics', () => ({
  useFleetMetrics: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    freshness: { observedAt: null, stale: false },
  }),
}))

const toastMock = { toast: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn(), clear: vi.fn() }
vi.mock('../../console/src/hooks/toast-context', () => ({
  ToastContext: { Provider: ({ children }: { children?: ReactNode }) => children },
  useToast: () => toastMock,
}))

// OpsMetrics is heavy (charts); stub it with a sentinel so the tab swap is
// provable without the chart machinery.
vi.mock('../../console/src/components/ops/OpsMetrics', () => ({
  OpsMetrics: () => <div data-testid="ops-metrics-stub">metrics surface</div>,
}))

import Operator from '../../console/src/pages/Operator'

function renderOps(initialEntries: string[] = ['/ops']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <Operator />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  Object.values(toastMock).forEach((fn) => fn.mockClear())
})

afterEach(cleanup)

describe('Ops metrics tab (T5 b-09a absorption shell)', () => {
  it('renders the Console tab by default; metrics surface mounts on first visit (deferred)', async () => {
    const { container, queryByTestId } = renderOps()
    await waitFor(() => expect(container.querySelector('[role="tablist"]')).not.toBeNull())
    const tabs = [...container.querySelectorAll('[role="tab"]')]
    expect(tabs.map((t) => t.textContent)).toEqual(['Console', 'Metrics'])
    // deferred mount: no metrics query load until the tab is first visited
    expect(queryByTestId('ops-metrics-stub')).toBeNull()
    expect(container.querySelector('#tabpanel-console')!.hasAttribute('hidden')).toBe(false)
  })

  it('after first visit the metrics surface stays mounted (keep-alive across switches)', async () => {
    const { container, getByTestId } = renderOps()
    await waitFor(() => expect(container.querySelector('[role="tablist"]')).not.toBeNull())
    fireEvent.click([...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Metrics')!)
    await waitFor(() => expect(getByTestId('ops-metrics-stub')).toBeDefined())
    fireEvent.click([...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Console')!)
    await waitFor(() =>
      expect(container.querySelector('#tabpanel-console')!.hasAttribute('hidden')).toBe(false),
    )
    // still mounted after the switch back — hidden, never unmounted
    expect(getByTestId('ops-metrics-stub')).toBeDefined()
    expect(container.querySelector('#tabpanel-metrics')!.hasAttribute('hidden')).toBe(true)
  })

  it('clicking Metrics swaps panels via hidden — both stay mounted (keep-alive)', async () => {
    const { container, getByTestId } = renderOps()
    await waitFor(() => expect(container.querySelector('[role="tablist"]')).not.toBeNull())
    const metricsTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Metrics')!
    fireEvent.click(metricsTab)
    await waitFor(() => expect(getByTestId('ops-metrics-stub')).toBeDefined())
    const consolePanel = container.querySelector('#tabpanel-console')!
    const metricsPanel = container.querySelector('#tabpanel-metrics')!
    expect(consolePanel.hasAttribute('hidden')).toBe(true)
    expect(metricsPanel.hasAttribute('hidden')).toBe(false)
    // both mounted — the console tree is hidden, never unmounted
    expect(container.querySelector('.soup-operator-layout')).not.toBeNull()
    fireEvent.click([...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Console')!)
    await waitFor(() => expect(consolePanel.hasAttribute('hidden')).toBe(false))
    expect(metricsPanel.hasAttribute('hidden')).toBe(true)
  })

  it('panels carry the a11y association: role=tabpanel + aria-labelledby to their tab', async () => {
    const { container } = renderOps()
    await waitFor(() => expect(container.querySelector('[role="tablist"]')).not.toBeNull())
    for (const id of ['console', 'metrics']) {
      const panel = container.querySelector(`#tabpanel-${id}`)!
      expect(panel.getAttribute('role')).toBe('tabpanel')
      expect(panel.getAttribute('aria-labelledby')).toBe(`tab-${id}`)
      expect(container.querySelector(`#tab-${id}`)).not.toBeNull()
    }
  })

  it('console state survives the switch: the selected line stays selected', async () => {
    const { container } = renderOps(['/ops'])
    await waitFor(() => expect(container.querySelector('[role="tablist"]')).not.toBeNull())
    // there is no line fixture (lines=[]) — pin the keep-alive DOM contract
    // directly: the console tree's React state container is never replaced,
    // only hidden (the unmount-and-remount path is what destroyed state).
    const consoleContent = container.querySelector('.soup-operator-layout')
    fireEvent.click([...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Metrics')!)
    await waitFor(() =>
      expect(container.querySelector('#tabpanel-console')!.hasAttribute('hidden')).toBe(true),
    )
    // SAME node instance — proof of keep-alive, not remount
    expect(container.querySelector('.soup-operator-layout')).toBe(consoleContent)
    fireEvent.click([...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Console')!)
    await waitFor(() =>
      expect(container.querySelector('#tabpanel-console')!.hasAttribute('hidden')).toBe(false),
    )
    expect(container.querySelector('.soup-operator-layout')).toBe(consoleContent)
  })

  it('?tab=metrics deep-link selects the Metrics tab', async () => {
    const { getByTestId } = renderOps(['/ops?tab=metrics'])
    await waitFor(() => expect(getByTestId('ops-metrics-stub')).toBeDefined())
  })
})

describe('/metrics redirect (App route pin)', () => {
  it('App.tsx redirects /metrics to /ops?tab=metrics', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const app = readFileSync(resolve(import.meta.dirname, '../../console/src/App.tsx'), 'utf8')
    expect(app).toContain('path="/metrics" element={<Navigate to="/ops?tab=metrics" replace />}')
    // and the page file is gone — absorbed, not shadowed
    expect(app).not.toContain("pages/Metrics")
  })
})
