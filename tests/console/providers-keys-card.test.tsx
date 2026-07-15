/**
 * ProvidersKeysCard — read-only "Providers & Keys" summary view that consumes
 * GET /api/lines/:name/provider-status and GET /api/providers.
 *
 * Covers: primary/fallback rows, the keyed / unkeyed / native-auth badge
 * tri-state from `keyPresent`, the active-fallback "reverts" indicator, the
 * inactive "fallback configured" state, and the "no fallback" state. Display
 * names are sourced from the /api/providers catalog (falling back to the
 * console providers.ts registry).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { ProviderCatalogEntry, ProviderStatus } from '../../console/src/types'

// Avoid the WebSocket realtime hook reaching into browser globals — pin it to a
// disconnected state so polling intervals are deterministic and inert.
vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: false }),
}))

vi.mock('../../console/src/lib/api', () => ({
  api: {
    getProviders: vi.fn(),
    getProviderStatus: vi.fn(),
  },
}))

import { ProvidersKeysCard } from '../../console/src/components/line-detail/ProvidersKeysCard'
import { api } from '../../console/src/lib/api'

const getProvidersMock = api.getProviders as unknown as ReturnType<typeof vi.fn>
const getProviderStatusMock = api.getProviderStatus as unknown as ReturnType<typeof vi.fn>

const CATALOG: ProviderCatalogEntry[] = [
  { id: 'claude-cli', displayName: 'Claude CLI', type: 'cli', needsApiKey: false, providerConfig: [] },
  { id: 'openai-api', displayName: 'OpenAI', type: 'api', needsApiKey: true, providerConfig: ['model', 'baseUrl', 'apiKeyService'] },
  { id: 'anthropic-api', displayName: 'Anthropic', type: 'api', needsApiKey: true, providerConfig: ['model', 'baseUrl', 'apiKeyService'] },
]

function fallbackStatus(
  overrides: Partial<ProviderStatus['fallback']> = {},
): ProviderStatus['fallback'] {
  return {
    provider: null,
    model: null,
    keyPresent: null,
    active: false,
    activeUntil: null,
    effectiveProvider: null,
    turnsServed: null,
    turnsEmpty: null,
    probeAttempts: null,
    lastFallbackTurnAt: null,
    activeEntry: null,
    chain: [],
    ...overrides,
  }
}

function withProviders(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

function withSeededProviderStatus(lineName: string, status: ProviderStatus) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })
  client.setQueryData(['providers'], CATALOG)
  client.setQueryData(['provider-status', lineName], status)
  return (
    <QueryClientProvider client={client}>
      <ProvidersKeysCard lineName={lineName} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  getProvidersMock.mockReset()
  getProviderStatusMock.mockReset()
  getProvidersMock.mockResolvedValue(CATALOG)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ProvidersKeysCard — render + key tri-state', () => {
  it('renders the primary provider display name, model, and a "key set" badge when keyPresent is true', async () => {
    const status: ProviderStatus = {
      primary: { provider: 'openai-api', model: 'gpt-4o', keyPresent: true },
      fallback: fallbackStatus(),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(<ProvidersKeysCard lineName="line-a" />))

    // Catalog display name (OpenAI) is resolved from /api/providers, not the raw id.
    expect(await screen.findByText('OpenAI')).toBeDefined()
    expect(screen.getByText('gpt-4o')).toBeDefined()
    expect(screen.getByText('key set')).toBeDefined()
  })

  it('renders a "no key" badge when keyPresent is false', async () => {
    const status: ProviderStatus = {
      primary: { provider: 'openai-api', model: 'gpt-4o', keyPresent: false },
      fallback: fallbackStatus(),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(<ProvidersKeysCard lineName="line-b" />))

    expect(await screen.findByText('no key')).toBeDefined()
  })

  it('renders a native-auth badge when keyPresent is null', async () => {
    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus(),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(<ProvidersKeysCard lineName="line-c" />))

    // Native-auth providers (primary here, plus the empty fallback slot) render
    // the "n/a — native auth" badge — assert at least one is present.
    const badges = await screen.findAllByText('n/a — native auth')
    expect(badges.length).toBeGreaterThanOrEqual(1)
    // The primary provider resolves to its catalog display name.
    expect(screen.getByText('Claude CLI')).toBeDefined()
  })
})

describe('ProvidersKeysCard — fallback states', () => {
  it('shows the active-fallback "reverts" indicator with a countdown when active is true', async () => {
    const activeUntil = Date.now() + 90_000 // 90s out → "in 1m"
    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus({
        provider: 'openai-api',
        model: 'gpt-4o',
        keyPresent: true,
        active: true,
        activeUntil,
        effectiveProvider: 'openai-api',
      }),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(<ProvidersKeysCard lineName="line-d" />))

    const indicator = await screen.findByText(/Fallback active — reverts in 1m/)
    expect(indicator.textContent).toContain('reverts in 1m')
    // The fallback row still renders its keyed badge.
    expect(screen.getByText('key set')).toBeDefined()
  })

  it('renders fallback counters and the last fallback turn timestamp when present', async () => {
    const now = Date.now()

    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus({
        provider: 'openai-api',
        model: 'gpt-4o',
        keyPresent: true,
        turnsServed: 3,
        turnsEmpty: 1,
        lastFallbackTurnAt: now - 120_000,
      }),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(<ProvidersKeysCard lineName="line-h" />))

    expect(await screen.findByText('fallback configured')).toBeDefined()
    expect(screen.getByText('3 served')).toBeDefined()
    expect(screen.getByText('1 empty')).toBeDefined()
    expect(screen.getByText('last turn 2m ago')).toBeDefined()
  })

  it('renders ordered chain eligibility when multiple fallback entries are present', async () => {
    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus({
        provider: 'opencode-cli',
        model: 'minimax/MiniMax-M2',
        keyPresent: false,
        active: true,
        activeUntil: Date.now() + 90_000,
        effectiveProvider: 'openai-api',
        activeEntry: { provider: 'openai-api', model: 'gpt-4o-mini' },
        chain: [
          { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: false },
          { provider: 'openai-api', model: 'gpt-4o-mini', eligible: true },
        ],
      }),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(<ProvidersKeysCard lineName="line-chain" />))

    expect(await screen.findByText('chain')).toBeDefined()
    expect(screen.getAllByText('OpenCode').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('minimax/MiniMax-M2').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('unavailable')).toBeDefined()
    expect(screen.getByText('OpenAI')).toBeDefined()
    expect(screen.getByText('gpt-4o-mini')).toBeDefined()
    expect(screen.getByText('ready')).toBeDefined()
  })

  it('suppresses fallback counters when older payloads omit the metric fields', async () => {
    const {
      turnsServed: _turnsServed,
      turnsEmpty: _turnsEmpty,
      ...fallbackWithoutMetrics
    } = fallbackStatus({
      provider: 'openai-api',
      model: 'gpt-4o',
      keyPresent: true,
    })

    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackWithoutMetrics as ProviderStatus['fallback'],
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(<ProvidersKeysCard lineName="line-m" />))

    expect(await screen.findByText('fallback configured')).toBeDefined()
    expect(screen.queryByText(/undefined served/)).toBeNull()
    expect(screen.queryByText(/undefined empty/)).toBeNull()
  })

  it('updates the active fallback countdown on the 30s timer when the line is reachable', async () => {
    const now = new Date('2026-06-12T12:00:00Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)

    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus({
        provider: 'openai-api',
        model: 'gpt-4o',
        keyPresent: true,
        active: true,
        activeUntil: now.getTime() + 89_000,
        effectiveProvider: 'openai-api',
      }),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withSeededProviderStatus('line-i', status))

    const initialIndicator = screen.getByText(/Fallback active/)
    expect(initialIndicator.textContent).toContain('reverts in 1m')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000)
    })
    expect(screen.getByText(/Fallback active/).textContent).toContain('reverts in 1m')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(screen.getByText(/Fallback active/).textContent).toContain('reverts in 59s')
  })

  it('stops showing the active fallback banner when the local window expires before the next poll', async () => {
    const now = new Date('2026-06-12T12:00:00Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)

    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus({
        provider: 'openai-api',
        model: 'gpt-4o',
        keyPresent: true,
        active: true,
        activeUntil: now.getTime() + 45_000,
        effectiveProvider: 'openai-api',
      }),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withSeededProviderStatus('line-l', status))

    expect(screen.getByText(/Fallback active/).textContent).toContain('reverts in 45s')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000)
    })
    expect(screen.queryByText(/Fallback active/)).toBeNull()
    expect(screen.getByText('fallback configured')).toBeDefined()
  })

  it('refreshes the countdown immediately when provider-status data changes', async () => {
    const now = new Date('2026-06-12T12:00:00Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } })
    client.setQueryData(['providers'], CATALOG)
    client.setQueryData(['provider-status', 'line-k'], {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus({
        provider: 'openai-api',
        model: 'gpt-4o',
        keyPresent: true,
        active: true,
        activeUntil: now.getTime() + 90_000,
        effectiveProvider: 'openai-api',
      }),
      lineReachable: true,
    } satisfies ProviderStatus)

    render(
      <QueryClientProvider client={client}>
        <ProvidersKeysCard lineName="line-k" />
      </QueryClientProvider>,
    )
    expect(screen.getByText(/Fallback active/).textContent).toContain('reverts in 1m')

    vi.setSystemTime(now.getTime() + 60_000)
    act(() => {
      client.setQueryData(['provider-status', 'line-k'], {
        primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
        fallback: fallbackStatus({
          provider: 'openai-api',
          model: 'gpt-4o',
          keyPresent: true,
          active: true,
          activeUntil: now.getTime() + 150_000,
          effectiveProvider: 'openai-api',
        }),
        lineReachable: true,
      } satisfies ProviderStatus)
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText(/Fallback active/).textContent).toContain('reverts in 1m')
  })

  it('does not show the active countdown while the line health endpoint is unreachable', async () => {
    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus({
        provider: 'openai-api',
        model: 'gpt-4o',
        keyPresent: true,
        active: true,
        activeUntil: Date.now() + 90_000,
        effectiveProvider: 'openai-api',
      }),
      lineReachable: false,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(<ProvidersKeysCard lineName="line-j" />))

    expect(await screen.findByText('fallback configured')).toBeDefined()
    expect(screen.queryByText(/Fallback active/)).toBeNull()
  })

  it('shows a muted "fallback configured" state when a fallback exists but is inactive', async () => {
    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus({
        provider: 'anthropic-api',
        model: 'claude-sonnet-4-6',
        keyPresent: false,
      }),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(<ProvidersKeysCard lineName="line-e" />))

    expect(await screen.findByText('fallback configured')).toBeDefined()
    expect(screen.queryByText(/Fallback active/)).toBeNull()
  })

  it('shows "no fallback" when no fallback provider is configured', async () => {
    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus({ turnsServed: 0, turnsEmpty: 0 }),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(<ProvidersKeysCard lineName="line-f" />))

    expect(await screen.findByText('no fallback')).toBeDefined()
    expect(screen.queryByText('fallback configured')).toBeNull()
    expect(screen.queryByText('0 served')).toBeNull()
    expect(screen.queryByText('0 empty')).toBeNull()
  })
})

describe('ProvidersKeysCard — load + error states', () => {
  it('renders a retryable error state when provider-status fetch rejects', async () => {
    getProviderStatusMock.mockRejectedValue(new Error('provider API down'))

    render(withProviders(<ProvidersKeysCard lineName="line-g" />))

    await waitFor(() => {
      expect(screen.getByText('Failed to load provider status')).toBeDefined()
    })
    expect(screen.getByText('provider API down')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => {
      expect(getProviderStatusMock).toHaveBeenCalledTimes(2)
    })
  })
})

describe('ProvidersKeysCard — health freshness (#1762 remediation 2)', () => {
  // The card consumes the instance `stale` flag (enrichInstance, src/fleet/routes/
  // lines.ts) threaded down from SummaryTab. When stale, the fallback counters and
  // the chain eligibility are carried forward from an older successful poll — so
  // they must be TAGGED stale, never hidden (rem-1: link/history stays visible).

  it('tags the fallback counters stale while STILL rendering the carried-forward values', async () => {
    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus({
        provider: 'openai-api',
        model: 'gpt-4o',
        keyPresent: true,
        turnsServed: 3,
        turnsEmpty: 1,
      }),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(
      <ProvidersKeysCard lineName="line-stale-metrics" stale healthObservedAt="2026-06-12T11:58:00.000Z" />,
    ))

    // Carried-forward values remain visible — never hard-hidden.
    expect(await screen.findByText('3 served')).toBeDefined()
    expect(screen.getByText('1 empty')).toBeDefined()
    // Stale affordance present so the counters are not misread as live.
    expect(screen.getAllByText('stale').length).toBeGreaterThanOrEqual(1)
  })

  it('tags the fallback chain stale while STILL rendering ready/unavailable eligibility', async () => {
    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus({
        provider: 'opencode-cli',
        model: 'minimax/MiniMax-M2',
        keyPresent: false,
        chain: [
          { provider: 'opencode-cli', model: 'minimax/MiniMax-M2', eligible: false },
          { provider: 'openai-api', model: 'gpt-4o-mini', eligible: true },
        ],
      }),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(
      <ProvidersKeysCard lineName="line-stale-chain" stale healthObservedAt="2026-06-12T11:58:00.000Z" />,
    ))

    expect(await screen.findByText('chain')).toBeDefined()
    // Eligibility still rendered — carried-forward, not hidden.
    expect(screen.getByText('unavailable')).toBeDefined()
    expect(screen.getByText('ready')).toBeDefined()
    // Stale affordance on the chain block.
    expect(screen.getAllByText('stale').length).toBeGreaterThanOrEqual(1)
  })

  it('renders the stale tag (without an "as of" timestamp) when stale but never successfully polled', async () => {
    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus({
        provider: 'openai-api',
        model: 'gpt-4o',
        keyPresent: true,
        turnsServed: 3,
        turnsEmpty: 1,
      }),
      lineReachable: false,
    }
    getProviderStatusMock.mockResolvedValue(status)

    // healthObservedAt null = the line has never had a successful poll yet.
    render(withProviders(
      <ProvidersKeysCard lineName="line-stale-nohealth" stale healthObservedAt={null} />,
    ))

    expect(await screen.findByText('3 served')).toBeDefined()
    expect(screen.getAllByText('stale').length).toBeGreaterThanOrEqual(1)
    // No observation timestamp → no "as of …" affordance.
    expect(screen.queryByText(/as of/)).toBeNull()
  })

  it('renders NO stale affordance when the instance is fresh', async () => {
    const status: ProviderStatus = {
      primary: { provider: 'claude-cli', model: 'claude-opus-4-6', keyPresent: null },
      fallback: fallbackStatus({
        provider: 'openai-api',
        model: 'gpt-4o',
        keyPresent: true,
        turnsServed: 3,
        turnsEmpty: 1,
        chain: [
          { provider: 'openai-api', model: 'gpt-4o', eligible: true },
          { provider: 'anthropic-api', model: 'claude-sonnet-4-6', eligible: false },
        ],
      }),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(<ProvidersKeysCard lineName="line-fresh" stale={false} />))

    expect(await screen.findByText('3 served')).toBeDefined()
    expect(screen.getByText('chain')).toBeDefined()
    expect(screen.queryByText('stale')).toBeNull()
  })
})
