/**
 * Deployments page — v3.5 surface contract harness (T5 b-08;
 * mockup deployments.html SSOT).
 *
 * Honesty under test: the admin lane has zero multi-host runtime basis, so
 * the surface must render exactly ONE real deployment derived from the
 * lines payload; org-hub and pairing anatomies must be visibly designed-
 * states (disabled + disclosed), never functional-looking.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { LineInstance } from '../../console/src/types'

let mockLines: LineInstance[] = []
vi.mock('../../console/src/hooks/use-fleet', () => ({
  useLines: () => ({ data: mockLines }),
}))

vi.mock('../../console/src/lib/api', () => ({
  api: {
    getVersion: vi.fn().mockResolvedValue({
      sha: 'abc1234def',
      remoteSha: 'abc1234def',
      updateAvailable: false,
      checkedAt: '',
    }),
    getLivez: vi.fn().mockResolvedValue({
      alive: true,
      instance: 'whatsoup',
      pid: 1234,
      uptime_seconds: 1_814_400, // 21d
      started_at: '',
    }),
  },
}))

import Deployments from '../../console/src/pages/Deployments'
import { api } from '../../console/src/lib/api'

const getVersionMock = api.getVersion as unknown as ReturnType<typeof vi.fn>

function makeLine(name: string, overrides: Record<string, unknown> = {}): LineInstance {
  return {
    name,
    phone: '+10000000000',
    mode: 'chat',
    status: 'online',
    accessMode: 'allowlist',
    healthPort: 4000,
    uptime: '1d',
    messagesTotal: 0,
    health: {
      status: 'ok',
      uptime_seconds: 60,
      messages_total: 0,
      whatsapp: { connected: true, connection: { state: 'connected' } },
      transport: { kind: 'baileys', connected: true },
      sqlite: { messages_total: 0, schema_version: 1 },
    },
    heartbeat: [],
    lastActive: '',
    error: null,
    ...overrides,
  } as LineInstance
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Deployments />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockLines = [
    makeLine('personal', { mode: 'agent', activeSessions: 1 }),
    makeLine('support'),
    makeLine('field', { health: { transport: { kind: 'signal', connected: true }, sqlite: { messages_total: 0, schema_version: 1 }, status: 'ok', uptime_seconds: 1, messages_total: 0 } }),
  ]
  getVersionMock.mockResolvedValue({
    sha: 'abc1234def',
    remoteSha: 'abc1234def',
    updateAvailable: false,
    checkedAt: '',
  })
})

afterEach(cleanup)

describe('v3.5 deployments — surface anatomy', () => {
  it('owns exactly one h1 (single-h1 law) with the admin-lane pill', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('.deploy-pagerow h1')).not.toBeNull())
    const h1s = container.querySelectorAll('h1')
    expect(h1s.length).toBe(1)
    expect(h1s[0]!.textContent).toBe('Deployments')
    expect(container.querySelector('.deploy-admin')!.textContent).toBe('admin lane')
  })

  it('summary strip wires three cells live and keeps shared-skills honest', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelectorAll('.deploy-kpi').length).toBe(4))
    const kpis = [...container.querySelectorAll('.deploy-kpi')]
    // Deployments: exactly one — this host (no multi-host registry exists)
    expect(kpis[0]!.querySelector('.deploy-kpi__v')!.textContent).toBe('1')
    expect(kpis[0]!.querySelector('.deploy-kpi__d')!.textContent).toContain('this host')
    // Total lines: live count + online + channel count (baileys + signal = 2)
    expect(kpis[1]!.querySelector('.deploy-kpi__v')!.textContent).toBe('3')
    expect(kpis[1]!.querySelector('.deploy-kpi__d')!.textContent).toContain('3 online')
    expect(kpis[1]!.querySelector('.deploy-kpi__d')!.textContent).toContain('2 channels')
    // Total agents: one agent-mode line, one with live sessions
    expect(kpis[2]!.querySelector('.deploy-kpi__v')!.textContent).toBe('1')
    expect(kpis[2]!.querySelector('.deploy-kpi__d')!.textContent).toContain('1 with live sessions')
    // Shared skills: honest no-hub state — never a fabricated count
    expect(kpis[3]!.querySelector('.deploy-kpi__v')!.textContent).toBe('—')
    expect(kpis[3]!.querySelector('.deploy-kpi__d')!.textContent).toContain('no org hub')
  })
})

describe('v3.5 deployments — the one real deployment card', () => {
  it('renders local · this host with state pill, version, and live cells', async () => {
    const { container, getByTestId } = renderPage()
    await waitFor(() => expect(getByTestId('deploy-card-local')).toBeDefined())
    const card = getByTestId('deploy-card-local')
    expect(card.querySelector('.deploy-dhead__nm')!.textContent).toContain('local')
    expect(card.querySelector('.deploy-dhead__nm')!.textContent).toContain('this host')
    expect(getByTestId('deploy-state').textContent).toBe('healthy')
    const cells = [...card.querySelectorAll('.deploy-dcell')]
    // lines cell: online/total + channel mini-tags from real transport kinds
    expect(cells[0]!.textContent).toContain('3 / 3')
    expect(cells[0]!.textContent).toContain('wa ×2')
    expect(cells[0]!.textContent).toContain('signal ×1')
    // agents cell: count + name mini-tags in the agent-mode channel color
    expect(cells[1]!.textContent).toContain('1')
    expect(cells[1]!.querySelector('.deploy-mini__agt')!.textContent).toBe('personal')
    // issues cell: all online → honest zero (no fabricated load numbers)
    expect(cells[2]!.textContent).toContain('no line issues')
    // uptime cell: fleet process uptime from /livez (21d fixture)
    await waitFor(() => expect(cells[3]!.textContent).toContain('21d'))
    expect(cells[3]!.textContent).toContain('fleet process')
  })

  it('degrades the state pill and surfaces real issues when lines are not online', async () => {
    mockLines = [
      makeLine('personal'),
      makeLine('builds', { status: 'degraded', statusReason: 'reconnect loop' }),
    ]
    const { container, getByTestId } = renderPage()
    await waitFor(() => expect(getByTestId('deploy-card-local')).toBeDefined())
    expect(getByTestId('deploy-state').textContent).toBe('degraded')
    const cells = [...getByTestId('deploy-card-local').querySelectorAll('.deploy-dcell')]
    expect(cells[0]!.textContent).toContain('1 / 2')
    expect(cells[2]!.querySelector('.deploy-dcell__k')!.textContent).toBe('Issues')
    expect(cells[2]!.textContent).toContain('builds: reconnect loop')
  })

  it('labels the crit severity critical (never a raw state code) on pill and summary', async () => {
    mockLines = [makeLine('personal'), makeLine('builds', { status: 'unreachable' })]
    const { container, getByTestId } = renderPage()
    await waitFor(() => expect(getByTestId('deploy-card-local')).toBeDefined())
    expect(getByTestId('deploy-state').textContent).toBe('critical')
    const kpis = [...container.querySelectorAll('.deploy-kpi')]
    expect(kpis[0]!.querySelector('.deploy-kpi__d')!.textContent).toContain('critical')
    expect(kpis[0]!.querySelector('.deploy-kpi__d')!.textContent).not.toContain('crit ·')
  })

  it('shows the update-available note with the retired-update explanation', async () => {
    getVersionMock.mockResolvedValue({
      sha: 'abc1234def',
      remoteSha: 'fff0000aaa',
      updateAvailable: true,
      checkedAt: '',
    })
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('.deploy-ver__up')).not.toBeNull())
    const up = container.querySelector('.deploy-ver__up')!
    expect(up.textContent).toContain('fff0000')
    expect(up.getAttribute('title')).toContain('retired')
  })

  it('org-hub row renders the designed anatomy disabled with the no-endpoint note', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(container.querySelector('.deploy-hub')).not.toBeNull())
    const hub = container.querySelector('.deploy-hub')!
    expect(hub.textContent).toContain('no shared catalog endpoint')
    const pull = hub.querySelector('button')!
    expect(pull.disabled).toBe(true)
    expect(pull.title).toContain('no shared catalog endpoint')
  })
})

describe('v3.5 deployments — pair card (designed-state)', () => {
  it('pair card discloses the missing backend and disables both actions', async () => {
    const { container, getByTestId } = renderPage()
    await waitFor(() => expect(getByTestId('deploy-pair-card')).toBeDefined())
    const card = getByTestId('deploy-pair-card')
    expect(card.textContent).toContain('no pairing endpoint')
    const buttons = [...card.querySelectorAll('button')]
    expect(buttons.length).toBe(2)
    for (const b of buttons) expect(b.disabled).toBe(true)
    // the code block is a placeholder — never a fabricated code
    expect(card.querySelector('.deploy-code')!.textContent).not.toMatch(/[A-Z0-9]{4}/)
  })

  it('pagerow pair action scrolls to the pair card (real navigation)', async () => {
    const { container, getByTestId } = renderPage()
    await waitFor(() => expect(getByTestId('deploy-pair-card')).toBeDefined())
    const scrollSpy = vi.fn()
    getByTestId('deploy-pair-card').scrollIntoView = scrollSpy
    const pairBtn = [...container.querySelectorAll('.deploy-pagerow button')].find((b) =>
      b.textContent?.includes('Pair deployment'),
    )!
    fireEvent.click(pairBtn)
    expect(scrollSpy).toHaveBeenCalled()
  })
})
