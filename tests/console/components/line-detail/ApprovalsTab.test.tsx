/**
 * ApprovalsTab — render + decision contract for the console approval queue
 * (D-4 build; design: docs/proposals/2026-07-19-approval-queue.md).
 * Props-driven (LineDetail owns useApprovals) — pure render + mocked api.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../../../console/src/lib/api', () => ({
  api: { postApprovalDecision: vi.fn() },
}))

import { ApprovalsTab } from '../../../../console/src/components/line-detail/ApprovalsTab'
import { api } from '../../../../console/src/lib/api'
import { ToastContext, type ToastContextValue } from '../../../../console/src/hooks/toast-context'
import type { ApprovalEntry, ApprovalsPayload } from '../../../../console/src/types'
import type { Freshness } from '../../../../console/src/lib/freshness'

const postMock = api.postApprovalDecision as unknown as ReturnType<typeof vi.fn>

const toastValue: ToastContextValue = {
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  clear: vi.fn(),
}

const LINE = 'agent-line'
const FRESH: Freshness = { observedAt: Date.now(), stale: false }

function renderTab(ui: ReactElement, queryClient?: QueryClient) {
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ToastContext.Provider value={toastValue}>{ui}</ToastContext.Provider>
    </QueryClientProvider>,
  )
}

const PENDING: ApprovalEntry = {
  mapKey: 'agent:chat:1',
  chatJid: '15550000001@s.whatsapp.net',
  mode: 'poll',
  source: 'askuser',
  questions: [
    {
      question: 'Deploy the new build to production?',
      options: [
        { label: 'Deploy now', description: 'Ship it immediately' },
        { label: 'Hold', description: 'Wait for the window' },
      ],
      multiSelect: false,
    },
  ],
  currentQuestionIndex: 0,
  answersCollected: {},
  createdAt: Date.now() - 60_000,
  timeoutMs: 3_600_000,
  hardClosesAt: Date.now() + 3_540_000,
}

const TEXT_FALLBACK: ApprovalEntry = {
  ...PENDING,
  mapKey: 'agent:chat:2',
  mode: 'textFallback',
  questions: [{ question: 'Pick a region?', options: [{ label: 'us-east', description: '' }], multiSelect: false }],
}

function payload(overrides: Partial<ApprovalsPayload> = {}): ApprovalsPayload {
  return {
    observedAt: '2026-07-19T04:00:00Z',
    supported: true,
    approvals: [PENDING],
    parseErrors: 0,
    ...overrides,
  }
}

beforeEach(() => {
  postMock.mockReset()
  postMock.mockResolvedValue({ status: 'decision_delivered' })
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('ApprovalsTab', () => {
  it('renders the pending question with its options and the originating chat', () => {
    renderTab(<ApprovalsTab payload={payload()} isLoading={false} freshness={FRESH} lineName={LINE} />)
    expect(screen.getByText('Deploy the new build to production?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deploy now' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hold' })).toBeTruthy()
    expect(screen.getByTitle('15550000001@s.whatsapp.net')).toBeTruthy()
  })

  it('renders an unsafe originating identity as visible escaped text', () => {
    const unsafe = { ...PENDING, mapKey: 'agent:chat:unsafe', chatJid: 'owner\u202E@example.com@imessage' }
    renderTab(<ApprovalsTab payload={payload({ approvals: [unsafe] })} isLoading={false} freshness={FRESH} lineName={LINE} />)

    expect(screen.getByTitle('owner\\u202E@example.com@imessage')).toBeTruthy()
    expect(document.body.textContent).not.toContain('\u202E')
  })

  it('single-select: choose → ConfirmDialog → api with (line, mapKey, questionIndex, option) → toast + invalidate', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')
    renderTab(<ApprovalsTab payload={payload()} isLoading={false} freshness={FRESH} lineName={LINE} />, client)

    fireEvent.click(screen.getByRole('button', { name: 'Deploy now' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toMatch(/Deploy now/)
    fireEvent.click(within(dialog).getByRole('button', { name: /Confirm/ }))

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1))
    expect(postMock).toHaveBeenCalledWith(LINE, {
      mapKey: 'agent:chat:1',
      questionIndex: 0,
      selectedOptions: ['Deploy now'],
    })
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['approvals', LINE] }))
    expect(toastValue.success).toHaveBeenCalled()
  })

  it('409 → honest "already resolved elsewhere" error toast, no invalidate', async () => {
    postMock.mockRejectedValue(Object.assign(new Error('already resolved'), { status: 409 }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')
    renderTab(<ApprovalsTab payload={payload()} isLoading={false} freshness={FRESH} lineName={LINE} />, client)

    fireEvent.click(screen.getByRole('button', { name: 'Deploy now' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Confirm/ }))
    await waitFor(() => expect(toastValue.error).toHaveBeenCalled())
    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('textFallback entries are decidable from the console (v1.1) with the typed-answer note', () => {
    renderTab(<ApprovalsTab payload={payload({ approvals: [TEXT_FALLBACK] })} isLoading={false} freshness={FRESH} lineName={LINE} />)
    expect(screen.getByText('Pick a region?')).toBeTruthy()
    expect(screen.getByText(/typed answer/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'us-east' })).toBeTruthy()
  })

  it('fails closed on readError — error panel, no cards, never a fake-empty queue', () => {
    renderTab(<ApprovalsTab payload={{ observedAt: '2026-07-19T04:00:00Z', supported: true, approvals: [], parseErrors: 0, readError: true }} isLoading={false} freshness={FRESH} lineName={LINE} />)
    expect(screen.getByText(/Approval data unavailable/)).toBeTruthy()
    expect(screen.queryByText('Deploy the new build to production?')).toBeNull()
  })

  it('empty queue renders the calm zero-state, not a skeleton', () => {
    renderTab(<ApprovalsTab payload={payload({ approvals: [] })} isLoading={false} freshness={FRESH} lineName={LINE} />)
    expect(screen.getByText(/no pending decisions/i)).toBeTruthy()
  })

  it('shows a loading skeleton without fabricating cards', () => {
    renderTab(<ApprovalsTab payload={undefined} isLoading freshness={FRESH} lineName={LINE} />)
    expect(screen.queryByText('Deploy the new build to production?')).toBeNull()
    expect(screen.getByText(/Loading…/)).toBeTruthy()
  })
})
