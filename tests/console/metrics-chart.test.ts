import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function elementName(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined
  const type = (node as { type?: { displayName?: string; name?: string } }).type
  return type?.displayName ?? type?.name
}

function toChildren(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return []
  const children = (node as { props?: { children?: unknown } }).props?.children
  if (children === undefined || children === null) return []
  return Array.isArray(children) ? children : [children]
}

describe('metrics query options', () => {
  it('fetches line metrics for the requested range', async () => {
    vi.stubGlobal('document', {
      querySelector: () => null,
    })

    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        range: '24h',
        messageVolume: [{ bucket: '2026-04-05T18:00:00.000Z', inbound: 4, outbound: 2 }],
        activeHours: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
      }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetch)

    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.ts')

    const options = getMetricsQueryOptions('loops', '24h')
    expect(options.queryKey).toEqual(['metrics', 'loops', '24h'])

    await expect(options.queryFn!({ queryKey: options.queryKey, signal: AbortSignal.timeout(5000), meta: undefined, client: {} as any })).resolves.toEqual({
      range: '24h',
      messageVolume: [{ bucket: '2026-04-05T18:00:00.000Z', inbound: 4, outbound: 2 }],
      activeHours: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
    })

    expect(fetch).toHaveBeenCalledWith(
      '/api/lines/loops/metrics?range=24h',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    )
  })

  it('fetches fleet metrics for the requested range', async () => {
    vi.stubGlobal('document', {
      querySelector: () => null,
    })

    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        range: '7d',
        messageVolume: [{ bucket: '2026-04-05T18:00:00.000Z', inbound: 9, outbound: 7 }],
      }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetch)

    const { getFleetMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.ts')

    const options = getFleetMetricsQueryOptions('7d')
    expect(options.queryKey).toEqual(['fleet-metrics', '7d'])

    await expect(options.queryFn!({ queryKey: options.queryKey, signal: AbortSignal.timeout(5000), meta: undefined, client: {} as any })).resolves.toEqual({
      range: '7d',
      messageVolume: [{ bucket: '2026-04-05T18:00:00.000Z', inbound: 9, outbound: 7 }],
    })

    expect(fetch).toHaveBeenCalledWith(
      '/api/metrics?range=7d',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    )
  })
})

describe('MetricsChart', () => {
  it('renders a stacked inbound/outbound bar chart with design tokens', async () => {
    const { MetricsChart } = await import('../../console/src/components/MetricsChart.tsx')

    const element = MetricsChart({
      data: [
        { bucket: '2026-04-05T17:00:00.000Z', inbound: 3, outbound: 1 },
        { bucket: '2026-04-05T18:00:00.000Z', inbound: 5, outbound: 4 },
      ],
    }) as { props: { className?: string; children?: unknown } }

    expect(element.props.className).toContain('c-card')

    const rootChildren = toChildren(element)
    const responsive = rootChildren[1] as { props?: { width?: string; height?: number; children?: unknown } } | undefined
    expect(responsive?.props?.width).toBe('100%')
    expect(responsive?.props?.height).toBe(180)

    const barChart = toChildren(responsive)[0]
    const chartChildren = toChildren(barChart)
    const xAxis = chartChildren.find((child) => elementName(child) === 'XAxis') as { props: { tick?: unknown } } | undefined
    const yAxis = chartChildren.find((child) => elementName(child) === 'YAxis') as { props: { tick?: unknown } } | undefined
    const bars = chartChildren.filter((child) => elementName(child) === 'Bar') as Array<{ props: { dataKey?: string; fill?: string; stackId?: string } }>

    expect(xAxis?.props.tick).toMatchObject({
      fontSize: 'var(--font-size-xs)',
    })
    expect(yAxis?.props.tick).toMatchObject({
      fontSize: 'var(--font-size-xs)',
    })

    expect(bars.map((bar) => ({
      dataKey: bar.props.dataKey,
      fill: bar.props.fill,
      stackId: bar.props.stackId,
    }))).toEqual([
      { dataKey: 'inbound', fill: 'var(--color-m-pas)', stackId: 'messages' },
      { dataKey: 'outbound', fill: 'var(--color-m-cht)', stackId: 'messages' },
    ])
  })
})
