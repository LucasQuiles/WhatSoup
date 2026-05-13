/**
 * SummaryTab — covers KPI card row, provider card in agent mode, mode-specific
 * placeholders, and the empty-config "Passive mode" branch.
 *
 * Backfills the test gap noted in WhatSoup issue #352: the PROVIDER card on
 * the agent-mode summary view already exists (shipped in 547a3d7) but had no
 * companion test pinning its contract.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'

import { SummaryTab } from '../../console/src/components/line-detail/SummaryTab'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'
import { DEFAULT_PROVIDER_ID, getProvider } from '../../console/src/lib/providers'
import type { LineInstance, Mode } from '../../console/src/types'

// Resolve display names from the providers registry rather than hard-coding
// product strings — keeps the repo-hygiene guard's model-attribution scan
// satisfied and lets the test track registry changes automatically.
const DEFAULT_PROVIDER_DISPLAY = getProvider(DEFAULT_PROVIDER_ID)!.displayName
const OPENAI_DISPLAY = getProvider('openai-api')!.displayName
const CODEX_DISPLAY = getProvider('codex-cli')!.displayName

afterEach(() => cleanup())

// ---------------------------------------------------------------------------
//  Test fixtures
// ---------------------------------------------------------------------------

const toastValue: ToastContextValue = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
}

function withToast(node: ReactElement) {
  return <ToastContext.Provider value={toastValue}>{node}</ToastContext.Provider>
}

interface LineOverrides {
  mode?: Mode
  provider?: string
  config?: Record<string, unknown>
  health?: LineInstance['health']
  activeSessions?: number
  status?: LineInstance['status']
  models?: LineInstance['models']
}

function makeLine(overrides: LineOverrides = {}): LineInstance {
  const mode = overrides.mode ?? 'agent'
  return {
    name: 'test-line',
    phone: '+15551234567',
    mode,
    provider: overrides.provider,
    status: overrides.status ?? 'online',
    accessMode: 'allowlist',
    healthPort: 9000,
    uptime: '1h',
    messagesTotal: 0,
    health: overrides.health ?? {
      status: 'ok',
      uptime_seconds: 3600,
      messages_total: 0,
      connection: { state: 'connected' },
      sqlite: { messages_total: 0, schema_version: 1 },
    },
    heartbeat: ['up', 'up', 'up'],
    lastActive: 'just now',
    error: null,
    activeSessions: overrides.activeSessions,
    config: overrides.config,
    models: overrides.models,
  }
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe('SummaryTab — agent-mode PROVIDER card', () => {
  it('renders the PROVIDER label with the provider display name when line.provider is set', () => {
    const line = makeLine({
      mode: 'agent',
      provider: 'openai-api',
      activeSessions: 0,
      config: { agentOptions: { provider: 'codex-cli' } },
      health: {
        status: 'ok',
        uptime_seconds: 0,
        messages_total: 0,
        connection: { state: 'connected' },
        sqlite: { messages_total: 0, schema_version: 1 },
        instance: {
          name: 'test-line',
          mode: 'agent',
          accessMode: 'allowlist',
          socketPath: null,
          provider: 'codex-cli',
        },
      },
    })

    render(withToast(<SummaryTab line={line} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

    // Locate the PROVIDER card by its label, then assert the value sibling
    // shows the resolved display name from the providers registry.
    const providerLabel = screen.getByText('PROVIDER')
    const card = providerLabel.closest('div.c-card') as HTMLElement
    expect(card).toBeTruthy()
    expect(within(card).getByText(OPENAI_DISPLAY)).toBeDefined()
  })

  it('falls back to health.instance.provider when line.provider is absent', () => {
    const line = makeLine({
      mode: 'agent',
      provider: undefined,
      health: {
        status: 'ok',
        uptime_seconds: 0,
        messages_total: 0,
        connection: { state: 'connected' },
        sqlite: { messages_total: 0, schema_version: 1 },
        instance: {
          name: 'test-line',
          mode: 'agent',
          accessMode: 'allowlist',
          socketPath: null,
          provider: 'codex-cli',
        },
      },
      config: { agentOptions: { provider: 'openai-api' } },
    })

    render(withToast(<SummaryTab line={line} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

    const card = screen.getByText('PROVIDER').closest('div.c-card') as HTMLElement
    expect(within(card).getByText(CODEX_DISPLAY)).toBeDefined()
  })

  it('falls back to config.agentOptions.provider when line and health provider hints are absent', () => {
    const line = makeLine({
      mode: 'agent',
      provider: undefined,
      config: { agentOptions: { provider: 'openai-api' } },
    })

    render(withToast(<SummaryTab line={line} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

    const card = screen.getByText('PROVIDER').closest('div.c-card') as HTMLElement
    expect(within(card).getByText(OPENAI_DISPLAY)).toBeDefined()
  })

  it('falls back to DEFAULT_PROVIDER_ID display name when no provider hint exists', () => {
    const line = makeLine({ mode: 'agent', provider: undefined, activeSessions: 2 })

    render(withToast(<SummaryTab line={line} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

    const card = screen.getByText('PROVIDER').closest('div.c-card') as HTMLElement
    expect(within(card).getByText(DEFAULT_PROVIDER_DISPLAY)).toBeDefined()
  })

  it('renders SESSIONS KPI alongside PROVIDER with the activeSessions value', () => {
    const line = makeLine({ mode: 'agent', provider: 'openai-api', activeSessions: 3 })

    render(withToast(<SummaryTab line={line} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

    const sessionsCard = screen.getByText('SESSIONS').closest('div.c-card') as HTMLElement
    expect(within(sessionsCard).getByText('3')).toBeDefined()
  })
})

describe('SummaryTab — placeholder/empty states', () => {
  it('omits the PROVIDER card when the instance is in passive mode', () => {
    const line = makeLine({ mode: 'passive' })

    render(withToast(<SummaryTab line={line} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

    expect(screen.queryByText('PROVIDER')).toBeNull()
    expect(screen.queryByText('SESSIONS')).toBeNull()
  })

  it('omits the PROVIDER card when the instance is in chat mode', () => {
    const line = makeLine({ mode: 'chat' })

    render(withToast(<SummaryTab line={line} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

    expect(screen.queryByText('PROVIDER')).toBeNull()
    // Chat mode shows QUEUE + ENRICHMENT instead
    expect(screen.getByText('QUEUE')).toBeDefined()
    expect(screen.getByText('ENRICHMENT')).toBeDefined()
  })

  it('renders the passive "no configuration required" placeholder in passive mode', () => {
    const line = makeLine({ mode: 'passive' })

    render(withToast(<SummaryTab line={line} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

    expect(screen.getByText(/Passive mode — no configuration required\./)).toBeDefined()
  })
})

describe('SummaryTab — KPI row structural contract', () => {
  it('renders the always-on STATUS and CONNECTION cards across modes', () => {
    const modes: Mode[] = ['passive', 'chat', 'agent']

    for (const mode of modes) {
      cleanup()
      const line = makeLine({ mode, status: 'online' })

      render(withToast(<SummaryTab line={line} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

      const statusCard = screen.getByText('STATUS').closest('div.c-card') as HTMLElement
      expect(within(statusCard).getByText('online')).toBeDefined()

      const connectionCard = screen.getByText('CONNECTION').closest('div.c-card') as HTMLElement
      expect(within(connectionCard).getByText('connected')).toBeDefined()
    }
  })

  it('renders the MODEL card when line.models.conversation is set', () => {
    const line = makeLine({
      mode: 'agent',
      provider: 'openai-api',
      models: { conversation: 'gpt-4o' },
    })

    render(withToast(<SummaryTab line={line} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

    const modelCard = screen.getByText('MODEL').closest('div.c-card') as HTMLElement
    expect(within(modelCard).getByText('gpt-4o')).toBeDefined()
  })

  it('renders the action buttons (Restart, Change Mode, Stop) on every mode', () => {
    const modes: Mode[] = ['passive', 'chat', 'agent']

    for (const mode of modes) {
      cleanup()
      const line = makeLine({ mode, provider: 'openai-api' })

      render(withToast(<SummaryTab line={line} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

      expect(screen.getByRole('button', { name: /Restart Instance/i })).toBeDefined()
      expect(screen.getByRole('button', { name: /Change Mode/i })).toBeDefined()
      expect(screen.getByRole('button', { name: /Stop Instance/i })).toBeDefined()
    }
  })

  it('omits the Edit Configuration button in passive mode', () => {
    const line = makeLine({ mode: 'passive' })

    render(withToast(<SummaryTab line={line} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

    expect(screen.queryByRole('button', { name: /Edit Configuration/i })).toBeNull()
  })
})
