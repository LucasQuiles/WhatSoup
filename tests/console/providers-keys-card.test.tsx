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
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
    lastFallbackTurnAt: null,
    ...overrides,
  }
}

function withProviders(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>
}

beforeEach(() => {
  getProvidersMock.mockReset()
  getProviderStatusMock.mockReset()
  getProvidersMock.mockResolvedValue(CATALOG)
})

afterEach(() => cleanup())

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
      fallback: fallbackStatus(),
      lineReachable: true,
    }
    getProviderStatusMock.mockResolvedValue(status)

    render(withProviders(<ProvidersKeysCard lineName="line-f" />))

    expect(await screen.findByText('no fallback')).toBeDefined()
    expect(screen.queryByText('fallback configured')).toBeNull()
  })
})

describe('ProvidersKeysCard — load + error states', () => {
  it('renders an error state when provider-status fetch rejects', async () => {
    getProviderStatusMock.mockRejectedValue(new Error('boom'))

    render(withProviders(<ProvidersKeysCard lineName="line-g" />))

    await waitFor(() => {
      expect(screen.getByText('Failed to load provider status.')).toBeDefined()
    })
  })
})
