/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FleetMetrics, LineMetrics, MetricsRange } from '../../console/src/types.js'

vi.mock('../../console/src/lib/api.js', () => ({
  api: {
    getMetrics: vi.fn(),
    getFleetMetrics: vi.fn(),
  },
}))

import { api } from '../../console/src/lib/api.js'
import {
  getFleetMetricsQueryOptions,
  getMetricsQueryOptions,
  useFleetMetrics,
  useMetrics,
} from '../../console/src/hooks/use-metrics.js'

const getMetricsMock = vi.mocked(api.getMetrics)
const getFleetMetricsMock = vi.mocked(api.getFleetMetrics)

const lineMetrics: LineMetrics = {
  range: '24h',
  messageVolume: [{ bucket: '2026-05-12T00:00:00.000Z', inbound: 10, outbound: 5, media: 2 }],
  tokenUsage: [{ bucket: '2026-05-12T00:00:00.000Z', input: 1000, output: 500 }],
  sessionActivity: [{ bucket: '2026-05-12T00:00:00.000Z', active: 3, started: 1 }],
  tokenUsageByProvider: { openai: [{ bucket: '2026-05-12T00:00:00.000Z', input: 1000, output: 500 }] },
  sessionActivityByProvider: { openai: [{ bucket: '2026-05-12T00:00:00.000Z', active: 3, started: 1 }] },
  activeHours: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
  activeHoursByDate: [{ date: '2026-05-12', hours: Array.from({ length: 24 }, () => 0) }],
  hasMessageData: true,
  hasTokenData: true,
  hasSessionData: false,
  providers: ['openai'],
}

const fleetMetrics: FleetMetrics = {
  range: '7d',
  meta: {
    instancesQueried: 3,
    instancesFailed: 0,
    hasMessageData: true,
    hasTokenData: true,
    hasSessionData: false,
    providers: ['openai', 'anthropic'],
  },
  messageVolume: [{ bucket: '2026-05-12T00:00:00.000Z', inbound: 42, outbound: 21, media: 7 }],
  tokenUsage: [{ bucket: '2026-05-12T00:00:00.000Z', input: 9000, output: 4500 }],
  sessionActivity: [{ bucket: '2026-05-12T00:00:00.000Z', active: 12, started: 4 }],
  tokenUsageByProvider: {},
  sessionActivityByProvider: {},
}

function makeLineQueryContext(
  options: ReturnType<typeof getMetricsQueryOptions>,
): Parameters<NonNullable<ReturnType<typeof getMetricsQueryOptions>['queryFn']>>[0] {
  type LineQueryContext = Parameters<NonNullable<ReturnType<typeof getMetricsQueryOptions>['queryFn']>>[0]

  return {
    queryKey: options.queryKey,
    signal: AbortSignal.timeout(5_000),
    meta: undefined,
    client: {} as LineQueryContext['client'],
  }
}

function makeFleetQueryContext(
  options: ReturnType<typeof getFleetMetricsQueryOptions>,
): Parameters<NonNullable<ReturnType<typeof getFleetMetricsQueryOptions>['queryFn']>>[0] {
  type FleetQueryContext = Parameters<NonNullable<ReturnType<typeof getFleetMetricsQueryOptions>['queryFn']>>[0]

  return {
    queryKey: options.queryKey,
    signal: AbortSignal.timeout(5_000),
    meta: undefined,
    client: {} as FleetQueryContext['client'],
  }
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('line metrics query options', () => {
  it('keys line metrics by line name and range', () => {
    expect(getMetricsQueryOptions('support', '24h').queryKey).toEqual(['metrics', 'support', '24h'])
    expect(getMetricsQueryOptions('sales', '24h').queryKey).toEqual(['metrics', 'sales', '24h'])
    expect(getMetricsQueryOptions('support', '7d').queryKey).toEqual(['metrics', 'support', '7d'])
  })

  it('only enables queries when a line name is present', () => {
    expect(getMetricsQueryOptions('support', '24h').enabled).toBe(true)
    expect(getMetricsQueryOptions('', '24h').enabled).toBe(false)
  })

  it('keeps the polling interval at one minute', () => {
    expect(getMetricsQueryOptions('support', '24h').refetchInterval).toBe(60_000)
  })

  it('loads the requested line metrics without transforming the API result', async () => {
    getMetricsMock.mockResolvedValueOnce(lineMetrics)

    const options = getMetricsQueryOptions('support', '7d')

    await expect(options.queryFn!(makeLineQueryContext(options))).resolves.toBe(lineMetrics)
    expect(getMetricsMock).toHaveBeenCalledWith('support', '7d')
  })
})

describe('fleet metrics query options', () => {
  it('keys fleet metrics by range', () => {
    expect(getFleetMetricsQueryOptions('24h').queryKey).toEqual(['fleet-metrics', '24h'])
    expect(getFleetMetricsQueryOptions('7d').queryKey).toEqual(['fleet-metrics', '7d'])
    expect(getFleetMetricsQueryOptions('30d').queryKey).toEqual(['fleet-metrics', '30d'])
  })

  it('does not add a line-name enabled gate', () => {
    expect(getFleetMetricsQueryOptions('24h').enabled).toBeUndefined()
  })

  it('keeps the polling interval at one minute', () => {
    expect(getFleetMetricsQueryOptions('24h').refetchInterval).toBe(60_000)
  })

  it('loads fleet metrics for the requested range without transforming the API result', async () => {
    getFleetMetricsMock.mockResolvedValueOnce(fleetMetrics)

    const options = getFleetMetricsQueryOptions('30d')

    await expect(options.queryFn!(makeFleetQueryContext(options))).resolves.toBe(fleetMetrics)
    expect(getFleetMetricsMock).toHaveBeenCalledWith('30d')
  })
})

describe('useMetrics', () => {
  it('does not fetch while the line name is empty, then fetches the selected line and range', async () => {
    getMetricsMock.mockResolvedValue(lineMetrics)

    const { rerender, result } = renderHook(
      ({ name, range }) => useMetrics(name, range),
      {
        initialProps: { name: '', range: '24h' as const },
        wrapper: createWrapper(),
      },
    )

    expect(result.current.fetchStatus).toBe('idle')
    expect(getMetricsMock).not.toHaveBeenCalled()

    rerender({ name: 'support', range: '24h' })

    await waitFor(() => expect(result.current.data).toBe(lineMetrics))
    expect(getMetricsMock).toHaveBeenCalledTimes(1)
    expect(getMetricsMock).toHaveBeenCalledWith('support', '24h')
  })

  it('refetches when the selected range changes', async () => {
    getMetricsMock.mockResolvedValue(lineMetrics)

    const { rerender, result } = renderHook(
      ({ range }) => useMetrics('support', range),
      {
        initialProps: { range: '24h' as MetricsRange },
        wrapper: createWrapper(),
      },
    )

    await waitFor(() => expect(result.current.data).toBe(lineMetrics))

    rerender({ range: '7d' })

    await waitFor(() => expect(getMetricsMock).toHaveBeenCalledWith('support', '7d'))
    expect(getMetricsMock).toHaveBeenCalledTimes(2)
  })
})

describe('useFleetMetrics', () => {
  it('fetches the 24h fleet metrics range by default', async () => {
    getFleetMetricsMock.mockResolvedValue(fleetMetrics)

    const { result } = renderHook(() => useFleetMetrics(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.data).toBe(fleetMetrics))
    expect(getFleetMetricsMock).toHaveBeenCalledWith('24h')
  })

  it('fetches the explicit fleet metrics range', async () => {
    getFleetMetricsMock.mockResolvedValue(fleetMetrics)

    const { result } = renderHook(() => useFleetMetrics('7d'), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.data).toBe(fleetMetrics))
    expect(getFleetMetricsMock).toHaveBeenCalledWith('7d')
  })
})

describe('useMetrics freshness (GUI-5)', () => {
  it('reports a fresh observation after a successful fetch', async () => {
    getMetricsMock.mockResolvedValue(lineMetrics)

    const { result } = renderHook(() => useMetrics('support', '24h'), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.data).toBe(lineMetrics))
    expect(result.current.freshness.stale).toBe(false)
    expect(result.current.freshness.observedAt).toBeGreaterThan(0)
  })

  it('flags carried data after a failed refetch, then clears on recovery', async () => {
    getMetricsMock.mockResolvedValueOnce(lineMetrics)

    const { result } = renderHook(() => useMetrics('support', '24h'), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.data).toBe(lineMetrics))
    expect(result.current.freshness.stale).toBe(false)

    getMetricsMock.mockRejectedValueOnce(new Error('boom'))
    await result.current.refetch()
    await waitFor(() => expect(result.current.isRefetchError).toBe(true))
    expect(result.current.data).toBe(lineMetrics) // payload stays visible
    expect(result.current.freshness.stale).toBe(true)

    getMetricsMock.mockResolvedValueOnce(lineMetrics)
    await result.current.refetch()
    await waitFor(() => expect(result.current.isRefetchError).toBe(false))
    expect(result.current.freshness.stale).toBe(false)
  })

  it('does not flag first load before any observation', () => {
    getMetricsMock.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() => useMetrics('support', '24h'), {
      wrapper: createWrapper(),
    })

    expect(result.current.freshness).toEqual({ observedAt: null, stale: false })
  })

  it('exposes freshness from useFleetMetrics as well', async () => {
    getFleetMetricsMock.mockResolvedValue(fleetMetrics)

    const { result } = renderHook(() => useFleetMetrics('7d'), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.data).toBe(fleetMetrics))
    expect(result.current.freshness.stale).toBe(false)
    expect(result.current.freshness.observedAt).toBeGreaterThan(0)
  })
})
