/**
 * CheckpointsTab — render contract for the checkpoint browser surface.
 * Spec: oc-re/specs/2026-07-19-checkpoint-browser-ui-spec.md
 * Follow-ups (sort + Delivery column):
 * oc-re/specs/2026-07-19-checkpoints-tab-followups-spec.md
 * Restore action (D-1): oc-re/specs/2026-07-19-checkpoint-restore-spec.md
 * The tab is props-driven for DATA (LineDetail owns useCheckpoints); the
 * restore action consumes toast/queryClient hooks, so renders wrap the
 * AccessTab-proven provider idiom.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../../../console/src/lib/api', () => ({
  api: { restoreCheckpoint: vi.fn() },
}))

import { CheckpointsTab } from '../../../../console/src/components/line-detail/CheckpointsTab'
import { api } from '../../../../console/src/lib/api'
import { ToastContext, type ToastContextValue } from '../../../../console/src/hooks/toast-context'
import type { CheckpointsPayload } from '../../../../console/src/types'
import type { Freshness } from '../../../../console/src/lib/freshness'

const restoreCheckpointMock = api.restoreCheckpoint as unknown as ReturnType<typeof vi.fn>

const toastValue: ToastContextValue = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
}

const LINE = 'test-line'

function renderTab(ui: ReactElement, queryClient?: QueryClient) {
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ToastContext.Provider value={toastValue}>{ui}</ToastContext.Provider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  restoreCheckpointMock.mockReset()
  restoreCheckpointMock.mockResolvedValue({ status: 'restore_requested' })
  vi.clearAllMocks()
})

const FRESH: Freshness = { observedAt: Date.now(), stale: false }
const STALE: Freshness = { observedAt: Date.now() - 10 * 60_000, stale: true }

const ROW_RESUMABLE = {
  conversationKey: '15550000001@s.whatsapp.net',
  sessionId: 'sess-abc',
  sessionStatus: 'suspended',
  checkpointVersion: 7,
  claudePid: 4321,
  workspacePath: '/workspaces/15550000001',
  createdAt: '2026-07-18T00:00:00Z',
  updatedAt: '2026-07-19T01:00:00Z',
  completedScope: 'per_chat',
  completedDeliveryJid: '15550000001@s.whatsapp.net',
  completedLogicalTurnId: 'lt-1',
  resumable: true,
}

const ROW_ENDED = {
  ...ROW_RESUMABLE,
  conversationKey: '15550000002@s.whatsapp.net',
  sessionId: 'sess-def',
  sessionStatus: 'ended',
  checkpointVersion: 3,
  claudePid: 5678,
  resumable: false,
}

function payload(overrides: Partial<CheckpointsPayload> = {}): CheckpointsPayload {
  return {
    observedAt: '2026-07-19T04:00:00Z',
    checkpoints: [ROW_RESUMABLE, ROW_ENDED],
    ...overrides,
  }
}

afterEach(cleanup)

describe('CheckpointsTab', () => {
  it('renders checkpoint rows with status badges and resumable markers', () => {
    renderTab(<CheckpointsTab lineName={LINE} payload={payload()} isLoading={false} freshness={FRESH} />)
    expect(screen.getByText('suspended')).toBeTruthy()
    expect(screen.getByText('ended')).toBeTruthy()
    // exactly one resumable marker (the suspended row)
    expect(screen.getAllByText('resumable')).toHaveLength(1)
    expect(screen.getByText('v7')).toBeTruthy()
    expect(screen.getByText('4321')).toBeTruthy()
    expect(screen.getByText('5678')).toBeTruthy()
    expect(screen.getAllByText('per_chat')).toHaveLength(2)
    // header summary
    expect(screen.getByText(/2 checkpoints · 1 resumable on restart/)).toBeTruthy()
  })

  it('fails closed on readError — error row, never the empty state', () => {
    renderTab(<CheckpointsTab lineName={LINE} payload={payload({ checkpoints: [], readError: true })} isLoading={false} freshness={FRESH} />)
    expect(screen.getByText(/Checkpoint data unavailable/)).toBeTruthy()
    expect(screen.queryByText(/No session checkpoints recorded/)).toBeNull()
    expect(screen.getByText('read unavailable')).toBeTruthy()
  })

  it('renders the empty state only for a genuine empty successful read', () => {
    renderTab(<CheckpointsTab lineName={LINE} payload={payload({ checkpoints: [] })} isLoading={false} freshness={FRESH} />)
    expect(screen.getByText(/No session checkpoints recorded/)).toBeTruthy()
    expect(screen.queryByText(/Checkpoint data unavailable/)).toBeNull()
  })

  it('shows skeleton rows while loading and no data rows', () => {
    const { container } = renderTab(<CheckpointsTab lineName={LINE} payload={undefined} isLoading freshness={FRESH} />)
    expect(container.querySelectorAll('.soup-table-skeleton-bar').length).toBeGreaterThan(0)
    expect(screen.queryByText('suspended')).toBeNull()
    expect(screen.getByText('not observed')).toBeTruthy()
  })

  it('marks the header stale when freshness says the observation is carried', () => {
    renderTab(<CheckpointsTab lineName={LINE} payload={payload()} isLoading={false} freshness={STALE} />)
    const marker = screen.getByText(/\(stale\)/)
    expect(marker.className).toContain('text-s-warn')
  })

  it('flags unknown statuses with the warn severity badge', () => {
    const weird = { ...ROW_RESUMABLE, conversationKey: 'weird@s.whatsapp.net', sessionStatus: 'melted' }
    renderTab(<CheckpointsTab lineName={LINE} payload={payload({ checkpoints: [weird] })} isLoading={false} freshness={FRESH} />)
    const badge = screen.getByText('melted')
    // warn severity maps to the warn wash/color tokens — unknown statuses never render green
    expect(badge.style.background).toBeTruthy()
    expect(badge.textContent).toBe('melted')
  })
})

describe('CheckpointsTab — sort (F-UX-1)', () => {
  // Short keys so truncateMiddle passes them through unchanged; payload
  // order is the server default (updated_at DESC): bravo (newer) then alpha.
  const ROW_ALPHA = {
    ...ROW_RESUMABLE,
    conversationKey: 'alpha@x',
    updatedAt: '2026-07-19T01:00:00Z',
  }
  const ROW_BRAVO = {
    ...ROW_RESUMABLE,
    conversationKey: 'bravo@x',
    sessionId: 'sess-bravo',
    updatedAt: '2026-07-19T03:00:00Z',
  }
  const serverOrder = [ROW_BRAVO, ROW_ALPHA]

  function renderedConversationOrder(): string[] {
    return screen
      .getAllByRole('row')
      .slice(1) // header row
      .map((r) => within(r).getAllByRole('cell')[0]!.textContent ?? '')
  }

  it('preserves payload (server) order before any sort interaction', () => {
    renderTab(<CheckpointsTab lineName={LINE} payload={payload({ checkpoints: serverOrder })} isLoading={false} freshness={FRESH} />)
    expect(renderedConversationOrder()).toEqual(['bravo@x', 'alpha@x'])
  })

  it('cycles Conversation asc → desc → cleared through the tri-state sort button', () => {
    renderTab(<CheckpointsTab lineName={LINE} payload={payload({ checkpoints: serverOrder })} isLoading={false} freshness={FRESH} />)
    const btn = screen.getByRole('button', { name: /Sort by Conversation/ })
    fireEvent.click(btn) // none → asc
    expect(renderedConversationOrder()).toEqual(['alpha@x', 'bravo@x'])
    fireEvent.click(btn) // asc → desc
    expect(renderedConversationOrder()).toEqual(['bravo@x', 'alpha@x'])
    fireEvent.click(btn) // desc → none (server order restored)
    expect(renderedConversationOrder()).toEqual(['bravo@x', 'alpha@x'])
  })

  it('sorts Updated chronologically — ascending puts the oldest checkpoint first', () => {
    renderTab(<CheckpointsTab lineName={LINE} payload={payload({ checkpoints: serverOrder })} isLoading={false} freshness={FRESH} />)
    fireEvent.click(screen.getByRole('button', { name: /Sort by Updated/ }))
    expect(renderedConversationOrder()).toEqual(['alpha@x', 'bravo@x'])
  })
})

describe('CheckpointsTab — Delivery column (F-UX-3)', () => {
  it('renders the truncated delivery JID with the full JID + turn id in the title', () => {
    const row = {
      ...ROW_RESUMABLE,
      conversationKey: 'conv-a',
      completedDeliveryJid: '15550000001@s.whatsapp.net',
      completedLogicalTurnId: 'lt-1',
    }
    renderTab(<CheckpointsTab lineName={LINE} payload={payload({ checkpoints: [row] })} isLoading={false} freshness={FRESH} />)
    // 26-char JID exceeds the truncateMiddle budget — rendered truncated…
    const cell = screen.getByText('15550000001@s.…atsapp.net')
    // …with the full identity bundle on the title for hover/AT
    expect(cell.getAttribute('title')).toBe('15550000001@s.whatsapp.net · turn lt-1')
  })

  it('renders the delivery JID (not the conversation key) under JID aliasing', () => {
    const row = {
      ...ROW_RESUMABLE,
      conversationKey: 'canonical:key-a',
      completedDeliveryJid: '11122233344455@lid',
      completedLogicalTurnId: 'lt-99',
    }
    renderTab(<CheckpointsTab lineName={LINE} payload={payload({ checkpoints: [row] })} isLoading={false} freshness={FRESH} />)
    expect(screen.getByText('11122233344455@lid')).toBeTruthy()
    expect(screen.getByTitle('11122233344455@lid · turn lt-99')).toBeTruthy()
  })

  it('renders an em-dash when the completed-delivery identity is absent', () => {
    const row = {
      ...ROW_RESUMABLE, // pid/scope/workspace all non-null — the Delivery dash is unambiguous
      conversationKey: 'conv-b',
      completedDeliveryJid: null,
      completedLogicalTurnId: null,
    }
    renderTab(<CheckpointsTab lineName={LINE} payload={payload({ checkpoints: [row] })} isLoading={false} freshness={FRESH} />)
    const bodyRow = screen.getAllByRole('row')[1]!
    // Cells: Conversation, Status, Resumable, Version, PID, Scope, DELIVERY(6), Updated, Workspace, Action
    expect(within(bodyRow).getAllByRole('cell')[6]!.textContent).toBe('—')
  })
})

describe('CheckpointsTab — Restore action (D-1)', () => {
  const ROW_ELIGIBLE = {
    ...ROW_ENDED, // ended + sessionId 'sess-def' → restore-eligible
    conversationKey: 'eligible@x',
  }
  const ROW_NO_SESSION = {
    ...ROW_ENDED,
    conversationKey: 'nosession@x',
    sessionId: null,
  }

  it('renders the Restore button only for eligible rows (not resumable, has session id)', () => {
    renderTab(<CheckpointsTab lineName={LINE} payload={payload({ checkpoints: [ROW_RESUMABLE, ROW_ELIGIBLE, ROW_NO_SESSION] })} isLoading={false} freshness={FRESH} />)
    const buttons = screen.getAllByRole('button', { name: /Restore/ })
    expect(buttons).toHaveLength(1)
    // eligible row carries it
    const eligibleRow = screen.getByText('eligible@x').closest('tr') as HTMLElement
    expect(within(eligibleRow).getByRole('button', { name: /Restore/ })).toBeTruthy()
    // null-session row explains why restore is impossible
    const noSessionRow = screen.getByText('nosession@x').closest('tr') as HTMLElement
    expect(within(noSessionRow).queryByRole('button', { name: /Restore/ })).toBeNull()
    expect(within(noSessionRow).getByTitle(/No session id — cannot be made resumable/)).toBeTruthy()
  })

  it('confirm flow: dialog names the restart, confirm calls api + invalidates + toasts', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')
    renderTab(<CheckpointsTab lineName={LINE} payload={payload({ checkpoints: [ROW_ELIGIBLE] })} isLoading={false} freshness={FRESH} />, client)

    fireEvent.click(screen.getByRole('button', { name: /Restore/ }))
    // Dialog explains the restart-mediated semantics before any mutation
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/restart/i)
    expect(dialog.textContent).toContain(LINE)

    fireEvent.click(within(dialog).getByRole('button', { name: /Restore & Restart/ }))
    await waitFor(() => expect(restoreCheckpointMock).toHaveBeenCalledTimes(1))
    expect(restoreCheckpointMock).toHaveBeenCalledWith(LINE, 'eligible@x')
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['checkpoints', LINE] }))
    expect(toastValue.success).toHaveBeenCalled()
    expect(toastValue.error).not.toHaveBeenCalled()
  })

  it('double-submit guard: rapid confirms produce a single api call', async () => {
    let resolveApi: (v: { status: string }) => void = () => {}
    restoreCheckpointMock.mockImplementation(() => new Promise((res) => { resolveApi = res }))
    renderTab(<CheckpointsTab lineName={LINE} payload={payload({ checkpoints: [ROW_ELIGIBLE] })} isLoading={false} freshness={FRESH} />)

    fireEvent.click(screen.getByRole('button', { name: /Restore/ }))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: /Restore & Restart/ })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await act(async () => { resolveApi({ status: 'restore_requested' }) })
    expect(restoreCheckpointMock).toHaveBeenCalledTimes(1)
  })

  it('api failure → error toast, no invalidate', async () => {
    restoreCheckpointMock.mockRejectedValue(new Error('restore failed: unit not found'))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')
    renderTab(<CheckpointsTab lineName={LINE} payload={payload({ checkpoints: [ROW_ELIGIBLE] })} isLoading={false} freshness={FRESH} />, client)

    fireEvent.click(screen.getByRole('button', { name: /Restore/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Restore & Restart/ }))
    await waitFor(() => expect(toastValue.error).toHaveBeenCalled())
    expect(invalidateSpy).not.toHaveBeenCalled()
    expect(toastValue.success).not.toHaveBeenCalled()
  })
})
