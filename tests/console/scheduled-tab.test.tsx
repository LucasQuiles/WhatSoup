/**
 * ScheduledTab — loading/error/empty, pending-first sort, cancel/edit/duplicate/new wiring, composer + invalidation.
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('../../console/src/lib/api', () => ({
  api: {
    getScheduled: vi.fn(),
    getChats: vi.fn(),
    cancelScheduled: vi.fn(),
    createScheduled: vi.fn(),
    updateScheduled: vi.fn(),
  },
}))

import { ScheduledTab } from '../../console/src/components/line-detail/ScheduledTab'
import { api } from '../../console/src/lib/api'
import { ToastContext, type ToastContextValue } from '../../console/src/hooks/toast-context'
import type { ChatItem, ScheduledMessage } from '../../console/src/types'

const getScheduledMock = api.getScheduled as unknown as ReturnType<typeof vi.fn>
const getChatsMock = api.getChats as unknown as ReturnType<typeof vi.fn>
const cancelScheduledMock = api.cancelScheduled as unknown as ReturnType<typeof vi.fn>
const createScheduledMock = api.createScheduled as unknown as ReturnType<typeof vi.fn>
const updateScheduledMock = api.updateScheduled as unknown as ReturnType<typeof vi.fn>

let toastValue: ToastContextValue

function makeToast(): ToastContextValue {
  return {
    toast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
    clear: vi.fn(),
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
    payload: { text: 'hello from scheduled row' },
    scheduledAt: 2_600_000_000,
    runCount: 0,
    status: 'pending',
    createdAt: 2_599_990_000,
    retryCount: 0,
    ...overrides,
  }
}

const pendingEarly = makeMsg({ id: 11, status: 'pending',    scheduledAt: 2_600_000_000, payload: { text: 'early pending message' } })
const pendingLate  = makeMsg({ id: 12, status: 'pending',    scheduledAt: 2_600_001_000, payload: { text: 'late pending message' } })
const processing   = makeMsg({ id: 13, status: 'processing', scheduledAt: 2_600_000_500, payload: { text: 'processing message' } })
const sentOlder    = makeMsg({ id: 14, status: 'sent',       scheduledAt: 2_599_000_000, sentAt: 2_599_000_500, payload: { text: 'older sent message' } })
const sentNewer    = makeMsg({ id: 15, status: 'sent',       scheduledAt: 2_599_500_000, sentAt: 2_599_500_500, payload: { text: 'newer sent message' } })
const cancelled    = makeMsg({ id: 16, status: 'cancelled',  scheduledAt: 2_599_200_000, payload: { text: 'cancelled message' } })
const groupMsg     = makeMsg({ id: 17, status: 'pending',    scheduledAt: 2_600_002_000, chatJid: '120363001@g.us', chatName: 'Group Alpha', payload: { text: 'group pending message' } })

function makeChat(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    conversationKey: '15555550001@s.whatsapp.net',
    name: 'Chat One',
    lastMessagePreview: 'latest direct preview',
    lastMessageAt: '2052-05-10T10:00:00.000Z',
    unreadCount: 0,
    isGroup: false,
    ...overrides,
  }
}

const chatItems: ChatItem[] = [
  makeChat(),
  makeChat({
    conversationKey: '120363001@g.us',
    name: 'Group Alpha',
    lastMessagePreview: 'latest group preview',
    unreadCount: 3,
    isGroup: true,
  }),
]

beforeEach(() => {
  getScheduledMock.mockReset()
  getChatsMock.mockReset()
  cancelScheduledMock.mockReset()
  createScheduledMock.mockReset()
  updateScheduledMock.mockReset()
  toastValue = makeToast()
  getChatsMock.mockResolvedValue(chatItems)
  createScheduledMock.mockResolvedValue(undefined)
  updateScheduledMock.mockResolvedValue(undefined)
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

function expectVisibleOrder(labels: string[]) {
  const nodes = labels.map(label => screen.getByText(label))
  for (let i = 0; i < nodes.length - 1; i += 1) {
    expect(Boolean(nodes[i].compareDocumentPosition(nodes[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  }
}

function inputValue(label: string): string {
  const input = screen.getByLabelText(label)
  return (input as HTMLInputElement | HTMLTextAreaElement).value
}

describe('ScheduledTab — loading / error / empty states', () => {
  it('renders the loading EmptyState while the scheduled query is pending', () => {
    // Never-resolving promises so the query stays in loading state.
    getScheduledMock.mockReturnValue(new Promise(() => {}))
    getChatsMock.mockReturnValue(new Promise(() => {}))

    render(withProviders(<ScheduledTab lineName={LINE} />))

    expect(screen.getByText('Loading scheduled messages...')).toBeDefined()
    expect(screen.getByText(/Fetching queue for this instance/i)).toBeDefined()
    expect(screen.queryByText(pendingEarly.payload.text as string)).toBeNull()
    expect(screen.queryByRole('button', { name: /New Scheduled Message/i })).toBeNull()
  })

  it('renders the error EmptyState with the thrown message when the query rejects', async () => {
    getScheduledMock.mockRejectedValue(new Error('socket down'))

    await renderSettled()

    expect(screen.getByText('Failed to load scheduled messages')).toBeDefined()
    expect(screen.getByText('socket down')).toBeDefined()
    expect(screen.queryByText(pendingEarly.payload.text as string)).toBeNull()
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
    expect(screen.queryByText(pendingEarly.payload.text as string)).toBeNull()
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
    expect(screen.getByText('early pending message')).toBeDefined()
  })

  it('renders the plural header text and one row per message', async () => {
    getScheduledMock.mockResolvedValue({
      count: 3,
      messages: [pendingEarly, pendingLate, sentNewer],
    })

    await renderSettled()

    expect(screen.getByText('3 scheduled messages')).toBeDefined()
    expect(screen.getByText('early pending message')).toBeDefined()
    expect(screen.getByText('late pending message')).toBeDefined()
    expect(screen.getByText('newer sent message')).toBeDefined()
  })

  it('sorts pending+processing first ASC by scheduledAt, then the rest DESC by scheduledAt', async () => {
    // Deliberately scrambled input order to prove the component re-orders it.
    getScheduledMock.mockResolvedValue({
      count: 6,
      messages: [sentOlder, pendingLate, cancelled, processing, sentNewer, pendingEarly],
    })

    await renderSettled()

    expectVisibleOrder([
      'early pending message',
      'processing message',
      'late pending message',
      'newer sent message',
      'cancelled message',
      'older sent message',
    ])
  })

  it('handles group-JID messages alongside phone messages without dropping either', async () => {
    getScheduledMock.mockResolvedValue({
      count: 2,
      messages: [pendingEarly, groupMsg],
    })

    await renderSettled()

    expect(screen.getByText('early pending message')).toBeDefined()
    expect(screen.getByText('group pending message')).toBeDefined()
    expect(screen.getByText('Group Alpha')).toBeDefined()
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
      fireEvent.click(screen.getByLabelText('Cancel scheduled message to Chat One'))
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
      fireEvent.click(screen.getByLabelText('Cancel scheduled message to Chat One'))
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
      fireEvent.click(screen.getByLabelText('Cancel scheduled message to Chat One'))
    })

    expect(toastValue.error).toHaveBeenCalledWith('Cancel failed: nope')
  })
})

describe('ScheduledTab — composer open / close / edit / duplicate / new', () => {
  it('keeps the composer closed until New is clicked, then shows an empty schedule form', async () => {
    getScheduledMock.mockResolvedValue({ count: 1, messages: [pendingEarly] })

    await renderSettled()

    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'New Scheduled Message' }))

    expect(screen.getByRole('dialog', { name: 'Schedule Message' })).toBeDefined()
    expect(inputValue('Message text')).toBe('')
    expect(screen.getByLabelText('Search chats...')).toBeDefined()
    expect(screen.queryByText('Edit Scheduled Message')).toBeNull()
  })

  it('opens edit mode with the selected chat and original message text visible', async () => {
    getScheduledMock.mockResolvedValue({ count: 1, messages: [pendingEarly] })

    await renderSettled()

    fireEvent.click(screen.getByLabelText('Edit scheduled message'))

    const dialog = screen.getByRole('dialog', { name: 'Edit Scheduled Message' })
    expect(dialog).toBeDefined()
    expect(within(dialog).getByText('Chat One')).toBeDefined()
    expect(inputValue('Message text')).toBe('early pending message')
    expect(screen.getByRole('button', { name: /^Update$/ })).toBeDefined()
  })

  it('duplicates a row as a new scheduled message template', async () => {
    getScheduledMock.mockResolvedValue({ count: 1, messages: [pendingEarly] })

    await renderSettled()

    fireEvent.click(screen.getByLabelText('Duplicate as new scheduled message'))

    const dialog = screen.getByRole('dialog', { name: 'Schedule Message' })
    expect(dialog).toBeDefined()
    expect(within(dialog).getByText('Chat One')).toBeDefined()
    expect(inputValue('Message text')).toBe('early pending message')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Schedule$/ }))
    })

    expect(createScheduledMock).toHaveBeenCalledWith(LINE, expect.objectContaining({
      chatJid: pendingEarly.chatJid,
      chatName: pendingEarly.chatName,
      text: 'early pending message',
    }))
    expect(updateScheduledMock).not.toHaveBeenCalled()
  })

  it('closes the composer and clears editMessage when the composer onClose fires', async () => {
    getScheduledMock.mockResolvedValue({ count: 1, messages: [pendingEarly] })

    await renderSettled()

    fireEvent.click(screen.getByLabelText('Edit scheduled message'))
    expect(screen.getByRole('dialog', { name: 'Edit Scheduled Message' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))

    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'New Scheduled Message' }))

    expect(screen.getByRole('dialog', { name: 'Schedule Message' })).toBeDefined()
    expect(inputValue('Message text')).toBe('')
  })

  it('lets a user choose a chat, submit a new scheduled message, and invalidates the scheduled query', async () => {
    getScheduledMock.mockResolvedValue({ count: 0, messages: [] })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries')
    const scheduledAtValue = '2099-01-02T09:30'
    const expectedScheduledAt = Math.floor(new Date(scheduledAtValue).getTime() / 1000)

    await renderSettled(client)

    fireEvent.click(screen.getByRole('button', { name: 'New Scheduled Message' }))
    fireEvent.focus(screen.getByLabelText('Search chats...'))
    // ChatPicker options are now <li role="option"> (Popover listbox, B2 rebuild)
    fireEvent.mouseDown(await waitFor(() => screen.getByRole('option', { name: /Group Alpha/ })))
    fireEvent.change(screen.getByLabelText('Message text'), { target: { value: 'Ship update' } })
    fireEvent.change(screen.getByLabelText('Scheduled time (local)'), { target: { value: scheduledAtValue } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Schedule$/ }))
    })

    expect(createScheduledMock).toHaveBeenCalledWith(LINE, {
      chatJid: '120363001@g.us',
      chatName: 'Group Alpha',
      scheduled_at: expectedScheduledAt,
      text: 'Ship update',
    })
    expect(toastValue.success).toHaveBeenCalledWith('Message scheduled')
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['scheduled', LINE] })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows no chat options and keeps submit disabled when the chats query returns null', async () => {
    getScheduledMock.mockResolvedValue({ count: 0, messages: [] })
    getChatsMock.mockResolvedValue(null)

    await renderSettled()

    fireEvent.click(screen.getByRole('button', { name: 'New Scheduled Message' }))
    fireEvent.change(screen.getByLabelText('Search chats...'), { target: { value: 'Chat One' } })

    expect(screen.queryByRole('button', { name: 'Chat One' })).toBeNull()
    expect((screen.getByRole('button', { name: /^Schedule$/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
