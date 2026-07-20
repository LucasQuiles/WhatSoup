/**
 * Contract test for WhatSoup #1763.
 *
 * The CONNECTION card (console/src/components/line-detail/SummaryTab.tsx)
 * read `line.health.connection.state` — a top-level shape no emitter has ever
 * produced — while the ONE /health emitter (src/core/health.ts) nests
 * connection state under `whatsapp.connection.state`. The card rendered
 * "unknown" for every line, always.
 *
 * This test runs the REAL emitter (a live http server built from
 * startHealthServer, mirroring the harness in tests/core/health.test.ts — if
 * that harness changes, this one should move with it) to source the health
 * body, feeds it through the REAL fleet accessor (enrichInstance, the single
 * seam lines.ts uses to build every console-facing LineInstance), then
 * renders the REAL SummaryTab against that output. No hand-typed literal
 * stands in for backend truth anywhere in this chain — a future emitter
 * refactor that reintroduces the shape mismatch fails this test, not just a
 * fixture that happens to encode today's (correct) assumption.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { request } from 'node:http'
import type { ReactElement } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../src/config.ts', () => ({
  config: {
    adminPhones: new Set<string>(),
    dbPath: ':memory:',
    mediaDir: '/tmp',
    botName: 'WhatSoup',
    accessMode: 'allowlist',
    healthPort: 9999,
    models: {
      conversation: 'claude-opus-4-5',
      extraction: 'claude-haiku-4-5',
      validation: 'claude-haiku-4-5',
      fallback: 'claude-sonnet-4-5',
    },
  },
}))
vi.mock('../../src/logger.ts', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('../../console/src/hooks/use-websocket', () => ({
  useRealtime: () => ({ connected: false }),
}))
vi.mock('../../console/src/lib/api', () => ({
  api: {
    restart: vi.fn(),
    stopInstance: vi.fn(),
    getProviders: vi.fn().mockResolvedValue([]),
    getProviderStatus: vi.fn().mockResolvedValue({
      primary: { provider: null, model: null, keyPresent: null },
      fallback: { provider: null, model: null, keyPresent: null, active: false, activeUntil: null },
    }),
  },
}))

import { Database } from '../../src/core/database.ts'
import type { HealthDeps } from '../../src/core/health.ts'
import type { ConnectionManager } from '../../src/transport/connection.ts'
import { enrichInstance } from '../../src/fleet/routes/lines.ts'
import type { DiscoveredInstance } from '../../src/fleet/discovery.ts'
import type { InstanceStatus } from '../../src/fleet/health-poller.ts'
import { SummaryTab } from '../../console/src/components/line-detail/SummaryTab'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'
import type { LineInstance } from '../../console/src/types'

afterEach(() => cleanup())

// ---------------------------------------------------------------------------
//  Real /health body — no hand-typed literal. Mirrors makeDeps/buildTestServer
//  in tests/core/health.test.ts.
// ---------------------------------------------------------------------------

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function fetchRealHealthBody(): Promise<Record<string, unknown>> {
  delete process.env.WHATSOUP_HEALTH_TOKEN
  const { startHealthServer } = await import('../../src/core/health.ts')

  const db = new Database(':memory:')
  db.open()
  const deps: HealthDeps = {
    db,
    connectionManager: {
      botJid: '15551230004@s.whatsapp.net',
      botLid: null,
      sendMessage: vi.fn().mockResolvedValue({ waMessageId: null }),
      sendMedia: vi.fn().mockResolvedValue({ waMessageId: null }),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConnectionManager,
    startedAt: Date.now() - 1000,
    getEnrichmentStats: vi.fn().mockReturnValue({ lastRun: null, unprocessed: 0 }),
    instanceName: 'contract-line',
    instanceType: 'chat',
    accessMode: 'allowlist',
  }

  const server = createServer()
  const started = startHealthServer(deps)

  const port = await new Promise<number>((resolve) => {
    started.close(() => {
      started.listen(0, '127.0.0.1', () => {
        const addr = started.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })
  })
  server.close()

  try {
    const res = await httpGet(port, '/health')
    expect(res.status).toBe(200)
    return JSON.parse(res.body) as Record<string, unknown>
  } finally {
    await new Promise<void>((resolve) => started.close(() => resolve()))
    db.close()
  }
}

// ---------------------------------------------------------------------------
//  SummaryTab render harness (mirrors tests/console/summary-tab.test.tsx)
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <ToastContext.Provider value={toastValue}>{node}</ToastContext.Provider>
    </QueryClientProvider>
  )
}

function fakeInstance(overrides: Partial<DiscoveredInstance> = {}): DiscoveredInstance {
  return {
    name: 'contract-line',
    type: 'chat',
    accessMode: 'allowlist',
    healthPort: 9100,
    dbPath: '/data/contract-line/bot.db',
    stateRoot: '/state/contract-line',
    logDir: '/data/contract-line/logs',
    healthToken: null,
    configPath: '/config/contract-line/config.json',
    socketPath: null,
    ...overrides,
  }
}

function fakePoll(health: Record<string, unknown>, overrides: Partial<InstanceStatus> = {}): InstanceStatus {
  return {
    name: 'contract-line',
    health,
    lastPollAt: new Date().toISOString(),
    consecutiveFailures: 0,
    everReachable: true,
    status: 'online',
    statusConfidence: 'confirmed',
    statusReason: 'health_body_ok',
    statusEvidence: ['health_status=healthy'],
    error: null,
    lastAlertAt: null,
    silencedUntil: null,
    activeAlertSources: [],
    ...overrides,
  }
}

describe('CONNECTION card — real emitter → enrichInstance → SummaryTab contract', () => {
  it('renders the real connected state, not "unknown", end to end', async () => {
    const rawHealth = await fetchRealHealthBody()

    // Pin the actual emission shape before trusting it further: the emitter
    // nests connection state under whatsapp.connection, never top-level.
    expect((rawHealth as { whatsapp?: { connection?: { state?: string } } }).whatsapp?.connection?.state).toBe('connected')
    expect((rawHealth as { connection?: unknown }).connection).toBeUndefined()

    const enriched = enrichInstance(fakeInstance(), fakePoll(rawHealth)) as unknown as LineInstance

    render(withToast(<SummaryTab line={enriched} onEditConfig={vi.fn()} onChangeMode={vi.fn()} />))

    const connectionCard = screen.getByText('CONNECTION').closest('div.soup-card') as HTMLElement
    expect(within(connectionCard).getByText('connected')).toBeDefined()
    expect(within(connectionCard).queryByText('unknown')).toBeNull()
  })
})
