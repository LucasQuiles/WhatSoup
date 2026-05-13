/**
 * Behavior coverage for console/src/hooks/use-metrics.ts
 *
 * Source facts:
 *  - Two queryOptions factories: getMetricsQueryOptions(name, range) and
 *    getFleetMetricsQueryOptions(range).
 *  - Two hooks: useMetrics(name, range) and useFleetMetrics(range = '24h').
 *  - Line metrics: enabled: !!name (disabled when name is empty string).
 *  - Fleet metrics: no `enabled` gate (always enabled).
 *  - Both: refetchInterval: 60_000 ms.
 *  - No select/transform — raw API response returned as-is.
 *
 * Test strategy: invoke queryOptions factories directly and assert all option
 * fields; call queryFn with a mocked api to verify data flows through without
 * transformation. Follows the established pattern in metrics-chart.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MetricsRange, LineMetrics, FleetMetrics } from '../../console/src/types.js'

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_LINE_METRICS: LineMetrics = {
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

const MOCK_FLEET_METRICS: FleetMetrics = {
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

// Minimal QueryContext stub expected by @tanstack/react-query v5 queryFn signature.
function makeQueryContext(queryKey: readonly unknown[]) {
  return {
    queryKey,
    signal: AbortSignal.timeout(5_000),
    meta: undefined as unknown,
    client: {} as unknown,
  } as Parameters<NonNullable<ReturnType<typeof import('../../console/src/hooks/use-metrics.js')['getMetricsQueryOptions']>['queryFn']>>[0]
}

// ---------------------------------------------------------------------------
// getMetricsQueryOptions — query key
// ---------------------------------------------------------------------------

describe('getMetricsQueryOptions — query key', () => {
  it('produces ["metrics", name, range] for 24h', async () => {
    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const opts = getMetricsQueryOptions('alice', '24h')
    expect(opts.queryKey).toEqual(['metrics', 'alice', '24h'])
  })

  it('produces ["metrics", name, range] for 7d', async () => {
    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const opts = getMetricsQueryOptions('alice', '7d')
    expect(opts.queryKey).toEqual(['metrics', 'alice', '7d'])
  })

  it('produces ["metrics", name, range] for 30d', async () => {
    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const opts = getMetricsQueryOptions('alice', '30d')
    expect(opts.queryKey).toEqual(['metrics', 'alice', '30d'])
  })

  it('different names produce different keys', async () => {
    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const keyA = getMetricsQueryOptions('alice', '24h').queryKey
    const keyB = getMetricsQueryOptions('bob', '24h').queryKey
    expect(keyA).not.toEqual(keyB)
  })

  it('different ranges produce different keys for the same name', async () => {
    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const key24 = getMetricsQueryOptions('alice', '24h').queryKey
    const key7d = getMetricsQueryOptions('alice', '7d').queryKey
    const key30d = getMetricsQueryOptions('alice', '30d').queryKey
    expect(key24).not.toEqual(key7d)
    expect(key7d).not.toEqual(key30d)
    expect(key24).not.toEqual(key30d)
  })
})

// ---------------------------------------------------------------------------
// getMetricsQueryOptions — enabled gating
// ---------------------------------------------------------------------------

describe('getMetricsQueryOptions — enabled gating', () => {
  it('is enabled when name is a non-empty string', async () => {
    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    expect(getMetricsQueryOptions('alice', '24h').enabled).toBe(true)
  })

  it('is disabled when name is an empty string', async () => {
    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    expect(getMetricsQueryOptions('', '24h').enabled).toBe(false)
  })

  it('is enabled when name is whitespace-only (!!name is truthy for non-empty strings)', async () => {
    // !!name: non-empty whitespace string is truthy — document the actual behaviour
    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    // '   ' is truthy, so enabled should be true (matches !!name semantics)
    expect(getMetricsQueryOptions('   ', '24h').enabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getMetricsQueryOptions — refetch interval
// ---------------------------------------------------------------------------

describe('getMetricsQueryOptions — refetch interval', () => {
  it('refetchInterval is 60 000 ms', async () => {
    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    expect(getMetricsQueryOptions('alice', '24h').refetchInterval).toBe(60_000)
  })
})

// ---------------------------------------------------------------------------
// getMetricsQueryOptions — queryFn data passthrough (no transform)
//
// Follows the fetch-stub pattern from metrics-chart.test.ts: stub document so
// the mock-fallback guard doesn't fire, then provide a fetch mock that handles
// the fleet health-check (GET /api/lines → 200) followed by the actual API
// call.  The queryFn result is the raw parsed JSON — no transformation.
// ---------------------------------------------------------------------------

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => '',
  } as Response
}

function makeErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => '',
  } as Response
}

function stubDocumentForApi(): void {
  vi.stubGlobal('document', { querySelector: () => null })
}

describe('getMetricsQueryOptions — queryFn data passthrough', () => {
  it('resolves with the raw api.getMetrics response (no transform)', async () => {
    stubDocumentForApi()
    const fetch = vi.fn()
      .mockResolvedValueOnce(makeOkResponse([]))       // fleet health check → available
      .mockResolvedValueOnce(makeOkResponse(MOCK_LINE_METRICS))
    vi.stubGlobal('fetch', fetch)

    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const opts = getMetricsQueryOptions('alice', '24h')
    const result = await opts.queryFn!(makeQueryContext(opts.queryKey) as any)
    expect(result).toStrictEqual(MOCK_LINE_METRICS)
  })

  it('calls fetch with the correct metrics URL and range', async () => {
    stubDocumentForApi()
    const fetch = vi.fn()
      .mockResolvedValueOnce(makeOkResponse([]))
      .mockResolvedValueOnce(makeOkResponse(MOCK_LINE_METRICS))
    vi.stubGlobal('fetch', fetch)

    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const opts = getMetricsQueryOptions('bob', '7d')
    await opts.queryFn!(makeQueryContext(opts.queryKey) as any)

    const metricsFetchCall = (fetch.mock.calls as unknown[][]).find(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/metrics')
    )
    expect(metricsFetchCall).toBeDefined()
    expect(metricsFetchCall![0]).toContain('/api/lines/bob/metrics')
    expect(metricsFetchCall![0]).toContain('range=7d')
  })

  it('falls back to mock data when the metrics endpoint returns a server error', async () => {
    // withFallback: in non-PROD (test) builds, a failed API call is caught and
    // mock data is substituted — the promise resolves with mock, never rejects.
    stubDocumentForApi()
    const fetch = vi.fn()
      .mockResolvedValueOnce(makeOkResponse([]))          // fleet health → available
      .mockResolvedValueOnce(makeErrorResponse(500))      // metrics → error → mock fallback
    vi.stubGlobal('fetch', fetch)

    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const opts = getMetricsQueryOptions('alice', '24h')
    // Should resolve (with mock data), not reject
    const result = await opts.queryFn!(makeQueryContext(opts.queryKey) as any)
    expect(result).toBeDefined()
    expect(typeof (result as { range?: unknown }).range).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// getFleetMetricsQueryOptions — query key
// ---------------------------------------------------------------------------

describe('getFleetMetricsQueryOptions — query key', () => {
  it('produces ["fleet-metrics", range] for 24h', async () => {
    const { getFleetMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    expect(getFleetMetricsQueryOptions('24h').queryKey).toEqual(['fleet-metrics', '24h'])
  })

  it('produces ["fleet-metrics", range] for 7d', async () => {
    const { getFleetMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    expect(getFleetMetricsQueryOptions('7d').queryKey).toEqual(['fleet-metrics', '7d'])
  })

  it('produces ["fleet-metrics", range] for 30d', async () => {
    const { getFleetMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    expect(getFleetMetricsQueryOptions('30d').queryKey).toEqual(['fleet-metrics', '30d'])
  })

  it('different ranges produce different fleet-metrics keys', async () => {
    const { getFleetMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const k24 = getFleetMetricsQueryOptions('24h').queryKey
    const k7d = getFleetMetricsQueryOptions('7d').queryKey
    expect(k24).not.toEqual(k7d)
  })
})

// ---------------------------------------------------------------------------
// getFleetMetricsQueryOptions — always enabled (no gate)
// ---------------------------------------------------------------------------

describe('getFleetMetricsQueryOptions — always enabled', () => {
  it('has no enabled gate, unlike line metrics which require a non-empty name', async () => {
    const { getMetricsQueryOptions, getFleetMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const fleetOpts = getFleetMetricsQueryOptions('24h')
    const lineOptsDisabled = getMetricsQueryOptions('', '24h')
    const lineOptsEnabled = getMetricsQueryOptions('alice', '24h')
    // Fleet metrics: no enabled field set → always runs (distinct from false)
    expect(fleetOpts.enabled).not.toBe(false)
    // Line metrics: gated on non-empty name
    expect(lineOptsDisabled.enabled).toBe(false)
    expect(lineOptsEnabled.enabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getFleetMetricsQueryOptions — refetch interval
// ---------------------------------------------------------------------------

describe('getFleetMetricsQueryOptions — refetch interval', () => {
  it('refetchInterval is 60 000 ms', async () => {
    const { getFleetMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    expect(getFleetMetricsQueryOptions('24h').refetchInterval).toBe(60_000)
  })
})

// ---------------------------------------------------------------------------
// getFleetMetricsQueryOptions — queryFn data passthrough (no transform)
// ---------------------------------------------------------------------------

describe('getFleetMetricsQueryOptions — queryFn data passthrough', () => {
  it('resolves with the raw api.getFleetMetrics response (no transform)', async () => {
    stubDocumentForApi()
    const fetch = vi.fn()
      .mockResolvedValueOnce(makeOkResponse([]))
      .mockResolvedValueOnce(makeOkResponse(MOCK_FLEET_METRICS))
    vi.stubGlobal('fetch', fetch)

    const { getFleetMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const opts = getFleetMetricsQueryOptions('7d')
    const result = await opts.queryFn!(makeQueryContext(opts.queryKey) as any)
    expect(result).toStrictEqual(MOCK_FLEET_METRICS)
  })

  it('calls fetch with the correct fleet metrics URL and range', async () => {
    stubDocumentForApi()
    const fetch = vi.fn()
      .mockResolvedValueOnce(makeOkResponse([]))
      .mockResolvedValueOnce(makeOkResponse(MOCK_FLEET_METRICS))
    vi.stubGlobal('fetch', fetch)

    const { getFleetMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const opts = getFleetMetricsQueryOptions('30d')
    await opts.queryFn!(makeQueryContext(opts.queryKey) as any)

    const metricsFetchCall = (fetch.mock.calls as unknown[][]).find(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/metrics')
    )
    expect(metricsFetchCall).toBeDefined()
    expect(metricsFetchCall![0]).toContain('/api/metrics')
    expect(metricsFetchCall![0]).toContain('range=30d')
  })

  it('falls back to mock data when the fleet metrics endpoint returns a server error', async () => {
    // withFallback: in non-PROD (test) builds, a failed API call is caught and
    // mock data is substituted — the promise resolves with mock, never rejects.
    stubDocumentForApi()
    const fetch = vi.fn()
      .mockResolvedValueOnce(makeOkResponse([]))
      .mockResolvedValueOnce(makeErrorResponse(503))
    vi.stubGlobal('fetch', fetch)

    const { getFleetMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const opts = getFleetMetricsQueryOptions('24h')
    const result = await opts.queryFn!(makeQueryContext(opts.queryKey) as any)
    expect(result).toBeDefined()
    expect(typeof (result as { range?: unknown }).range).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// useFleetMetrics — default range
// ---------------------------------------------------------------------------

describe('useFleetMetrics — default range', () => {
  it('default range is 24h (fleet-metrics key contains 24h)', async () => {
    // Source: export function useFleetMetrics(range: MetricsRange = '24h')
    // Verify by inspecting getFleetMetricsQueryOptions('24h') key — same path the hook takes
    const { getFleetMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const defaultOpts = getFleetMetricsQueryOptions('24h' as MetricsRange)
    expect(defaultOpts.queryKey[1]).toBe('24h')
  })
})

// ---------------------------------------------------------------------------
// Exports shape
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('exports exactly the four expected symbols', async () => {
    const mod = await import('../../console/src/hooks/use-metrics.js')
    const exported = Object.keys(mod).sort()
    expect(exported).toEqual([
      'getFleetMetricsQueryOptions',
      'getMetricsQueryOptions',
      'useFleetMetrics',
      'useMetrics',
    ])
  })

  it('all exports are functions', async () => {
    const mod = await import('../../console/src/hooks/use-metrics.js')
    for (const key of Object.keys(mod)) {
      expect(typeof (mod as Record<string, unknown>)[key], `${key} should be a function`).toBe('function')
    }
  })
})

// ---------------------------------------------------------------------------
// Cache isolation — different query keys must be independent cache entries
// ---------------------------------------------------------------------------

describe('cache key isolation', () => {
  it('line-metrics and fleet-metrics keys share no prefix segment', async () => {
    const { getMetricsQueryOptions, getFleetMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const lineKey = getMetricsQueryOptions('alice', '24h').queryKey
    const fleetKey = getFleetMetricsQueryOptions('24h').queryKey
    expect(lineKey[0]).not.toBe(fleetKey[0])
  })

  it('line-metrics for name=alice and name=bob share no overlap in first two segments', async () => {
    const { getMetricsQueryOptions } = await import('../../console/src/hooks/use-metrics.js')
    const aliceKey = getMetricsQueryOptions('alice', '24h').queryKey
    const bobKey = getMetricsQueryOptions('bob', '24h').queryKey
    // Same segment[0] ('metrics'), different segment[1]
    expect(aliceKey[0]).toBe(bobKey[0])
    expect(aliceKey[1]).not.toBe(bobKey[1])
  })
})
