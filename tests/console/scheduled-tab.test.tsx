/**
 * ScheduledTab — loading/error/empty, pending-first sort, cancel/edit/duplicate/new wiring, composer + invalidation.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../console/src/lib/api', () => ({
  api: {
    getScheduled: vi.fn(),
    getChats: vi.fn(),
    cancelScheduled: vi.fn(),
  },
}))

// Stub ScheduledMessageRow so we can assert which messages were passed and in what order,
// without depending on its internal markup (already covered by its own tests).
vi.mock('../../console/src/components/line-detail/ScheduledMessageRow', () => ({
  ScheduledMessageRow: ({ message, onCancel, onEdit, onDuplicate, cancelling }: {
    message: { id: number; status: string; scheduledAt: number }
    onCancel: (id: number) => void
    onEdit: (m: unknown) => void
    onDuplicate: (m: unknown) => void
    cancelling: number | null
  }) => (
    <div data-testid="sched-row" data-id={message.id} data-status={message.status} data-scheduled-at={message.scheduledAt}>
      <span>row-{message.id}</span>
      <button type="button" onClick={() => onCancel(message.id)}>row-cancel-{message.id}</button>
      <button type="button" onClick={() => onEdit(message)}>row-edit-{message.id}</button>
      <button type="button" onClick={() => onDuplicate(message)}>row-duplicate-{message.id}</button>
      {cancelling === message.id && <span>row-cancelling-{message.id}</span>}
    </div>
  ),
}))

// Stub the composer so we can assert open/close + props without rendering the heavy modal.
const composerProps: { last: Record<string, unknown> | null } = { last: null }
vi.mock('../../console/src/components/line-detail/ScheduleComposerModal', () => ({
  ScheduleComposerModal: (props: Record<string, unknown>) => {
    composerProps.last = props
    if (!props.open) return null
    return (
      <div data-testid="composer-modal">
        <span>composer-open</span>
        {props.editMessage ? <span>composer-edit-{(props.editMessage as { id: number }).id}</span> : <span>composer-new</span>}
        <button type="button" onClick={() => (props.onClose as () => void)()}>composer-close</button>
        <button type="button" onClick={() => (props.onCreated as () => void)()}>composer-created</button>
      </div>
    )
  },
}))

import { ScheduledTab } from '../../console/src/components/line-detail/ScheduledTab'
import { api } from '../../console/src/lib/api'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'
import type { ScheduledMessage } from '../../console/src/types'

const getScheduledMock = api.getScheduled as unknown as ReturnType<typeof vi.fn>
const getChatsMock = api.getChats as unknown as ReturnType<typeof vi.fn>
const cancelScheduledMock = api.cancelScheduled as unknown as ReturnType<typeof vi.fn>

let toastValue: ToastContextValue

function makeToast(): ToastContextValue {
  return {
    toast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  }
}

function withProviders(node: ReactElement, queryClient?: QueryClient) {
  const client = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <ToastContext.Provider value={toastValue}>{node}</ToastContext.Provider>
    </QueryClientProvider>
  )
}

const LINE = 'demo-line'

// Repo convention: 1555-prefixed phone JIDs / short 120363NNN@g.us synthetic group JIDs.
function makeMsg(overrides: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: 1,
    chatJid: '15555550001@s.whatsapp.net',
    chatName: 'Chat One',
    contentType: 'text',
    payload: { text: 'hello' },
    scheduledAt: 1_700_000_000,
    runCount: 0,
    status: 'pending',
    createdAt: 1_699_990_000,
    retryCount: 0,
    ...overrides,
  }
}

const pendingEarly = makeMsg({ id: 11, status: 'pending',    scheduledAt: 1_700_000_000 })
const pendingLate  = makeMsg({ id: 12, status: 'pending',    scheduledAt: 1_700_001_000 })
const processing   = makeMsg({ id: 13, status: 'processing', scheduledAt: 1_700_000_500 })
const sentOlder    = makeMsg({ id: 14, status: 'sent',       scheduledAt: 1_699_000_000, sentAt: 1_699_000_500 })
const sentNewer    = makeMsg({ id: 15, status: 'sent',       scheduledAt: 1_699_500_000, sentAt: 1_699_500_500 })
const cancelled    = makeMsg({ id: 16, status: 'cancelled',  scheduledAt: 1_699_200_000 })
const groupMsg     = makeMsg({ id: 17, status: 'pending',    scheduledAt: 1_700_002_000, chatJid: '120363001@g.us', chatName: 'Group Alpha' })

const chatItems = [
  { jid: '15555550001@s.whatsapp.net', name: 'Chat One' },
  { jid: '120363001@g.us', name: 'Group Alpha' },
]

beforeEach(() => {
  getScheduledMock.mockReset()
  getChatsMock.mockReset()
  cancelScheduledMock.mockReset()
  composerProps.last = null
  toastValue = makeToast()
  getChatsMock.mockResolvedValue(chatItems)
})

afterEach(() => cleanup())

/** Render and wait for the scheduled query to settle past isLoading. */
async function renderSettled(client?: QueryClient) {
  const utils = render(withProviders(<ScheduledTab lineName={LINE} />, client))
  // Loading branch matches "Loading scheduled messages..."; success/empty branches show a "<N> scheduled
  // message(s)" header line; error branch shows "Failed to load scheduled messages". Wait until
  // the loading title is gone.
  await waitFor(() => {
    if (screen.queryByText('Loading scheduled messages...') !== null) {
      throw new Error('still loading')
    }
  })
  return utils
}

describe('ScheduledTab — loading / error / empty states', () => {
  it('renders the loading EmptyState while the scheduled query is pending', () => {
    // Never-resolving promises so the query stays in loading state.
    getScheduledMock.mockReturnValue(new Promise(() => {}))
    getChatsMock.mockReturnValue(new Promise(() => {}))

    render(withProviders(<ScheduledTab lineName={LINE} />))

    expect(screen.getByText('Loading scheduled messages...')).toBeDefined()
    expect(screen.getByText(/Fetching queue for this instance/i)).toBeDefined()
    expect(screen.queryByTestId('sched-row')).toBeNull()
    expect(screen.queryByRole('button', { name: /New Scheduled Message/i })).toBeNull()
  })

  it('renders the error EmptyState with the thrown message when the query rejects', async () => {
    getScheduledMock.mockRejectedValue(new Error('socket down'))

    await renderSettled()

    expect(screen.getByText('Failed to load scheduled messages')).toBeDefined()
    expect(screen.getByText('socket down')).toBeDefined()
    expect(screen.queryByTestId('sched-row')).toBeNull()
  })

  it('falls back to the MCP-socket hint when the rejection is not an Error', async () => {
    getScheduledMock.mockRejectedValue('plain string failure')

    await renderSettled()

    expect(screen.getByText('Failed to load scheduled messages')).toBeDefined()
    expect(screen.getByText(/MCP socket may not be available/i)).toBeDefined()
  })

  it('renders the "No scheduled messages" empty state with the header count when the list is empty', async () => {
    getScheduledMock.mockResolvedValue({ count: 0, messages: [] })

    await renderSettled()

    expect(screen.getByText('0 scheduled messages')).toBeDefined()
    expect(screen.getByText('No scheduled messages')).toBeDefined()
    expect(screen.getByText(/Messages scheduled via the agent or MCP tools will appear here/i)).toBeDefined()
    expect(screen.queryByTestId('sched-row')).toBeNull()
  })

  it('does not fire either query when lineName is empty (enabled:false guard)', () => {
    render(withProviders(<ScheduledTab lineName="" />))

    expect(getScheduledMock).not.toHaveBeenCalled()
    expect(getChatsMock).not.toHaveBeenCalled()
  })
})

describe('ScheduledTab — header counts and sort order', () => {
  it('renders the singular header text when there is exactly one message', async () => {
    getScheduledMock.mockResolvedValue({ count: 1, messages: [pendingEarly] })

    await renderSettled()

    expect(screen.getByText('1 scheduled message')).toBeDefined()
    expect(screen.getAllByTestId('sched-row')).toHaveLength(1)
  })

  it('renders the plural header text and one row per message', async () => {
    getScheduledMock.mockResolvedValue({
      count: 3,
      messages: [pendingEarly, pendingLate, sentNewer],
    })

    await renderSettled()

    expect(screen.getByText('3 scheduled messages')).toBeDefined()
    expect(screen.getAllByTestId('sched-row')).toHaveLength(3)
  })

  it('sorts pending+processing first ASC by scheduledAt, then the rest DESC by scheduledAt', async () => {
    // Deliberately scrambled input order to prove the component re-orders it.
    getScheduledMock.mockResolvedValue({
      count: 6,
      messages: [sentOlder, pendingLate, cancelled, processing, sentNewer, pendingEarly],
    })

    await renderSettled()

    const ids = screen.getAllByTestId('sched-row').map(el => el.getAttribute('data-id'))
    expect(ids).toEqual([
      String(pendingEarly.id),
      String(processing.id),
      String(pendingLate.id),
      String(sentNewer.id),
      String(cancelled.id),
      String(sentOlder.id),
    ])
  })

  it('handles group-JID messages alongside phone messages without dropping either', async () => {
    getScheduledMock.mockResolvedValue({
      count: 2,
      messages: [pendingEarly, groupMsg],
    })

    await renderSettled()

    const rows = screen.getAllByTestId('sched-row')
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.getAttribute('data-id'))).toEqual([String(pendingEarly.id), String(groupMsg.id)])
  })
})

describe('ScheduledTab — cancel flow wiring', () => {
  it('calls api.cancelScheduled(lineName, id), toasts success, and invalidates the scheduled query', async () => {
    getScheduledMock.mockResolvedValue({ count: 1, messages: [pendingEarly] })
    cancelScheduledMock.mockResolvedValue(undefined)

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')

    await renderSettled(client)

    await act(async () => {
      fireEvent.click(screen.getByText(`row-cancel-${pendingEarly.id}`))
    })

    expect(cancelScheduledMock).toHaveBeenCalledTimes(1)
    expect(cancelScheduledMock).toHaveBeenCalledWith(LINE, pendingEarly.id)
    expect(toastValue.success).toHaveBeenCalledWith('Scheduled message cancelled')
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['scheduled', LINE] })
  })

  it('surfaces cancel errors via toast.error and does not invalidate the scheduled query', async () => {
    getScheduledMock.mockResolvedValue({ count: 1, messages: [pendingEarly] })
    cancelScheduledMock.mockRejectedValue(new Error('boom'))

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')

    await renderSettled(client)

    await act(async () => {
      fireEvent.click(screen.getByText(`row-cancel-${pendingEarly.id}`))
    })

    expect(toastValue.error).toHaveBeenCalledWith('Cancel failed: boom')
    expect(toastValue.success).not.toHaveBeenCalled()
    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('stringifies non-Error cancel rejections into the toast message', async () => {
    getScheduledMock.mockResolvedValue({ count: 1, messages: [pendingEarly] })
    cancelScheduledMock.mockRejectedValue('nope')

    await renderSettled()

    await act(async () => {
      fireEvent.click(screen.getByText(`row-cancel-${pendingEarly.id}`))
    })

    expect(toastValue.error).toHaveBeenCalledWith('Cancel failed: nope')
  })
})

describe('ScheduledTab — composer open / close / edit / duplicate / new', () => {
  it('does not render the composer body until the New button is clicked, then opens it with no editMessage', async () => {
    getScheduledMock.mockResolvedValue({ count: 1, messages: [pendingEarly] })

    await renderSettled()

    expect(screen.queryByTestId('composer-modal')).toBeNull()
    expect(composerProps.last?.open).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /New Scheduled Message/i }))

    expect(screen.getByTestId('composer-modal')).toBeDefined()
    expect(screen.getByText('composer-new')).toBeDefined()
    expect(composerProps.last?.open).toBe(true)
    expect(composerProps.last?.editMessage).toBeUndefined()
    // Confirm the edit-marker branch did not render — proves we entered the "new" path.
    expect(screen.queryByText(/^composer-edit-/)).toBeNull()
  })

  it('opens the composer in edit mode with the original message when row.onEdit fires', async () => {
    getScheduledMock.mockResolvedValue({ count: 1, messages: [pendingEarly] })

    await renderSettled()

    fireEvent.click(screen.getByText(`row-edit-${pendingEarly.id}`))

    expect(screen.getByTestId('composer-modal')).toBeDefined()
    expect(screen.getByText(`composer-edit-${pendingEarly.id}`)).toBeDefined()
    expect((composerProps.last?.editMessage as ScheduledMessage).id).toBe(pendingEarly.id)
  })

  it('opens the composer with id=-1 (signals "create new from template") when row.onDuplicate fires', async () => {
    getScheduledMock.mockResolvedValue({ count: 1, messages: [pendingEarly] })

    await renderSettled()

    fireEvent.click(screen.getByText(`row-duplicate-${pendingEarly.id}`))

    expect(screen.getByTestId('composer-modal')).toBeDefined()
    // id=-1 still goes through ScheduledTab's `editMessage?.id ? ... : undefined` gate (truthy),
    // so the composer receives a templated edit payload with id=-1.
    expect((composerProps.last?.editMessage as ScheduledMessage).id).toBe(-1)
    // Other fields are preserved from the source message.
    expect((composerProps.last?.editMessage as ScheduledMessage).chatJid).toBe(pendingEarly.chatJid)
  })

  it('closes the composer and clears editMessage when the composer onClose fires', async () => {
    getScheduledMock.mockResolvedValue({ count: 1, messages: [pendingEarly] })

    await renderSettled()

    fireEvent.click(screen.getByText(`row-edit-${pendingEarly.id}`))
    expect(screen.getByTestId('composer-modal')).toBeDefined()

    fireEvent.click(screen.getByText('composer-close'))

    expect(screen.queryByTestId('composer-modal')).toBeNull()
    expect(composerProps.last?.open).toBe(false)
    expect(composerProps.last?.editMessage).toBeUndefined()
    expect(screen.queryByText(`composer-edit-${pendingEarly.id}`)).toBeNull()
  })

  it('invalidates the scheduled query when the composer fires onCreated', async () => {
    getScheduledMock.mockResolvedValue({ count: 1, messages: [pendingEarly] })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')

    await renderSettled(client)

    fireEvent.click(screen.getByRole('button', { name: /New Scheduled Message/i }))
    fireEvent.click(screen.getByText('composer-created'))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['scheduled', LINE] })
  })

  it('forwards the lineName and chats list from useQuery into the composer props', async () => {
    getScheduledMock.mockResolvedValue({ count: 0, messages: [] })

    await renderSettled()

    expect(composerProps.last?.lineName).toBe(LINE)
    expect(composerProps.last?.chats).toEqual(chatItems)
  })

  it('passes [] for chats when the chats query returns undefined/null', async () => {
    getScheduledMock.mockResolvedValue({ count: 0, messages: [] })
    getChatsMock.mockResolvedValue(null)

    await renderSettled()

    expect(composerProps.last?.chats).toEqual([])
  })
})
